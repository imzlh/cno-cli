import { os } from '../cts/src/utils';

export type Subcommand =
    | 'run' | 'task' | 'eval' | 'cache' | 'repl'
    | 'fmt' | 'lint' | 'test' | 'upgrade'
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
    'fmt', 'lint', 'test', 'upgrade',
    'help', 'version',
]);

const ALIASES: Record<string, string> = {
    '-h': 'help',
    '--help': 'help',
    '-v': 'version',
    '--version': 'version',
};

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

    while (i < argv.length) {
        const a = argv[i]!;

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

        // --flag value | --flag (bool)
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
            if (next !== undefined && !next.startsWith('-')) {
                // Heuristic: value flags consume next token if it doesn't look like a flag.
                // Booleans are still possible — pre-emptively grab the value; subcommand
                // handlers can reinterpret if needed via the `raw` array.
                flags[k] = next;
                i += 2;
            } else {
                flags[k] = true;
                i++;
            }
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
            }
            cmdDecided = true;
        } else {
            positional.push(a);
        }
        i++;
    }

    return { cmd, positional, flags, raw };
}

/** Get argv passed to this cno invocation (skips the binary name). */
export function readArgv(): string[] {
    // os.args[0] is the binary path. Drop it.
    return (os.args as string[]).slice(1);
}
