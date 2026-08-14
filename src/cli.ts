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
    'cache-dir', 'lock-dir', 'no-lock', 'frozen', 'disable-cache',
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
    'memory-limit', 'max-stack-size',
    'inspect', 'inspect-brk', 'inspect-wait',
    'require', 'import', 'loader',
    // resource limits inherited from cts
    'allow-all', 'A',
    // shorthand aliases & subcommand-like flags handled in parser
    'eval', 'help', 'h', 'version', 'v',
]);

/* ------------------------------------------------------------------ *
 * Per-subcommand scoping
 *
 * KNOWN_FLAGS above is the *vocabulary*: it decides how a token is
 * TOKENIZED (is `--filter x` one token or two?). It deliberately stays
 * flat, because tokenization cannot depend on the subcommand — the
 * subcommand is not known until the first positional is reached, which is
 * after the flags in `cno --filter=x test`.
 *
 * Validation is a separate question and it IS per-subcommand. A flat
 * vocabulary used as the validation set meant a flag valid for *some*
 * command was accepted by *every* command and then silently dropped by a
 * consumer that never reads it: OBSERVED `cno pack --filter=x entry.js`
 * exited 0 and packed everything, `cno run --out=x entry.js` ran the entry
 * and ignored --out. deno rejects the same shapes (rc 1, "unexpected
 * argument '--filter' found").
 *
 * Each set below is derived from the CODE that reads the flag, not from
 * --help. Cited call sites are the consumers; a flag absent from every
 * consumer for a command is not in that command's set.
 * ------------------------------------------------------------------ */

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

/**
 * Module resolution / cache / limits — the documented "COMMON OPTIONS".
 * Consumers: flagsToConfig (commands/run.ts:96) for run/eval/test,
 * buildCacheConfig (commands/cache-utils.ts:22) for cache/pack.
 *
 * Deliberately shared by every code-running command even though the two
 * consumers read different subsets — see the "parsed but never read" list in
 * the report. Narrowing this to each consumer's exact subset would reject
 * `cno cache --frozen`, which help.ts advertises as a common option, and that
 * is a documentation/consumer defect to fix in the consumer rather than a
 * user error to reject at the CLI.
 */
const CONFIG_FLAGS = new Set<string>([
    'cache-dir', 'lock-dir', 'no-lock', 'frozen', 'disable-cache',
    'no-http', 'no-jsr', 'no-node', 'no-oxc', 'polyfill',
    'memory-limit', 'max-stack-size',
    'npm-mode', 'ignore-scripts',
    'precache', 'reload', 'r',
]);

/** parseInspectFlags (commands/inspect.ts:8); task forwards them (task.ts:8). */
const INSPECT_FLAGS = new Set<string>(['inspect', 'inspect-brk', 'inspect-wait']);

/**
 * Flags only a program-running command honors.
 * ext        — sourceLangFromFlags (run.ts:173), extFromFlags (eval.ts:16)
 * location   — applyLocationFlag (run.ts:464), eval.ts:40
 * env/-file  — loadEnvFiles via collectValueFlags (run.ts:479)
 * preload    — runDenoPreloads (run.ts:425)
 * require/…  — collectNodePreloads (run.ts:402)
 * conditions — conditionsFromFlags (commands/node-options.ts:3)
 * v8-flags / max-old-space-size — flags-config.ts:51-58
 */
const PROGRAM_FLAGS = new Set<string>([
    'ext', 'location',
    'env', 'env-file', 'preload',
    'require', 'import', 'loader', 'conditions', 'C',
    'max-old-space-size', 'v8-flags',
]);

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

/**
 * Allow-list per subcommand. `null` (implicit run) maps to 'run'.
 *
 * setup takes only globals: runSetup (commands/setup.ts:319) reads --cache-dir
 * only, so that one is listed explicitly rather than pulling in all of
 * CONFIG_FLAGS.
 */
