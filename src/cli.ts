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

// Flag-shaped shorthands (-h / -v / -e). Not listed in help either when they
// only mirror an existing subcommand name.
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
    'cache-dir', 'lock-dir', 'no-lock', 'frozen', 'disable-cache', 'cached-only',
    'no-http', 'no-jsr', 'no-node', 'no-oxc', 'ignore-scripts',
    'npm-mode', 'polyfill', 'ext', 'cwd',
    'reload', 'r', 'precache', 'env', 'env-file', 'preload',
    // serve
    'port', 'host',
    // pack
    'out', 'o',
    // test
    'concurrency', 'filter', 'fail-fast', 'permit-no-files',
    // task
    // --eval under `task` is ad-hoc shell (specs/task/eval); top-level --eval is subcommand
    // location is honored for Deno.location (--location=URL)
    'location',
    // misc
    'silent', 'q', 'print', 'p',
    'system-proxy', 'skip-cert-verify',
    'memory-limit', 'max-stack-size', 'max-old-space-size', 'v8-flags',
    'inspect', 'inspect-brk', 'inspect-wait',
    'require', 'import', 'loader', 'conditions', 'C',
    // resource limits inherited from cts
    'allow-all', 'A',
    // shorthand aliases & subcommand-like flags handled in parser
    'eval', 'help', 'h', 'version', 'v',
]);

// Tokenization needs one shared vocabulary because flags can precede the
// subcommand; validation below applies each command's supported subset.

/** Accepted by every subcommand: meta, plus the two dispatch-level toggles. */
const GLOBAL_FLAGS = new Set<string>([
    // main.ts:444-451 — checked before the subcommand switch.
    'help', 'h', 'version', 'v',
    // main.ts:481-495 — applied for every command, before dispatch.
    'system-proxy', 'skip-cert-verify',
    // Read by flagsToConfig/buildCacheConfig for the commands that build a
    // config, and harmless elsewhere; -q is the documented spelling.
    'silent', 'q',
]);

const RUNTIME_CONFIG_FLAGS = new Set<string>([
    'cache-dir', 'lock-dir', 'frozen', 'disable-cache', 'cached-only',
    'no-http', 'no-jsr', 'no-node', 'no-oxc',
    'memory-limit', 'max-stack-size', 'max-old-space-size', 'v8-flags',
    'conditions', 'C',
]);
const RUN_CONFIG_FLAGS = new Set<string>([
    ...RUNTIME_CONFIG_FLAGS, 'no-lock', 'polyfill',
]);
const CACHE_CONFIG_FLAGS = new Set<string>([
    ...RUNTIME_CONFIG_FLAGS, 'npm-mode', 'ignore-scripts',
]);
const PACK_CONFIG_FLAGS = new Set<string>([
    ...RUNTIME_CONFIG_FLAGS, 'no-lock',
]);
const REPL_CONFIG_FLAGS = new Set<string>([
    ...RUNTIME_CONFIG_FLAGS, 'no-lock',
]);

/** parseInspectFlags (commands/inspect.ts:8); task forwards them (task.ts:8). */
const INSPECT_FLAGS = new Set<string>(['inspect', 'inspect-brk', 'inspect-wait']);

const RUN_PROGRAM_FLAGS = new Set<string>([
    'ext', 'location',
    'env', 'env-file', 'preload',
    'require', 'import', 'loader',
    'precache', 'reload', 'r',
]);
const EVAL_PROGRAM_FLAGS = new Set<string>(['ext', 'location']);

/** commands/eval.ts:97 — printableCode; meaningless without eval source. */
const EVAL_FLAGS = new Set<string>(['eval', 'print', 'p']);

/** runTest (commands/test.ts:327) reads all four; nothing else does. */
const TEST_FLAGS = new Set<string>(['concurrency', 'filter', 'fail-fast', 'permit-no-files']);

/** runPack (commands/pack.ts:47) reads out/o; nothing else does. */
const PACK_FLAGS = new Set<string>(['out', 'o']);

/** taskLookup (commands/task.ts:24) reads cwd + config; runTask reads eval. */
const TASK_FLAGS = new Set<string>(['cwd', 'config', 'eval']);
const SERVE_FLAGS = new Set<string>(['port', 'host']);

