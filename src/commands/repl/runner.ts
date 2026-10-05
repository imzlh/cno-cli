import type { TokenStyle } from './types';
import { COLOR, STYLE_MAP } from './types';
import { JSColorizer } from './colorizer';
import { CompletionEngine } from './completion';
import { HistoryStore } from './history';
import { openReplInput, openReplOutput } from './file-stdio';
import type { ReplInputHandle, ReplOutputHandle } from './file-stdio';
import { readEnv } from '../../env';

const os = import.meta.use('os');
const streams = import.meta.use('streams');
const engine = import.meta.use('engine');
const console = import.meta.use('console');
const sfs = import.meta.use('fs');
const error = import.meta.use('error');

// preset some envs
Reflect.set(globalThis, 'console', console);

// ==================== Types ====================

interface KeyCommand {
    (input: string): Promise<CommandResult | void> | CommandResult | void;
}

type TerminalSize =
    | { width?: number; columns?: number }
    | [number, number];

interface ResizableOutput {
    readonly size?: TerminalSize;
    getWindowSize?: () => TerminalSize;
    getwinsize?: () => TerminalSize;
}

function isResizableOutput(value: unknown): value is ResizableOutput {
    if (value === null || typeof value !== 'object') return false;
    return 'size' in value || 'getWindowSize' in value || 'getwinsize' in value;
}

interface EngineEvalResult {
    value: unknown;
}

type CommandResult =
    | { type: 'continue' }
    | { type: 'submit'; value: string }
    | { type: 'cancel' }
    | { type: 'exit' };

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

export class CnoRepl {
    #history: HistoryStore;
    #clipboard = '';
    #colorizer = new JSColorizer();
    #completer = new CompletionEngine();
    #transform: (code: string) => string;

    // State
    #cmd = '';
    #cursorPos = 0;
    #multilineExpr = '';
    #braceLevel = 0;
    #pstate = '';
    #quoteFlag = false;
    #running = true;
    #evaluating = false;
    #lastEmptyCtrlCAt = 0;

    // Terminal
    #stdin: CModuleStreams.Pipe | CModuleStreams.Stream | ReplInputHandle;
    #stdout: CModuleStreams.Pipe | CModuleStreams.Stream | ReplOutputHandle;
    /** stdin is a TTY — governs echo, repaint and raw-mode key handling. */
    #isatty: boolean = false;
    /** stdout TTY state controls color independently of interactive input. */
    #stdoutIsatty: boolean = false;
    #reading = false;
    #termWidth = 80;
    #termCursorX = 0;   // cursor X after prompt (start of input area)
    #inputRows = 0;     // rendered rows below the prompt line
    #cursorRow = 0;     // current cursor row below the prompt line
    #sigintHandle: CModuleSignals.SignalHandler | undefined;

