import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { createConfig, parseSize, loadConfigFile } from '../../cts/src/config.ts';
import { err, ErrorKind, formatError, TransformError } from '../../cts/src/errors.ts';
import { runSync, StepType } from '../../cts/src/flow.ts';
import { LockStore } from '../../cts/src/lock.ts';
import { applyAttrType, guessFileKind, isTypeDecl, validateAttrType } from '../../cts/src/resolve/protocols/base.ts';
import { DataHandler } from '../../cts/src/resolve/protocols/data.ts';
import { NpmHandler } from '../../cts/src/resolve/protocols/npm.ts';
import { ModuleResolver } from '../../cts/src/resolve/index.ts';
import { isRemote, JscCache } from '../../cts/src/source/cache.ts';
import { moduleRef, moduleViewRef } from '../../cts/src/types.ts';
import { dirname, joinPaths, parentDirKey } from '../../cts/src/utils/path.ts';

/**
 * A ModuleResolver owns a SQLite handle on cts.lock. SQLite opens through its
 * own Win32 VFS, which does not set FILE_SHARE_DELETE, so the lock dir cannot
 * be removed while the handle is live — teardown must close first.
 */
function closeResolverQuietly(resolver: ModuleResolver | null): void {
    try {
        resolver?.close();
    } catch {}
}

function decodeBytes(data: Uint8Array | ArrayBuffer): string {
    return decodeUtf8(new Uint8Array(data));
}

Deno.test('cts config: parseSize accepts common units and rejects malformed values', () => {
    strictEqual(parseSize(undefined), undefined);
    strictEqual(parseSize('512'), 512);
    strictEqual(parseSize('1.5KB'), 1536);
    strictEqual(parseSize('2 MB'), 2 * 1024 * 1024);
    strictEqual(parseSize('1GB'), 1024 ** 3);
    throws(() => parseSize('large'), /Invalid size/);
});

