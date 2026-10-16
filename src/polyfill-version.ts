// Replaced by scripts/bundle.mjs with the cno checkout used for this binary.
// Source-mode development still supports local setup without a bundle define.
declare const __CNO_POLYFILL_REVISION__: string;

export const bundledPolyfillRevision: string | null =
    typeof __CNO_POLYFILL_REVISION__ === 'string' ? __CNO_POLYFILL_REVISION__ : null;

export function requirePolyfillRevision(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
        throw new Error('Polyfill revision must be a full 40-character Git commit SHA; use setup --polyfill-revision=<commit>');
    }
    return value.toLowerCase();
}
