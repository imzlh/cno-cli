import { dirname, cwd, hasSchemeId, resolvePath } from '../cts/src/utils';

/**
 * Resolve a user-supplied file target into an absolute entry path and its
 * parent directory (for config-file lookup).
 *
 * Handles Windows drive-letter paths (D:/x.js), URL protocols (https://...),
 * relative paths, and absolute POSIX paths.
 */
export function entryAndDir(raw: string): { entry: string; dir: string } {
    const hasProto = hasSchemeId(raw) && !raw.startsWith('/');
    const entry = hasProto ? raw : resolvePath(raw);
    return { entry, dir: hasProto ? cwd() : dirname(entry) };
}
