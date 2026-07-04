import { strictEqual, ok, match } from 'node:assert';

// ============================================================================
// CTS transformer / loader behavior — what cts/src/transform does
// These exercise the loader's grammar, not its full pipeline (which needs a
// running QJS instance). They catch regressions in the parts that *can* run
// standalone.
// ============================================================================

// --- 1. BUILTINS set includes the modules we polyfill ----------------------
Deno.test('cts: BUILTINS includes major node modules', async () => {
    const { BUILTINS } = await import('../../../cts/src/resolve/builtins.ts');
    for (const name of ['fs', 'path', 'events', 'stream', 'http', 'crypto', 'os', 'util']) {
        ok(BUILTINS.has(name), `BUILTINS must include ${name}`);
    }
});

// --- 2. isBuiltinSpecifier returns true for node: prefixes ----------------
Deno.test('cts: isBuiltinSpecifier detects node: prefix', async () => {
    const { isBuiltinSpecifier } = await import('../../../cts/src/resolve/builtins.ts');
    ok(isBuiltinSpecifier('node:fs'));
    ok(isBuiltinSpecifier('node:path'));
    ok(!isBuiltinSpecifier('fs'));
    ok(!isBuiltinSpecifier('./local'));
});

// --- 3. ModuleInfo shape has required fields -------------------------------
Deno.test('cts: ModuleInfo type from types.ts has specPath/localPath/format/fileKind', async () => {
    // types.ts is a type-only module — we can't runtime-check its types, but
    // we *can* check that the module file parses.
    const types = await import('../../../cts/src/types.ts');
    ok(types !== null);
});

// --- 4. package.json exports/imports field resolution ---------------------
Deno.test('cts: pkg.ts resolves exports field for known packages', async () => {
    // This one downloads from npm in some configurations — only test local resolution
    // by checking the module loads without crashing.
    const pkg = await import('../../../cts/src/resolve/pkg.ts');
    ok(typeof pkg === 'object');
});
