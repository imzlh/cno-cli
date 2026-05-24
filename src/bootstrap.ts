// Resolve where the cno polyfill bundle lives, and register native .so
// extensions with circu.js before any polyfill code runs.
//
// Polyfill lookup priority:
//   1. --polyfill CLI flag                (handled by caller)
//   2. CNO_POLYFILL env var
//   3. <binary_dir>/lib/cno-polyfill.js   (release layout)
//   4. <binary_dir>/../cno/dist.js        (dev layout, run from build tree)
//   5. <repo_root>/cno/dist.js            (last resort, dev via `cts src/main.ts`)
//
// Extension lookup:
//   - CNO_EXT_PATH env var
//   - <binary_dir>/ext/
// Each name → file mapping is hard-coded below. The .so must export
// `tjs_module_info` (see circu.js/src/tjs.h DEF_MODULE).

import { os, fs, uname, console } from '../cts/src/utils';
import { dirname, joinPaths } from '../cts/src/utils/path';

const IS_WIN = uname.sysname.includes('Windows');
const IS_MAC = uname.sysname === 'Darwin';
const DLEXT  = IS_WIN ? '.dll' : IS_MAC ? '.dylib' : '.so';

function tryFile(path: string): string | null {
    try {
        if (fs.exists(path) && fs.stat(path).isFile) return path;
    } catch {}
    return null;
}

function fromEnv(): string | null {
    try {
        const v = os.getenv('CNO_POLYFILL');
        if (v) return tryFile(v);
    } catch {}
    return null;
}

function binaryDir(): string {
    try {
        return dirname(os.exePath as string);
    } catch {
        return os.cwd as string;
    }
}

/**
 * Resolve the polyfill bundle to load before user code.
 * Returns absolute path, or null if no bundle was found.
 */
export function resolvePolyfillPath(override?: string): string | null {
    if (override) return tryFile(override);

    const env = fromEnv();
    if (env) return env;

    const dir = binaryDir();
    const candidates = [
        joinPaths(dir, 'lib', 'cno-polyfill.js'),
        joinPaths(dir, '..', 'cno', 'dist.js'),
        joinPaths(dir, '..', '..', 'cno', 'dist.js'),
        // Repo-root fallback when this file runs as TS via cts:
        joinPaths(((import.meta as any).dirname as string) ?? dir, '..', 'cno', 'dist.js'),
    ];
    for (const c of candidates) {
        const hit = tryFile(c);
        if (hit) return hit;
    }
    return null;
}

/**
 * Resolve the directory holding native shared-library extensions
 * (ext-h2, ext-quic). Returns null if none found — the runtime will
 * fall back to whatever circu.js has statically linked.
 */
export function resolveExtDir(): string | null {
    try {
        const v = os.getenv('CNO_EXT_PATH');
        if (v) return v;
    } catch {}
    const dir = binaryDir();
    for (const c of [joinPaths(dir, 'ext'), joinPaths(dir, 'lib', 'ext')]) {
        try { if (fs.exists(c) && fs.stat(c).isDirectory) return c; } catch {}
    }
    return null;
}

/** Name → relative filename within the ext directory. */
const EXTENSIONS: Record<string, string> = {
    '@cnojs/http/ext-h2': 'cno_nghttp2' + DLEXT,
    '@cnojs/quic':        'cno_quicly'  + DLEXT,
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
    const reg = (import.meta as any).register;
    if (typeof reg !== 'function') return;  // older circu.js — silently no-op
    for (const [name, file] of Object.entries(EXTENSIONS)) {
        const p = joinPaths(dir, file);
        if (!tryFile(p)) continue;
        try { reg(name, p); }
        catch (e) {
            const msg = (e as Error).message || '';
            // Built-in shadow / already-registered — expected when statically
            // embedded; not worth surfacing.
            if (/built-in|already registered/i.test(msg)) continue;
            console.error(`cno: register('${name}') failed: ${msg}`);
        }
    }
}
