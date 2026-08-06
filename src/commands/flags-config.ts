import type { ConfigOptions } from '../../cts/src/api';

const os = import.meta.use('os');

function envValue(name: string): string | undefined {
    try {
        return os.getenv(name) ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Honor node's `--max-old-space-size=<MB>` as a memory cap.
 *
 * It was accepted by the parser, forwarded into `process.execArgv` (so it
 * *looked* applied) and then read by nobody: measured against node v24.18,
 * `--max-old-space-size=32` aborts node at ~60k retained objects (rc=134,
 * "Reached heap limit") while cno retained 600k and exited 0. The same held
 * for `NODE_OPTIONS=--max-old-space-size=32`, which is the usual way a CI job
 * or container caps a build — so the cap was silently absent exactly where it
 * is relied upon.
 *
 * Semantics are not identical (node caps only V8's old space; cts's
 * memoryLimit is a total allocation cap), so an explicit cno-native knob must
 * win: `--memory-limit` and `CTS_MEMORY_LIMIT` both take precedence and this
 * only fills an otherwise-unset limit. Capping at N MB is far closer to the
 * user's intent than ignoring the flag.
 */
export function applyMaxOldSpaceSize(
    c: Partial<ConfigOptions>,
    flags: Record<string, string | boolean>,
    execArgv: string[] = [],
): void {
    if (c.memoryLimit !== undefined) return;
    if (envValue('CTS_MEMORY_LIMIT')) return;
    const raw = maxOldSpaceMb(flags, execArgv);
    if (raw === undefined) return;
    const mb = Number(raw);
    // Node treats a non-numeric or non-positive value as a usage error; cno
    // accepts the flag for compatibility, so ignore garbage rather than throw.
    if (!Number.isFinite(mb) || mb <= 0) return;
    c.memoryLimit = Math.floor(mb) * 1024 * 1024;
}

/** The flag value, preferring the CLI form over one inherited from NODE_OPTIONS. */
function maxOldSpaceMb(
    flags: Record<string, string | boolean>,
    execArgv: string[],
): string | undefined {
    const fromFlag = flags['max-old-space-size'];
    if (typeof fromFlag === 'string' && fromFlag.length > 0) return fromFlag;
    // Deno's spelling: --v8-flags=--max-old-space-size=32[,--other]. REASONED
    // (deno is not installed here): deno documents --v8-flags as passing options
    // through to V8, so a heap cap given this way is equally load-bearing and
    // was equally ignored — OBSERVED, `--v8-flags=--max-old-space-size=16` did
    // not even reach process.execArgv.
    const fromV8 = flags['v8-flags'];
    if (typeof fromV8 === 'string' && fromV8.length > 0) {
        const found = scanMaxOldSpace(fromV8.split(','));
        if (found !== undefined) return found;
    }
    // NODE_OPTIONS reaches us only through execArgv, never through `flags`.
    return scanMaxOldSpace(execArgv);
}

/** Last-wins scan for --max-old-space-size in a token list (both = and space forms). */
function scanMaxOldSpace(tokens: string[]): string | undefined {
    let found: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === undefined) continue;
        if (token === '--max-old-space-size') {
            const next = tokens[i + 1];
            if (next !== undefined && !next.startsWith('-')) {
                found = next;
                i++;
            }
            continue;
        }
        if (token.startsWith('--max-old-space-size=')) {
            found = token.slice('--max-old-space-size='.length);
        }
    }
    return found;
}
