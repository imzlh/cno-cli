const os = import.meta.use('os');
const console = import.meta.use('console');
import { SUBCOMMANDS as SUBCOMMAND_LIST, type Args, type Subcommand as CnoSubcommand } from '../cno/src/utils/args';

/** A subcommand name, or null when the first non-flag token is a file path. */
export type Subcommand = CnoSubcommand | null;

export interface ParsedCli {
    /** Subcommand name, or null if the first non-flag token is a file path. */
    cmd: Subcommand;
    /** Positional args after the subcommand. */
    positional: string[];
    /** Parsed flags, as a flat record. */
    flags: Record<string, string | boolean>;
    /** Raw argv shape for runtime argv reconstruction. */
    rawArgs: Args;
}

const SUBCOMMANDS = new Set<string>(SUBCOMMAND_LIST);

function isSubcommand(value: string): value is CnoSubcommand {
    return SUBCOMMANDS.has(value);
}

const ALIASES: Partial<Record<string, CnoSubcommand>> = {
    '-h': 'help',
    '--help': 'help',
    '-v': 'version',
    '--version': 'version',
    '-e': 'eval',
};

/**
 * Flags cno actually honors. Anything not in this set and not in
 * DENO_NOOP_FLAGS triggers a stderr warning so users notice silent typos.
 */
const KNOWN_FLAGS = new Set<string>([
    // run / eval / cache
    'cache-dir', 'lock-dir', 'no-lock', 'frozen', 'disable-cache',
    'no-http', 'no-jsr', 'no-node', 'no-oxc', 'ignore-scripts',
    'npm-mode', 'polyfill', 'ext', 'cwd',
    'reload', 'r', 'precache', 'env', 'env-file', 'preload',
    // test
    'concurrency', 'filter', 'fail-fast', 'permit-no-files',
    // misc
    'silent', 'q', 'print', 'p',
    'system-proxy', 'skip-cert-verify',
    'memory-limit', 'max-stack-size',
    'inspect', 'inspect-brk', 'inspect-wait',
    'require', 'import', 'loader',
    // resource limits inherited from cts
    'allow-all', 'A',
    // shorthand aliases & subcommand-like flags handled in parser
    'eval', 'help', 'h', 'version', 'v',
]);

/**
 * Deno flags we recognise but intentionally don't implement. Silently
 * accepted so deno scripts can be run unmodified. Add aliases freely.
 */
const DENO_NOOP_FLAGS = new Set<string>([
    // permissions — cno has no permission system yet, allow everything
    'allow-net', 'allow-read', 'allow-write', 'allow-env',
    'allow-run', 'allow-ffi', 'allow-sys', 'allow-import',
    'deny-net', 'deny-read', 'deny-write', 'deny-env',
    'deny-run', 'deny-ffi', 'deny-sys', 'deny-import',
    'no-prompt',
    // version channel / experimental
    'unstable', 'unstable-bare-node-builtins', 'unstable-byonm',
    'unstable-sloppy-imports', 'unstable-workspaces', 'unstable-detect-cjs',
    // type checking — cts always transpiles, never type-checks
    'check', 'no-check',
    // logging / output (we have our own)
    'log-level', 'quiet',
    // network / cert (delegated to underlying fetch impl)
    'cert', 'cached-only',
    // import map (cts uses its own config)
    'import-map', 'no-config', 'config',
    // locking
    'no-remote', 'lock', 'lock-write',
    // misc deno features we just ignore
    'v8-flags',
    'seed', 'location', 'no-npm',
    // Node runtime flags accepted for process.execPath compatibility.
    'conditions', 'C', 'no-warnings', 'max-old-space-size',
]);

const VALUE_FLAGS = new Set<string>([
    'cache-dir', 'lock-dir', 'npm-mode', 'polyfill', 'ext', 'cwd',
    'memory-limit', 'max-stack-size', 'concurrency', 'filter',
    'cert', 'config', 'import-map', 'lock', 'location', 'log-level',
    'seed', 'v8-flags',
    'require', 'import', 'loader', 'env', 'env-file', 'preload',
    'conditions', 'max-old-space-size',
]);

const NODE_RUNTIME_VALUE_FLAGS = new Set<string>(['require', 'import', 'loader', 'conditions', 'max-old-space-size']);
const NODE_INSPECT_FLAGS = new Set<string>(['inspect', 'inspect-brk', 'inspect-wait']);

function isRecognizedOptionToken(token: string): boolean {
    if (token.startsWith('--')) {
        const eq = token.indexOf('=');
        const name = token.slice(2, eq === -1 ? undefined : eq);
        return KNOWN_FLAGS.has(name) || DENO_NOOP_FLAGS.has(name);
    }
    if (!token.startsWith('-') || token.length <= 1) return false;
    const name = token.slice(1);
    if (ALIASES[token] || name === 'r' || name === 'q' || name === 'A') return true;
    return KNOWN_FLAGS.has(name) || DENO_NOOP_FLAGS.has(name);
}

function shouldConsumeValueFlagToken(token: string | undefined): token is string {
    if (token === undefined) return false;
    if (!token.startsWith('-')) return true;
    return !isRecognizedOptionToken(token);
}

