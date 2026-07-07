import { uname, joinPaths, errMsg } from '../cts/src/api';

const fs = import.meta.use('fs');
const os = import.meta.use('os');
const console = import.meta.use('console');

const IS_WIN = uname.sysname.includes('Windows');
const IS_MAC = uname.sysname === 'Darwin';
const DLEXT  = IS_WIN ? '.dll' : IS_MAC ? '.dylib' : '.so';

function tryFile(path: string): string | null {
    try {
        if (fs.exists(path) && fs.stat(path).isFile) return path;
    } catch {}
    return null;
}

function binaryDir(): string {
    try {
        return os.exePath.replace(/[\\/][^\\/]+$/, '');
    } catch {
        return os.cwd;
    }
}

function getEnv(name: string): string | null {
    try {
        return os.getenv(name) ?? null;
    } catch {
        return null;
    }
}

/**
 * Resolve the directory holding native shared-library extensions
 * (ext-h2, ext-quic). Returns null if none found — the runtime will
 * fall back to whatever circu.js has statically linked.
 */
export function resolveExtDir(): string | null {
    const envPath = getEnv('CNO_EXT_PATH');
    if (envPath) return envPath;

    const dir = binaryDir();
    for (const c of [joinPaths(dir, 'ext'), joinPaths(dir, 'lib', 'ext')]) {
        try {
            if (fs.exists(c) && fs.stat(c).isDirectory) return c;
        } catch {}
    }
    return null;
}

/** Name → relative filename within the ext directory. */
const EXTENSIONS: Record<string, string> = {
    // '@cnojs/http/ext-h2': 'cno_nghttp2' + DLEXT,
    // '@cnojs/quic':        'cno_quicly'  + DLEXT,
};

/**
 * Register all native extension .so/.dll files we can find with the
 * runtime's dynamic-module registry. Skips entries whose file is missing
 * so a partial install still boots. Also silently skips entries whose
 * name is already a built-in (e.g. statically embedded via CJS_EXTRA_*) —
 * the built-in always wins.
 *
 * Call this exactly once, before any polyfill or user code runs.
 */
export function registerExtensions(): void {
    const dir = resolveExtDir();
    if (!dir) return;
    for (const [name, file] of Object.entries(EXTENSIONS)) {
        const p = joinPaths(dir, file);
        if (!tryFile(p)) continue;
        try { import.meta.register(name, p); }
        catch (e) {
            const msg = errMsg(e);
            if (/built-in|already registered/i.test(msg)) continue;
            console.error(`cno: register('${name}') failed: ${msg}`);
        }
    }
}