const COMMAND_FLAGS: Record<CnoSubcommand, Set<string>> = {
    run:     unionFlags(CONFIG_FLAGS, PROGRAM_FLAGS, INSPECT_FLAGS),
    serve:   unionFlags(CONFIG_FLAGS, PROGRAM_FLAGS, INSPECT_FLAGS, SERVE_FLAGS),
    // `cno eval` shares flagsToConfig with run (eval.ts:59) and accepts the
    // eval/print pair on top. It has no entry directory, hence no env/preload.
    eval:    unionFlags(CONFIG_FLAGS, PROGRAM_FLAGS, INSPECT_FLAGS, EVAL_FLAGS),
    // A test child is a real `cno run` (main.ts:587) and receives the parent's
    // flags verbatim via flagsToArgs (test.ts:166), so run's whole surface is
    // legitimately in scope here as well as the four test-only flags.
    test:    unionFlags(CONFIG_FLAGS, PROGRAM_FLAGS, INSPECT_FLAGS, TEST_FLAGS),
    cache:   unionFlags(CONFIG_FLAGS),
    pack:    unionFlags(CONFIG_FLAGS, PACK_FLAGS, new Set(['ext'])),
    repl:    unionFlags(CONFIG_FLAGS, INSPECT_FLAGS),
    // A task spawns a shell command that may itself be a `cno run`, so the
    // config family stays in scope; --cwd/--config/--eval are task-only.
    task:    unionFlags(CONFIG_FLAGS, INSPECT_FLAGS, TASK_FLAGS),
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
    'cert', 'cached-only',
    // import map (cts uses its own config)
    'import-map', 'no-config', 'config',
    // locking
    'no-remote', 'lock', 'lock-write',
    // misc deno features we just ignore
    'v8-flags',
    'seed', 'no-npm',
    // Node runtime flags accepted for process.execPath compatibility.
    'conditions', 'C', 'no-warnings', 'max-old-space-size',
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
    'conditions', 'max-old-space-size', 'out',
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
    if (token === undefined) return false;
    // `--` is the option terminator, never a value — deno and node both reject
    // `--config --` as "a value is required". Swallowing it also loses the
    // boundary, so `test --filter -- a_test.ts` would filter on "--".
    if (token === '--') return false;
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
            if (cmd === 'test') {
                // `cno test [paths...] -- [args...]` must preserve the boundary
                // so the test runner can separate discovery roots from Deno.args.
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

        // Top-level --eval=code → eval subcommand; under `task`, --eval is a flag.
        if (!cmdDecided && a.startsWith('--eval=')) {
            cmd = 'eval';
            cmdDecided = true;
            positional.push(a.slice('--eval='.length));
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
            if (!cmdDecided && (k === 'pe' || k === 'ep')) { consumeEvalAlias(true); continue; }
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
    };

    return { cmd, positional, flags, rawArgs };
}

/**
 * Names of flags this invocation does not honor — unknown everywhere, or known
 * but not for THIS subcommand.
 *
 * Deno-compat no-op flags are accepted silently for every command (cno claims
 * deno compatibility, so `--allow-net` and friends must keep working);
 * anything else is either a typo like `--frozenn`, which used to print a
 * warning and then run anyway with the intent silently dropped — exit 0 — or a
 * mis-scoped flag like `cno pack --filter=x`, which exited 0 and packed
 * everything. node exits 9 ("bad option") and deno exits 1 ("unexpected
 * argument"), so a warn-only path meant CI scored both as a pass.
 *
 * Scoping is validation-only and deliberately does not touch tokenization: the
 * subcommand is not known while tokens are being consumed (`cno --filter=x
 * test` puts the flag first), so KNOWN_FLAGS stays flat and this decides
 * whether the resulting flag was legal for the command that was selected.
 *
 * Returned rather than exited on so this stays unit-testable; `dispatch` turns
 * a non-empty list into exit 1.
 */
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

/**
 * True when `name` is a real cno flag that is simply not valid for `cmd`.
 *
 * Lets a caller distinguish "you typed `--frozenn`" from "`--filter` belongs to
 * `cno test`", which is the difference between a typo and a wrong-command
 * mistake. `dispatch` uses it to add the "not supported by" half of the error.
 */
export function isMisscopedFlag(name: string, cmd: Subcommand): boolean {
    const bare = name.startsWith('--') ? name.slice(2) : name.startsWith('-') ? name.slice(1) : name;
    return KNOWN_FLAGS.has(bare) && !allowedFlagsFor(cmd).has(bare);
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
