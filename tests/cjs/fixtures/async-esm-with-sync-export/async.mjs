// ESM with BOTH a sync named export AND a top-level await.
//
// This is exactly the trap loadEsmSync guards against: mod.eval() returns
// null (top-level await unresolved) yet the namespace is already populated
// with `syncExport`. A weak "namespace size > 0 ? return it" check would hand
// CJS a half-initialized module -> silent dead-lock of downstream awaits.

export const syncExport = 123;

await Promise.resolve();
export const asyncExport = 456;
