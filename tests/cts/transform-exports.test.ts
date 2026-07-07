import { strictEqual, ok } from 'node:assert';
import { Transformer } from '../../cts/src/source/transform.ts';
import { transform } from '../../cts/deps/sucrase/src/index.ts';
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

// --- 3. Sucrase sourcemaps stay local/offline ------------------------------

Deno.test('cts: sucrase source maps are generated without npm dependencies', () => {
    const out = transform('using resource: Resource = getResource();\nconst b: string = "x";', {
        transforms: ['typescript'],
        filePath: 'input.ts',
        sourceMapOptions: { compiledFilename: 'output.js' },
    });
    ok(out.code.includes('using resource = getResource()'), 'using syntax must be preserved');
    ok(out.code.includes('const b = "x"'), 'typescript syntax must be stripped');
    ok(out.sourceMap, 'source map must be returned when sourceMapOptions is set');
    strictEqual(out.sourceMap!.version, 3);
    strictEqual(out.sourceMap!.file, 'output.js');
    strictEqual(out.sourceMap!.sources[0], 'input.ts');
    strictEqual(out.sourceMap!.names.length, 0);
    ok(out.sourceMap!.mappings.includes(';'), 'multi-line source must emit line separators');
});

// --- 4. Sucrase preserves runtime imports while eliding type-only imports ---

Deno.test('cts: sucrase distinguishes runtime imports from type-only imports', () => {
    const typeOnly = transform('import { Foo } from "m"; type T = Foo;', {
        transforms: ['typescript'],
    });
    ok(!typeOnly.code.includes('import { Foo }'), typeOnly.code);

    const runtime = transform('import { Foo as Bar, type Baz as Qux } from "m"; console.log(Bar);', {
        transforms: ['typescript'],
    });
    ok(runtime.code.includes('Foo as Bar'), runtime.code);
    ok(runtime.code.includes('console.log(Bar)'), runtime.code);
    ok(!runtime.code.includes('Baz'), runtime.code);
});

Deno.test('cts: CJS transform preserves import-equals require side effects', () => {
    const t = new Transformer();
    const out = t.transformForCjs('import test = require("./side-effect.js");', '<eval>.cts', 'cts');
    ok(out.includes('const test = require("./side-effect.js")'), out);
});

Deno.test('cts: CNO transform preserves runtime import attributes', () => {
    const t = new Transformer();
    const out = t.transform(
        'import bytes from "./hello.ts" with { type: "bytes" }; console.log(bytes);',
        'main.ts',
    );
    ok(out.includes('with { type: "bytes" }'), out);

    const generic = transform('import bytes from "./hello.ts" with { type: "bytes" }; console.log(bytes);', {
        transforms: ['typescript'],
    });
    ok(!generic.code.includes('with { type: "bytes" }'), generic.code);
});

// --- 5. Sucrase ignores shadowed imported names when eliding imports --------

Deno.test('cts: sucrase ignores shadowed imported names for import elision', () => {
    const out = transform('import { Foo } from "m"; function f(){ const Foo = 1; return Foo; }', {
        transforms: ['typescript'],
    });
    ok(!out.code.includes('import { Foo }'), out.code);
    ok(out.code.includes('const Foo = 1'), out.code);
});

// --- 6. Sucrase export type groups avoid re-export placeholders ------------

Deno.test('cts: sucrase export type groups only emit local placeholders', () => {
    const local = transform('export type { User, Admin };', {
        transforms: ['typescript'],
    });
    ok(local.code.includes('export const User = undefined;'), local.code);
    ok(local.code.includes('export const Admin = undefined;'), local.code);

    const reExport = transform('export type { User, Admin } from "./types";', {
        transforms: ['typescript'],
    });
    ok(!reExport.code.includes('User'), reExport.code);
    ok(!reExport.code.includes('Admin'), reExport.code);
    ok(!reExport.code.includes('undefined'), reExport.code);
});

// --- 7. Sucrase preserves QJS-native class field syntax --------------------