function unionFlags(...sets: ReadonlySet<string>[]): Set<string> {
    const out = new Set<string>(GLOBAL_FLAGS);
    for (const set of sets) for (const name of set) out.add(name);
    return out;
}

/** Allow-list per subcommand; implicit runs use `run`. */
const COMMAND_FLAGS: Record<CnoSubcommand, Set<string>> = {
    run:     unionFlags(RUN_CONFIG_FLAGS, RUN_PROGRAM_FLAGS, INSPECT_FLAGS),
    serve:   unionFlags(RUN_CONFIG_FLAGS, RUN_PROGRAM_FLAGS, INSPECT_FLAGS, SERVE_FLAGS),
    eval:    unionFlags(RUN_CONFIG_FLAGS, EVAL_PROGRAM_FLAGS, INSPECT_FLAGS, EVAL_FLAGS),
    test:    unionFlags(RUN_CONFIG_FLAGS, RUN_PROGRAM_FLAGS, INSPECT_FLAGS, TEST_FLAGS),
    cache:   unionFlags(CACHE_CONFIG_FLAGS),
    pack:    unionFlags(PACK_CONFIG_FLAGS, PACK_FLAGS, new Set(['ext'])),
    repl:    unionFlags(REPL_CONFIG_FLAGS, INSPECT_FLAGS),
    task:    unionFlags(INSPECT_FLAGS, TASK_FLAGS),
    // exec resolves an npm bin (main.ts:526) and reads only --cache-dir.
    exec:    unionFlags(new Set(['cache-dir'])),
    setup:   unionFlags(new Set(['cache-dir'])),
    help:    unionFlags(),
    version: unionFlags(),
};

/** The allow-list for a parsed command; implicit run (null) is `run`. */
function allowedFlagsFor(cmd: Subcommand): Set<string> {
    return COMMAND_FLAGS[cmd ?? 'run'];
}

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
    'cert',
    // import map (cts uses its own config)
    'import-map', 'no-config', 'config',
    // locking
    'no-remote', 'lock', 'lock-write',
    // misc deno features we just ignore
    'seed', 'no-npm',
    'no-warnings',
]);

/** Deno-compat no-op families documented as wildcards (--allow-*, --deny-*, --unstable-*). */
function isDenoNoopFlag(name: string): boolean {
    if (DENO_NOOP_FLAGS.has(name)) return true;
    return name.startsWith('allow-') || name.startsWith('deny-') || name.startsWith('unstable-');
}

const VALUE_FLAGS = new Set<string>([
    'cache-dir', 'lock-dir', 'npm-mode', 'polyfill', 'ext', 'cwd',
    'port', 'host',
    'memory-limit', 'max-stack-size', 'concurrency', 'filter',
    'cert', 'config', 'import-map', 'lock', 'location', 'log-level',
    'seed', 'v8-flags',
    'require', 'import', 'loader', 'env', 'env-file', 'preload',
    'conditions', 'C', 'max-old-space-size', 'out',
]);

const NODE_RUNTIME_VALUE_FLAGS = new Set<string>(['require', 'import', 'loader', 'conditions', 'max-old-space-size']);
const NODE_INSPECT_FLAGS = new Set<string>(['inspect', 'inspect-brk', 'inspect-wait']);

/**
 * Value flags that are meaningless as booleans: reaching a consumer as `true`
 * means the value was missing, and every consumer type-guards on `string`, so
 * the flag would be silently ignored. Deno errors ("a value is required for
 * '--filter <filter>' but none was supplied") and so do we.
 *
 * Excluded on purpose: `out`/`o` (pack prints its own message), `eval` (bare
 * `task --eval` is a documented usage error) and `v8-flags` (deno accepts the
 * bare form as a help request).
 */
const REQUIRED_VALUE_FLAGS = new Set<string>([
    'cache-dir', 'lock-dir', 'npm-mode', 'polyfill', 'ext', 'cwd',
    'port', 'host',
    'memory-limit', 'max-stack-size', 'concurrency', 'filter',
    'cert', 'config', 'import-map', 'lock', 'location', 'log-level', 'seed',
    'require', 'import', 'loader', 'env', 'env-file', 'preload',
    'conditions', 'C', 'max-old-space-size',
]);

