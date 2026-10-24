import { COLOR } from './types';
import { JSColorizer } from './colorizer';
import { CompletionEngine } from './completion';
import { HistoryStore } from './history';
import { openReplOutput } from './file-stdio';
import type { ReplOutputHandle } from './file-stdio';
import { LineEditor } from './line-editor';
import type { EditorCommandResult, KeyCommand, LineEditorHost } from './line-editor';
import { readEnv } from '../../env';

const os = import.meta.use('os');
const streams = import.meta.use('streams');
const engine = import.meta.use('engine');
const console = import.meta.use('console');
const sfs = import.meta.use('fs');
const error = import.meta.use('error');

// preset some envs
Reflect.set(globalThis, 'console', console);

// ==================== REPL Core ====================

export interface CnoReplOptions {
    /** Transform user input (e.g. TS → JS) before evaluation. Identity if absent. */
    transform?: (code: string) => string;
    /** First-line banner. Default: "cno REPL. enter \".help\" for help.\n" */
    banner?: string;
    /** Primary prompt. Overrides REPL_PS1. */
    ps1?: string;
    /** Continuation prompt. Overrides REPL_PS2. */
    ps2?: string;
    /** SQLite history DB path; each line is written immediately. */
    historyPath?: string;
    /** Cap history length (default 1000). */
    historyLimit?: number;
    /** Optional pre-built store (tests). */
    history?: HistoryStore;
}

