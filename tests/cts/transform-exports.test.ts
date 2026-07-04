import { strictEqual, ok } from 'node:assert';
import { Transformer } from '../../cts/src/source/transform.ts';
import { resolveExports, createCtx, clearPkgCache } from '../../cts/src/resolve/pkg.ts';
import { normalizeBinField, getBinMap } from '../../cts/src/resolve/pkg.ts';

// --- 1. Transformer: illegal TS syntax throws a structured error -----------
//
// TransformError must carry fileName/line/column so REPL/CLI can render a
// code frame without parsing human text. Asserting the structured fields,
// not just that *some* error was thrown.

Deno.test('cts: TransformError carries fileName/line/column on syntax error', () => {
    const t = new Transformer();
    const bad = 'const x: number = ;'; // TS parse error
    let caught: Error | null = null;
    try {
        t.transform(bad, 'bad.ts');
    } catch (e) {
        caught = e as Error;
    }
    ok(caught, 'transform of illegal syntax must throw');
    const anyErr = caught as unknown as { fileName?: string; line?: number; column?: number };
    ok('fileName' in anyErr, 'error must carry fileName');
    strictEqual(anyErr.fileName, 'bad.ts');
    ok(typeof anyErr.line === 'number' && anyErr.line >= 1, 'error must carry a positive line');
    ok(typeof anyErr.column === 'number' && anyErr.column >= 0, 'error must carry a column');
});

// --- 2. Transformer: strips a shebang line before parsing ------------------

Deno.test('cts: transformer strips shebang before transform', () => {
    const t = new Transformer();
    const code = '#!/usr/bin/env node\nconst a: number = 1;';
    const out = t.transform(code, 'she.ts');
    ok(!out.startsWith('#!'), 'shebang must be stripped');
    ok(out.includes('const a = 1') || out.includes('const a: number = 1') || out.includes('number = 1'),
        'transformed body must remain');
});

// --- 3. resolveExports: "exports" "." maps to declared file ----------------

Deno.test('cts: resolveExports maps "." to package exports', () => {
    const dir = new URL('./fixtures/cts-pkg-exports/', import.meta.url).pathname;
    clearPkgCache();
    const ctx = createCtx(dir);
    ok(ctx, 'createCtx must return a context for a dir with package.json');
    const r = resolveExports(ctx!, '.');
    ok(r, 'resolveExports(".") must resolve');
    ok(r!.path.endsWith('entry.js'), `expected entry.js, got ${r!.path}`);
    strictEqual(r!.format, 'esm');
});

// --- 4. resolveExports: subpath "./utils" resolves under exports ------------

Deno.test('cts: resolveExports maps "./utils" to subpath target', () => {
    const dir = new URL('./fixtures/cts-pkg-exports/', import.meta.url).pathname;
    clearPkgCache();
    const ctx = createCtx(dir)!;
    const r = resolveExports(ctx, './utils');
    ok(r, 'resolveExports("./utils") must resolve');
    ok(r!.path.endsWith('utils.js'), `expected utils.js, got ${r!.path}`);
});

// --- 5. resolveExports: unknown subpath returns null ----------------------

Deno.test('cts: resolveExports returns null for an unmapped subpath', () => {
    const dir = new URL('./fixtures/cts-pkg-exports/', import.meta.url).pathname;
    clearPkgCache();
    const ctx = createCtx(dir)!;
    const r = resolveExports(ctx, './nope');
    strictEqual(r, null, 'unmapped subpath must resolve to null');
});

// --- 6. normalizeBinField: string and object forms -------------------------

Deno.test('cts: normalizeBinField accepts string bin', () => {
    const m = normalizeBinField('mypkg', './bin/cli.js');
    strictEqual(m['mypkg'], './bin/cli.js');
});

Deno.test('cts: getBinMap reads bin field from package.json', () => {
    const pkg = { name: 'p', bin: { cli: './c.js', srv: './s.js' } } as Parameters<typeof getBinMap>[0];
    const m = getBinMap(pkg);
    strictEqual(m['cli'], './c.js');
    strictEqual(m['srv'], './s.js');
});
