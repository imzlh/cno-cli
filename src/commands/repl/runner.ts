/*
 * cno Read Eval Print Loop — adapted from circu.js/src/repl.ts
 *
 * Copyright (c) 2025~2026 iz
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

const os = import.meta.use('os');
const streams = import.meta.use('streams');
const engine = import.meta.use('engine');
const console = import.meta.use('console');
const sfs = import.meta.use('fs');

// preset some envs
Reflect.set(globalThis, 'console', console);

// ==================== Types ====================

type TokenStyle =
    | 'comment' | 'string' | 'regex' | 'number' | 'keyword'
    | 'function' | 'type' | 'identifier' | 'error' | 'default'
    | 'directive';

interface HighlightResult {
    state: string;
    level: number;
    styles: TokenStyle[];
}

interface CompletionResult {
    completions: string[];
    position: number;
    context: unknown;
}

interface KeyCommand {
    (input: string): Promise<CommandResult | void> | CommandResult | void;
}

type CommandResult =
    | { type: 'continue' }
    | { type: 'submit'; value: string }
    | { type: 'cancel' }
    | { type: 'exit' };

// ==================== Utilities ====================

const COLOR = {
    reset: '\x1b[0m',
    black: '\x1b[30m', red: '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m',
    cyan: '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m',
    brightRed: '\x1b[91m', brightGreen: '\x1b[92m', brightYellow: '\x1b[93m',
    brightBlue: '\x1b[94m', brightMagenta: '\x1b[95m', brightCyan: '\x1b[96m',
    brightWhite: '\x1b[97m',
} as const;

const STYLE_MAP: Record<TokenStyle, keyof typeof COLOR> = {
    default: 'brightGreen', comment: 'gray', string: 'brightCyan',
    regex: 'cyan', number: 'green', keyword: 'brightWhite',
    function: 'brightYellow', type: 'brightMagenta', identifier: 'brightGreen',
    error: 'red', directive: 'gray'
};
function getenv(env: string) {
    try {
        return os.getenv(env);
    } catch {
        return null;
    }
}

// ==================== Highlighter (Optimized) ====================

class JSColorizer {
    static #KEYWORDS = new Set([
        'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete', 'do',
        'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof', 'new',
        'return', 'switch', 'this', 'throw', 'try', 'typeof', 'while', 'with',
        'class', 'const', 'enum', 'import', 'export', 'extends', 'super',
        'implements', 'interface', 'let', 'package', 'private', 'protected',
        'public', 'static', 'yield', 'undefined', 'null', 'true', 'false',
        'Infinity', 'NaN', 'eval', 'arguments', 'await', 'async', 'of', 'void'
    ]);

    static #NO_REGEX = new Set([
        'this', 'super', 'undefined', 'null', 'true', 'false',
        'Infinity', 'NaN', 'arguments'
    ]);

    static #DIRECTIVES = new Set(['help', 'h', 'x', 'd', 't', 'c', 'q', 'quit', 'u']);

    static #TYPES = new Set(['void', 'let', 'var', 'const']);

    #str = '';
    #index = 0;
    #length = 0;
    #start = 0;
    #styles: TokenStyle[] = [];
    #stateStack = '';
    #braceLevel = 0;
    #canBeRegex = true;
    #currentStyle: TokenStyle | null = null;

    colorize(input: string, state = '', level = 0): HighlightResult {
        this.#str = input;
        this.#index = 0;
        this.#length = input.length;
        this.#stateStack = state;
        this.#braceLevel = level;
        this.#canBeRegex = true;
        this.#styles = [];

        while (this.#index < this.#length) {
            this.#currentStyle = null;
            this.#start = this.#index;
            const char = this.#str[this.#index++]!;

            switch (char) {
                case ' ': case '\t': case '\r': case '\n': continue;
                case '+': case '-':
                    if (this.#peek() === char) this.#index++;
                    else this.#canBeRegex = true;
                    continue;
                case '/':
                    if (this.#peek() === '*') this.#parseBlockComment();
                    else if (this.#peek() === '/') this.#parseLineComment();
                    else if (this.#canBeRegex) {
                        this.#parseRegex();
                        this.#canBeRegex = false;
                    } else {
                        this.#canBeRegex = true;
                        continue;
                    }
                    break;
                case "'": case '"': case '`':
                    this.#parseString(char);
                    this.#canBeRegex = false;
                    break;
                case '(': case '[': case '{':
                    this.#canBeRegex = true;
                    this.#braceLevel++;
                    this.#pushState(char);
                    continue;
                case ')': case ']': case '}':
                    this.#canBeRegex = false;
                    if (this.#braceLevel > 0 && this.#isBalanced(this.#lastState(), char)) {
                        this.#braceLevel--;
                        this.#popState();
                        continue;
                    }
                    this.#currentStyle = 'error';
                    break;
                default:
                    if (this.#isDigit(char)) {
                        this.#parseNumber();
                        this.#canBeRegex = false;
                    } else if (this.#isWordChar(char) || char === '$') {
                        this.#parseIdentifier();
                    } else {
                        this.#canBeRegex = true;
                        continue;
                    }
            }

            if (this.#currentStyle) this.#fillStyle(this.#start, this.#index);
        }

        this.#fillStyle(this.#length, this.#length);
        return { state: this.#stateStack, level: this.#braceLevel, styles: this.#styles };
    }

    #peek() { return this.#str[this.#index]; }
    #pushState(c: string) { this.#stateStack += c; }
    #lastState() { return this.#stateStack.at(-1) ?? ''; }
    #popState() { this.#stateStack = this.#stateStack.slice(0, -1); }
    #isDigit(c: string) { return /[0-9]/.test(c); }
    #isWordChar(c: string) { return /[a-zA-Z0-9_$]/.test(c); }
    #isBalanced(a: string, b: string) {
        return (a === '(' && b === ')') || (a === '[' && b === ']') || (a === '{' && b === '}');
    }

    #parseBlockComment() {
        this.#currentStyle = 'comment';
        this.#pushState('/');
        for (this.#index++; this.#index < this.#length - 1; this.#index++) {
            if (this.#str[this.#index] === '*' && this.#str[this.#index + 1] === '/') {
                this.#index += 2;
                this.#popState();
                break;
            }
        }
    }

    #parseLineComment() {
        this.#currentStyle = 'comment';
        for (this.#index++; this.#index < this.#length && this.#str[this.#index] !== '\n'; this.#index++);
    }

    #parseString(delim: string) {
        this.#currentStyle = 'string';
        this.#pushState(delim);
        while (this.#index < this.#length) {
            const c = this.#str[this.#index++];
            if (c === '\n' && delim !== '`') { this.#currentStyle = 'error'; continue; }
            if (c === '\\') { if (this.#index < this.#length) this.#index++; }
            else if (c === delim) { this.#popState(); break; }
        }
    }

    #parseRegex() {
        this.#currentStyle = 'regex';
        this.#pushState('/');
        while (this.#index < this.#length) {
            const c = this.#str[this.#index++];
            if (c === '\n') { this.#currentStyle = 'error'; continue; }
            if (c === '\\') { if (this.#index < this.#length) this.#index++; continue; }
            if (this.#lastState() === '[') { if (c === ']') this.#popState(); continue; }
            if (c === '[') {
                this.#pushState('[');
                if (this.#peek() === '[' || this.#peek() === ']') this.#index++;
                continue;
            }
            if (c === '/') {
                this.#popState();
                while (this.#index < this.#length && this.#isWordChar(this.#str[this.#index]!)) this.#index++;
                break;
            }
        }
    }

    #parseNumber() {
        this.#currentStyle = 'number';
        while (this.#index < this.#length) {
            const c = this.#str[this.#index]!;
            if (this.#isWordChar(c) || c === '.' || c === '+' || c === '-') {
                if (c === '.' && (this.#index === this.#length - 1 || this.#str[this.#index + 1] === '.')) break;
                this.#index++;
            } else break;
        }
    }

    #parseIdentifier() {
        if (this.#start > 0 && this.#str[this.#start - 1] === '.' && this.#braceLevel === 0) {
            this.#canBeRegex = true;
            while (this.#index < this.#length && this.#isWordChar(this.#str[this.#index]!)) this.#index ++;

            const word = this.#str.substring(this.#start, this.#index);
            if (JSColorizer.#DIRECTIVES.has(word)) {
                this.#currentStyle = 'directive';
                return;
            }
            this.#index = this.#start;
        }

        // Check for keywords
        this.#canBeRegex = true;
        while (this.#index < this.#length && this.#isWordChar(this.#str[this.#index]!)) this.#index++;

        const word = this.#str.substring(this.#start, this.#index);
        if (JSColorizer.#KEYWORDS.has(word)) {
            this.#currentStyle = 'keyword';
            if (JSColorizer.#NO_REGEX.has(word)) this.#canBeRegex = false;
            return;
        }

        // Check if function call
        let next = this.#index;
        while (next < this.#length && this.#str[next] === ' ') next++;
        if (this.#str[next] === '(') {
            this.#currentStyle = 'function';
            return;
        }

        this.#currentStyle = JSColorizer.#TYPES.has(word) ? 'type' : 'identifier';
        if (this.#currentStyle === 'identifier') this.#canBeRegex = false;
    }

    #fillStyle(from: number, to: number) {
        while (this.#styles.length < from) this.#styles.push('default');
        while (this.#styles.length < to) this.#styles.push(this.#currentStyle ?? 'default');
    }
}

// ==================== Completion Engine ====================

class CompletionEngine {
    getCompletions(line: string, pos: number): CompletionResult {
        const word = this.#getContextWord(line, pos);
        const ctxObj = this.#getContextObject(line, pos - word.length);
        const completions = this.#enumerateProperties(ctxObj, word);

        return { completions, position: word.length, context: ctxObj };
    }

    #getContextWord(line: string, pos: number): string {
        let s = '';
        while (pos > 0 && this.#isWordChar(line[pos - 1]!)) s = line[--pos] + s;
        return s;
    }

    #getContextObject(line: string, pos: number): unknown {
        if (pos <= 0 || ' ~!%^&*(-+={[|:;,<>?/'.includes(line[pos - 1]!)) return globalThis;
        if (line[pos - 1] !== '.') return undefined;

        pos--;
        const c = line[pos - 1];
        switch (c) {
            case undefined: return '';
            case "'": case '"': return 'a';
            case ']': return [];
            case '}': return {};
            case '/': return / /;
            default:
                if (this.#isWordChar(c)) {
                    const base = this.#getContextWord(line, pos);
                    if (['true', 'false', 'null', 'this'].includes(base) || !Number.isNaN(+base)) {
                        return new Function(base)();
                    }
                    // Check for regex flags
                    if (pos - base.length >= 2 && line[pos - base.length - 1] === '/') {
                        return new RegExp('', base);
                    }
                    const obj = this.#getContextObject(line, pos - base.length);
                    if (obj == null) return obj;
                    return (obj as Record<string, unknown>)[base] ?? eval?.(base);
                }
                return {};
        }
    }

    #enumerateProperties(obj: unknown, prefix: string): string[] {
        const seen = new Set<string>();
        const results: string[] = [];

        for (let i = 0, curr = obj; i < 10 && curr != null; i++, curr = Object.getPrototypeOf(curr)) {
            for (const key of Object.getOwnPropertyNames(curr)) {
                if (typeof key === 'string' && !/^\d+$/.test(key) && key.startsWith(prefix) && !seen.has(key)) {
                    seen.add(key);
                    results.push(key);
                }
            }
        }

        return results.sort((a, b) => {
            if (a[0] === '_' && b[0] !== '_') return 1;
            if (b[0] === '_' && a[0] !== '_') return -1;
            return a.localeCompare(b);
        });
    }

    #isWordChar(c: string) { return /[a-zA-Z0-9_$]/.test(c); }
}

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
}

export class CnoRepl {
    #history: string[] = [];
    #historyIndex = 0;
    #historyDraft = '';
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
    #stdin: CModuleStreams.Pipe | CModuleStreams.Stream;
    #stdout: CModuleStreams.Pipe | CModuleStreams.Stream;
    #isatty: boolean = false;
    #termWidth = 80;
    #termCursorX = 0;   // cursor X after prompt (start of input area)
    #inputRows = 0;     // rendered rows below the prompt line
    #cursorRow = 0;     // current cursor row below the prompt line

    // Configuration
    #config: {
        ps1: string; ps2: string; banner: string;
        showTime: boolean; hexMode: boolean; colors: boolean; utf8: boolean;
    };

    // Input handling
    #readlineResolver: ((value: string | null) => void) | null = null;
    #escState: 'normal' | 'esc' | 'csi' | 'osc' | 'paste' = 'normal';
    #escBuffer = '';
    #pasteBuffer = '';
    #inPasteMode = false;

    constructor(opts: CnoReplOptions = {}) {
        this.#transform = opts.transform ?? ((c) => c);
        this.#config = {
            ps1: opts.ps1 ?? getenv('REPL_PS1') ?? 'cno > ',
            ps2: opts.ps2 ?? getenv('REPL_PS2') ?? '  ... ',
            banner: opts.banner ?? 'cno REPL. enter ".help" for help.\n',
            showTime: false,
            hexMode: false,
            colors: true,
            utf8: true,
        };
        // Set up stdout: use TTY for terminal, Pipe for redirection
        if (os.guessHandle(os.STDOUT_FILENO) === 'tty') {
            this.#stdout = new streams.TTY(os.STDOUT_FILENO, false);
        } else {
            const pipe = new streams.Pipe();
            pipe.open(os.STDOUT_FILENO);
            this.#stdout = pipe as unknown as CModuleStreams.Stream;
        }

        if (os.guessHandle(os.STDIN_FILENO) === 'tty') {
            const stdin = this.#stdin = new streams.TTY(os.STDIN_FILENO, true);
            stdin.mode = streams.TTY_MODE_RAW_VT;
            this.#isatty = true;
            this.#refreshTermWidth();
        } else {
            const pipe = new streams.Pipe();
            pipe.open(os.STDIN_FILENO);
            this.#stdin = pipe;
            console.warn('stdin is not a TTY, some features may not work');
        }

        // Cleanup on exit
        this.#onExit(() => {
        // Disable bracketed paste mode before exiting
            if (this.#isatty) {
                sfs.write(os.STDOUT_FILENO, engine.encodeString('\x1b[?2004l'));
                (this.#stdin as CModuleStreams.TTY).mode = streams.TTY_MODE_NORMAL;
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
        try {
            while (this.#running) {
                const line = await this.#readLine();
                if (line === null) {
                    // null means cancelled (Ctrl+C) — just loop for next line
                    if (!this.#running) break;
                    continue;
                }
                await this.#handleCommand(line);
            }
        } catch (e) {
            this.#printError(e);
        }
    }

    async #readLine(): Promise<string | null> {
        this.#cmd = '';
        this.#cursorPos = 0;
        this.#historyIndex = this.#history.length;
        this.#historyDraft = '';
        this.#inputRows = 0;
        this.#cursorRow = 0;
        // Start fresh on a new line — no matter where external output left the cursor
        this.#printPrompt();
        this.#flush();
        return new Promise((resolve) => {
            this.#readlineResolver = resolve;
        });
    }

    // Pending async command queue — ensures onread callbacks are serialised
    #cmdQueue: Promise<void> = Promise.resolve();

    async #readInput(): Promise<void> {
        this.#stdin.onread = (res: null | undefined | Uint8Array, err: undefined | CModuleError.Error) => {
            if (!res) {
                console.error('Failed to read from console:', err ?? 'EOF');
                this.cleanup();
                os.exit(1);
                throw 0;    // fallback
            }
            const bytes = res.slice(); // copy before async gap
            this.#cmdQueue = this.#cmdQueue.then(async () => {
                for (let i = 0; i < bytes.length && this.#running; i++)
                    this.#handleByte(bytes[i]!);
                if (!this.#running) this.#stdin.stopRead();
            });
        };
        this.#stdin.startRead();
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
            this.#cmdQueue = this.#cmdQueue.then(() => this.#update());
            return;
        }

        const cmd = this.#keyMap.get(char);
        if (cmd) {
            this.#cmdQueue = this.#cmdQueue.then(() => this.#executeCommand(cmd, char));
        } else if ([...char].length === 1 && char >= ' ') {
            this.#insert(char);
            this.#cmdQueue = this.#cmdQueue.then(() => this.#update());
        } else {
            this.#alert();
        }
    }

    #processEscSequence(seq: string): void {
        const cmd = this.#keyMap.get(seq) ?? this.#keyMap.get(seq.slice(1));
        if (cmd) {
            this.#cmdQueue = this.#cmdQueue.then(() => this.#executeCommand(cmd, seq));
        } else {
            this.#alert();
        }
    }

    async #executeCommand(cmd: KeyCommand, input: string): Promise<void> {
        this.#lastCommand = input;
        const result = await cmd.call(this, input);

        switch (result?.type) {
            case 'submit':
                this.#historyIndex = this.#history.length;
                if (this.#readlineResolver) {
                    const resolver = this.#readlineResolver;
                    this.#readlineResolver = null;
                    resolver(result.value);
                }
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
                if (this.#readlineResolver) {
                    this.#readlineResolver(null);
                }
                this.cleanup();
                os.exit(0);
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
        if (this.#cmd.length && this.#history[this.#history.length - 1] !== this.#cmd) {
            this.#history.push(this.#cmd);
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
        const pos = this.#cursorPos === this.#cmd.length ? this.#cursorPos - 1 : this.#cursorPos;
        const chars = [...this.#cmd];
        [chars[pos - 1], chars[pos]] = [chars[pos]!, chars[pos - 1]!];
        this.#cmd = chars.join('');
        this.#cursorPos = pos + 1;
    }

    #prevHistory(): void {
        if (this.#historyIndex > 0) {
            if (this.#historyIndex === this.#history.length) {
                this.#historyDraft = this.#cmd;
            }
            this.#historyIndex--;
            this.#cmd = this.#history[this.#historyIndex] ?? '';
            this.#cursorPos = this.#cmd.length;
        }
    }

    #nextHistory(): void {
        if (this.#historyIndex < this.#history.length) {
            this.#historyIndex++;
            this.#cmd = this.#historyIndex === this.#history.length
                ? this.#historyDraft
                : this.#history[this.#historyIndex] ?? '';
            this.#cursorPos = this.#cmd.length;
        }
    }

    #complete(): void {
        const { completions, position } = this.#completer.getCompletions(this.#cmd, this.#cursorPos);

        if (completions.length === 0) {
            this.#alert();
            return;
        }

        // const word = this.#cmd.substring(this.#cursorPos - position, this.#cursorPos);
        let common = completions[0]!;

        for (let i = 1; i < completions.length; i++) {
            let j = position;
            while (j < common.length && j < completions[i]!.length && common[j] === completions[i]![j]) {
                j++;
            }
            common = common.substring(0, j);
        }

        if (common.length > position) {
            for (let i = position; i < common.length; i++) {
                this.#insert(common[i]!);
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
                    const item = list[idx]!;
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
        while (pos < this.#cmd.length && !this.#isWordChar(this.#cmd[pos]!)) pos++;
        while (pos < this.#cmd.length && this.#isWordChar(this.#cmd[pos]!)) pos++;
        return pos;
    }

    #skipWordBack(pos: number): number {
        while (pos > 0 && !this.#isWordChar(this.#cmd[pos - 1]!)) pos--;
        while (pos > 0 && this.#isWordChar(this.#cmd[pos - 1]!)) pos--;
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
            const out = this.#stdout as any;
            const size = out.size ?? out.getWindowSize?.() ?? out.getwinsize?.();
            const width = Array.isArray(size) ? size[0] : (size?.width ?? size?.columns);
            if (Number.isInteger(width) && width > 0) this.#termWidth = width;
        } catch {}
    }

    #displayWidth(str: string): number {
        let width = 0;
        for (const ch of str) {
            const cp = ch.codePointAt(0)!;
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
            this.#print(str[i]!);
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
        if (highlight.state || highlight.level > 0) {
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
                await import(file.endsWith('.js') ? file : file + '.js');
                return false;
            case 'x': this.#config.hexMode = true; return false;
            case 'd': this.#config.hexMode = false; return false;
            case 't': this.#config.showTime = !this.#config.showTime; return false;
            case 'c': case 'clear':
                this.#print('\x1b[H\x1b[J');
                this.#flush();
                return false;
            case 'q':
                this.#running = false;
                this.cleanup();
                os.exit(0); // avoid blocking
                return false;
            case 'u':
                rest = rest.trim();
                // @ts-ignore
                globalThis[rest] = import.meta.use(rest);
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
            const result = (await engine.eval<any>(code, '<eval>', engine.EVAL_ASYNC | engine.EVAL_NEW_BACKTRACE)).value;

            if (this.#config.showTime) {
                this.#config.showTime = false;
            }

            this.#print(COLOR.brightWhite);
            this.#flush();
            if (this.#config.hexMode && (typeof result === 'number' || typeof result === 'bigint')) {
                const hex = typeof result === 'bigint'
                    ? '0x' + result.toString(16)
                    : '0x' + Math.floor(result).toString(16);
                this.#print(hex + (typeof result === 'bigint' ? 'n' : ''));
            } else {
                console.log(result);
            }
            this.#print(COLOR.reset + '\n');
            this.#flush();

            // @ts-ignore
            globalThis._ = result;
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
            `.h          this help\n` +
            `.x         ${sel(this.#config.hexMode)} hexadecimal number display\n` +
            `.d         ${sel(!this.#config.hexMode)} decimal number display\n` +
            `.t         ${sel(this.#config.showTime)} toggle timing display\n` +
            `.u          use a built-in c-module and save it to globalThis\n` +
            `.c          clear the terminal\n` +
            `.q          exit`
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
        this.#print(COLOR.brightRed);
        if (!(err instanceof Error)) this.#print('Throw: ');
        this.#flush();
        console.log(err);
        this.#print(COLOR.reset + '\n');
        this.#flush();
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
        this.#historyIndex = this.#history.length;
        this.#historyDraft = '';
        this.#inputRows = 0;
        this.#cursorRow = 0;
        this.#flush();
    }

    exportHistory() {
        return this.#history;
    }

    importHistory(history: string[]) {
        this.#history = history;
        this.#historyIndex = this.#history.length;
        this.#historyDraft = '';
    }
}