function isAsciiDigit(code: number): boolean {
    return code >= 48 && code <= 57;
}

function isInspectHostChar(code: number): boolean {
    return isAsciiDigit(code) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        code === 45 ||
        code === 46;
}

function isInspectValueToken(token: string | undefined): token is string {
    if (token === undefined || token.length === 0) return false;
    let colon = -1;
    for (let i = 0; i < token.length; i++) {
        const code = token.charCodeAt(i);
        if (code === 58) {
            if (colon !== -1 || i === 0 || i === token.length - 1) return false;
            colon = i;
            continue;
        }
        if (colon === -1) {
            if (!isAsciiDigit(code) && !isInspectHostChar(code)) return false;
        } else if (!isAsciiDigit(code)) return false;
    }
    if (colon === -1) {
        for (let i = 0; i < token.length; i++) {
            if (!isAsciiDigit(token.charCodeAt(i))) return false;
        }
    }
    return true;
}

function appendTokens(target: string[], source: string[]): string[] {
    for (let i = 0; i < source.length; i++) target.push(source[i]!);
    return target;
}

function splitNodeRuntimeTokens(tokens: string[], inspectWithoutValueIsInternal = false): { internal: string[]; rest: string[] } {
    const internal: string[] = [];
    const rest: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === undefined) break;
        if (token === '-C') {
            internal.push(token);
            if (tokens[i + 1] !== undefined) {
                internal.push(tokens[i + 1]!);
                i++;
            }
            continue;
        }
        if (!token.startsWith('--')) {
            rest.push(token);
            continue;
        }
        const eq = token.indexOf('=');
        const name = token.slice(2, eq === -1 ? undefined : eq);
        if (NODE_INSPECT_FLAGS.has(name)) {
            if (eq !== -1) {
                internal.push(token);
            } else {
                const next = tokens[i + 1];
                if (isInspectValueToken(next)) {
                    internal.push(token, next);
                    i++;
                } else if (inspectWithoutValueIsInternal) internal.push(token);
                else rest.push(token);
            }
            continue;
        }
        if (!NODE_RUNTIME_VALUE_FLAGS.has(name)) {
            rest.push(token);
            continue;
        }
        internal.push(token);
        if (eq === -1 && tokens[i + 1] !== undefined) {
            internal.push(tokens[i + 1]);
            i++;
        }
    }
    return { internal, rest };
}

