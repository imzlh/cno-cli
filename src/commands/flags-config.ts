import type { ConfigOptions } from '../../cts/src/api';

const os = import.meta.use('os');

function envValue(name: string): string | undefined {
    try {
        return os.getenv(name) ?? undefined;
    } catch {
        return undefined;
    }
}

/** Apply Node's old-space setting when no cno-specific limit was supplied. */
export function applyMaxOldSpaceSize(
    c: Partial<ConfigOptions>,
    flags: Record<string, string | boolean>,
    execArgv: string[] = [],
): void {
    const raw = maxOldSpaceMb(flags, execArgv);
    if (raw === undefined) return;
    const mb = Number(raw);
    if (!Number.isFinite(mb) || mb <= 0) {
        throw new Error('--max-old-space-size must be a positive number of megabytes');
    }
    if (c.memoryLimit !== undefined || envValue('CTS_MEMORY_LIMIT')) return;
    c.memoryLimit = Math.floor(mb) * 1024 * 1024;
}

/** The flag value, preferring the CLI form over one inherited from NODE_OPTIONS. */
function maxOldSpaceMb(
    flags: Record<string, string | boolean>,
    execArgv: string[],
): string | undefined {
    const fromFlag = flags['max-old-space-size'];
    if (typeof fromFlag === 'string' && fromFlag.length > 0) return fromFlag;
    const fromV8 = flags['v8-flags'];
    if (typeof fromV8 === 'string' && fromV8.length > 0) {
        const found = scanMaxOldSpace(fromV8.split(','));
        if (found !== undefined) return found;
    }
    // NODE_OPTIONS reaches us only through execArgv, never through `flags`.
    return scanMaxOldSpace(execArgv);
}

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
