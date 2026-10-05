import { dirname, cwd, hasSchemeId, resolvePath, toFileUrl } from '../cts/src/utils';

/** URL schemes exclude Windows drive letters and absolute filesystem paths. */
export function hasUrlScheme(entry: string): boolean {
    return hasSchemeId(entry) && !entry.startsWith('/');
}

export function entryUrl(entry: string): string {
    return hasUrlScheme(entry) ? entry : toFileUrl(entry);
}

export function sourceExtension(value: string | boolean | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    return (value.startsWith('.') ? value.slice(1) : value) || undefined;
}

/**
 * Resolve a user-supplied file target into an absolute entry path and its
 * parent directory (for config-file lookup).
 *
 * Handles Windows drive-letter paths (D:/x.js), URL protocols (https://...),
 * relative paths, and absolute POSIX paths.
 */
export function entryAndDir(raw: string): { entry: string; dir: string } {
    const hasProto = hasUrlScheme(raw);
    const entry = hasProto ? raw : resolvePath(raw);
    return { entry, dir: hasProto ? cwd() : dirname(entry) };
}