Deno.test('cts: sucrase preserves native class fields when ES transforms are disabled', () => {
    const out = transform('class A { public x: number; static accessor y: string = "y"; declare accessor z: boolean; }', {
        transforms: ['typescript'],
        disableESTransforms: true,
    });
    ok(out.code.includes('class A {  x; static  y = "y"; ; }'), out.code);
    ok(!out.code.includes('accessor'), out.code);
});

// --- 8. Sucrase processes native class field initializers in output pass ----

Deno.test('cts: sucrase native class field initializers are transformed once', () => {
    const out = transform('class A { view = <span />; }', {
        transforms: ['typescript', 'jsx'],
        disableESTransforms: true,
        filePath: 'field.tsx',
    });
    ok(out.code.includes('class A { view = React.createElement'), out.code);
    ok(!out.code.includes('__init'), out.code);
});

// --- 9. Sucrase emits compact modern JS for simple enums -------------------

Deno.test('cts: sucrase emits compact modern enum literals', () => {
    const out = transform('enum E { A, B = 1_000, C, D = "d" }', {
        transforms: ['typescript'],
        disableESTransforms: true,
    });
    ok(out.code.includes('var E = {...E'), out.code);
    ok(!out.code.includes('(function (E)'), out.code);
    ok(out.code.includes('["A"]: 0'), out.code);
    ok(out.code.includes('["B"]: 1_000'), out.code);
    ok(out.code.includes('[1_000]: "B"'), out.code);
    ok(out.code.includes('["C"]: 1001'), out.code);
    ok(out.code.includes('["D"]: "d"'), out.code);

    const negative = transform('enum N { A = -1_000, B }', {
        transforms: ['typescript'],
        disableESTransforms: true,
    });
    ok(negative.code.includes('["A"]: -1_000'), negative.code);
    ok(negative.code.includes('[-1_000]: "A"'), negative.code);
    ok(negative.code.includes('["B"]: -999'), negative.code);
});

// --- 10. Sucrase lazily claims generated names without collisions ----------

Deno.test('cts: sucrase generated names avoid source collisions', () => {
    const out = transform('const _jsxFileName = 1; <div />;', {
        transforms: ['jsx'],
        filePath: 'x.jsx',
    });
    ok(out.code.includes('const _jsxFileName2 = "x.jsx";'), out.code);
    ok(out.code.includes('fileName: _jsxFileName2'), out.code);
});

// --- 11. Sucrase JSX-only keeps ESM syntax without type import work --------

Deno.test('cts: sucrase jsx-only transform preserves imports and exports', () => {
    const out = transform('import React from "react"; export const node = <div />; export { node as view };', {
        transforms: ['jsx'],
        filePath: 'view.jsx',
    });
    ok(out.code.includes('import React from "react";'), out.code);
    ok(out.code.includes('export const node = React.createElement'), out.code);
    ok(out.code.includes('export { node as view };'), out.code);
});

// --- 12. Sucrase automatic JSX runtime keeps compact imports ---------------

Deno.test('cts: sucrase automatic jsx runtime emits direct import list', () => {
    const out = transform('const node = <><span />text</>;', {
        transforms: ['jsx'],
        jsxRuntime: 'automatic',
        filePath: 'auto.jsx',
    });
    ok(/import \{[^}]*jsxDEV as _jsxDEV[^}]*\} from "react\/jsx-dev-runtime";/.test(out.code), out.code);
    ok(/import \{[^}]*Fragment as _Fragment[^}]*\} from "react\/jsx-dev-runtime";/.test(out.code), out.code);
    ok(out.code.includes('_jsxDEV(_Fragment'), out.code);
});

// --- 13. Sucrase JSX string whitespace avoids regex regressions ------------

Deno.test('cts: sucrase jsx string whitespace and entities are preserved', () => {
    const out = transform(`const node = <div title="a
	 b &amp; c &quot;q&quot; &apos;s&apos; &lt;x&gt;">x
  y &#33; &#x3f;</div>;`, {
        transforms: ['jsx'],
        filePath: 'space.jsx',
    });
    ok(out.code.includes('title: "a b & c \\"q\\" \'s\' <x>"'), out.code);
    ok(out.code.includes('"x y ! ?"'), out.code);
});

