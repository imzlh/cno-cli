import { strictEqual, ok } from 'node:assert';

// cwd is project root. This file: tests/cts/loader.test.ts
// Import base = file directory (tests/cts/), NOT cwd.
// tests/cts/ → ../ → tests/ → ../ → project root → cts/src/resolve/builtins.ts

Deno.test('cts: BUILTINS includes major node modules', async () => {
    const { BUILTINS } = await import('../../cts/src/resolve/builtins.ts');
    for (const name of ['fs', 'path', 'events', 'stream', 'http', 'crypto', 'os', 'util']) {
        ok(BUILTINS.has(name));
    }
});

Deno.test('cts: isBuiltinSpecifier detects node: prefix', async () => {
    const { isBuiltinSpecifier } = await import('../../cts/src/resolve/builtins.ts');
    ok(isBuiltinSpecifier('node:fs'));
    ok(isBuiltinSpecifier('fs'));
    ok(!isBuiltinSpecifier('./local'));
});

Deno.test('cts: isBuiltinSpecifier only accepts known builtin subpaths', async () => {
    const { isBuiltinSpecifier } = await import('../../cts/src/resolve/builtins.ts');
    ok(isBuiltinSpecifier('fs/promises'));
    ok(isBuiltinSpecifier('node:stream/web'));
    ok(!isBuiltinSpecifier('string_decoder/'));
    ok(!isBuiltinSpecifier('fs/utils'));
});

Deno.test('cts: builtins.ts exports BUILTINS and isBuiltinSpecifier', async () => {
    const mod = await import('../../cts/src/resolve/builtins.ts');
    ok(mod.BUILTINS !== undefined);
    ok(typeof mod.isBuiltinSpecifier === 'function');
});
