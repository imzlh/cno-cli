const os = import.meta.use('os');
const console = import.meta.use('console');

export type Subcommand =
    | 'run' | 'task' | 'eval' | 'cache' | 'repl'
    | 'fmt' | 'lint' | 'test' | 'upgrade' | 'setup'
    | 'help' | 'version'
    | null;

export interface ParsedCli {
    /** Subcommand name, or null if the first non-flag token is a file path. */
    cmd: Subcommand;
    /** Positional args after the subcommand. */
    positional: string[];
    /** Parsed flags, as a flat record. */
    flags: Record<string, string | boolean>;
    /** Raw argv slice (for forwarding to subprocesses). */
    raw: string[];
}

const SUBCOMMANDS = new Set<string>([
    'run', 'task', 'eval', 'cache', 'repl',
    'fmt', 'lint', 'test', 'upgrade', 'setup',
    'help', 'version',
]);

const ALIASES: Record<string, string> = {
    '-h': 'help',
    '--help': 'help',
    '-v': 'version',
    '--version': 'version',
};

/**
 * Flags cno actually honors. Anything not in this set and not in
 * DENO_NOOP_FLAGS triggers a stderr warning so users notice silent typos.
 */
const KNOWN_FLAGS = new Set<string>([
    // run / eval / cache
    'cache-dir', 'lock-dir', 'no-lock', 'frozen', 'disable-cache',
    'no-http', 'no-jsr', 'no-node', 'no-swc', 'ignore-scripts',
    'reload', 'r', 'precache',
    // misc
    'silent', 'q',
    'system-proxy', 'skip-cert-verify',
    'memory-limit', 'max-stack-size',
    'inspect', 'inspect-brk', 'inspect-wait',
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
]);


/**
 * Parse cno's argv.
 *
 *   cno run foo.ts a b      → { cmd:'run',  positional:['foo.ts','a','b'] }
 *   cno foo.ts a b          → { cmd:null,   positional:['foo.ts','a','b'] }  (implicit run)
 *   cno task build          → { cmd:'task', positional:['build'] }
 *   cno -h                  → { cmd:'help', positional:[] }
 *   cno --eval 'code'       → { cmd:'eval', positional:['code'] }
 */
export function parseArgv(argv: string[]): ParsedCli {
    const raw = argv.slice();
    const flags: Record<string, string | boolean> = {};
    let cmd: Subcommand = null;
    const positional: string[] = [];
    let i = 0;

    // First non-flag token decides the subcommand.
    let cmdDecided = false;
    // After the script path (first positional after cmd) is found,
    // stop parsing flags — remaining tokens are forwarded to the script.
    let fileFound = false;

    while (i < argv.length) {
        const a = argv[i]!;

        // Once the script file has been seen, collect everything as positional.
        if (fileFound) { positional.push(a); i++; continue; }

        // -h / --help / -v / --version are subcommand-like aliases
        if (!cmdDecided && ALIASES[a]) {
            cmd = ALIASES[a] as Subcommand;
            cmdDecided = true;
            i++;
            continue;
        }

        // --flag=value
        if (a.startsWith('--') && a.includes('=')) {
            const eq = a.indexOf('=');
            const k  = a.slice(2, eq);
            const v  = a.slice(eq + 1);
            flags[k] = v;
            i++;
            continue;
        }

        // --flag (bool) — values must use --flag=value syntax
        if (a.startsWith('--')) {
            const k = a.slice(2);
            // Treat --eval as a value flag synonym for the subcommand.
            if (!cmdDecided && k === 'eval') {
                cmd = 'eval';
                cmdDecided = true;
                if (argv[i + 1] !== undefined) {
                    positional.push(argv[i + 1]!);
                    i += 2;
                } else i++;
                continue;
            }
            const next = argv[i + 1];
            // --inspect and --inspect-brk/--inspect-wait: optional port/host:port value — only
            // consume the next token if it looks like a port number or host:port,
            // not if it's a file path or another flag.
            if (k === 'inspect' || k === 'inspect-brk' || k === 'inspect-wait') {
                if (next !== undefined && /^(\d+|[a-z0-9.-]+:\d+)$/i.test(next)) {
                    flags[k] = next;
                    i += 2;
                } else {
                    flags[k] = true;
                    i++;
                }
                continue;
            }
            flags[k] = true;
            i++;
            continue;
        }

        // -x short
        if (a.startsWith('-') && a.length > 1) {
            const k = a.slice(1);
            // -r is "reload"
            if (k === 'r')      { flags['reload'] = true; i++; continue; }
            if (k === 'q')      { flags['silent'] = true; i++; continue; }
            if (k === 'A')      { flags['allow-all'] = true; i++; continue; }
            flags[k] = true;
            i++;
            continue;
        }

        // Positional
        if (!cmdDecided) {
            if (SUBCOMMANDS.has(a)) {
                cmd = a as Subcommand;
            } else {
                // Implicit `run` when first token is not a subcommand.
                cmd = null;
                positional.push(a);
                fileFound = true;   // script path collected — stop parsing flags
            }
            cmdDecided = true;
        } else {
            positional.push(a);
            if (!fileFound) fileFound = true;  // first positional after cmd = script file
        }
        i++;
    }

    return { cmd, positional, flags, raw };
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
    return (os.args as string[]).slice(1);
}