/**
 * Parse cno's argv.
 *
 *   cno run foo.ts a b      → { cmd:'run',  positional:['foo.ts','a','b'] }
 *   cno foo.ts a b          → { cmd:null,   positional:['foo.ts','a','b'] }  (implicit run)
 *   cno task build          → { cmd:'task', positional:['build'] }
 *   cno -h                  → { cmd:'help', positional:[] }
 *   cno --eval 'code'       → { cmd:'eval', positional:['code'] }
 *   cno -e 'code'           → { cmd:'eval', positional:['code'] }
*/
export function parseArgv(argv: string[]): ParsedCli {
    const flags: Record<string, string | boolean> = {};
    let cmd: Subcommand = null;
    const positional: string[] = [];
    const preCommandTokens: string[] = [];
    const actionTokens: string[] = [];
    let i = 0;

    // First non-flag token decides the subcommand.
    let cmdDecided = false;
    // After the script path (first positional after cmd) is found,
    // stop parsing flags — remaining tokens are forwarded to the script.
    let fileFound = false;

    function pushRawTokens(...tokens: string[]): void {
        if (fileFound) return;
        if (!cmdDecided) preCommandTokens.push(...tokens);
        else actionTokens.push(...tokens);
    }

    function shouldStopParsingFlagsAfterPositional(): boolean {
        return cmd === null || cmd === 'run';
    }

    function consumeEvalAlias(print: boolean): void {
        if (print) flags['print'] = true;
        cmd = 'eval';
        cmdDecided = true;
        const value = argv[i + 1];
        if (value !== undefined) {
            positional.push(value);
            i += 2;
        } else {
            i++;
        }
    }

    while (i < argv.length) {
        const a = argv[i];
        if (a === undefined) break;

        // Once the run script file has been seen, collect everything as positional.
        if (fileFound) {
            positional.push(a);
            i++;
            continue;
        }

        // End of cno option parsing. Everything after this belongs to the
        // selected command; the first token becomes the run/test/cache target.
        if (a === '--') {
            if (cmdDecided && cmd !== null && cmd !== 'run') {
                positional.push(a);
            } else if (!cmdDecided) {
                cmd = null;
                cmdDecided = true;
            }
            i++;
            while (i < argv.length) {
                const value = argv[i];
                if (value !== undefined) positional.push(value);
                i++;
            }
            break;
        }

        // -h / --help / -v / --version / -e are subcommand-like aliases
        const alias = ALIASES[a];
        if (!cmdDecided && alias) {
            if (alias === 'eval') consumeEvalAlias(false);
            else {
                cmd = alias;
                cmdDecided = true;
                i++;
            }
            continue;
        }

        if (!cmdDecided && (a === '-p' || a === '--print')) {
            consumeEvalAlias(true);
            continue;
        }

        if (!cmdDecided && a.startsWith('--eval=')) {
            cmd = 'eval';
            cmdDecided = true;
            positional.push(a.slice('--eval='.length));
            i++;
            continue;
        }

        // --flag=value
        if (a.startsWith('--') && a.includes('=')) {
            const eq = a.indexOf('=');
            const k  = a.slice(2, eq);
            const v  = a.slice(eq + 1);
            flags[k] = v;
            pushRawTokens(a);
            i++;
            continue;
        }

        // --flag (bool) — values must use --flag=value syntax
        if (a.startsWith('--')) {
            const k = a.slice(2);
            // Treat --eval as a value flag synonym for the subcommand.
            if (!cmdDecided && k === 'eval') {
                consumeEvalAlias(false);
                continue;
            }
            if (!cmdDecided && k === 'print') {
                consumeEvalAlias(true);
                continue;
            }
            const next = argv[i + 1];
            // --inspect and --inspect-brk/--inspect-wait: optional port/host:port value — only
            // consume the next token if it looks like a port number or host:port,
            // not if it's a file path or another flag.
            if (NODE_INSPECT_FLAGS.has(k)) {
                if (isInspectValueToken(next)) {
                    flags[k] = next;
                    pushRawTokens(a, next);
                    i += 2;
                } else {
                    flags[k] = true;
                    pushRawTokens(a);
                    i++;
                }
                continue;
            }
            if (VALUE_FLAGS.has(k) && shouldConsumeValueFlagToken(next)) {
                flags[k] = next;
                pushRawTokens(a, next);
                i += 2;
                continue;
            }
            flags[k] = true;
            pushRawTokens(a);
            i++;
            continue;
        }

        // -x short
        if (a.startsWith('-') && a.length > 1) {
            const k = a.slice(1);
            // -r is "reload"
            if (k === 'r')      { flags['reload'] = true; pushRawTokens(a); i++; continue; }
            if (k === 'q')      { flags['silent'] = true; pushRawTokens(a); i++; continue; }
            if (k === 'p')      { flags['print'] = true; pushRawTokens(a); i++; continue; }
            if (k === 'A')      { flags['allow-all'] = true; pushRawTokens(a); i++; continue; }
            if (!cmdDecided && (k === 'pe' || k === 'ep')) { consumeEvalAlias(true); continue; }
            if (k === 'C') {
                const next = argv[i + 1];
                if (shouldConsumeValueFlagToken(next)) {
                    flags['C'] = next;
                    pushRawTokens(a, next);
                    i += 2;
                } else {
                    flags['C'] = true;
                    pushRawTokens(a);
                    i++;
                }
                continue;
            }
            pushRawTokens(a);
            flags[k] = true;
            i++;
            continue;
        }

        // Positional
        if (!cmdDecided) {
            if (isSubcommand(a)) {
                cmd = a;
            } else {
                // Implicit `run` when first token is not a subcommand.
                cmd = null;
                positional.push(a);
                fileFound = true;   // script path collected — stop parsing flags
            }
            cmdDecided = true;
        } else {
            positional.push(a);
            if (!fileFound && shouldStopParsingFlagsAfterPositional()) {
                fileFound = true;
            }
        }
        i++;
    }

    const splitPreCommand = splitNodeRuntimeTokens(preCommandTokens, cmd === 'run');
    const splitAction = splitNodeRuntimeTokens(actionTokens, cmd === 'run');
    const runLike = cmd === null || cmd === 'run';
    const internalArgs = runLike
        ? appendTokens(splitPreCommand.internal.slice(), splitAction.internal)
        : preCommandTokens.slice();
    const actionArgs = cmd === null
        ? splitPreCommand.rest
        : cmd === 'run'
            ? appendTokens(splitPreCommand.rest.slice(), splitAction.rest)
            : actionTokens.slice();
    const rawArgs: Args = {
        binary: os.args[0],
        internalArgs,
        action: cmd ?? 'run',
        actionArgs,
        entry: positional[0] ?? 'repl',
        args: positional.length > 0 ? positional.slice(1) : [],
    };

    return { cmd, positional, flags, rawArgs };
}

/**
 * Warn (once, to stderr) about flags cno doesn't honor. Deno-compat no-op
 * flags are silently accepted; everything else gets a yellow ⚠ line so a
 * typo like `--frozenn` doesn't silently disable the intent.
 *
 * Returns the same parsed object for convenient chaining.
 */
export function warnUnknownFlags(cli: ParsedCli): ParsedCli {
    for (const k of Object.keys(cli.flags)) {
        if (KNOWN_FLAGS.has(k)) continue;
        if (DENO_NOOP_FLAGS.has(k)) continue;
        console.error(`cno: warning: unknown flag --${k} (ignored)`);
    }
    return cli;
}

/** Get argv passed to this cno invocation (skips the binary name). */
export function readArgv(): string[] {
    // os.args[0] is the binary path. Drop it.
    return os.args.slice(1);
}