export class CnoRepl implements LineEditorHost {
    readonly #colorizer = new JSColorizer();
    readonly #completer = new CompletionEngine();
    readonly #history: HistoryStore;
    #config: {
        ps1: string; ps2: string; banner: string;
        showTime: boolean; hexMode: boolean; colors: boolean;
    };
    #editor!: LineEditor;

    #transform: (code: string) => string;

    // State
    #multilineExpr = '';
    #braceLevel = 0;
    #pstate = '';
    #running = true;
    #evaluating = false;
    #lastEmptyCtrlCAt = 0;

    // Terminal
    #stdout: CModuleStreams.Pipe | CModuleStreams.Stream | ReplOutputHandle;
    /** stdin is a TTY — governs echo and the `.editor` directive. */
    #isatty: boolean = false;
    /** stdout TTY state controls color independently of interactive input. */
    #stdoutIsatty: boolean = false;
    #reading = false;
    #sigintHandle: CModuleSignals.SignalHandler | undefined;

    // Input handling
    #readlineResolver: ((value: string | null) => void) | null = null;
    #pendingLines: string[] = [];
    #inputResumeResolver: (() => void) | null = null;

    /** Code lines evaluated in this session, for `.save`. */
    #sessionLines: string[] = [];

    constructor(opts: CnoReplOptions = {}) {
        this.#transform = opts.transform ?? ((c) => c);
        this.#history = opts.history ?? new HistoryStore({
            path: opts.historyPath ?? null,
            limit: opts.historyLimit,
        });
        this.#config = {
            ps1: opts.ps1 ?? readEnv('REPL_PS1') ?? 'cno > ',
            ps2: opts.ps2 ?? readEnv('REPL_PS2') ?? '  ... ',
            banner: opts.banner ?? 'cno REPL. enter ".help" for help.\n',
            showTime: false,
            hexMode: false,
            colors: true,
        };
        // Redirected stdio needs the fd shim; Pipe.open() accepts pipes only.
        if (os.guessHandle(os.STDOUT_FILENO) === 'tty') {
            this.#stdout = new streams.TTY(os.STDOUT_FILENO, false);
            this.#stdoutIsatty = true;
        } else {
            this.#stdout = openReplOutput(os.STDOUT_FILENO);
        }

        this.#isatty = os.guessHandle(os.STDIN_FILENO) === 'tty';
        this.#editor = new LineEditor(this, { tty: this.#isatty });
        if (!this.#isatty) {
            console.warn('stdin is not a TTY, some features may not work');
        }

        // Keep Ctrl+C under REPL control while a read is active.
        try {
            const sig = import.meta.use('signals');
            if (sig) {
                let debounce = 0;
                this.#sigintHandle = sig.signal(sig.signals.SIGINT, () => {
                    if (this.#running && !this.#evaluating) {
                        this.#stopReadingQuietly();
                    }
                    const now = Date.now();
                    if (now - debounce < 300) {
                        // Double-press within 300ms: force exit
                        this.cleanup();
                        os.exit(130);
                        return;
                    }
                    debounce = now;
                    this.handleCtrlC();
                });
            }
        } catch {
            // signal module unavailable — rely on raw-VT \x03 delivery only
        }

        // Cleanup on exit (TTY restore + close history DB)
        this.#onExit(() => {
            this.#history.close();
            this.#settleExitCode();
            try {
                this.#sigintHandle?.close();
            } catch {}
            if (this.#isatty) {
                try {
                    sfs.write(os.STDOUT_FILENO, engine.encodeString('\x1b[?2004l'));
                } catch {}
                try {
                    this.#editor.setTerminalMode(streams.TTY_MODE_NORMAL);
                } catch {}
            }
        });
    }

    async start(): Promise<void> {
        this.print(this.#config.banner);
        if (this.#isatty) this.print('\x1b[?2004h');
        this.flush();
        this.#readInput();
        await this.#readLineLoop();
    }

    // ==================== Async Input Handling ====================

    async #readLineLoop(): Promise<void> {
        while (this.#running) {
            let line: string | null;
            try {
                line = await this.#readLine();
            } catch (e) {
                this.#printError(e);
                this.#releaseInputQueue();
                continue;
            }
            if (line === null) {
                // null means cancelled (Ctrl+C) — just loop for next line
                this.#releaseInputQueue();
                if (!this.#running) break;
                continue;
            }
            try {
                await this.#handleCommand(line);
            } catch (e) {
                // Directives such as `.load` can fail independently of eval.
                // Keep the interactive session alive after reporting them.
                this.#printError(e);
            } finally {
                // Pause input after each submitted line until evaluation ends.
                this.#releaseInputQueue();
            }
        }
    }

    async #readLine(): Promise<string | null> {
        this.#editor.beginLine();
        this.#startReadingQuietly();
        const queued = this.#pendingLines.shift();
        if (queued !== undefined) return queued;
        return new Promise((resolve) => {
            this.#readlineResolver = resolve;
        });
    }

    // Pending async command queue — ensures onread callbacks are serialised
    #cmdQueue: Promise<void> = Promise.resolve();
    /** True while draining a read chunk; key cmds run inline (no re-queue). */
    #processingInput = false;
    #syncKeyCmds: Array<{ cmd: KeyCommand; input: string }> = [];

    // LineEditorHost surface

    get config() { return this.#config; }
    get history() { return this.#history; }
    get colorizer() { return this.#colorizer; }
    get completer() { return this.#completer; }
    get multilineText() { return this.#multilineExpr; }
    get braceLevel() { return this.#braceLevel; }
    get pstate() { return this.#pstate; }

    get commandQueue(): Promise<void> {
        return this.#cmdQueue;
    }

    set commandQueue(queue: Promise<void>) {
        this.#cmdQueue = queue;
    }

    get processingInput(): boolean {
        return this.#processingInput;
    }

    get syncKeyCommands() {
        return this.#syncKeyCmds;
    }

    ctrlC(): void {
        if (this.#evaluating) {
            this.print('\n^C\n');
            this.flush();
            this.cleanup();
            os.exit(130);
            return;
        }
        this.handleCtrlC();
    }

    #releaseInputQueue(): void {
        const resolver = this.#inputResumeResolver;
        this.#inputResumeResolver = null;
        resolver?.();
    }

    #waitForInputQueue(): Promise<void> {
        if (!this.#running) return Promise.resolve();
        return new Promise((resolve) => { this.#inputResumeResolver = resolve; });
    }

    #stopReadingQuietly(): void {
        if (!this.#reading) return;
        try {
            this.#editor.stdin.stopRead();
        } catch {} finally {
            this.#reading = false;
        }
    }

    #startReadingQuietly(): void {
        if (!this.#running || this.#reading) return;
        try {
            this.#editor.stdin.startRead();
            this.#reading = true;
        } catch (err) {
            if (this.#isTerminalDisconnect(err)) {
                this.#finishInput();
                return;
            }
            throw err;
        }
    }

    #finishInput(): void {
        this.#running = false;
        if (this.#readlineResolver) {
            const resolver = this.#readlineResolver;
            this.#readlineResolver = null;
            resolver(null);
        }
        this.#releaseInputQueue();
        this.#stopReadingQuietly();
    }

    #isTerminalDisconnect(err: unknown): boolean {
        if (!this.#isatty || typeof err !== 'object' || err === null) return false;
        return Reflect.get(err, 'code') === error.errno.EIO;
    }

    #readInput(): void {
        this.#editor.stdin.onread = (res: null | undefined | Uint8Array, err: undefined | CModuleError.Error) => {
            if (!res) {
                // A detached POSIX PTY reports EIO instead of EOF.
                if (!err || this.#isTerminalDisconnect(err)) {
                    // Preserve ordering with data callbacks already queued.
                    this.#cmdQueue = this.#cmdQueue
                        .then(() => this.#finishInput())
                        .catch((e) => this.#printError(e));
                    return;
                }
                console.error('Failed to read from console:', err ?? 'EOF');
                this.cleanup();
                os.exit(1);
                throw 0;    // fallback
            }
            const bytes = res.slice(); // copy before async gap
            this.#cmdQueue = this.#cmdQueue.then(async () => {
                this.#processingInput = true;
                try {
                    for (let i = 0; i < bytes.length && this.#running; i++) {
                        const byte = bytes[i];
                        if (byte !== undefined) this.#editor.readBytes(bytes.subarray(i, i + 1));
                        // Flush key commands before the next byte so a piped
                        // "line\\n.q\\n" chunk does not glue into one #cmd.
                        while (this.#syncKeyCmds.length > 0 && this.#running) {
                            const item = this.#syncKeyCmds.shift();
                            if (!item) break;
                            await this.#executeCommand(item.cmd, item.input);
                        }
                    }
                } finally {
                    this.#processingInput = false;
                }
                if (!this.#running) this.#stopReadingQuietly();
            }).catch((e) => {
                this.#printError(e);
                this.#releaseInputQueue();
            });
        };
        this.#startReadingQuietly();
    }

    executeKeyCommand(cmd: KeyCommand, input: string): Promise<EditorCommandResult | void> {
        return this.#editor.executeKeyCommand(cmd, input);
    }

    async #executeCommand(cmd: KeyCommand, input: string): Promise<void> {
        const result = await this.#editor.executeKeyCommand(cmd, input);

        switch (result?.type) {
            case 'submit':
                this.#recordSubmittedLine(result.value);
                // Clear so more bytes in this onread chunk start a fresh line.
                this.#editor.clearLine();
                const resume = this.#waitForInputQueue();
                if (this.#readlineResolver) {
                    const resolver = this.#readlineResolver;
                    this.#readlineResolver = null;
                    resolver(result.value);
                } else {
                    this.#pendingLines.push(result.value);
                }
                await resume;
                break;
            case 'cancel':
                if (this.#readlineResolver) {
                    const resolver = this.#readlineResolver;
                    this.#readlineResolver = null;
                    this.#cancelCurrentInput('^C\n');
                    resolver(null);
                }
                break;
            case 'continue':
                break;
            case 'exit':
                this.#running = false;
                this.#editor.clearLine();
                if (this.#readlineResolver) {
                    const resolver = this.#readlineResolver;
                    this.#readlineResolver = null;
                    resolver(null);
                }
                this.#releaseInputQueue();
                this.cleanup();
                break;
            default:
                this.#editor.render();
                break;
        }
    }

    #recordSubmittedLine(line: string): void {
        // Pure meta directives (.q / .help / …) are not worth replaying.
        if (!line.length || /^\.[a-z]+\s*$/i.test(line)) return;
        this.#history.append(line);
        // `.save` writes the code evaluated in THIS session (node's
        // semantics), which is not the same as the persistent history.
        if (!/^\.[a-z]+(\s|$)/i.test(line)) this.#sessionLines.push(line);
    }

    // ==================== Evaluation ====================

    async #handleCommand(line: string): Promise<void> {
        if (line === '?') {
            this.#showHelp();
            return;
        }

        // Handle directives
        const directive = line.match(/^\.([a-z]+)\s*/)?.[1];
        if (directive) {
            const handled = await this.#handleDirective(directive, line.slice(directive.length + 1));
            if (!handled) return;
            line = line.slice(directive.length + 1).trim();
        }

        if (!line) return;

        // Accumulate multiline
        if (this.#multilineExpr) {
            line = this.#multilineExpr + '\n' + line;
        }

        // Check for incomplete input.
        // Always colorize from fresh state — `line` is the full accumulated expression,
        // so seeding with accumulated pstate/braceLevel would double-count openers.
        const highlight = this.#colorizer.colorize(line, '', 0);
        if (!highlight.invalid && (highlight.state || highlight.level > 0)) {
            this.#multilineExpr = line;
            this.#pstate = highlight.state;
            this.#braceLevel = highlight.level;
            return;
        }

        this.#multilineExpr = '';
        this.#pstate = '';
        this.#braceLevel = 0;

        await this.#evaluate(line);
    }

    async #handleDirective(cmd: string, rest: string): Promise<boolean> {
        switch (cmd) {
            case 'h': case 'help':
                this.#showHelp();
                return false;
            case 'load':
                const file = rest.trim() || 'script.js';
                // The resolver reads a bare specifier as a package name, so make a
                // local path explicitly relative. Extensions are preserved.
                const specifier = /^(?:[a-z][a-z\d+.-]*:|[\\/]|\.\.?[\\/])/i.test(file)
                    ? file
                    : `./${file}`;
                await import(specifier);
                return false;
            case 'x': this.#config.hexMode = true; return false;
            case 'd': this.#config.hexMode = false; return false;
            case 't': this.#config.showTime = !this.#config.showTime; return false;
            case 'c': case 'clear':
                this.print('\x1b[H\x1b[J');
                this.flush();
                return false;
            case 'q': case 'exit':
                // `.exit` is the name node and deno both use; `.q` predates it
                // here and stays as an alias. Omitting `.exit` meant the most
                // widely known way to leave a REPL printed "Unknown directive".
                this.#running = false;
                this.cleanup();
                return false;
            case 'save': {
                const target = rest.trim();
                if (!target) {
                    this.print('.save requires a filename\n');
                    this.flush();
                    return false;
                }
                const body = this.#sessionLines.length
                    ? this.#sessionLines.join('\n') + '\n'
                    : '';
                try {
                    sfs.writeFile(target, engine.encodeString(body));
                    this.print(`Session saved to: ${target}\n`);
                } catch {
                    // node prints exactly this on an unwritable path.
                    this.print(`Failed to save: ${target}\n`);
                }
                this.flush();
                return false;
            }
            case 'editor': {
                // node's `.editor`: read raw lines until ^D, then evaluate the
                // whole block as one expression. Reusing paste mode keeps the
                // existing submit path (and its brace tracking) intact.
                if (!this.#isatty) {
                    // Without a terminal there is no way to signal ^D distinctly
                    // from EOF, so node also refuses. Say so instead of hanging.
                    this.print('.editor requires a terminal\n');
                    this.flush();
                    return false;
                }
                this.#editor.setPasteMode(true);
                this.print('// Entering editor mode (^D to finish, ^C to cancel)\n');
                this.flush();
                return false;
            }
            case 'u':
                rest = rest.trim();
                Reflect.set(globalThis, rest, import.meta.use(rest));
                return false;
            default:
                this.print(`Unknown directive: .${cmd}\n`);
                this.flush();
                return false;
        }
    }

    async #evaluate(expr: string): Promise<void> {
        try {
            this.#evaluating = true;
            let code: string;
            try {
                code = this.#transform(expr);
            } catch (e) {
                this.#printError(e);
                return;
            }
            const result = (await engine.eval<{ value: unknown }>(code, '<eval>', engine.EVAL_ASYNC | engine.EVAL_NEW_BACKTRACE)).value;

            // ANSI color belongs only on a terminal.
            this.#printColor(COLOR.brightWhite);
            this.flush();
            if (this.#config.hexMode && (typeof result === 'number' || typeof result === 'bigint')) {
                const hex = typeof result === 'bigint'
                    ? '0x' + result.toString(16)
                    : '0x' + Math.floor(result).toString(16);
                this.print(hex + (typeof result === 'bigint' ? 'n' : ''));
            } else {
                console.log(result);
            }
            this.#printColor(COLOR.reset);
            this.print('\n');
            this.flush();

            Reflect.set(globalThis, '_', result);
        } catch (e) {
            this.#printError(e);
        } finally {
            this.#evaluating = false;
            engine.gc.run();
        }
    }

    #showHelp(): void {
        const sel = (n: boolean) => n ? '*' : ' ';
        console.log(
            `.h, .help   this help\n` +
            `.x         ${sel(this.#config.hexMode)} hexadecimal number display\n` +
            `.d         ${sel(!this.#config.hexMode)} decimal number display\n` +
            `.t         ${sel(this.#config.showTime)} toggle timing display\n` +
            `.u          use a built-in c-module and save it to globalThis\n` +
            `.load       load and evaluate a file in this session\n` +
            `.save       write this session's code to a file\n` +
            `.editor     multi-line editor mode (terminal only)\n` +
            `.c, .clear  clear the terminal\n` +
            `.q, .exit   exit`
        );
    }

    // ==================== Utilities ====================

    // Accumulate output during an update cycle, flush once at the end.
    #outBuf = '';

    writeSync(data: Uint8Array): void {
        this.#stdout.write(data);
    }

    print(str: string): void {
        this.#outBuf += str;
    }

    flush(): void {
        if (!this.#outBuf) return;
        this.writeSync(engine.encodeString(this.#outBuf));
        this.#outBuf = '';
    }

    #printError(err: unknown): void {
        this.#printColor(COLOR.brightRed);
        if (!(err instanceof Error)) this.print('Throw: ');
        this.flush();
        console.log(err);
        this.#printColor(COLOR.reset);
        this.print('\n');
        this.flush();
    }

    /** Emit an ANSI color escape only to a terminal. */
    #printColor(code: string): void {
        if (this.#stdoutIsatty && this.#config.colors) this.print(code);
    }

    /** Preserve an explicit exit code; otherwise successful REPL exit is zero. */
    #settleExitCode(): void {
        try {
            const proc = Reflect.get(globalThis, 'process');
            if (proc === null || typeof proc !== 'object') return;
            if (Reflect.get(proc, 'exitCode') === undefined) {
                Reflect.set(proc, 'exitCode', 0);
            }
        } catch { /* Exit-code cleanup is best effort. */ }
    }

    #onExit(callback: () => void): void { this.#exitCallback = callback; }
    #exitCallback: (() => void) | null = null;

    /** Restore terminal state (TTY mode, bracketed paste). Call before exit. */
    cleanup(): void {
        if (this.#exitCallback) {
            this.#exitCallback();
            this.#exitCallback = null;
        }
    }

    handleCtrlC(): void {
        if (this.#readlineResolver) {
            const hasInput = this.#editor.command.length > 0 || this.#multilineExpr.length > 0;
            const now = Date.now();
            if (!hasInput && now - this.#lastEmptyCtrlCAt < 1000) {
                this.print('\n');
                this.flush();
                this.cleanup();
                os.exit(130);
                return;
            }
            this.#lastEmptyCtrlCAt = hasInput ? 0 : now;

            const resolver = this.#readlineResolver;
            this.#readlineResolver = null;
            this.#cancelCurrentInput(hasInput ? '^C\n' : '^C (again to exit)\n');
            resolver(null);
        }
    }

    #cancelCurrentInput(message: string): void {
        this.#editor.cancelInput(message);
        this.#multilineExpr = '';
        this.#pstate = '';
        this.#braceLevel = 0;
    }

    exportHistory() {
        return this.#history.lines();
    }

    importHistory(history: string[]) {
        this.#history.importLines(history);
    }

    /** Underlying history store (for migrate / tests). */
    get historyStore(): HistoryStore {
        return this.#history;
    }
}
