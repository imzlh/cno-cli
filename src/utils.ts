// src/utils.ts — shared CLI utilities
import { dirname, normalizePath, isAbsolute, joinPaths, cwd, toPosixPath } from '../cts/src/utils';

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
    if (hasProto) {
        entry = raw;
    } else if (raw.startsWith('/') || winAbs) {
        entry = toPosixPath(raw);
    } else {
        entry = normalizePath(joinPaths(cwd(), toPosixPath(raw)));
    }
    return { entry, dir: hasProto ? cwd() : dirname(entry) };
}
