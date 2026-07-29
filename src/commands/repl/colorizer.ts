/** Incremental JS/TS highlighter for incomplete REPL input. */
import type { TokenStyle, HighlightResult } from './types';

export class JSColorizer {
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
    #invalid = false;
    #canBeRegex = true;
    #currentStyle: TokenStyle | null = null;

    colorize(input: string, state = '', level = 0): HighlightResult {
        this.#str = input;
        this.#index = 0;
        this.#length = input.length;
        this.#stateStack = state;
        this.#braceLevel = level;
        this.#invalid = false;
        this.#canBeRegex = true;
        this.#styles = [];

        while (this.#index < this.#length) {
            this.#currentStyle = null;
            this.#start = this.#index;
            const char = this.#str[this.#index++];
            if (char === undefined) break;

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
                    this.#invalid = true;
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
        return {
            state: this.#stateStack,
            level: this.#braceLevel,
            invalid: this.#invalid,
            styles: this.#styles,
        };
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
        let closed = false;
        for (this.#index++; this.#index < this.#length; this.#index++) {
            if (this.#str[this.#index] === '*' && this.#str[this.#index + 1] === '/') {
                this.#index += 2;
                this.#popState();
                closed = true;
                break;
            }
        }
        if (!closed) this.#index = this.#length;
    }

    #parseLineComment() {
        this.#currentStyle = 'comment';
        for (this.#index++; this.#index < this.#length && this.#str[this.#index] !== '\n'; this.#index++);
    }

    #parseString(delim: string) {
        this.#currentStyle = 'string';
        const stateLength = this.#stateStack.length;
        this.#pushState(delim);
        let closed = false;
        while (this.#index < this.#length) {
            const c = this.#str[this.#index++];
            if (c === '\n' && delim !== '`') {
                this.#invalid = true;
                this.#currentStyle = 'error';
                continue;
            }
            if (c === '\\') {
                if (this.#index < this.#length) this.#index++;
            } else if (c === delim) {
                this.#popState();
                closed = true;
                break;
            }
        }
        if (!closed && delim !== '`') {
            this.#stateStack = this.#stateStack.slice(0, stateLength);
            this.#invalid = true;
            this.#currentStyle = 'error';
        }
    }

    #parseRegex() {
        this.#currentStyle = 'regex';
        const stateLength = this.#stateStack.length;
        this.#pushState('/');
        let closed = false;
        while (this.#index < this.#length) {
            const c = this.#str[this.#index++];
            if (c === '\n') {
                this.#invalid = true;
                this.#currentStyle = 'error';
                continue;
            }
            if (c === '\\') {
                if (this.#index < this.#length) this.#index++;
                continue;
            }
            if (this.#lastState() === '[') {
                if (c === ']') this.#popState();
                continue;
            }
            if (c === '[') {
                this.#pushState('[');
                if (this.#peek() === '[' || this.#peek() === ']') this.#index++;
                continue;
            }
            if (c === '/') {
                this.#popState();
                while (this.#index < this.#length && this.#isWordChar(this.#str[this.#index] ?? '')) this.#index++;
                closed = true;
                break;
            }
        }
        if (!closed) {
            this.#stateStack = this.#stateStack.slice(0, stateLength);
            this.#invalid = true;
            this.#currentStyle = 'error';
        }
    }

    #parseNumber() {
        this.#currentStyle = 'number';
        while (this.#index < this.#length) {
            const c = this.#str[this.#index];
            if (c === undefined) break;
            if (this.#isWordChar(c) || c === '.' || c === '+' || c === '-') {
                if (c === '.' && (this.#index === this.#length - 1 || this.#str[this.#index + 1] === '.')) break;
                this.#index++;
            } else break;
        }
    }

    #parseIdentifier() {
        if (this.#start > 0 && this.#str[this.#start - 1] === '.' && this.#braceLevel === 0) {
            this.#canBeRegex = true;
            while (this.#index < this.#length && this.#isWordChar(this.#str[this.#index] ?? '')) this.#index ++;

            const word = this.#str.substring(this.#start, this.#index);
            if (JSColorizer.#DIRECTIVES.has(word)) {
                this.#currentStyle = 'directive';
                return;
            }
            this.#index = this.#start;
        }

        // Check for keywords
        this.#canBeRegex = true;
        while (this.#index < this.#length && this.#isWordChar(this.#str[this.#index] ?? '')) this.#index++;

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
