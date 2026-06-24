// src/utils.ts — shared CLI utilities
import { dirname, normalizePath, isAbsolute, joinPaths } from '../cts/src/utils/path';

const os = import.meta.use('os');

/**
 * Resolve a user-supplied file target into an absolute entry path and its
 * parent directory (for config-file lookup).
 *
 * Handles Windows drive-letter paths (D:/x.js), URL protocols (https://...),
 * relative paths, and absolute POSIX paths.
 */
export function entryAndDir(raw: string): { entry: string; dir: string } {
    const winAbs = isAbsolute(raw);
    // Do not treat Windows drive paths like D:/x.js as URL protocols.
    const hasProto = !winAbs && /^[a-z][a-z0-9+\-.]*:/i.test(raw) && !raw.startsWith('/');
    let entry: string;
    if (hasProto || raw.startsWith('/') || winAbs) {
        entry = raw.replace(/\\/g, '/');
    } else {
        const cwd = os.cwd.replace(/\\/g, '/');
        entry = normalizePath(joinPaths(cwd, raw.replace(/\\/g, '/')));
    }
    return { entry, dir: hasProto ? os.cwd : dirname(entry) };
}
