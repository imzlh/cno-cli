import type { TokenStyle } from './types';
import { COLOR, STYLE_MAP } from './types';
import type { JSColorizer } from './colorizer';
import type { CompletionEngine } from './completion';
import type { HistoryStore } from './history';
import { openReplInput, openReplOutput } from './file-stdio';
import type { ReplInputHandle, ReplOutputHandle } from './file-stdio';

// ==================== Types ====================

export type KeyCommand = () => Promise<EditorCommandResult | void> | EditorCommandResult | void;

export type TerminalSize =
    | { width?: number; columns?: number }
    | [number, number];

export interface ResizableOutput {
    readonly size?: TerminalSize;
    getWindowSize?: () => TerminalSize;
    getwinsize?: () => TerminalSize;
}

function isResizableOutput(value: unknown): value is ResizableOutput {
    if (value === null || typeof value !== 'object') return false;
    return 'size' in value || 'getWindowSize' in value || 'getwinsize' in value;
}

export type EditorCommandResult =
    | { type: 'continue' }
    | { type: 'submit'; value: string }
    | { type: 'cancel' }
    | { type: 'exit' };

/**
 * Editor-side access to the session: presentation state, output and history.
 */
export interface LineEditorHost {
    readonly config: { ps1: string; ps2: string; colors: boolean; showTime: boolean };
    readonly history: HistoryStore;
    readonly colorizer: JSColorizer;
    readonly completer: CompletionEngine;
    /** Lines accumulated for an unfinished expression, and its lexer state. */
    readonly multilineText: string;
    readonly braceLevel: number;
    readonly pstate: string;

    /** True inside a read chunk; key commands run from the queue instead. */
    readonly processingInput: boolean;
    get commandQueue(): Promise<void>;
    set commandQueue(queue: Promise<void>);
    readonly syncKeyCommands: Array<{ cmd: KeyCommand; input: string }>;
    executeKeyCommand(cmd: KeyCommand, input: string): Promise<EditorCommandResult | void>;
    ctrlC(): void;

    print(str: string): void;
    writeSync(data: Uint8Array): void;
    flush(): void;
}

type RawInput = CModuleStreams.Pipe | CModuleStreams.Stream | ReplInputHandle;
type RawOutput = CModuleStreams.Pipe | CModuleStreams.Stream | ReplOutputHandle;

export interface LineEditorOptions {
    tty: boolean;
}

// ==================== Line Editor ====================

export class LineEditor {
    #host: LineEditorHost;
    #tty: boolean;

    #cmd = '';
    #cursorPos = 0;
    #clipboard = '';
    #quoteFlag = false;

    #stdin: RawInput;
    #stdout: RawOutput;
    #stdoutIsatty: boolean = false;
    #termWidth = 80;
    #termCursorX = 0;   // cursor X after prompt (start of input area)
    #inputRows = 0;     // rendered rows below the prompt line
    #cursorRow = 0;     // current cursor row below the prompt line

    #keyMap: Map<string, KeyCommand>;
    #lastCommand = '';
    #utf8Remaining = 0;
    #utf8Acc = 0;
    #escState: 'normal' | 'esc' | 'csi' | 'osc' | 'paste' = 'normal';
    #escBuffer = '';
    #pasteBuffer = '';
    #inPasteMode = false;

    constructor(host: LineEditorHost, opts: LineEditorOptions) {
        this.#host = host;
        this.#tty = opts.tty;
        const os = import.meta.use('os');
        const streams = import.meta.use('streams');
        if (os.guessHandle(os.STDOUT_FILENO) === 'tty') {
            this.#stdout = new streams.TTY(os.STDOUT_FILENO, false) as RawOutput;
            this.#stdoutIsatty = true;
        } else {
            this.#stdout = openReplOutput(os.STDOUT_FILENO);
        }
        if (opts.tty) {
            const stdin = new streams.TTY(os.STDIN_FILENO, true);
            stdin.mode = streams.TTY_MODE_RAW_VT;
            this.#stdin = stdin;
            this.#refreshTermWidth();
        } else {
            this.#stdin = openReplInput(os.STDIN_FILENO);
        }
        this.#keyMap = this.#createKeyMap();
    }