    // Configuration
    #config: {
        ps1: string; ps2: string; banner: string;
        showTime: boolean; hexMode: boolean; colors: boolean; utf8: boolean;
    };

    // Input handling
    #readlineResolver: ((value: string | null) => void) | null = null;
    #pendingLines: string[] = [];
    #inputResumeResolver: (() => void) | null = null;
    #escState: 'normal' | 'esc' | 'csi' | 'osc' | 'paste' = 'normal';
    #escBuffer = '';
    #pasteBuffer = '';
    #inPasteMode = false;

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
            utf8: true,
        };
        // Redirected stdio needs the fd shim; Pipe.open() accepts pipes only.
        if (os.guessHandle(os.STDOUT_FILENO) === 'tty') {
            this.#stdout = new streams.TTY(os.STDOUT_FILENO, false);
            this.#stdoutIsatty = true;
        } else {
            this.#stdout = openReplOutput(os.STDOUT_FILENO);
        }

        if (os.guessHandle(os.STDIN_FILENO) === 'tty') {
            const stdin = this.#stdin = new streams.TTY(os.STDIN_FILENO, true);
            stdin.mode = streams.TTY_MODE_RAW_VT;
            this.#isatty = true;
            this.#refreshTermWidth();
        } else {
            this.#stdin = openReplInput(os.STDIN_FILENO);
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
                    (this.#stdin as CModuleStreams.TTY).mode = streams.TTY_MODE_NORMAL;
                } catch {}
            }
        });
    }

    async start(): Promise<void> {
        this.#print(this.#config.banner);
        if (this.#isatty) this.#print('\x1b[?2004h');
        this.#flush();
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
        this.#cmd = '';
        this.#cursorPos = 0;
        this.#history.resetCursor();
        this.#inputRows = 0;
        this.#cursorRow = 0;
        // Start fresh on a new line — no matter where external output left the cursor
        this.#printPrompt();
        this.#flush();
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
            this.#stdin.stopRead();
        } catch {} finally {
            this.#reading = false;
        }
    }

    #startReadingQuietly(): void {
        if (!this.#running || this.#reading) return;
        try {
            this.#stdin.startRead();
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
        this.#stdin.onread = (res: null | undefined | Uint8Array, err: undefined | CModuleError.Error) => {
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
                        if (byte !== undefined) this.#handleByte(byte);
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

    #handleByte(byte: number): void {
        if (!this.#config.utf8) {
            this.#handleChar(byte);
            return;
        }

        // UTF-8 decode
        if ((byte & 0x80) === 0) {
            this.#handleChar(byte);
        } else if ((byte & 0xe0) === 0xc0) {
            this.#utf8Remaining = 1;
            this.#utf8Acc = byte & 0x1f;
        } else if ((byte & 0xf0) === 0xe0) {
            this.#utf8Remaining = 2;
            this.#utf8Acc = byte & 0x0f;
        } else if ((byte & 0xf8) === 0xf0) {
            this.#utf8Remaining = 3;
            this.#utf8Acc = byte & 0x07;
        } else if ((byte & 0xc0) === 0x80 && this.#utf8Remaining > 0) {
            this.#utf8Acc = (this.#utf8Acc << 6) | (byte & 0x3f);
            if (--this.#utf8Remaining === 0) {
                this.#handleChar(this.#utf8Acc);
            }
        } else {
            this.#utf8Remaining = 0;
            this.#handleChar(byte);
        }
    }

    #utf8Remaining = 0;
    #utf8Acc = 0;

    #handleChar(code: number): void {
        const char = String.fromCodePoint(code);

        // Handle paste mode - accumulate everything until we see the end sequence
        if (this.#escState === 'paste') {
            this.#pasteBuffer += char;
            const pasteEnd = '\x1b[201~';
            if (this.#pasteBuffer.endsWith(pasteEnd)) {
                const content = this.#pasteBuffer.slice(0, -pasteEnd.length);
                this.#escState = 'normal';
                this.#inPasteMode = false;
                // Insert the pasted content, stripping \r from Windows CRLF
                for (const c of content) {
                    if (c !== '\r') this.#insert(c);
                }
                this.#update();
            }
            return;
        }

        switch (this.#escState) {
            case 'normal':
                if (char === '\x1b') {
                    this.#escState = 'esc';
                    this.#escBuffer = char;
                } else {
                    this.#processChar(char);
                }
                break;

            case 'esc':
                this.#escBuffer += char;
                if (char === '[') {
                    this.#escState = 'csi';
                } else if (char === 'O') {
                    this.#escState = 'osc';
                } else {
                    this.#processEscSequence(this.#escBuffer);
                    this.#escState = 'normal';
                }
                break;

            case 'csi':
            case 'osc':
                this.#escBuffer += char;
                // Check for paste start sequence \x1b[200~
                if (this.#escBuffer === '\x1b[200~') {
                    this.#escState = 'paste';
                    this.#inPasteMode = true;
                    this.#pasteBuffer = '';
                    return;
                }
                if ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '~') {
                    this.#processEscSequence(this.#escBuffer);
                    this.#escState = 'normal';
                }
                break;
        }
    }

    #processChar(char: string): void {
        if (this.#quoteFlag) {
            if ([...char].length === 1) this.#insert(char);
            this.#quoteFlag = false;
            if (this.#processingInput) this.#update();
            else this.#cmdQueue = this.#cmdQueue.then(() => this.#update());
            return;
        }

        const cmd = this.#keyMap.get(char);
        if (cmd) {
            this.#queueKeyCommand(cmd, char);
        } else if ([...char].length === 1 && char >= ' ') {
            this.#insert(char);
            if (this.#processingInput) this.#update();
            else this.#cmdQueue = this.#cmdQueue.then(() => this.#update());
        } else {
            this.#alert();
        }
    }

    #processEscSequence(seq: string): void {
        // SS3 (application keypad) cursor keys \x1bO<X> map onto the CSI form \x1b[<X>.
        const key = seq.startsWith('\x1bO') ? '\x1b[' + seq.slice(2) : seq;
        const cmd = this.#keyMap.get(key) ?? this.#keyMap.get(key.slice(1));
        if (cmd) {
            this.#queueKeyCommand(cmd, seq);
        } else {
            this.#alert();
        }
    }

    #queueKeyCommand(cmd: KeyCommand, input: string): void {
        if (this.#processingInput) {
            this.#syncKeyCmds.push({ cmd, input });
            return;
        }
        this.#cmdQueue = this.#cmdQueue.then(() => this.#executeCommand(cmd, input));
    }

    async #executeCommand(cmd: KeyCommand, input: string): Promise<void> {
        const previousValue = this.#cmd;
        const result = await cmd.call(this, input);
        this.#lastCommand = input === '\t' && this.#cmd !== previousValue ? '' : input;

        switch (result?.type) {
            case 'submit':
                this.#history.resetCursor();
                // Clear so more bytes in this onread chunk start a fresh line.
                this.#cmd = '';
                this.#cursorPos = 0;
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
                this.#cmd = '';
                this.#cursorPos = 0;
                if (this.#readlineResolver) {
                    const resolver = this.#readlineResolver;
                    this.#readlineResolver = null;
                    resolver(null);
                }
                this.#releaseInputQueue();
                this.cleanup();
                break;
            default:
                this.#cursorPos = Math.max(0, Math.min(this.#cmd.length, this.#cursorPos));
                this.#update();
        }
    }

    // ==================== Commands ====================

    #keyMap = new Map<string, KeyCommand>([
        ['\x01', () => { this.#cursorPos = 0; }],                    // ^A
        ['\x02', () => this.#moveCursor(-1)],                         // ^B
        ['\x03', () => {                                        // ^C
            this.handleCtrlC();
            return { type: 'continue' } as const;
        }],
        ['\x04', async () => {                                        // ^D
            if (this.#cmd.length === 0) return { type: 'exit' } as const;
            this.#deleteChar(1);
        }],
        ['\x05', () => { this.#cursorPos = this.#cmd.length; }],      // ^E
        ['\x06', () => this.#moveCursor(1)],                          // ^F
        ['\x07', () => { }],                                           // ^G
        ['\x08', () => this.#deleteChar(-1)],                         // ^H
        ['\x7f', () => this.#deleteChar(-1)],
        ['\t', () => this.#complete()],                               // Tab
        ['\n', () => this.#submitLine()],                            // ^J
        ['\x0b', () => {                                              // ^K
            this.#clipboard = this.#cmd.slice(this.#cursorPos);
            this.#cmd = this.#cmd.slice(0, this.#cursorPos);
        }],
        ['\x0d', () => this.#submitLine()],                          // ^M
        ['\x0e', () => this.#nextHistory()],                          // ^N
        ['\x10', () => this.#prevHistory()],                          // ^P
        ['\x11', () => { this.#quoteFlag = true; }],                  // ^Q
        ['\x14', () => this.#transpose()],                            // ^T
        ['\x18', () => { this.#cmd = ''; this.#cursorPos = 0; }],     // ^X
        ['\x19', () => this.#insert(this.#clipboard)],                // ^Y
        // Arrow keys
        ['\x1b[A', () => this.#prevHistory()],
        ['\x1b[B', () => this.#nextHistory()],
        ['\x1b[C', () => this.#moveCursor(1)],
        ['\x1b[D', () => this.#moveCursor(-1)],
        ['\x1b[H', () => { this.#cursorPos = 0; }],                   // Home
        ['\x1b[F', () => { this.#cursorPos = this.#cmd.length; }],    // End
        ['\x1b[3~', () => this.#deleteChar(1)],                       // Delete
        // Word navigation
        ['\x1bb', () => { this.#cursorPos = this.#skipWordBack(this.#cursorPos); }],
        ['\x1bf', () => { this.#cursorPos = this.#skipWordForward(this.#cursorPos); }],
        ['\x1b[1;5D', () => { this.#cursorPos = this.#skipWordBack(this.#cursorPos); }],  // Ctrl-Left
        ['\x1b[1;5C', () => { this.#cursorPos = this.#skipWordForward(this.#cursorPos); }], // Ctrl-Right
        // Kill operations
        ['\x1bd', () => {                                            // M-d
            const end = this.#skipWordForward(this.#cursorPos);
            this.#clipboard = this.#cmd.slice(this.#cursorPos, end);
            this.#cmd = this.#cmd.slice(0, this.#cursorPos) + this.#cmd.slice(end);
        }],
        ['\x1b\x7f', () => {                                          // M-Backspace
            const start = this.#skipWordBack(this.#cursorPos);
            this.#clipboard = this.#cmd.slice(start, this.#cursorPos);
            this.#cmd = this.#cmd.slice(0, start) + this.#cmd.slice(this.#cursorPos);
            this.#cursorPos = start;
        }],
    ]);

    #lastCommand = '';

    /** Code lines evaluated in this session, for `.save`. */
    #sessionLines: string[] = [];

    // ==================== Command Implementation ====================

    #submitLine(): CommandResult | void {
        if (this.#inPasteMode) {
            this.#insert('\n');
            return;
        }
        // Move cursor to end of input, then newline — so prompt clears from correct position
        this.#cursorPos = this.#cmd.length;
        this.#update();
        this.#print('\n');
        this.#flush();
        this.#inputRows = 0;
        this.#cursorRow = 0;
        // Pure meta directives (.q / .help / …) are not worth replaying.
        if (this.#cmd.length && !/^\.[a-z]+\s*$/i.test(this.#cmd)) {
            this.#history.append(this.#cmd);
            // `.save` writes the code evaluated in THIS session (node's
            // semantics), which is not the same as the persistent history.
            if (!/^\.[a-z]+(\s|$)/i.test(this.#cmd)) this.#sessionLines.push(this.#cmd);
        }
        return { type: 'submit', value: this.#cmd } as const;
    }

    #moveCursor(delta: number): void {
        const newPos = Math.max(0, Math.min(this.#cmd.length, this.#cursorPos + delta));
        if (newPos !== this.#cursorPos) {
            if (delta > 0 && newPos < this.#cmd.length && this.#isTrailingSurrogate(this.#cmd[newPos])) {
                this.#cursorPos = newPos + 1;
            } else if (delta < 0 && newPos > 0 && this.#isTrailingSurrogate(this.#cmd[newPos])) {
                this.#cursorPos = newPos - 1;
            } else {
                this.#cursorPos = newPos;
            }
        }
    }

    #insert(str: string): void {
        this.#cmd = this.#cmd.slice(0, this.#cursorPos) + str + this.#cmd.slice(this.#cursorPos);
        this.#cursorPos += str.length;
        this.#lastCommand = '';
    }

    #deleteChar(dir: number): void {
        if (dir < 0 && this.#cursorPos > 0) {
            this.#moveCursor(-1);
            this.#deleteChar(1);
            return;
        }
        if (dir > 0 && this.#cursorPos < this.#cmd.length) {
            let end = this.#cursorPos + 1;
            while (end < this.#cmd.length && this.#isTrailingSurrogate(this.#cmd[end])) end++;
            this.#cmd = this.#cmd.slice(0, this.#cursorPos) + this.#cmd.slice(end);
        }
    }

    #transpose(): void {
        if (this.#cursorPos === 0 || this.#cmd.length < 2) return;
        // At end of line readline transposes the last two characters.
        let mid = this.#cursorPos;
        if (mid === this.#cmd.length) {
            mid--;
            while (mid > 0 && this.#isTrailingSurrogate(this.#cmd[mid])) mid--;
        }
        if (mid === 0) return;
        let start = mid - 1;
        while (start > 0 && this.#isTrailingSurrogate(this.#cmd[start])) start--;
        let end = mid + 1;
        while (end < this.#cmd.length && this.#isTrailingSurrogate(this.#cmd[end])) end++;
        const first = this.#cmd.slice(start, mid);
        const second = this.#cmd.slice(mid, end);
        this.#cmd = this.#cmd.slice(0, start) + second + first + this.#cmd.slice(end);
        this.#cursorPos = end;
    }

    #prevHistory(): void {
        const line = this.#history.prev(this.#cmd);
        if (line === null) return;
        this.#cmd = line;
        this.#cursorPos = this.#cmd.length;
    }

    #nextHistory(): void {
        const line = this.#history.next();
        if (line === null) return;
        this.#cmd = line;
        this.#cursorPos = this.#cmd.length;
    }

    #complete(): void {
        const { completions, position } = this.#completer.getCompletions(this.#cmd, this.#cursorPos);

        if (completions.length === 0) {
            this.#alert();
            return;
        }

        // const word = this.#cmd.substring(this.#cursorPos - position, this.#cursorPos);
        const first = completions[0];
        if (first === undefined) {
            this.#alert();
            return;
        }
        let common = first;

        for (let i = 1; i < completions.length; i++) {
            const completion = completions[i];
            if (completion === undefined) continue;
            let j = position;
            while (j < common.length && j < completion.length && common[j] === completion[j]) {
                j++;
            }
            common = common.substring(0, j);
        }

        if (common.length > position) {
            for (let i = position; i < common.length; i++) {
                const ch = common[i];
                if (ch !== undefined) this.#insert(ch);
            }
            this.#lastCommand = '';
            return;
        }

        if (this.#lastCommand === '\t') {
            this.#showCompletions(completions);
            return;
        }

        this.#alert();
    }

    #showCompletions(list: string[]): void {
        const maxWidth = Math.max(...list.map(s => s.length)) + 2;
        const cols = Math.max(1, Math.floor(this.#termWidth / maxWidth));
        const rows = Math.ceil(list.length / cols);

        this.#print('\n');
        for (let row = 0; row < rows; row++) {
            const line: string[] = [];
            for (let col = 0; col < cols; col++) {
                const idx = col * rows + row;
                if (idx < list.length) {
                    const item = list[idx];
                    if (item === undefined) continue;
                    line.push(col === cols - 1 ? item : item.padEnd(maxWidth));
                }
            }
            this.#print(line.join('') + '\n');
        }
        this.#printPrompt();
        this.#print(this.#cmd);
        this.#flush();
    }

    #skipWordForward(pos: number): number {
        while (pos < this.#cmd.length && !this.#isWordChar(this.#cmd[pos] ?? '')) pos++;
        while (pos < this.#cmd.length && this.#isWordChar(this.#cmd[pos] ?? '')) pos++;
        return pos;
    }

    #skipWordBack(pos: number): number {
        while (pos > 0 && !this.#isWordChar(this.#cmd[pos - 1] ?? '')) pos--;
        while (pos > 0 && this.#isWordChar(this.#cmd[pos - 1] ?? '')) pos--;
        return pos;
    }

    // ==================== Display ====================

    #printPrompt(): void {
        this.#refreshTermWidth();
        const timeStr = this.#config.showTime ? `${(Date.now() / 1000).toFixed(6)} ` : '';
        const prompt = this.#multilineExpr
            ? ' '.repeat(this.#displayWidth(this.#config.ps1)) + this.#config.ps2
            : timeStr + this.#config.ps1;
        this.#print(prompt);
        this.#termCursorX = this.#displayWidth(prompt) % this.#termWidth;
    }

    #update(): void {
        // Piped input has no cursor to repaint.
        if (!this.#isatty) return;

        this.#moveToStart();

        if (this.#config.colors) {
            const fullExpr = this.#multilineExpr ? this.#multilineExpr + '\n' + this.#cmd : this.#cmd;
            const startOffset = fullExpr.length - this.#cmd.length;
            const { styles } = this.#colorizer.colorize(fullExpr, this.#pstate, this.#braceLevel);
            this.#printHighlighted(fullExpr.slice(startOffset), styles.slice(startOffset));
        } else {
            this.#print(this.#cmd);
        }

        this.#print('\x1b[J');

        const cursorCells = this.#displayWidth(this.#cmd.slice(0, this.#cursorPos));
        const absCol = this.#termCursorX + cursorCells;
        const cursorRow = Math.floor(absCol / this.#termWidth);
        const cursorCol = absCol % this.#termWidth;

        const totalCells = this.#termCursorX + this.#displayWidth(this.#cmd);
        this.#inputRows = Math.floor(totalCells / this.#termWidth);
        this.#cursorRow = cursorRow;

        if (this.#inputRows > cursorRow) this.#print(`\x1b[${this.#inputRows - cursorRow}A`);
        this.#print(`\x1b[${cursorCol + 1}G`);

        this.#flush();
    }

    #moveToStart(): void {
        if (this.#cursorRow > 0) this.#print(`\x1b[${this.#cursorRow}A`);
        this.#print('\r\x1b[J');
        this.#inputRows = 0;
        this.#cursorRow = 0;
        this.#printPrompt();
    }

    #refreshTermWidth(): void {
        if (!this.#isatty) return;
        try {
            if (!isResizableOutput(this.#stdout)) return;
            const out = this.#stdout;
            const size = out.size ?? out.getWindowSize?.() ?? out.getwinsize?.();
            const width = Array.isArray(size) ? size[0] : (size?.width ?? size?.columns);
            if (typeof width === 'number' && Number.isInteger(width) && width > 0) this.#termWidth = width;
        } catch {}
    }

    #displayWidth(str: string): number {
        let width = 0;
        for (const ch of str) {
            const cp = ch.codePointAt(0);
            if (cp === undefined) continue;
            if (cp === 0) continue;
            if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) continue;
            width += this.#isWideCodePoint(cp) ? 2 : 1;
        }
        return width;
    }

    #isWideCodePoint(cp: number): boolean {
        return cp >= 0x1100 && (
            cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
            (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
            (cp >= 0xac00 && cp <= 0xd7a3) ||
            (cp >= 0xf900 && cp <= 0xfaff) ||
            (cp >= 0xfe10 && cp <= 0xfe19) ||
            (cp >= 0xfe30 && cp <= 0xfe6f) ||
            (cp >= 0xff00 && cp <= 0xff60) ||
            (cp >= 0xffe0 && cp <= 0xffe6) ||
            (cp >= 0x1f300 && cp <= 0x1faff)
        );
    }

    #printHighlighted(str: string, styles: TokenStyle[]): void {
        let currentStyle: TokenStyle | null = null;
        for (let i = 0; i < str.length; i++) {
            const style = styles[i] ?? 'default';
            if (style !== currentStyle) {
                if (currentStyle) this.#print(COLOR.reset);
                if (style !== 'default') this.#print(COLOR[STYLE_MAP[style]]);
                currentStyle = style;
            }
            const ch = str[i];
            if (ch !== undefined) this.#print(ch);
        }
        if (currentStyle) this.#print(COLOR.reset);
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
                // Dynamic imports without a leading `./` are treated as
                // package specifiers by the resolver. `.load` is a local
                // file command, so make a bare path explicitly relative and
                // preserve the extension supplied by the user (TS included).
                const specifier = /^(?:[a-z][a-z\d+.-]*:|[\\/]|\.\.?[\\/])/i.test(file)
                    ? file
                    : `./${file}`;
                await import(specifier);
                return false;
            case 'x': this.#config.hexMode = true; return false;
            case 'd': this.#config.hexMode = false; return false;
            case 't': this.#config.showTime = !this.#config.showTime; return false;
            case 'c': case 'clear':
                this.#print('\x1b[H\x1b[J');
                this.#flush();
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
                    this.#print('.save requires a filename\n');
                    this.#flush();
                    return false;
                }
                const body = this.#sessionLines.length
                    ? this.#sessionLines.join('\n') + '\n'
                    : '';
                try {
                    sfs.writeFile(target, engine.encodeString(body));
                    this.#print(`Session saved to: ${target}\n`);
                } catch {
                    // node prints exactly this on an unwritable path.
                    this.#print(`Failed to save: ${target}\n`);
                }
                this.#flush();
                return false;
            }
            case 'editor': {
                // node's `.editor`: read raw lines until ^D, then evaluate the
                // whole block as one expression. Reusing paste mode keeps the
                // existing submit path (and its brace tracking) intact.
                if (!this.#isatty) {
                    // Without a terminal there is no way to signal ^D distinctly
                    // from EOF, so node also refuses. Say so instead of hanging.
                    this.#print('.editor requires a terminal\n');
                    this.#flush();
                    return false;
                }
                this.#inPasteMode = true;
                this.#print('// Entering editor mode (^D to finish, ^C to cancel)\n');
                this.#flush();
                return false;
            }
            case 'u':
                rest = rest.trim();
                Reflect.set(globalThis, rest, import.meta.use(rest));
                return false;
            default:
                this.#print(`Unknown directive: .${cmd}\n`);
                this.#flush();
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
            const result = (await engine.eval<EngineEvalResult>(code, '<eval>', engine.EVAL_ASYNC | engine.EVAL_NEW_BACKTRACE)).value;

            // ANSI color belongs only on a terminal.
            this.#printColor(COLOR.brightWhite);
            this.#flush();
            if (this.#config.hexMode && (typeof result === 'number' || typeof result === 'bigint')) {
                const hex = typeof result === 'bigint'
                    ? '0x' + result.toString(16)
                    : '0x' + Math.floor(result).toString(16);
                this.#print(hex + (typeof result === 'bigint' ? 'n' : ''));
            } else {
                console.log(result);
            }
            this.#printColor(COLOR.reset);
            this.#print('\n');
            this.#flush();

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

    #writeSync(data: Uint8Array): void {
        this.#stdout.write(data);
    }

    #print(str: string): void {
        this.#outBuf += str;
    }

    #flush(): void {
        if (!this.#outBuf) return;
        this.#writeSync(engine.encodeString(this.#outBuf));
        this.#outBuf = '';
    }

    #printError(err: unknown): void {
        this.#printColor(COLOR.brightRed);
        if (!(err instanceof Error)) this.#print('Throw: ');
        this.#flush();
        console.log(err);
        this.#printColor(COLOR.reset);
        this.#print('\n');
        this.#flush();
    }

    /** Emit an ANSI color escape only to a terminal. */
    #printColor(code: string): void {
        if (this.#stdoutIsatty && this.#config.colors) this.#print(code);
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

    #alert(): void {
        this.#writeSync(new Uint8Array([0x07]));
    }

    #isWordChar(c: string) { return /[a-zA-Z0-9_$]/.test(c); }
    #isTrailingSurrogate(c?: string) {
        const code = c?.codePointAt(0);
        return code !== undefined && code >= 0xdc00 && code < 0xe000;
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
        if (this.#evaluating) {
            this.#print('\n^C\n');
            this.#flush();
            this.cleanup();
            os.exit(130);
            return;
        }
        if (this.#readlineResolver) {
            const hasInput = this.#cmd.length > 0 || this.#multilineExpr.length > 0;
            const now = Date.now();
            if (!hasInput && now - this.#lastEmptyCtrlCAt < 1000) {
                this.#print('\n');
                this.#flush();
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
        const rowsToStart = Math.max(this.#cursorRow, this.#inputRows);
        if (rowsToStart > 0) this.#print(`\x1b[${rowsToStart}A`);
        this.#print('\r\x1b[J' + message);
        this.#cmd = '';
        this.#cursorPos = 0;
        this.#multilineExpr = '';
        this.#pstate = '';
        this.#braceLevel = 0;
        this.#history.resetCursor();
        this.#inputRows = 0;
        this.#cursorRow = 0;
        this.#flush();
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