function setFlag(
    flags: Record<string, string | boolean>,
    name: string,
    value: string | boolean,
): void {
    // Node accepts repeated condition flags. Preserve all values in the flat
    // parser result; conditionsFromFlags splits the comma-separated form.
    const previous = flags[name];
    if ((name === 'conditions' || name === 'C')
        && typeof previous === 'string'
        && typeof value === 'string') {
        flags[name] = `${previous},${value}`;
        return;
    }
    flags[name] = value;
}

function isRecognizedOptionToken(token: string): boolean {
    if (token.startsWith('--')) {
        const eq = token.indexOf('=');
        const name = token.slice(2, eq === -1 ? undefined : eq);
        return KNOWN_FLAGS.has(name) || isDenoNoopFlag(name);
    }
    if (!token.startsWith('-') || token.length <= 1) return false;
    const name = token.slice(1);
    if (ALIASES[token] || name === 'r' || name === 'q' || name === 'A') return true;
    return KNOWN_FLAGS.has(name) || isDenoNoopFlag(name);
}

function shouldConsumeValueFlagToken(token: string | undefined): token is string {
    if (token === undefined || token === '--') return false;
    if (!token.startsWith('-')) return true;
    // Long option-shaped tokens always start another option, including unknown
    // options that validation must report. A single-dash token is a value unless
    // it is a recognized short option, preserving paths such as `-cache` and
    // negative numeric values without swallowing real flags.
    if (token.startsWith('--')) return false;
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
            if (shouldConsumeValueFlagToken(tokens[i + 1])) {
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
        if (eq === -1 && shouldConsumeValueFlagToken(tokens[i + 1])) {
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
    let evalToken: Args['evalToken'];
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
        // run/serve/implicit-run: first positional is the script.
        // exec: first positional is the package/bin name (pnpx-style); rest is for that bin.
        // task: the first positional is the task name; all following tokens
        // belong to the task command (including flags unknown to cno).
        return cmd === null || cmd === 'run' || cmd === 'serve' || cmd === 'exec' || cmd === 'task';
    }

    function consumeEvalAlias(flag: '-e' | '--eval' | '-p' | '--print'): void {
        const print = flag === '-p' || flag === '--print';
        if (print) flags['print'] = true;
        cmd = 'eval';
        cmdDecided = true;
        evalToken = { flag, inline: false };
        const value = argv[i + 1];
        // Native Deno does not consume option-shaped tokens as eval/print code.
        // Such code must follow a standalone `--`, including negative literals.
        if (value !== undefined && value !== '--' && !value.startsWith('-')) {
            positional.push(value);
            i += 2;
        } else {
            i++;
        }
    }

    while (i < argv.length) {
        const a = argv[i];
        if (a === undefined) break;

        // Once a run-like entry has been seen, every remaining token belongs
        // to the script. Preserve an explicit separator so it remains visible
        // in Deno.args, matching native Deno run semantics.
        if (fileFound) {
            positional.push(a);
            i++;
            continue;
        }

        // End of cno option parsing. Everything after this belongs to the
        // selected command; the first token becomes the run/test/cache target.
        if (a === '--') {
            if (cmd === 'test') {
                // Test needs the boundary for path/script-arg splitting.
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
            if (alias === 'eval') consumeEvalAlias(a === '-e' ? '-e' : '--eval');
            else {
                cmd = alias;
                cmdDecided = true;
                i++;
            }
            continue;
        }

        if (!cmdDecided && (a === '-p' || a === '--print')) {
            consumeEvalAlias(a === '-p' ? '-p' : '--print');
            continue;
        }

        // Top-level --eval=code / --print=code → eval subcommand; under
        // `task`, --eval remains a task flag.
        if (!cmdDecided && (a.startsWith('--eval=') || a.startsWith('--print='))) {
            const print = a.startsWith('--print=');
            const prefix = print ? '--print=' : '--eval=';
            cmd = 'eval';
            cmdDecided = true;
            if (print) flags.print = true;
            evalToken = { flag: print ? '--print' : '--eval', inline: true };
            positional.push(a.slice(prefix.length));
            i++;
            continue;
        }
        if (cmd === 'task' && a.startsWith('--eval=')) {
            flags['eval'] = a.slice('--eval='.length);
            pushRawTokens(a);
            i++;
            continue;
        }

        // --flag=value
        if (a.startsWith('--') && a.includes('=')) {
            const eq = a.indexOf('=');
            const k  = a.slice(2, eq);
            const v  = a.slice(eq + 1);
            setFlag(flags, k, v);
            pushRawTokens(a);
            i++;
            continue;
        }

        // --flag (bool) — values must use --flag=value syntax
        if (a.startsWith('--')) {
            const k = a.slice(2);
            // specs/task/eval: `task --eval <shell>` is ad-hoc shell, not eval subcommand.
            if (cmd === 'task' && k === 'eval') {
                const next = argv[i + 1];
                if (shouldConsumeValueFlagToken(next)) {
                    flags['eval'] = next;
                    pushRawTokens(a, next);
                    i += 2;
                } else {
                    flags['eval'] = true;
                    pushRawTokens(a);
                    i++;
                }
                continue;
            }
            // Treat --eval as a value flag synonym for the subcommand.
            if (!cmdDecided && k === 'eval') {
                consumeEvalAlias('--eval');
                continue;
            }
            if (!cmdDecided && k === 'print') {
                consumeEvalAlias('--print');
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
                setFlag(flags, k, next);
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
            if (!cmdDecided && (k === 'pe' || k === 'ep')) { consumeEvalAlias('--print'); continue; }
            if (k === 'o') {
                const next = argv[i + 1];
                if (shouldConsumeValueFlagToken(next)) {
                    flags['out'] = next;
                    pushRawTokens(a, next);
                    i += 2;
                } else {
                    flags['out'] = true;
                    pushRawTokens(a);
                    i++;
                }
                continue;
            }
            if (k === 'C') {
                const next = argv[i + 1];
                if (shouldConsumeValueFlagToken(next)) {
                    setFlag(flags, 'C', next);
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

    const runLike = cmd === null || cmd === 'run' || cmd === 'serve';
    const splitPreCommand = splitNodeRuntimeTokens(preCommandTokens, cmd === 'run' || cmd === 'serve');
    const splitAction = splitNodeRuntimeTokens(actionTokens, cmd === 'run' || cmd === 'serve');
    const internalArgs = runLike
        ? appendTokens(splitPreCommand.internal.slice(), splitAction.internal)
        : preCommandTokens.slice();
    const actionArgs = cmd === null
        ? splitPreCommand.rest
        : runLike
            ? appendTokens(splitPreCommand.rest.slice(), splitAction.rest)
            : actionTokens.slice();
    const rawArgs: Args = {
        binary: os.args[0],
        internalArgs,
        action: cmd ?? 'run',
        actionArgs,
        entry: positional[0] ?? 'repl',
        args: positional.length > 0 ? positional.slice(1) : [],
        evalToken,
    };

    return { cmd, positional, flags, rawArgs };
}

/** Return unknown or command-inapplicable flags for dispatch to reject. */
export function unknownFlags(cli: ParsedCli): string[] {
    const unknown: string[] = [];
    const allowed = allowedFlagsFor(cli.cmd);
    for (const k of Object.keys(cli.flags)) {
        if (allowed.has(k)) continue;
        if (isDenoNoopFlag(k)) continue;
        // Short flags are stored under their bare name; report them as typed.
        unknown.push(`${k.length === 1 ? '-' : '--'}${k}`);
    }
    return unknown;
}

/** Get argv passed to this cno invocation (skips the binary name). */
export function readArgv(): string[] {
    // os.args[0] is the binary path. Drop it.
    return os.args.slice(1);
}

/**
 * Names of flags that need a value but were given none (`--filter` at the end
 * of argv, or followed by another option). Returning instead of exiting keeps
 * this unit-testable; `dispatch` turns a non-empty list into exit 1.
 */
export function missingFlagValues(cli: ParsedCli): string[] {
    const missing: string[] = [];
    for (const [k, v] of Object.entries(cli.flags)) {
        if (v !== true && v !== '') continue;
        if (!REQUIRED_VALUE_FLAGS.has(k)) continue;
        missing.push(k);
    }
    return missing;
}
