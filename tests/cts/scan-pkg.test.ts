import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import {
    extractImports,
    isScannablePath,
    isTsLikePath,
    isWasmPath,
} from '../../cts/src/scan.ts';
import {
    clearPkgCache,
    createCtx,
    detectFormat,
    resolveExports,
    resolveImports,
    resolveMain,
    resolveSubpath,
} from '../../cts/src/resolve/pkg.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';

function write(root: string, rel: string, content = ''): string {
    const file = joinPaths(root, rel);
    mkdirSync(join(root, ...rel.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(file, content);
    return file;
}

function sorted(values: string[]): string[] {
    return values.slice().sort();
}

Deno.test('cts scan: extracts runtime imports and skips type-only references', () => {
    const imports = extractImports(`
        import './side-effect';
        import value, { named } from './value';
        import json from './config.json' with { type: 'json' };
        import type { Shape } from './types';
        import type * as TypeNS from './type-ns';
        import type DefaultType from './default-type';
        import type from './binding-named-type';
        export { named as renamed } from './re-export';
        export type { Exported } from './export-types';
        export * from './star';
        const dynamic = import('./dynamic');
        const dynamicWithOptions = import('./dynamic-json', { with: { type: 'json' } });
        const computedDynamic = import('./prefix/' + name);
        const cjs = require('./cjs');
        const computedCjs = require('./prefix/' + name);
        const ignored = require(name);
    `);

    deepStrictEqual(sorted(imports), sorted([
        './side-effect',
        './value',
        './config.json',
        './binding-named-type',
        './re-export',
        './star',
        './dynamic',
        './dynamic-json',
        './cjs',
    ]));
});

Deno.test('cts scan: dedupes imports and ignores invalid source', () => {
    deepStrictEqual(extractImports('const x = 1;'), []);
    deepStrictEqual(extractImports('import {'), []);
    throws(() => extractImports('import {', true, true));
    deepStrictEqual(extractImports(`
        import './same';
        export * from './same';
        require('./same');
    `), ['./same']);
});

Deno.test('cts scan: finds from-clause after a long named import list', () => {
    // multiaddr registry.js-style: dozens of named bindings exceed the old
    // 80-token findFromString window and dropped "./constants.js" from the
    // pack edge table (compile then failed with "no static edge").
    const names = Array.from({ length: 50 }, (_, i) => `CODE_${i}`).join(', ');
    const source = `import { ${names} } from "./constants.js";\nimport { x } from "./errors.js";\n`;
    deepStrictEqual(sorted(extractImports(source, false)), sorted([
        './constants.js',
        './errors.js',
    ]));
});

Deno.test('cts scan: path helpers match scan extension policy', () => {
    // .mts/.cts are TS-family sources and must be scanned (require/import graph).
    for (const path of ['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.mts', 'a.cts', 'a.d.ts', 'a.d.cts']) {
        ok(isScannablePath(path), path);
    }
    for (const path of ['a.json', 'a.wasm']) {
        strictEqual(isScannablePath(path), false, path);
    }
    for (const path of ['a.ts', 'a.tsx', 'a.mts', 'a.mtsx', 'a.cts', 'a.ctsx']) {
        ok(isTsLikePath(path), path);
    }
    strictEqual(isTsLikePath('a.jsx'), false);
    ok(isWasmPath('mod.wasm'));
    strictEqual(isWasmPath('mod.wasm.js'), false);
});

Deno.test('cts pkg: detectFormat follows extension, package type and deno defaults', () => {
    const root = makePosixTempDir('pkg-format');
    try {
        clearPkgCache();
        strictEqual(detectFormat(write(root, 'esm.mjs')), 'esm');
        strictEqual(detectFormat(write(root, 'cjs.cjs')), 'cjs');

        const moduleDir = joinPaths(root, 'module');
        mkdirSync(moduleDir, { recursive: true });
        writeFileSync(joinPaths(moduleDir, 'package.json'), JSON.stringify({ type: 'module' }));
        strictEqual(detectFormat(write(moduleDir, 'index.js')), 'esm');

        const commonDir = joinPaths(root, 'common');
        mkdirSync(commonDir, { recursive: true });
        writeFileSync(joinPaths(commonDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
        strictEqual(detectFormat(write(commonDir, 'index.js')), 'cjs');

        const denoDir = joinPaths(root, 'deno');
        mkdirSync(denoDir, { recursive: true });
        writeFileSync(joinPaths(denoDir, 'deno.json'), '{}');
        strictEqual(detectFormat(write(denoDir, 'index.js')), 'esm');

        const plainDir = joinPaths(root, 'plain');
        mkdirSync(plainDir, { recursive: true });
        strictEqual(detectFormat(write(plainDir, 'index.js')), 'esm');

        const packageDir = joinPaths(root, 'package');
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(joinPaths(packageDir, 'package.json'), JSON.stringify({ name: 'pkg' }));
        strictEqual(detectFormat(write(packageDir, 'index.js')), 'cjs');
        strictEqual(detectFormat(write(packageDir, 'esm.js', 'export const value = 1;\n')), 'cjs');
    } finally {
        clearPkgCache();
        rmSync(root, { recursive: true, force: true });
    }
});

// Node's rule for a `.js` file with no package.json anywhere up the tree is
// CommonJS when it is reached by require(). cno keeps the Deno-style ESM default
// for the import side, so the same path answers differently per context and both
// answers have to be pinned: a regression in either direction is silent, and
// getting require() wrong makes a plain `module.exports = 7` child die with
// "ReferenceError: module is not defined" on its first line.
Deno.test('cts pkg: detectFormat splits require and import for no-package.json .js', () => {
    const root = makePosixTempDir('pkg-format-kind');
    try {
        clearPkgCache();
        const bare = write(root, 'bare/child.js', 'module.exports = 7;\n');

        strictEqual(detectFormat(bare, 'require'), 'cjs', 'require() of a no-manifest .js is CJS (node)');
        strictEqual(detectFormat(bare, 'import'), 'esm', 'import of a no-manifest .js stays Deno-style ESM');
        strictEqual(detectFormat(bare), 'esm', 'default kind is the import side');

        // Extension always wins over context, in both directions.
        const mjs = write(root, 'bare/m.mjs');
        const cjs = write(root, 'bare/c.cjs');
        strictEqual(detectFormat(mjs, 'require'), 'esm');
        strictEqual(detectFormat(mjs, 'import'), 'esm');
        strictEqual(detectFormat(cjs, 'require'), 'cjs');
        strictEqual(detectFormat(cjs, 'import'), 'cjs');

        // A manifest resolves both contexts identically — only the no-manifest
        // tail is context-dependent.
        const noType = joinPaths(root, 'notype');
        mkdirSync(noType, { recursive: true });
        writeFileSync(joinPaths(noType, 'package.json'), JSON.stringify({ name: 'notype' }));
        const noTypeJs = write(noType, 'index.js');
        strictEqual(detectFormat(noTypeJs, 'require'), 'cjs');
        strictEqual(detectFormat(noTypeJs, 'import'), 'cjs');

        const moduleType = joinPaths(root, 'moduletype');
        mkdirSync(moduleType, { recursive: true });
        writeFileSync(joinPaths(moduleType, 'package.json'), JSON.stringify({ type: 'module' }));
        const moduleJs = write(moduleType, 'index.js');
        strictEqual(detectFormat(moduleJs, 'require'), 'esm');
        strictEqual(detectFormat(moduleJs, 'import'), 'esm');

        // deno.json stays ESM in both contexts.
        const denoDir = joinPaths(root, 'denodir');
        mkdirSync(denoDir, { recursive: true });
        writeFileSync(joinPaths(denoDir, 'deno.json'), '{}');
        const denoJs = write(denoDir, 'index.js');
        strictEqual(detectFormat(denoJs, 'require'), 'esm');
        strictEqual(detectFormat(denoJs, 'import'), 'esm');
    } finally {
        clearPkgCache();
        rmSync(root, { recursive: true, force: true });
    }
});

// The format caches are keyed by path only, so a naive per-context answer stored
// under a shared key would let whichever context ran first dictate the other's
// result. The caches store the *reason* (no manifest found) instead, so both
// query orders must produce both answers.
Deno.test('cts pkg: no-package.json format cache is not poisoned by query order', () => {
    const root = makePosixTempDir('pkg-format-cache');
    try {
        // import first, then require, on one path.
        clearPkgCache();
        const a = write(root, 'a/child.js');
        strictEqual(detectFormat(a, 'import'), 'esm');
        strictEqual(detectFormat(a, 'require'), 'cjs', 'import first must not pin the require answer');

        // require first, then import, on one path.
        clearPkgCache();
        const b = write(root, 'b/child.js');
        strictEqual(detectFormat(b, 'require'), 'cjs');
        strictEqual(detectFormat(b, 'import'), 'esm', 'require first must not pin the import answer');

        // Warm, no clear: the directory walk back-fills every visited parent, so
        // a sibling deeper in the same manifest-less tree must still answer per
        // context rather than inheriting the first caller's format.
        const deep = write(root, 'b/nested/deeper/child.js');
        strictEqual(detectFormat(deep, 'require'), 'cjs');
        strictEqual(detectFormat(deep, 'import'), 'esm');
        const sibling = write(root, 'b/nested/deeper/other.js');
        strictEqual(detectFormat(sibling, 'import'), 'esm');
        strictEqual(detectFormat(sibling, 'require'), 'cjs');
    } finally {
        clearPkgCache();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts pkg: resolveExports honors import/require conditions and wildcard maps', () => {
    const root = makePosixTempDir('pkg-exports');
    try {
        write(root, 'esm.js');
        write(root, 'cjs.cjs');
        write(root, 'fallback.js');
        write(root, 'features/a.js');
        write(root, 'features/b.js');
        writeFileSync(joinPaths(root, 'package.json'), JSON.stringify({
            type: 'module',
            exports: {
                '.': {
                    import: './esm.js',
                    require: './cjs.cjs',
                    default: './fallback.js',
                },
                './features/*': './features/*.js',
            },
        }));

        clearPkgCache();
        const esmCtx = createCtx(root)!;
        const cjsCtx = createCtx(root, { forceCjs: true })!;

        strictEqual(resolveExports(esmCtx, '.')?.path, joinPaths(root, 'esm.js'));
        strictEqual(resolveExports(esmCtx, '.')?.format, 'esm');
        strictEqual(resolveExports(cjsCtx, '.')?.path, joinPaths(root, 'cjs.cjs'));
        strictEqual(resolveExports(cjsCtx, '.')?.format, 'cjs');
        strictEqual(resolveExports(esmCtx, './features/a')?.path, joinPaths(root, 'features/a.js'));
        strictEqual(resolveExports(esmCtx, './missing'), null);
    } finally {
        clearPkgCache();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts pkg: package maps preserve declaration order and explicit blocks', () => {
    const root = makePosixTempDir('pkg-exports-order');
    try {
        write(root, 'default.js');
        write(root, 'import.js');
        write(root, 'private.js');
        write(root, 'fallback/private.js');
        write(root, 'specific/item.js');
        write(root, 'generated/item/item.js');
        write(root, 'extensionless.js');
        write(root, 'sync.js');
        write(root, 'addon.node');
        write(root, 'with-suffix.js');
        writeFileSync(joinPaths(root, 'package.json'), JSON.stringify({
            type: 'module',
            exports: {
                '.': {
                    default: './default.js',
                    import: './import.js',
                },
                './private': null,
                './feature/*': './specific/*',
                './double/*': './generated/*/*.js',
                './*': './fallback/*',
                './extensionless': './extensionless',
                './sync': {
                    'module-sync': './sync.js',
                    import: './import.js',
                },
                './addon': {
                    'node-addons': './addon.node',
                    default: './default.js',
                },
                './with-suffix': './with-suffix.js?mode=x#frag',
                './empty*': './fallback/*',
                './many**': './fallback/*',
            },
            imports: {
                '#ordered': {
                    default: './default.js',
                    import: './import.js',
                },
                '#private': null,
                '#external': 'dep/subpath',
                '#exact': './internal',
                '#with-suffix': './with-suffix.js?mode=x#frag',
                '#many**': './fallback/*.js',
                '#*': './fallback/*.js',
            },
        }));

        clearPkgCache();
        const ctx = createCtx(root)!;
        strictEqual(resolveExports(ctx, '.')?.path, joinPaths(root, 'default.js'));
        strictEqual(resolveExports(ctx, './private'), null, 'exact null must block wildcard fallback');
        strictEqual(resolveExports(ctx, './feature/item.js')?.path, joinPaths(root, 'specific/item.js'));
        strictEqual(resolveExports(ctx, './double/item')?.path, joinPaths(root, 'generated/item/item.js'));
        strictEqual(resolveExports(ctx, './extensionless')?.path, joinPaths(root, 'extensionless'));
        strictEqual(resolveExports(ctx, './sync')?.path, joinPaths(root, 'sync.js'));
        strictEqual(resolveExports(ctx, './addon')?.path, joinPaths(root, 'addon.node'));
        strictEqual(resolveExports(ctx, './with-suffix')?.path, joinPaths(root, 'with-suffix.js'));
        strictEqual(resolveExports(ctx, './with-suffix')?.specifierSuffix, '?mode=x#frag');
        strictEqual(resolveExports(ctx, './empty')?.path, joinPaths(root, 'fallback/empty'),
            'empty wildcard matches must fall through to the catch-all');
        strictEqual(resolveExports(ctx, './many-value')?.path, joinPaths(root, 'fallback/many-value'),
            'keys with multiple wildcards must fall through to the catch-all');
        strictEqual(resolveImports(ctx, '#ordered')?.path, joinPaths(root, 'default.js'));
        strictEqual(resolveImports(ctx, '#private'), null, 'exact imports null must block wildcard fallback');
        strictEqual(resolveImports(ctx, '#external')?.path, 'dep/subpath');
        strictEqual(resolveImports(ctx, '#external')?.externalSpecifier, true);
        strictEqual(resolveImports(ctx, '#exact')?.path, joinPaths(root, 'internal'),
            'imports targets must not use extension probing');
        strictEqual(resolveImports(ctx, '#with-suffix')?.path, joinPaths(root, 'with-suffix.js'));
        strictEqual(resolveImports(ctx, '#with-suffix')?.specifierSuffix, '?mode=x#frag');
        strictEqual(resolveImports(ctx, '#many-value')?.path, joinPaths(root, 'fallback/many-value.js'),
            'valid fallback wildcard must win after rejecting a multi-wildcard key');
    } finally {
        clearPkgCache();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts pkg: package map errors and array fallbacks match Node', () => {
    const root = makePosixTempDir('pkg-map-errors');
    try {
        write(root, 'ok.js');
        const setPackage = (exports: unknown, type = 'module') => {
            writeFileSync(joinPaths(root, 'package.json'), JSON.stringify({ type, exports }));
            clearPkgCache();
            return createCtx(root)!;
        };
        const hasCode = (code: string) => (error: NodeJS.ErrnoException) => {
            strictEqual(error.code, code);
            return true;
        };

        throws(() => resolveExports(setPackage({
            '.': './ok.js',
            default: './ok.js',
        }), '.'), hasCode('ERR_INVALID_PACKAGE_CONFIG'));

        throws(() => resolveExports(setPackage({
            '.': { import: '../bad.js', default: './ok.js' },
        }), '.'), hasCode('ERR_INVALID_PACKAGE_TARGET'));

        strictEqual(resolveExports(setPackage({
            '.': ['../bad.js', './ok.js'],
        }), '.')?.path, joinPaths(root, 'ok.js'));
        strictEqual(resolveExports(setPackage({
            '.': ['../bad.js', null],
        }), '.'), null);

        throws(() => resolveExports(setPackage({ '.': './foo%2fbar.js' }), '.'),
            hasCode('ERR_INVALID_MODULE_SPECIFIER'));

        const requireCtx = setPackage({ '.': { require: './ok.js' } });
        const requireJs = resolveExports({ ...requireCtx, forceCjs: true }, '.');
        strictEqual(requireJs?.format, 'esm', 'require condition must not override package type');
        const importJs = resolveExports(setPackage({ '.': { import: './ok.js' } }, 'commonjs'), '.');
        strictEqual(importJs?.format, 'cjs', 'import condition must not override package type');
    } finally {
        clearPkgCache();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts pkg: resolveImports handles direct and wildcard package imports', () => {
    const root = makePosixTempDir('pkg-imports');
    try {
        write(root, 'internal.js');
        write(root, 'lib/foo.js');
        write(root, 'src/add.js');
        writeFileSync(joinPaths(root, 'package.json'), JSON.stringify({
            imports: {
                '#internal': './internal.js',
                '#lib/*': './lib/*.js',
                '#/*': './src/*.js',
            },
        }));

        clearPkgCache();
        const ctx = createCtx(root)!;
        strictEqual(resolveImports(ctx, '#internal')?.path, joinPaths(root, 'internal.js'));
        strictEqual(resolveImports(ctx, '#lib/foo')?.path, joinPaths(root, 'lib/foo.js'));
        strictEqual(resolveImports(ctx, '#/add')?.path, joinPaths(root, 'src/add.js'));
        strictEqual(resolveImports(ctx, '#none'), null);
        for (const spec of ['#', '#foo/']) {
            throws(() => resolveImports(ctx, spec), (error: NodeJS.ErrnoException) => {
                strictEqual(error.code, 'ERR_INVALID_MODULE_SPECIFIER');
                return true;
            });
        }
    } finally {
        clearPkgCache();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts pkg: resolveMain and resolveSubpath keep ESM subpaths strict but CJS fallbacks wide', () => {
    const root = makePosixTempDir('pkg-main');
    try {
        write(root, 'module-entry.js');
        write(root, 'main-entry.cjs');
        write(root, 'sub/index.js');
        write(root, 'extensionless', 'module.exports = 1;\n');
        const untypedDir = joinPaths(root, 'untyped');
        write(root, 'untyped/extensionless', 'export const value = 1;\n');
        writeFileSync(joinPaths(untypedDir, 'package.json'), JSON.stringify({ name: 'untyped' }));
        writeFileSync(joinPaths(root, 'package.json'), JSON.stringify({
            type: 'module',
            module: './module-entry.js',
            main: './main-entry.cjs',
        }));

        clearPkgCache();
        const esmCtx = createCtx(root)!;
        const cjsCtx = createCtx(root, { forceCjs: true })!;
        const untypedCtx = createCtx(untypedDir)!;
        strictEqual(resolveMain(esmCtx)?.path, joinPaths(root, 'module-entry.js'));
        strictEqual(resolveMain(esmCtx)?.format, 'esm');
        strictEqual(resolveMain(cjsCtx)?.path, joinPaths(root, 'main-entry.cjs'));
        strictEqual(resolveMain(cjsCtx)?.format, 'cjs');
        strictEqual(resolveSubpath(esmCtx, './sub'), null);
        strictEqual(resolveSubpath(cjsCtx, './sub')?.path, joinPaths(root, 'sub/index.js'));
        strictEqual(resolveSubpath(esmCtx, './module-entry'), null);
        strictEqual(resolveSubpath(cjsCtx, './module-entry')?.path, joinPaths(root, 'module-entry.js'));
        strictEqual(resolveSubpath(esmCtx, './extensionless')?.format, 'esm');
        strictEqual(resolveSubpath(cjsCtx, './extensionless')?.format, 'esm');
        strictEqual(resolveSubpath(esmCtx, './extensionless')?.fileKind, 'source');
        strictEqual(resolveSubpath(untypedCtx, './extensionless')?.format, 'cjs');
        strictEqual(resolveSubpath(esmCtx, './missing'), null);
    } finally {
        clearPkgCache();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts pkg: exports arrays preserve the first valid target URL', () => {
    const root = makePosixTempDir('pkg-array-exports');
    try {
        write(root, 'ok.js');
        writeFileSync(joinPaths(root, 'package.json'), JSON.stringify({
            exports: {
                '.': ['./missing.js', './ok.js'],
            },
        }));

        clearPkgCache();
        const ctx = createCtx(root)!;
        strictEqual(resolveExports(ctx, '.')?.path, joinPaths(root, 'missing.js'));
    } finally {
        clearPkgCache();
        rmSync(root, { recursive: true, force: true });
    }
});
