/** REPL syntax highlight styles and ANSI helpers. */
export type TokenStyle =
    | 'comment' | 'string' | 'regex' | 'number' | 'keyword'
    | 'function' | 'type' | 'identifier' | 'error' | 'default'
    | 'directive';

export interface HighlightResult {
    state: string;
    level: number;
    invalid: boolean;
    styles: TokenStyle[];
}

export const COLOR = {
    reset: '\x1b[0m',
    black: '\x1b[30m', red: '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m',
    cyan: '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m',
    brightRed: '\x1b[91m', brightGreen: '\x1b[92m', brightYellow: '\x1b[93m',
    brightBlue: '\x1b[94m', brightMagenta: '\x1b[95m', brightCyan: '\x1b[96m',
    brightWhite: '\x1b[97m',
} as const;

export const STYLE_MAP: Record<TokenStyle, keyof typeof COLOR> = {
    default: 'brightGreen', comment: 'gray', string: 'brightCyan',
    regex: 'cyan', number: 'green', keyword: 'brightWhite',
    function: 'brightYellow', type: 'brightMagenta', identifier: 'brightGreen',
    error: 'red', directive: 'gray'
};