    get stdin(): RawInput { return this.#stdin; }
    get command(): string { return this.#cmd; }

    // ==================== Line State ====================

    beginLine(): void {
        this.#cmd = '';
        this.#cursorPos = 0;
        this.#host.history.resetCursor();
        this.#inputRows = 0;
        this.#cursorRow = 0;
        // Start fresh on a new line — no matter where external output left the cursor
        this.#printPrompt();
        this.#host.flush();
    }

    clearLine(): void {
        this.#cmd = '';
        this.#cursorPos = 0;
    }

    setPasteMode(on: boolean): void {
        this.#inPasteMode = on;
        if (!on) this.#pasteBuffer = '';
    }

    setTerminalMode(mode: number): void {
        try {
            (this.#stdin as CModuleStreams.TTY).mode = mode;
        } catch {}
    }

    /** Erase the current input, then write `message` in its place. */
    cancelInput(message: string): void {
        const rowsToStart = Math.max(this.#cursorRow, this.#inputRows);
        if (rowsToStart > 0) this.#host.print(`\x1b[${rowsToStart}A`);
        this.#host.print('\r\x1b[J' + message);
        this.#cmd = '';
        this.#cursorPos = 0;
        this.#host.history.resetCursor();
        this.#inputRows = 0;
        this.#cursorRow = 0;
        this.#host.flush();
    }

    // ==================== Raw Input ====================

    readBytes(bytes: Uint8Array): void {
        for (let i = 0; i < bytes.length; i++) {
            const byte = bytes[i];
            if (byte !== undefined) this.#handleByte(byte);
        }
    }

    #handleByte(byte: number): void {
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
            this.#scheduleUpdate();
            return;
        }

        const cmd = this.#keyMap.get(char);
        if (cmd) {
            this.#queueKeyCommand(cmd, char);
        } else if ([...char].length === 1 && char >= ' ') {
            this.#insert(char);
            this.#scheduleUpdate();
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
        if (this.#host.processingInput) {
            this.#host.syncKeyCommands.push({ cmd, input });
            return;
        }
        this.#host.commandQueue = this.#host.commandQueue.then(async () => { await this.#host.executeKeyCommand(cmd, input); });
    }

    /** Run a key command, remembering it for the "show completions" retry. */
    async executeKeyCommand(cmd: KeyCommand, input: string): Promise<EditorCommandResult | void> {
        const previousValue = this.#cmd;
        const result = await cmd();
        this.#lastCommand = input === '\t' && this.#cmd !== previousValue ? '' : input;
        return result;
    }

    // ==================== Key Commands ====================

    #createKeyMap(): Map<string, KeyCommand> {
        return new Map<string, KeyCommand>([
            ['\x01', () => { this.#cursorPos = 0; }],                    // ^A
            ['\x02', () => this.#moveCursor(-1)],                         // ^B
            ['\x03', () => {                                              // ^C
                this.#host.ctrlC();
                return { type: 'continue' } as const;
            }],
            ['\x04', async () => {                                        // ^D
                if (this.#cmd.length === 0) return { type: 'exit' } as const;
                this.#deleteChar(1);
            }],
            ['\x05', () => { this.#cursorPos = this.#cmd.length; }],      // ^E
            ['\x06', () => this.#moveCursor(1)],                          // ^F
            ['\x07', () => { }],                                          // ^G
            ['\x08', () => this.#deleteChar(-1)],                         // ^H
            ['\x7f', () => this.#deleteChar(-1)],
            ['\t', () => this.#complete()],                               // Tab
            ['\n', () => this.#submitLine()],                             // ^J
            ['\x0b', () => {                                              // ^K
                this.#clipboard = this.#cmd.slice(this.#cursorPos);
                this.#cmd = this.#cmd.slice(0, this.#cursorPos);
            }],
            ['\x0d', () => this.#submitLine()],                           // ^M
            ['\x0e', () => this.#nextHistory()],                           // ^N
            ['\x10', () => this.#prevHistory()],                           // ^P
            ['\x11', () => { this.#quoteFlag = true; }],                  // ^Q
            ['\x14', () => this.#transpose()],                             // ^T
            ['\x18', () => { this.#cmd = ''; this.#cursorPos = 0; }],      // ^X
            ['\x19', () => this.#insert(this.#clipboard)],                 // ^Y
            // Arrow keys
            ['\x1b[A', () => this.#prevHistory()],
            ['\x1b[B', () => this.#nextHistory()],
            ['\x1b[C', () => this.#moveCursor(1)],
            ['\x1b[D', () => this.#moveCursor(-1)],
            ['\x1b[H', () => { this.#cursorPos = 0; }],                    // Home
            ['\x1b[F', () => { this.#cursorPos = this.#cmd.length; }],     // End
            ['\x1b[3~', () => this.#deleteChar(1)],                        // Delete
            // Word navigation
            ['\x1bb', () => { this.#cursorPos = this.#skipWordBack(this.#cursorPos); }],
            ['\x1bf', () => { this.#cursorPos = this.#skipWordForward(this.#cursorPos); }],
            ['\x1b[1;5D', () => { this.#cursorPos = this.#skipWordBack(this.#cursorPos); }],  // Ctrl-Left
            ['\x1b[1;5C', () => { this.#cursorPos = this.#skipWordForward(this.#cursorPos); }], // Ctrl-Right
            // Kill operations
            ['\x1bd', () => {                                              // M-d
                const end = this.#skipWordForward(this.#cursorPos);
                this.#clipboard = this.#cmd.slice(this.#cursorPos, end);
                this.#cmd = this.#cmd.slice(0, this.#cursorPos) + this.#cmd.slice(end);
            }],
            ['\x1b\x7f', () => {                                           // M-Backspace
                const start = this.#skipWordBack(this.#cursorPos);
                this.#clipboard = this.#cmd.slice(start, this.#cursorPos);
                this.#cmd = this.#cmd.slice(0, start) + this.#cmd.slice(this.#cursorPos);
                this.#cursorPos = start;
            }],
        ]);
    }

    #submitLine(): EditorCommandResult | void {
        if (this.#inPasteMode) {
            this.#insert('\n');
            return;
        }
        // Move cursor to end of input, then newline — so prompt clears from correct position
        this.#cursorPos = this.#cmd.length;
        this.#update();
        this.#host.print('\n');
        this.#host.flush();
        this.#inputRows = 0;
        this.#cursorRow = 0;
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
        const line = this.#host.history.prev(this.#cmd);
        if (line === null) return;
        this.#cmd = line;
        this.#cursorPos = this.#cmd.length;
    }

    #nextHistory(): void {
        const line = this.#host.history.next();
        if (line === null) return;
        this.#cmd = line;
        this.#cursorPos = this.#cmd.length;
    }

    #complete(): void {
        const { completions, position } = this.#host.completer.getCompletions(this.#cmd, this.#cursorPos);

        if (completions.length === 0) {
            this.#alert();
            return;
        }

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

        this.#host.print('\n');
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
            this.#host.print(line.join('') + '\n');
        }
        this.#printPrompt();
        this.#host.print(this.#cmd);
        this.#host.flush();
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

    #scheduleUpdate(): void {
        if (this.#host.processingInput) this.#update();
        else this.#host.commandQueue = this.#host.commandQueue.then(() => this.#update());
    }

    #printPrompt(): void {
        this.#refreshTermWidth();
        const config = this.#host.config;
        const timeStr = config.showTime ? `${(Date.now() / 1000).toFixed(6)} ` : '';
        const prompt = this.#host.multilineText
            ? ' '.repeat(this.#displayWidth(config.ps1)) + config.ps2
            : timeStr + config.ps1;
        this.#host.print(prompt);
        this.#termCursorX = this.#displayWidth(prompt) % this.#termWidth;
    }

    /** Repaint the line in place, as after a key command. */
    render(): void {
        this.#update();
    }

    #update(): void {
        // Piped input has no cursor to repaint.
        if (!this.#tty) return;

        this.#moveToStart();

        if (this.#host.config.colors) {
            const fullExpr = this.#host.multilineText
                ? this.#host.multilineText + '\n' + this.#cmd
                : this.#cmd;
            const startOffset = fullExpr.length - this.#cmd.length;
            const { styles } = this.#host.colorizer.colorize(fullExpr, this.#host.pstate, this.#host.braceLevel);
            this.#printHighlighted(fullExpr.slice(startOffset), styles.slice(startOffset));
        } else {
            this.#host.print(this.#cmd);
        }

        this.#host.print('\x1b[J');

        const cursorCells = this.#displayWidth(this.#cmd.slice(0, this.#cursorPos));
        const absCol = this.#termCursorX + cursorCells;
        const cursorRow = Math.floor(absCol / this.#termWidth);
        const cursorCol = absCol % this.#termWidth;

        const totalCells = this.#termCursorX + this.#displayWidth(this.#cmd);
        this.#inputRows = Math.floor(totalCells / this.#termWidth);
        this.#cursorRow = cursorRow;

        if (this.#inputRows > cursorRow) this.#host.print(`\x1b[${this.#inputRows - cursorRow}A`);
        this.#host.print(`\x1b[${cursorCol + 1}G`);

        this.#host.flush();
    }

    #moveToStart(): void {
        if (this.#cursorRow > 0) this.#host.print(`\x1b[${this.#cursorRow}A`);
        this.#host.print('\r\x1b[J');
        this.#inputRows = 0;
        this.#cursorRow = 0;
        this.#printPrompt();
    }

    #refreshTermWidth(): void {
        if (!this.#tty) return;
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
                if (currentStyle) this.#host.print(COLOR.reset);
                if (style !== 'default') this.#host.print(COLOR[STYLE_MAP[style]]);
                currentStyle = style;
            }
            const ch = str[i];
            if (ch !== undefined) this.#host.print(ch);
        }
        if (currentStyle) this.#host.print(COLOR.reset);
    }

    #alert(): void {
        this.#host.writeSync(new Uint8Array([0x07]));
    }

    #isWordChar(c: string) { return /[a-zA-Z0-9_$]/.test(c); }
    #isTrailingSurrogate(c?: string) {
        const code = c?.codePointAt(0);
        return code !== undefined && code >= 0xdc00 && code < 0xe000;
    }
}
