import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { extractImports, isScannablePath, isTsLikePath, isWasmPath } from '../../cts/src/scan.ts';
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
        const cjs = require('./cjs');
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
        './cjs',
    ]));
});

Deno.test('cts scan: dedupes imports and ignores invalid source', () => {
    deepStrictEqual(extractImports('const x = 1;'), []);
    deepStrictEqual(extractImports('import {'), []);
    deepStrictEqual(extractImports(`
        import './same';
        export * from './same';
        require('./same');
    `), ['./same']);
});

Deno.test('cts scan: path helpers match scan extension policy', () => {
    for (const path of ['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.d.ts']) {
        ok(isScannablePath(path), path);
    }
    for (const path of ['a.cts', 'a.mts', 'a.d.cts', 'a.json', 'a.wasm']) {
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
        strictEqual(detectFormat(write(packageDir, 'esm.js', 'export const value = 1;\n')), 'esm');
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
        write(root, 'extensionless');
        writeFileSync(joinPaths(root, 'package.json'), JSON.stringify({
            type: 'module',
            module: './module-entry.js',
            main: './main-entry.cjs',
        }));

        clearPkgCache();
        const esmCtx = createCtx(root)!;
        const cjsCtx = createCtx(root, { forceCjs: true })!;
        strictEqual(resolveMain(esmCtx)?.path, joinPaths(root, 'module-entry.js'));
        strictEqual(resolveMain(esmCtx)?.format, 'esm');
        strictEqual(resolveMain(cjsCtx)?.path, joinPaths(root, 'main-entry.cjs'));
        strictEqual(resolveMain(cjsCtx)?.format, 'cjs');
        strictEqual(resolveSubpath(esmCtx, './sub'), null);
        strictEqual(resolveSubpath(cjsCtx, './sub')?.path, joinPaths(root, 'sub/index.js'));
        strictEqual(resolveSubpath(esmCtx, './extensionless')?.format, 'cjs');
        strictEqual(resolveSubpath(esmCtx, './extensionless')?.fileKind, 'source');
        strictEqual(resolveSubpath(esmCtx, './missing'), null);
    } finally {
        clearPkgCache();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts pkg: resolveExports tries array fallbacks in order', () => {
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
        strictEqual(resolveExports(ctx, '.')?.path, joinPaths(root, 'ok.js'));
    } finally {
        clearPkgCache();
        rmSync(root, { recursive: true, force: true });
    }
});