Deno.test('cts config: loadConfigFile merges tsconfig deno import maps and package cts mode', () => {
    const root = makePosixTempDir('load-config');
    try {
        const subdir = joinPaths(root, 'src', 'nested');
        mkdirSync(join(root, 'src', 'nested'), { recursive: true });
        writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
                baseUrl: './src',
                paths: { '@ts/*': ['./ts/*'] },
            },
        }));
        writeFileSync(join(root, 'import_map.json'), JSON.stringify({
            imports: {
                'mapped/': './mapped/',
                '#private': './private.ts',
                ignored: { target: './bad.ts' },
            },
        }));
        writeFileSync(join(root, 'deno.jsonc'), `{
            "imports": {
                "std/": "https://deno.land/std/",
                "#internal": "./internal.ts",
                "bad": { "not": "string" }
            },
            "importMap": "./import_map.json",
            "compilerOptions": {
                "paths": { "@deno/*": ["./deno/*"] }
            }
        }`);
        writeFileSync(join(root, 'package.json'), JSON.stringify({
            imports: {
                'pkg-alias': './pkg.ts',
                '#pkg-private': './private.ts',
            },
            cts: { nodeModulesMode: 'soft' },
        }));

        const cfg = loadConfigFile(subdir);
        strictEqual(cfg.baseUrl, joinPaths(root, './src'));
        deepStrictEqual(cfg.pathAliases, {
            '@ts/*': ['./ts/*'],
            '@deno/*': ['./deno/*'],
        });
        deepStrictEqual(cfg.importMap, {
            'pkg-alias': joinPaths(root, 'pkg.ts'),
            'std/': 'https://deno.land/std/',
            'mapped/': joinPaths(root, 'mapped/'),
        });
        strictEqual(cfg.nodeModulesMode, 'soft');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts config: external import map targets resolve from the map file', () => {
    const root = makePosixTempDir('external-import-map-base');
    try {
        const mapDir = joinPaths(root, 'config', 'maps');
        const target = joinPaths(mapDir, 'targets', 'dep.ts');
        mkdirSync(join(mapDir, 'targets'), { recursive: true });
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'deno.json'), JSON.stringify({
            importMap: './config/maps/import_map.json',
        }));
        writeFileSync(join(mapDir, 'import_map.json'), JSON.stringify({
            imports: { dep: './targets/dep.ts' },
        }));
        writeFileSync(target, 'export const value = 1;\n');

        const fileCfg = loadConfigFile(joinPaths(root, 'src'));
        strictEqual(fileCfg.importMap?.dep, target);

        const resolver = new ModuleResolver(createConfig({
            ...fileCfg,
            cacheDir: joinPaths(root, 'cache'),
            disableLock: true,
            enableOxc: false,
            silent: true,
        }), root, true);
        const info = resolver.resolve('dep', joinPaths(root, 'src', 'entry.ts'));
        strictEqual(info.localPath, target);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver: import map suffixes stay out of mapped physical paths', async () => {
    const root = makePosixTempDir('import-map-suffix');
    try {
        const mapDir = joinPaths(root, 'config');
        const target = joinPaths(mapDir, 'targets', 'dep.ts');
        mkdirSync(join(mapDir, 'targets'), { recursive: true });
        writeFileSync(join(root, 'deno.json'), JSON.stringify({ importMap: './config/import_map.json' }));
        writeFileSync(join(mapDir, 'import_map.json'), JSON.stringify({
            imports: {
                exact: './targets/dep.ts?mode=exact#fragment',
                'prefix/': './targets/',
            },
        }));
        writeFileSync(target, 'export const value = 1;\n');

        const resolver = new ModuleResolver(createConfig({
            ...loadConfigFile(root),
            cacheDir: joinPaths(root, 'cache'),
            disableLock: true,
            enableOxc: false,
            silent: true,
        }), root, true);
        const exact = resolver.resolve('exact', joinPaths(root, 'entry.ts'));
        const prefix = await resolver.resolveAsync(
            'prefix/dep.ts?mode=prefix#fragment',
            joinPaths(root, 'entry.ts'),
        );

        strictEqual(exact.localPath, target);
        strictEqual(exact.specPath, `${target}?mode=exact#fragment`);
        strictEqual(prefix.localPath, target);
        strictEqual(prefix.specPath, `${target}?mode=prefix#fragment`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver: import map scopes use longest parent match with global fallback', () => {
    const root = makePosixTempDir('import-map-scopes');
    try {
        mkdirSync(join(root, 'src', 'nested'), { recursive: true });
        writeFileSync(join(root, 'deno.json'), JSON.stringify({
            imports: {
                dep: './global.ts',
                fallback: './global-fallback.ts',
            },
            scopes: {
                './src/': {
                    dep: './scoped.ts',
                    'outer-only': './outer.ts',
                },
                './src/nested/': { dep: './nested.ts' },
            },
        }));
        writeFileSync(join(root, 'global.ts'), 'export const source = "global";\n');
        writeFileSync(join(root, 'global-fallback.ts'), 'export const source = "fallback";\n');
        writeFileSync(join(root, 'scoped.ts'), 'export const source = "scoped";\n');
        writeFileSync(join(root, 'nested.ts'), 'export const source = "nested";\n');
        writeFileSync(join(root, 'outer.ts'), 'export const source = "outer";\n');

        const fileCfg = loadConfigFile(joinPaths(root, 'src', 'nested'));
        const resolver = new ModuleResolver(createConfig({
            ...fileCfg,
            cacheDir: joinPaths(root, 'cache'),
            disableLock: true,
            enableOxc: false,
            silent: true,
        }), root, true);

        strictEqual(
            resolver.resolve('dep', joinPaths(root, 'src', 'entry.ts')).localPath,
            joinPaths(root, 'scoped.ts'),
        );
        strictEqual(
            resolver.resolve('dep', `file://${joinPaths(root, 'src', 'nested', 'entry.ts')}`).localPath,
            joinPaths(root, 'nested.ts'),
        );
        strictEqual(
            resolver.resolve('fallback', joinPaths(root, 'src', 'nested', 'entry.ts')).localPath,
            joinPaths(root, 'global-fallback.ts'),
        );
        strictEqual(
            resolver.resolve('outer-only', joinPaths(root, 'src', 'nested', 'entry.ts')).localPath,
            joinPaths(root, 'outer.ts'),
        );
        strictEqual(
            resolver.resolve('dep', joinPaths(root, 'outside.ts')).localPath,
            joinPaths(root, 'global.ts'),
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver upstream: ESM package subpaths do not add extensions or directory indexes', () => {
    const root = makePosixTempDir('resolver-esm-package-subpath-strict');
    try {
        const pkgDir = join(root, 'node_modules', 'package');
        mkdirSync(join(pkgDir, 'dir'), { recursive: true });
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'package', type: 'module' }));
        writeFileSync(join(pkgDir, 'module.js'), 'export const value = 1;\n');
        writeFileSync(join(pkgDir, 'esm.mjs'), 'export const value = 2;\n');
        writeFileSync(join(pkgDir, 'commonjs.cjs'), 'module.exports.value = 3;\n');
        writeFileSync(join(pkgDir, 'dir', 'index.js'), 'export default 4;\n');
        writeFileSync(join(pkgDir, 'extensionless'), 'module.exports.value = 5;\n');

        const resolver = new ModuleResolver(createConfig({ cacheDir: joinPaths(root, '.cache') }), root, true);
        const parent = joinPaths(root, 'entry.mjs');

        throws(() => resolver.resolve('package/module2', parent), /Cannot resolve "module2"/);
        throws(() => resolver.resolve('package/module', parent), /Cannot resolve "module"/);
        throws(() => resolver.resolve('package/esm', parent), /Cannot resolve "esm"/);
        throws(() => resolver.resolve('package/commonjs', parent), /Cannot resolve "commonjs"/);
        throws(() => resolver.resolve('package/dir', parent), /Cannot resolve "dir"/);

        const exact = resolver.resolve('package/extensionless', parent);
        strictEqual(exact.localPath, joinPaths(pkgDir, 'extensionless'));
        strictEqual(exact.format, 'esm');

        const cjsParent = joinPaths(root, 'entry.cjs');
        strictEqual(resolver.resolve('package/module', cjsParent, { cjs: true }).localPath, joinPaths(pkgDir, 'module.js'));
        strictEqual(resolver.resolve('package/dir', cjsParent, { cjs: true }).localPath, joinPaths(pkgDir, 'dir', 'index.js'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts path: parentDirKey collapses same-dir file parents', () => {
    strictEqual(parentDirKey('/proj/a.js'), '/proj');
    strictEqual(parentDirKey('/proj/b.js'), '/proj');
    strictEqual(parentDirKey('file:///proj/a.js'), '/proj');
    strictEqual(parentDirKey('file:///proj/b.js?x=1'), '/proj');
    // Scheme parents without a real path segment stay intact (dirname would be '.').
    strictEqual(parentDirKey('npm:pkg@1.0.0'), 'npm:pkg@1.0.0');
    strictEqual(parentDirKey('npm:pkg@1.0.0/mod.js'), 'npm:pkg@1.0.0');
});

Deno.test('cts resolver: same-dir relative edges share exact resolve cache', () => {
    const root = makePosixTempDir('exact-resolve-cache');
    try {
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'util.js'), 'export const u = 1;\n');
        writeFileSync(join(root, 'a.js'), "import './util.js';\n");
        writeFileSync(join(root, 'b.js'), "import './util.js';\n");

        const resolver = new ModuleResolver(createConfig({
            cacheDir: joinPaths(root, 'cache'),
            enableOxc: false,
            silent: true,
            disableLock: true,
        }), root, true);

        const fromA = resolver.resolve('./util.js', joinPaths(root, 'a.js'));
        const fromB = resolver.resolve('./util.js', joinPaths(root, 'b.js'));
        const again = resolver.resolve('./util.js', joinPaths(root, 'a.js'));

        strictEqual(fromA.localPath, joinPaths(root, 'util.js'));
        strictEqual(fromB.localPath, fromA.localPath);
        // Same object identity → exact-hit cache (not a fresh ModuleInfo).
        ok(fromA === fromB, 'same-dir relative resolve must reuse exact cache entry');
        ok(fromA === again, 'repeat resolve from same parent file must reuse exact cache entry');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver: tsconfig paths resolve relative to baseUrl', () => {
    const root = makePosixTempDir('path-alias-base-url');
    try {
        mkdirSync(join(root, 'src', 'aliases'), { recursive: true });
        mkdirSync(join(root, 'src', 'nested'), { recursive: true });
        writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
                baseUrl: './src',
                paths: { '@alias/*': ['aliases/*'] },
            },
        }));
        writeFileSync(join(root, 'src', 'aliases', 'dep.ts'), 'export const value = 1;\n');

        const fileCfg = loadConfigFile(joinPaths(root, 'src', 'nested'));
        const resolver = new ModuleResolver(createConfig({
            ...fileCfg,
            cacheDir: joinPaths(root, 'cache'),
            enableOxc: false,
            silent: true,
        }), root, true);
        const info = resolver.resolve('@alias/dep', joinPaths(root, 'src', 'nested', 'entry.ts'));

        strictEqual(info.localPath, joinPaths(root, 'src', 'aliases', 'dep.ts'));
        strictEqual(info.specPath, info.localPath);
        strictEqual(info.fileKind, 'source');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver: package imports use default condition from local package parent', () => {
    const root = makePosixTempDir('pkg-imports-default');
    try {
        writeFileSync(join(root, 'package.json'), JSON.stringify({
            name: '@denotest/pkg-json-imports',
            version: '1.0.0',
            imports: {
                '#add': {
                    default: './add.ts',
                },
            },
        }));
        writeFileSync(join(root, 'main.ts'), 'import { add } from "#add";\n');
        writeFileSync(join(root, 'add.ts'), 'export const add = (a: number, b: number) => a + b;\n');

        const resolver = new ModuleResolver(createConfig({
            cacheDir: joinPaths(root, 'cache'),
            enableOxc: false,
            silent: true,
        }), root, true);
        const info = resolver.resolve('#add', joinPaths(root, 'main.ts'));

        strictEqual(info.localPath, joinPaths(root, 'add.ts'));
        strictEqual(info.specPath, 'npm:@denotest/pkg-json-imports@1.0.0/add.ts');
        strictEqual(info.format, 'esm');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver: package imports can redirect to an external package', () => {
    const root = makePosixTempDir('pkg-imports-external');
    try {
        const depDir = joinPaths(root, 'node_modules', 'pkg-imports-dep');
        mkdirSync(depDir, { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({
            name: 'pkg-imports-owner',
            version: '1.0.0',
            imports: { '#dep': 'pkg-imports-dep' },
            dependencies: { 'pkg-imports-dep': '1.0.0' },
        }));
        writeFileSync(join(root, 'main.ts'), 'import value from "#dep";\n');
        writeFileSync(join(depDir, 'package.json'), JSON.stringify({
            name: 'pkg-imports-dep',
            version: '1.0.0',
            main: './index.js',
        }));
        writeFileSync(join(depDir, 'index.js'), 'module.exports = 42;\n');

        const resolver = new ModuleResolver(createConfig({
            cacheDir: joinPaths(root, 'cache'),
            enableOxc: false,
            silent: true,
        }), root, true);
        const info = resolver.resolve('#dep', joinPaths(root, 'main.ts'));

        strictEqual(info.localPath, joinPaths(depDir, 'index.js'));
        strictEqual(info.specPath, 'npm:pkg-imports-dep@1.0.0/index.js');
        strictEqual(info.format, 'cjs');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: package imports missing entries expose Node error code', () => {
    const root = makePosixTempDir('pkg-imports-missing');
    try {
        writeFileSync(join(root, 'package.json'), JSON.stringify({
            name: 'pkg-imports-missing',
            version: '1.0.0',
            imports: {
                '#ok': './ok.js',
            },
        }));
        writeFileSync(join(root, 'index.js'), 'require("#missing");\n');
        writeFileSync(join(root, 'ok.js'), 'module.exports = 1;\n');

        const resolver = new ModuleResolver(createConfig({
            cacheDir: joinPaths(root, 'cache'),
            enableOxc: false,
            silent: true,
        }), root, true);

        throws(
            () => resolver.resolve('#missing', joinPaths(root, 'index.js'), { cjs: true }),
            (error: NodeJS.ErrnoException) => {
                strictEqual(error.code, 'ERR_PACKAGE_IMPORT_NOT_DEFINED');
                ok(String(error.message).includes('#missing'));
                return true;
            },
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: package exports without matching condition do not fall back to package marker', () => {
    const root = makePosixTempDir('pkg-exports-condition-missing');
    try {
        const pkgDir = joinPaths(root, 'node_modules', 'condition-only-package');
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
            name: 'condition-only-package',
            version: '1.0.0',
            type: 'module',
            exports: {
                '.': {
                    require: './require.cjs',
                },
            },
        }));
        writeFileSync(join(pkgDir, 'require.cjs'), 'module.exports = "require";\n');

        const resolver = new ModuleResolver(createConfig({
            cacheDir: joinPaths(root, 'cache'),
            enableOxc: false,
            silent: true,
        }), root, true);

        throws(
            () => resolver.resolve('condition-only-package', joinPaths(root, 'entry.mjs')),
            (error: NodeJS.ErrnoException) => {
                strictEqual(error.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
                ok(String(error.message).includes('condition-only-package'));
                return true;
            },
        );

        const cjs = resolver.resolve('condition-only-package', joinPaths(root, 'entry.cjs'), { cjs: true });
        strictEqual(cjs.localPath, joinPaths(pkgDir, 'require.cjs'));
        strictEqual(cjs.format, 'cjs');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: canonical exported targets reload without reopening deep imports', () => {
    const root = makePosixTempDir('pkg-canonical-export-target');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const pkgDir = joinPaths(cacheDir, 'npm', 'canonical-package@1.0.0');
        mkdirSync(joinPaths(pkgDir, 'src'), { recursive: true });
        writeFileSync(joinPaths(pkgDir, 'package.json'), JSON.stringify({
            name: 'canonical-package',
            version: '1.0.0',
            type: 'module',
            exports: {
                './feature': './src/feature.js',
            },
        }));
        writeFileSync(joinPaths(pkgDir, 'src/feature.js'), 'export { value } from "./internal.js";\n');
        writeFileSync(joinPaths(pkgDir, 'src/internal.js'), 'export const value = 1;\n');

        const resolver = new ModuleResolver(createConfig({
            cacheDir,
            enableOxc: false,
            silent: true,
        }), root, true);
        const feature = resolver.resolve('npm:canonical-package@1.0.0/feature', joinPaths(root, 'entry.mjs'));
        strictEqual(feature.specPath, 'npm:canonical-package@1.0.0/src/feature.js');
        strictEqual(resolver.getInfo(feature.specPath).localPath, joinPaths(pkgDir, 'src/feature.js'));

        throws(
            () => resolver.resolve('npm:canonical-package@1.0.0/src/feature.js', joinPaths(root, 'entry.mjs')),
            (error: NodeJS.ErrnoException) => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: package export suffixes stay out of physical paths', () => {
    const root = makePosixTempDir('pkg-export-suffix');
    try {
        const pkgDir = joinPaths(root, 'node_modules', 'suffix-package');
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(joinPaths(pkgDir, 'package.json'), JSON.stringify({
            name: 'suffix-package',
            version: '1.0.0',
            type: 'module',
            exports: './index.js?mode=x#frag',
        }));
        writeFileSync(joinPaths(pkgDir, 'index.js'), 'export const value = 1;\n');

        const resolver = new ModuleResolver(createConfig({
            cacheDir: joinPaths(root, 'cache'),
            enableOxc: false,
            silent: true,
        }), root, true);
        const info = resolver.resolve('suffix-package', joinPaths(root, 'entry.mjs'));

        strictEqual(info.localPath, joinPaths(pkgDir, 'index.js'));
        strictEqual(info.specPath, 'npm:suffix-package@1.0.0/index.js?mode=x#frag');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: version after package subpath is an invalid specifier', () => {
    const root = makePosixTempDir('npm-version-after-subpath');
    try {
        const resolver = new ModuleResolver(createConfig({
            cacheDir: joinPaths(root, 'cache'),
            enableOxc: false,
            silent: true,
        }), root, true);

        throws(
            () => resolver.resolve('npm:react-dom/server@18.2.0', joinPaths(root, 'entry.ts')),
            (error: Error) => {
                strictEqual(error.kind, ErrorKind.InvalidSpecifier);
                ok(String(error.message).includes('npm:react-dom@18.2.0/server'));
                return true;
            },
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: legacy package subpaths cannot escape the package directory', () => {
    const root = makePosixTempDir('npm-subpath-containment');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const pkgDir = joinPaths(cacheDir, 'npm', 'package@1.0.0');
        mkdirSync(joinPaths(pkgDir, 'nested'), { recursive: true });
        writeFileSync(joinPaths(pkgDir, 'package.json'), JSON.stringify({
            name: 'package',
            version: '1.0.0',
        }));
        writeFileSync(joinPaths(cacheDir, 'npm', 'outside.js'), 'export default "outside";\n');

        const resolver = new ModuleResolver(createConfig({
            cacheDir,
            cachedOnly: true,
            enableOxc: false,
            silent: true,
        }), root, true);
        for (const specifier of [
            'npm:package@1.0.0/../outside.js',
            'npm:package@1.0.0/nested/../../outside.js',
            'npm:package@1.0.0/..\\outside.js',
        ]) {
            throws(
                () => resolver.resolve(specifier, joinPaths(root, 'entry.ts')),
                (error: Error) => {
                    strictEqual(error.kind, ErrorKind.InvalidSpecifier);
                    ok(String(error.message).includes('Unsafe npm package subpath'));
                    return true;
                },
            );
        }
        const npm = new NpmHandler(createConfig({ cacheDir, cachedOnly: true, silent: true }));
        throws(() => npm.localPath('npm:package@..\\..\\victim'), /Unsafe npm package version/);
        strictEqual(npm.resolveBin('tool\\..\\victim', root), null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: dependency bin metadata cannot unlink or link outside the package', () => {
    const root = makePosixTempDir('npm-bin-containment');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const parentDir = joinPaths(cacheDir, 'npm', 'parent@1.0.0');
        const depDir = joinPaths(cacheDir, 'npm', 'dep@1.0.0');
        mkdirSync(parentDir, { recursive: true });
        mkdirSync(joinPaths(depDir, 'bin'), { recursive: true });
        writeFileSync(joinPaths(parentDir, 'package.json'), JSON.stringify({
            name: 'parent',
            version: '1.0.0',
            main: 'index.js',
            dependencies: { dep: '1.0.0' },
        }));
        writeFileSync(joinPaths(parentDir, 'index.js'), 'module.exports = 1;\n');
        writeFileSync(joinPaths(parentDir, 'victim'), 'keep\n');
        writeFileSync(joinPaths(depDir, 'package.json'), JSON.stringify({
            name: 'dep',
            version: '1.0.0',
            main: 'index.js',
            bin: {
                '../../victim': './bin/cli.js',
                tool: './bin/escape.js',
                lexical: '../outside.js',
            },
        }));
        writeFileSync(joinPaths(depDir, 'index.js'), 'module.exports = 2;\n');
        writeFileSync(joinPaths(depDir, 'bin', 'cli.js'), '#!/usr/bin/env node\n');
        writeFileSync(joinPaths(cacheDir, 'npm', 'outside.js'), 'outside\n');
        symlinkSync(joinPaths(cacheDir, 'npm', 'outside.js'), joinPaths(depDir, 'bin', 'escape.js'));

        const resolver = new ModuleResolver(createConfig({
            cacheDir,
            cachedOnly: true,
            disableLock: true,
            ignoreScripts: true,
            enableOxc: false,
            silent: true,
        }), root, true);
        resolver.resolve('npm:parent@1.0.0', joinPaths(root, 'entry.ts'), { cjs: true });

        strictEqual(readFileSync(joinPaths(parentDir, 'victim'), 'utf8'), 'keep\n');
        ok(!existsSync(joinPaths(parentDir, 'node_modules', '.bin', 'tool')));
        ok(!existsSync(joinPaths(parentDir, 'node_modules', '.bin', 'lexical')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: invalid dependency names cannot select cache or link paths', () => {
    const root = makePosixTempDir('npm-dependency-name-containment');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const parentDir = joinPaths(cacheDir, 'npm', 'parent@1.0.0');
        const escapedDir = joinPaths(cacheDir, 'victim@1.0.0');
        mkdirSync(parentDir, { recursive: true });
        mkdirSync(escapedDir, { recursive: true });
        writeFileSync(joinPaths(parentDir, 'package.json'), JSON.stringify({
            name: 'parent',
            version: '1.0.0',
            main: 'index.js',
            dependencies: { '../../victim': '1.0.0' },
        }));
        writeFileSync(joinPaths(parentDir, 'index.js'), 'module.exports = 1;\n');
        writeFileSync(joinPaths(escapedDir, 'package.json'), JSON.stringify({
            name: 'victim',
            version: '1.0.0',
            main: 'index.js',
        }));
        writeFileSync(joinPaths(escapedDir, 'index.js'), 'module.exports = 2;\n');
        writeFileSync(joinPaths(escapedDir, 'sentinel'), 'keep\n');

        const resolver = new ModuleResolver(createConfig({
            cacheDir,
            cachedOnly: true,
            disableLock: true,
            ignoreScripts: true,
            enableOxc: false,
            silent: true,
        }), root, true);
        throws(
            () => resolver.resolve('npm:parent@1.0.0', joinPaths(root, 'entry.ts'), { cjs: true }),
            /Invalid npm package name/,
        );
        strictEqual(readFileSync(joinPaths(escapedDir, 'sentinel'), 'utf8'), 'keep\n');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: package directory subpaths prefer index.js over ts json and wasm siblings', () => {
    const root = makePosixTempDir('npm-index-js-priority');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const pkgDir = joinPaths(cacheDir, 'npm', 'package@1.0.0');
        mkdirSync(join(pkgDir, 'subdir'), { recursive: true });
        mkdirSync(join(pkgDir, 'json'), { recursive: true });
        mkdirSync(join(pkgDir, 'wasm'), { recursive: true });
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
            name: 'package',
            version: '1.0.0',
        }));
        writeFileSync(join(pkgDir, 'index.js'), 'require("./subdir"); require("./json"); require("./wasm");\n');
        writeFileSync(join(pkgDir, 'subdir', 'index.js'), 'module.exports = "js";\n');
        writeFileSync(join(pkgDir, 'subdir', 'index.ts'), 'export default "ts";\n');
        writeFileSync(join(pkgDir, 'json', 'index.js'), 'module.exports = "json-js";\n');
        writeFileSync(join(pkgDir, 'json', 'index.json'), '{}\n');
        writeFileSync(join(pkgDir, 'wasm', 'index.js'), 'module.exports = "wasm-js";\n');
        writeFileSync(join(pkgDir, 'wasm', 'index.wasm'), '\0asm\x01\0\0\0');

        const resolver = new ModuleResolver(createConfig({
            cacheDir,
            enableOxc: false,
            silent: true,
        }), root, true);

        const rootEntry = resolver.resolve('npm:package@1.0.0', joinPaths(root, 'entry.ts'));
        strictEqual(rootEntry.localPath, joinPaths(pkgDir, 'index.js'));
        strictEqual(rootEntry.format, 'cjs');

        const subdir = resolver.resolve('npm:package@1.0.0/subdir', joinPaths(root, 'entry.ts'), { cjs: true });
        strictEqual(subdir.localPath, joinPaths(pkgDir, 'subdir', 'index.js'));
        strictEqual(subdir.format, 'cjs');

        const json = resolver.resolve('npm:package@1.0.0/json', joinPaths(root, 'entry.ts'), { cjs: true });
        strictEqual(json.localPath, joinPaths(pkgDir, 'json', 'index.js'));
        strictEqual(json.fileKind, 'source');

        const wasm = resolver.resolve('npm:package@1.0.0/wasm', joinPaths(root, 'entry.ts'), { cjs: true });
        strictEqual(wasm.localPath, joinPaths(pkgDir, 'wasm', 'index.js'));
        strictEqual(wasm.fileKind, 'source');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: nested npm parents resolve dependency ranges from their own package', () => {
    const root = makePosixTempDir('npm-nested-dep-version');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const parentDir = joinPaths(cacheDir, 'npm', '@denotest', 'different-nested-dep@1.0.0');
        const childV1Dir = joinPaths(cacheDir, 'npm', '@denotest', 'different-nested-dep-child@1.0.0');
        const childV2Dir = joinPaths(cacheDir, 'npm', '@denotest', 'different-nested-dep-child@2.0.0');
        for (const dir of [parentDir, childV1Dir, childV2Dir]) mkdirSync(dir, { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({
            dependencies: {
                '@denotest/different-nested-dep': '1.0.0',
                '@denotest/different-nested-dep-child': '2.0.0',
            },
        }));
        writeFileSync(join(parentDir, 'package.json'), JSON.stringify({
            name: '@denotest/different-nested-dep',
            version: '1.0.0',
            main: 'main.js',
            dependencies: {
                '@denotest/different-nested-dep-child': '1.0.0',
            },
        }));
        writeFileSync(join(parentDir, 'main.js'), 'module.exports = require("@denotest/different-nested-dep-child");\n');
        writeFileSync(join(childV1Dir, 'package.json'), JSON.stringify({
            name: '@denotest/different-nested-dep-child',
            version: '1.0.0',
            main: 'main.js',
        }));
        writeFileSync(join(childV1Dir, 'main.js'), 'module.exports = 1;\n');
        writeFileSync(join(childV2Dir, 'package.json'), JSON.stringify({
            name: '@denotest/different-nested-dep-child',
            version: '2.0.0',
            main: 'main.js',
        }));
        writeFileSync(join(childV2Dir, 'main.js'), 'module.exports = 2;\n');

        const resolver = new ModuleResolver(createConfig({
            cacheDir,
            enableOxc: false,
            silent: true,
        }), root, true);

        const projectChild = resolver.resolve('@denotest/different-nested-dep-child', joinPaths(root, 'main.js'));
        strictEqual(projectChild.localPath, joinPaths(childV2Dir, 'main.js'));
        strictEqual(projectChild.specPath, 'npm:@denotest/different-nested-dep-child@2.0.0/main.js');

        const parentChild = resolver.resolve(
            '@denotest/different-nested-dep-child',
            'npm:@denotest/different-nested-dep@1.0.0/main.js',
            { cjs: true },
        );
        strictEqual(parentChild.localPath, joinPaths(childV1Dir, 'main.js'));
        strictEqual(parentChild.specPath, 'npm:@denotest/different-nested-dep-child@1.0.0/main.js');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: local package lookup follows symlink real paths for private deps', () => {
    const root = makePosixTempDir('local-symlink-deps');
    try {
        const realPkg = joinPaths(root, 'store', 'foo');
        const linkPkg = joinPaths(root, 'node_modules', 'foo');
        const depDir = joinPaths(realPkg, 'node_modules', 'dep-fixture');
        mkdirSync(join(depDir), { recursive: true });
        mkdirSync(join(root, 'node_modules'), { recursive: true });
        writeFileSync(join(realPkg, 'package.json'), JSON.stringify({
            name: 'foo',
            version: '1.0.0',
            dependencies: { 'dep-fixture': '1.0.0' },
        }));
        writeFileSync(join(realPkg, 'index.js'), 'module.exports = require("dep-fixture");\n');
        writeFileSync(join(depDir, 'package.json'), JSON.stringify({
            name: 'dep-fixture',
            version: '1.0.0',
            main: 'index.js',
        }));
        writeFileSync(join(depDir, 'index.js'), 'module.exports = "private";\n');
        try {
            symlinkSync(realPkg, linkPkg, 'dir');
        } catch {
            return;
        }

        const resolver = new ModuleResolver(createConfig({
            cacheDir: joinPaths(root, 'cache'),
            enableOxc: false,
            silent: true,
        }), root, true);
        const info = resolver.resolve('dep-fixture', joinPaths(linkPkg, 'index.js'), { cjs: true });

        strictEqual(info.localPath, joinPaths(depDir, 'index.js'));
        strictEqual(info.specPath, 'npm:dep-fixture@1.0.0/index.js');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver: file kind and attr helpers classify common paths', () => {
    strictEqual(guessFileKind('/x/mod.ts'), 'source');
    strictEqual(guessFileKind('/x/data.jsonc'), 'json');
    strictEqual(guessFileKind('/x/addon.wasm'), 'wasm');
    strictEqual(guessFileKind('/x/addon.node'), 'binary');
    strictEqual(applyAttrType('source', { type: 'text' }), 'text');
    strictEqual(applyAttrType('source', { type: 'bytes' }), 'binary');
    strictEqual(applyAttrType('source', { type: 'json' }), 'json');
    strictEqual(applyAttrType('source', { type: 'unknown' }), 'source');
    validateAttrType('json', { type: 'json' }, 'file:///data.json');
    validateAttrType('source', { type: 'text' }, 'file:///mod.ts');
    throws(
        () => validateAttrType('source', { type: 'unknown' }, 'file:///mod.mjs'),
        { name: 'TypeError', code: 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED' },
    );
    throws(
        () => validateAttrType('source', { type: 'json' }, 'file:///mod.mjs'),
        { name: 'TypeError', code: 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE' },
    );
    ok(isTypeDecl('/x/index.d.ts'));
    ok(isTypeDecl('/x/index.d.mts'));
    ok(isTypeDecl('/x/index.d.cts'));
    ok(!isTypeDecl('/x/index.ts'));
});

Deno.test('cts resolver: data handler emits filesystem flow for plain data URLs', () => {
    const root = makePosixTempDir('data-cache');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const spec = 'data:text/javascript,export%20default%201';
        const handler = new DataHandler({ cacheDir } as any);
        const flow = handler.resolve(spec, '');

        const exists = flow.next();
        strictEqual(exists.done, false);
        strictEqual(exists.value.type, StepType.FS_EXISTS);
        ok(exists.value.path.endsWith('.js'));

        const ensure = flow.next(false);
        strictEqual(ensure.done, false);
        strictEqual(ensure.value.type, StepType.FS_ENSURE_DIR);

        const write = flow.next();
        strictEqual(write.done, false);
        strictEqual(write.value.type, StepType.FS_WRITE_BYTES);
        strictEqual(decodeBytes(write.value.data), 'export default 1');

        const done = flow.next();
        strictEqual(done.done, true);
        strictEqual(done.value.specPath, spec);
        strictEqual(done.value.localPath, handler.localPath(spec));
        strictEqual(done.value.fileKind, 'source');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver: data handler decodes base64 JSON and rejects invalid URLs', () => {
    const root = makePosixTempDir('data-cache');
    try {
        const handler = new DataHandler({ cacheDir: joinPaths(root, 'cache') } as any);
        const flow = handler.resolve('data:application/json;base64,eyJhIjoxfQ==', '');
        flow.next();
        flow.next(false);
        const write = flow.next();
        strictEqual(write.done, false);
        strictEqual(write.value.type, StepType.FS_WRITE_BYTES);
        strictEqual(decodeBytes(write.value.data), '{"a":1}');
        const done = flow.next();
        strictEqual(done.done, true);
        strictEqual(done.value.fileKind, 'json');
        ok(done.value.localPath.endsWith('.json'));

        const missingComma = handler.resolve('data:text/plain', '');
        throws(() => missingComma.next(), /Invalid data URL/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: cached packages still queue lifecycle scripts during cache', () => {
    const root = makePosixTempDir('npm-lifecycle-cache-hit');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const pkgDir = joinPaths(cacheDir, 'npm', 'native-fixture@1.0.0');
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, 'index.js'), 'module.exports = 1;\n');
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
            name: 'native-fixture',
            version: '1.0.0',
            main: 'index.js',
            scripts: {
                install: 'node scripts/prebuild.js || node-gyp rebuild',
                postinstall: 'node postinstall.js',
            },
        }));

        const handler = new NpmHandler({
            cacheDir,
            persistLock: true,
            ignoreScripts: false,
            silent: true,
            requestTimeout: 1000,
        } as any);

        runSync(handler.resolve('npm:native-fixture@1.0.0', `${root}/entry.ts`));
        runSync(handler.resolve('npm:native-fixture@1.0.0', `${root}/entry.ts`));

        deepStrictEqual(handler.drainLifecycleScripts().map(({ lifecycle, script }) => [lifecycle, script]), [
            ['install', 'node scripts/prebuild.js || node-gyp rebuild'],
            ['postinstall', 'node postinstall.js'],
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver: trusts remote lock entries without revalidation', () => {
    const root = makePosixTempDir('stale-remote-lock');
    let resolver: ModuleResolver | null = null;
    try {
        const cacheDir = joinPaths(root, 'cache');
        const oldCacheDir = joinPaths(root, 'old-cache');
        const stale = joinPaths(oldCacheDir, 'data', 'stale.js');
        mkdirSync(dirname(stale), { recursive: true });
        writeFileSync(stale, 'export default 0;\n');
        const lock = new LockStore(root, false);
        const spec = 'data:text/javascript,export%20default%201';
        lock.setModule({
            specPath: spec,
            localPath: stale,
            format: 'esm',
            fileKind: 'source',
        });
        lock.flush();
        lock.close();

        resolver = new ModuleResolver({
            cacheDir,
            enableHttp: true,
            enableJsr: true,
            enableNode: true,
            enableCache: true,
            enableOxc: false,
            ignoreScripts: true,
            nodeModulesMode: 'normal',
            silent: true,
            requestTimeout: 1000,
            jsrCacheTTL: 0,
            polyfill: '',
            _offset: 0,
        } as any, root, false);
        const info = resolver.resolve(spec, `${root}/entry.ts`);

        strictEqual(info.localPath, stale);
    } finally {
        // The resolver owns a second SQLite handle on cts.lock. SQLite opens
        // through its own Win32 VFS (no FILE_SHARE_DELETE), so the directory
        // cannot be removed while that handle is live.
        closeResolverQuietly(resolver);
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver: trusts locked npm path and format without revalidation', () => {
    const root = makePosixTempDir('stale-npm-format-lock');
    let resolver: ModuleResolver | null = null;
    try {
        const cacheDir = joinPaths(root, 'cache');
        const pkgDir = joinPaths(cacheDir, 'npm', 'format-fixture@1.0.0');
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
            name: 'format-fixture',
            version: '1.0.0',
            main: 'index.js',
        }));
        writeFileSync(join(pkgDir, 'index.js'), 'module.exports = 1;\n');
        writeFileSync(join(pkgDir, 'mod.js'), 'export default 2;\n');

        const parent = `${root}/entry.ts`;
        const staleSpec = 'npm:format-fixture@1.0.0/mod.js';
        const lock = new LockStore(root, false);
        lock.setModule({
            specPath: staleSpec,
            localPath: joinPaths(pkgDir, 'mod.js'),
            format: 'esm',
            fileKind: 'source',
        });
        lock.setSourceByKey(`esm\0npm:format-fixture@1.0.0\0${parent}\0`, staleSpec);
        lock.flush();
        lock.close();

        resolver = new ModuleResolver({
            cacheDir,
            enableHttp: true,
            enableJsr: true,
            enableNode: true,
            enableCache: true,
            enableOxc: false,
            ignoreScripts: true,
            nodeModulesMode: 'normal',
            silent: true,
            requestTimeout: 1000,
            jsrCacheTTL: 0,
            polyfill: '',
            _offset: 0,
        } as any, root, false);
        const info = resolver.resolve('npm:format-fixture@1.0.0', parent);

        strictEqual(info.localPath, joinPaths(pkgDir, 'mod.js'));
        strictEqual(info.format, 'esm');
    } finally {
        closeResolverQuietly(resolver);
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm: stale parent localPath does not redirect dependency lookup to old cache', () => {
    const root = makePosixTempDir('stale-npm-parent-lock');
    let resolver: ModuleResolver | null = null;
    try {
        const cacheDir = joinPaths(root, 'cache');
        const oldCacheDir = joinPaths(root, 'old-cache');
        const parentSpec = 'npm:parent-fixture@1.0.0/index.js';
        const parentDir = joinPaths(cacheDir, 'npm', 'parent-fixture@1.0.0');
        const depDir = joinPaths(cacheDir, 'npm', 'dep-fixture@1.0.0');
        const oldParentDir = joinPaths(oldCacheDir, 'npm', 'parent-fixture@1.0.0');
        const oldDepDir = joinPaths(oldParentDir, 'node_modules', 'dep-fixture');
        for (const dir of [parentDir, depDir, oldParentDir, oldDepDir]) mkdirSync(dir, { recursive: true });
        writeFileSync(join(parentDir, 'package.json'), JSON.stringify({
            name: 'parent-fixture',
            version: '1.0.0',
            main: 'index.js',
            dependencies: { 'dep-fixture': '1.0.0' },
        }));
        writeFileSync(join(parentDir, 'index.js'), 'module.exports = require("dep-fixture");\n');
        writeFileSync(join(depDir, 'package.json'), JSON.stringify({
            name: 'dep-fixture',
            version: '1.0.0',
            main: 'index.js',
        }));
        writeFileSync(join(depDir, 'index.js'), 'module.exports = "current";\n');
        writeFileSync(join(oldParentDir, 'package.json'), JSON.stringify({
            name: 'parent-fixture',
            version: '1.0.0',
            main: 'index.js',
        }));
        writeFileSync(join(oldParentDir, 'index.js'), 'module.exports = require("dep-fixture");\n');
        writeFileSync(join(oldDepDir, 'package.json'), JSON.stringify({
            name: 'dep-fixture',
            version: '1.0.0',
            main: 'index.js',
        }));
        writeFileSync(join(oldDepDir, 'index.js'), 'module.exports = "old";\n');

        const lock = new LockStore(root, false);
        lock.setModule({
            specPath: parentSpec,
            localPath: joinPaths(oldParentDir, 'index.js'),
            format: 'cjs',
            fileKind: 'source',
        });
        lock.flush();
        lock.close();

        resolver = new ModuleResolver({
            cacheDir,
            enableHttp: true,
            enableJsr: true,
            enableNode: true,
            enableCache: true,
            enableOxc: false,
            ignoreScripts: true,
            nodeModulesMode: 'normal',
            silent: true,
            requestTimeout: 1000,
            jsrCacheTTL: 0,
            polyfill: '',
            _offset: 0,
        } as any, root, false);
        const info = resolver.resolve('dep-fixture', parentSpec, { cjs: true });

        strictEqual(info.localPath, joinPaths(depDir, 'index.js'));
    } finally {
        closeResolverQuietly(resolver);
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts source cache: remote detection and empty local cache are stable', () => {
    for (const spec of ['http://x/mod.ts', 'https://x/mod.ts', 'npm:pkg@1.0.0', 'jsr:@a/b@1.0.0', 'node:fs']) {
        strictEqual(isRemote(spec), true);
    }
    for (const spec of ['./mod.ts', '/tmp/mod.ts', 'file:///tmp/mod.ts']) {
        strictEqual(isRemote(spec), false);
    }
    const cache = new JscCache();
    strictEqual(cache.hasFresh('/tmp/nope.ts', false), false);
    strictEqual(cache.load('/tmp/nope.ts', false), null);
});

Deno.test('cts errors: err attaches kind and formatError uses labels and hints', () => {
    const e = err(ErrorKind.ModuleNotFound, 'Cannot find npm:left-pad');
    strictEqual(e.kind, ErrorKind.ModuleNotFound);
    strictEqual((e as Error & { code?: string }).code, 'MODULE_NOT_FOUND');
    const formatted = formatError(e, 'load');
    ok(formatted.includes('Uncaught (in load) Module Not Found'));
    ok(formatted.includes('Cannot find npm:left-pad'));
    ok(formatted.includes('cts cache <entry>'));

    const t = new TransformError('Unexpected token', 'bad.ts', 1, 5);
    strictEqual(t.kind, ErrorKind.TransformError);
    strictEqual(t.fileName, 'bad.ts');
    strictEqual(t.line, 1);
    strictEqual(t.column, 5);
    ok(formatError(t).includes('Transform Error'));
});

Deno.test('cts types: moduleRef prefers explicit module identity', () => {
    strictEqual(moduleRef({ specPath: 'npm:a@1.0.0' }), 'npm:a@1.0.0');
    strictEqual(moduleRef({ specPath: 'npm:a@1.0.0', moduleId: 'npm:a@1.0.0?cjs' }), 'npm:a@1.0.0?cjs');
    const view = moduleViewRef('file:///tmp/mod.ts#cts-view=text', 'text');
    strictEqual(view, 'ctsview:text/file%3A%2F%2F%2Ftmp%2Fmod.ts%23cts-view%3Dtext');
    strictEqual(view.includes('#cts-view='), false);
});