// --- 14. Sucrase JSX hyphenated props stay quoted --------------------------

Deno.test('cts: sucrase jsx hyphenated props stay quoted', () => {
    const out = transform('const node = <div data-id="a" />;', {
        transforms: ['jsx'],
        filePath: 'prop.jsx',
    });
    ok(out.code.includes("'data-id': \"a\""), out.code);
});

// --- 15. Sucrase preserves duplicate JSX key line mapping without regex ----

Deno.test('cts: sucrase duplicate jsx keys preserve discarded key newlines', () => {
    const out = transform('const node = <div key={first(\n1,\n2)} key={second} />;', {
        transforms: ['jsx'],
        jsxRuntime: 'automatic',
        filePath: 'dup.jsx',
    });
    ok(out.code.includes('{\n\n}'), out.code);
    ok(!out.code.includes('first'), out.code);
    ok(out.code.includes('second'), out.code);
});

// --- 16. Sucrase Flow pragma removal preserves surrounding trivia ----------

Deno.test('cts: sucrase flow pragma removal preserves trivia', () => {
    const out = transform('// @flow\nconst x: number = 1;\n', {
        transforms: ['flow'],
    });
    strictEqual(out.code, '// \nconst x = 1;\n');
});

// --- 17. Sucrase tokenizer lookahead skips comments without regex ----------

Deno.test('cts: sucrase tokenizer lookahead skips comments without regex', () => {
    const out = transform('const a: number = 1 /* block */\n// line\nconst b: string = "b";', {
        transforms: ['typescript'],
    });
    ok(out.code.includes('const a = 1'), out.code);
    ok(out.code.includes('const b = "b"'), out.code);
});

// --- 18. Sucrase tokenizer lookahead handles TS const enum -----------------

Deno.test('cts: sucrase tokenizer lookahead handles const enum', () => {
    const out = transform('const enum Mode { Read, Write }', {
        transforms: ['typescript'],
    });
    ok(out.code.includes('var Mode = {...Mode'), out.code);
    ok(out.code.includes('["Read"]: 0'), out.code);
});

// --- 19. Sucrase TSX fragment keeps runtime React import -------------------

Deno.test('cts: sucrase tsx fragment import elision keeps React', () => {
    const out = transform('import React, { type FC } from "react"; const node = <>x</>;', {
        transforms: ['typescript', 'jsx'],
        filePath: 'frag.tsx',
    });
    ok(out.code.includes('import React'), out.code);
    ok(out.code.includes('React.Fragment'), out.code);
    ok(!out.code.includes('FC'), out.code);
});

// --- 20. Sucrase displayName derives index names without path splitting ----

Deno.test('cts: sucrase react displayName uses parent directory for index files', () => {
    const out = transform('export default React.createClass({render(){return <div />;}});', {
        transforms: ['jsx'],
        filePath: 'components/Card/index.jsx',
    });
    ok(out.code.includes("displayName: 'Card'"), out.code);
});

// --- 21. resolveExports: "exports" "." maps to declared file ---------------

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

// --- 22. resolveExports: subpath "./utils" resolves under exports -----------

Deno.test('cts: resolveExports maps "./utils" to subpath target', () => {
    const dir = new URL('./fixtures/cts-pkg-exports/', import.meta.url).pathname;
    clearPkgCache();
    const ctx = createCtx(dir)!;
    const r = resolveExports(ctx, './utils');
    ok(r, 'resolveExports("./utils") must resolve');
    ok(r!.path.endsWith('utils.js'), `expected utils.js, got ${r!.path}`);
});

// --- 23. resolveExports: unknown subpath returns null ---------------------

Deno.test('cts: resolveExports returns null for an unmapped subpath', () => {
    const dir = new URL('./fixtures/cts-pkg-exports/', import.meta.url).pathname;
    clearPkgCache();
    const ctx = createCtx(dir)!;
    const r = resolveExports(ctx, './nope');
    strictEqual(r, null, 'unmapped subpath must resolve to null');
});

// --- 24. normalizeBinField: string and object forms ------------------------

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
