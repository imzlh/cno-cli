import { uname, joinPaths, errMsg } from '../cts/src/api';
import { readEnv } from './env';

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

/**
 * Resolve the directory holding native shared-library extensions
 * (oxc, ext-h2, ext-quic). Returns null if none found — the runtime will
 * fall back to whatever circu.js has statically linked.
 */
export function resolveExtDir(): string | null {
    const envPath = readEnv('CTS_EXT_PATH');
    if (envPath) return envPath;

    const dir = binaryDir();
    const candidates = [
        joinPaths(dir, 'ext'),
        joinPaths(dir, 'lib', 'ext'),
        joinPaths(dir, '..', 'lib', 'cno', 'ext'),
        joinPaths(dir, '..', 'lib64', 'cno', 'ext'),
        joinPaths(dir, '..', 'lib', 'ext'),
        joinPaths(dir, '..', 'lib64', 'ext'),
    ];
    let firstDirectory: string | null = null;
    for (const c of candidates) {
        try {
            if (!fs.exists(c) || !fs.stat(c).isDirectory) continue;
            firstDirectory ??= c;
            for (const files of Object.values(EXTENSIONS)) {
                if (files.some((file) => tryFile(joinPaths(c, file)))) return c;
            }
        } catch {}
    }
    return firstDirectory;
}

/** Name → candidate filenames within the ext directory. */
const EXTENSIONS: Record<string, readonly string[]> = {
    // Optional native accelerator for cts scan/transform (worker_safe).
    // Without this entry, tryLoadOxc must register itself — and a failed
    // re-register used to silently fall back to Sucrase for the whole graph.
    'oxc': ['oxc' + DLEXT],
    // Optional protocol natives when not statically embedded (CJS_EXTRA_*).
    // Built-in embed always wins over dyn register of the same name.
    // Standalone CMake targets keep their libCNO_* names on Unix.
    'ext:h2': ['cno_nghttp2' + DLEXT, 'libCNO_nghttp2' + DLEXT, 'CNO_nghttp2' + DLEXT],
    'ext:quic': ['cno_quicly' + DLEXT, 'libCNO_QUIC' + DLEXT, 'CNO_QUIC' + DLEXT],
};

/**
 * Register all native extension .so/.dll files we can find with the
 * runtime's dynamic-module registry. Skips entries whose file is missing
 * so a partial install still boots. Also silently skips entries whose
 * name is already a built-in (e.g. statically embedded via CJS_EXTRA_*) —
 * the built-in always wins.
 *
 * Runs on the main process and every worker that boots via src/main.ts
 * (parse workers included) so dyn_registry is populated per JSRuntime.
 */
export function registerExtensions(): void {
    const dir = resolveExtDir();
    if (!dir) return;
    for (const [name, files] of Object.entries(EXTENSIONS)) {
        for (const file of files) {
            const p = joinPaths(dir, file);
            if (!tryFile(p)) continue;
            try {
                import.meta.register(name, p);
                break;
            } catch (e) {
                const msg = errMsg(e);
                if (/built-in|already registered/i.test(msg)) break;
                console.error(`cno: register('${name}') failed: ${msg}`);
            }
        }
    }
}
