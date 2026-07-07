import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import Module, * as module from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withTempDir } from '../_helpers/temp.ts';

Deno.test('module: builtinModules and isBuiltin expose bare builtin names', () => {
    ok(module.builtinModules.includes('fs'));
    ok(module.builtinModules.includes('module'));
    ok(!module.builtinModules.includes('node:fs'));
    ok(module.isBuiltin('fs'));
    ok(module.isBuiltin('node:fs'));
    ok(!module.isBuiltin('node:not-real'));
    ok(!module.isBuiltin('internal/errors'));
    ok(module.isBuiltin('test'));
    ok(!module.isBuiltin(''));
    ok(!module.isBuiltin(undefined as unknown as string));
});

Deno.test('module: default export exposes Module static helpers', () => {
    strictEqual(Module.isBuiltin('node:path'), true);
    strictEqual(Module.createRequire, module.createRequire);
    strictEqual(Module._cache, module._cache);
});

Deno.test('module: createRequire accepts file URL strings and objects', () => {
    const fromString = module.createRequire(import.meta.url);
    const fromUrl = module.createRequire(new URL(import.meta.url));
    strictEqual(typeof fromString('node:path').join, 'function');
    strictEqual(typeof fromUrl('node:assert').strictEqual, 'function');
});

Deno.test('module: createRequire from absolute filename loads and resolves local CJS', () => {
    return withTempDir('node-module', (root) => {
        const dep = path.join(root, 'dep.cjs');
        Deno.writeTextFileSync(dep, 'exports.answer = 42; exports.dirname = __dirname;');

        const req = module.createRequire(path.join(root, 'entry.cjs'));
        const loaded = req('./dep.cjs');

        strictEqual(loaded.answer, 42);
        strictEqual(loaded.dirname, root);
        strictEqual(req.resolve('./dep.cjs'), dep);
    });
});

Deno.test('module upstream: require.resolve paths accepts directories and file URL directories', () => {
    return withTempDir('node-module-resolve-paths', (root) => {
        const pkgDir = path.join(root, 'node_modules', '@denotest', 'esm-basic');
        Deno.mkdirSync(pkgDir, { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: '@denotest/esm-basic',
            version: '1.0.0',
            type: 'module',
            main: './main.mjs',
        }));
        Deno.writeTextFileSync(path.join(pkgDir, 'main.mjs'), 'export default 1;');

        const req = module.createRequire(path.join(root, 'entry.cjs'));
        const expected = path.join(pkgDir, 'main.mjs');
        strictEqual(req.resolve('@denotest/esm-basic', { paths: [root] }), expected);
        strictEqual(
            req.resolve('@denotest/esm-basic', { paths: [pathToFileURL(root + path.sep).href] }),
            expected,
        );
    });
});

Deno.test('module upstream: require loads node_modules package main entry', () => {
    return withTempDir('node-module-package-main', (root) => {
        const pkgDir = path.join(root, 'node_modules', 'main-entry-package');
        Deno.mkdirSync(pkgDir, { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: 'main-entry-package',
            version: '1.0.0',
            main: './lib/main.cjs',
        }));
        Deno.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'lib', 'main.cjs'), 'module.exports = { kind: "main" };\n');

        const req = module.createRequire(path.join(root, 'entry.cjs'));
        deepStrictEqual(req('main-entry-package'), { kind: 'main' });
        strictEqual(req.resolve('main-entry-package'), path.join(pkgDir, 'lib', 'main.cjs'));
    });
});

Deno.test('module upstream: require.resolve package exports errors expose code', () => {
    return withTempDir('node-module-exports-error-code', (root) => {
        const pkgDir = path.join(root, 'node_modules', 'exports-locked-package');
        Deno.mkdirSync(pkgDir, { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: 'exports-locked-package',
            version: '1.0.0',
            exports: {
                '.': './index.js',
            },
        }));
        Deno.writeTextFileSync(path.join(pkgDir, 'index.js'), 'module.exports = 1;\n');

        const req = module.createRequire(path.join(root, 'entry.cjs'));
        throws(
            () => req.resolve('exports-locked-package/package.json'),
            (error: NodeJS.ErrnoException) => {
                strictEqual(error.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
                return true;
            },
        );
        strictEqual(req.resolve('exports-locked-package'), path.join(pkgDir, 'index.js'));
    });
});

Deno.test('module upstream: package exports use import and require conditions', async () => {
    await withTempDir('node-module-dual-conditions', async (root) => {
        const pkgDir = path.join(root, 'node_modules', 'dual-condition-package');
        Deno.mkdirSync(pkgDir, { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: 'dual-condition-package',
            version: '1.0.0',
            type: 'module',
            exports: {
                '.': {
                    import: './mod.mjs',
                    require: './require.cjs',
                },
            },
        }));
        Deno.writeTextFileSync(path.join(pkgDir, 'mod.mjs'), 'export const kind = "esm";\n');
        Deno.writeTextFileSync(path.join(pkgDir, 'require.cjs'), 'module.exports.kind = "cjs";\n');
        Deno.writeTextFileSync(path.join(root, 'entry.mjs'), `
            import { createRequire } from "node:module";
            export const imported = (await import("dual-condition-package")).kind;
            const require = createRequire(import.meta.url);
            export const required = require("dual-condition-package").kind;
        `);

        const ns = await import(pathToFileURL(path.join(root, 'entry.mjs')).href);
        strictEqual(ns.imported, 'esm');
        strictEqual(ns.required, 'cjs');
    });
});

Deno.test('module upstream: package exports resolve root and pattern ESM entries', async () => {
    await withTempDir('node-module-conditional-exports-patterns', async (root) => {
        const pkgDir = path.join(root, 'node_modules', 'conditional-pattern-package');
        Deno.mkdirSync(path.join(pkgDir, 'client'), { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: 'conditional-pattern-package',
            version: '1.0.0',
            type: 'module',
            exports: {
                '.': {
                    import: './mod.mjs',
                    require: './require.cjs',
                },
                './foo.js': './foo.mjs',
                './client': {
                    import: './client/mod.mjs',
                },
                './client/*': {
                    import: './client/*.mjs',
                },
            },
        }));
        Deno.writeTextFileSync(path.join(pkgDir, 'mod.mjs'), 'export default { hello: "from esm" };\n');
        Deno.writeTextFileSync(path.join(pkgDir, 'foo.mjs'), 'export default { hello: "from foo" };\n');
        Deno.writeTextFileSync(path.join(pkgDir, 'client', 'mod.mjs'), 'export default { hello: "from esm client" };\n');
        Deno.writeTextFileSync(path.join(pkgDir, 'client', 'foo.mjs'), 'export default { hello: "from esm client foo" };\n');
        Deno.writeTextFileSync(path.join(pkgDir, 'client', 'bar.mjs'), 'export default { hello: "from esm client bar" };\n');
        Deno.writeTextFileSync(path.join(pkgDir, 'require.cjs'), 'module.exports = { hello: "from cjs" };\n');
        Deno.writeTextFileSync(path.join(root, 'entry.mjs'), `
            import mod from "conditional-pattern-package";
            import foo from "conditional-pattern-package/foo.js";
            import client from "conditional-pattern-package/client";
            import clientFoo from "conditional-pattern-package/client/foo";
            import clientBar from "conditional-pattern-package/client/bar";

            export const values = [mod.hello, foo.hello, client.hello, clientFoo.hello, clientBar.hello];
        `);

        const ns = await import(pathToFileURL(path.join(root, 'entry.mjs')).href);
        deepStrictEqual(ns.values, [
            'from esm',
            'from foo',
            'from esm client',
            'from esm client foo',
            'from esm client bar',
        ]);
    });
});

Deno.test('module upstream: ESM import of type commonjs package exposes named exports', async () => {
    await withTempDir('node-module-type-commonjs-import', async (root) => {
        const pkgDir = path.join(root, 'node_modules', 'type-commonjs-package');
        Deno.mkdirSync(pkgDir, { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: 'type-commonjs-package',
            version: '1.0.0',
            type: 'commonjs',
            main: './index.js',
        }));
        Deno.writeTextFileSync(path.join(pkgDir, 'index.js'), 'exports.add = (a, b) => a + b;\n');
        Deno.writeTextFileSync(path.join(root, 'entry.mjs'), `
            import { add } from "type-commonjs-package";
            export const result = add(1, 2);
        `);

        const ns = await import(pathToFileURL(path.join(root, 'entry.mjs')).href);
        strictEqual(ns.result, 3);
    });
});

Deno.test('module upstream: CJS default property is preserved on default import', async () => {
    await withTempDir('node-module-cjs-reexport-collision', async (root) => {
        const pkgDir = path.join(root, 'node_modules', 'cjs-reexport-collision-package');
        Deno.mkdirSync(pkgDir, { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: 'cjs-reexport-collision-package',
            version: '1.0.0',
            main: './index.cjs',
        }));
        Deno.writeTextFileSync(path.join(pkgDir, 'index.cjs'), `
            module.exports.default = {
                sayHello() {
                    return 'Hi.';
                },
            };
        `);
        Deno.writeTextFileSync(path.join(root, 'entry.mjs'), `
            import reexportCollision from "cjs-reexport-collision-package";
            export const result = reexportCollision.default.sayHello();
        `);

        const ns = await import(pathToFileURL(path.join(root, 'entry.mjs')).href);
        strictEqual(ns.result, 'Hi.');
    });
});

Deno.test('module upstream: CJS dynamic import resolves ESM package exports', async () => {
    await withTempDir('node-module-cjs-dynamic-import-exports', async (root) => {
        const cjsDir = path.join(root, 'node_modules', 'cjs-add');
        const esmDir = path.join(root, 'node_modules', 'esm-add');
        Deno.mkdirSync(cjsDir, { recursive: true });
        Deno.mkdirSync(esmDir, { recursive: true });
        Deno.writeTextFileSync(path.join(cjsDir, 'package.json'), JSON.stringify({ name: 'cjs-add' }));
        Deno.writeTextFileSync(path.join(cjsDir, 'index.js'), `
            module.exports.addAsync = async (a, b) => {
                const add = await import("esm-add");
                return add.default(a, b);
            };
        `);
        Deno.writeTextFileSync(path.join(esmDir, 'package.json'), JSON.stringify({
            name: 'esm-add',
            version: '1.0.0',
            type: 'module',
            exports: {
                '.': {
                    import: './index.js',
                },
            },
        }));
        Deno.writeTextFileSync(path.join(esmDir, 'index.js'), 'export default function add(a, b) { return a + b; }\n');

        const req = module.createRequire(path.join(root, 'entry.cjs'));
        const cjsAdd = req('cjs-add') as { addAsync(a: number, b: number): Promise<number> };
        strictEqual(await cjsAdd.addAsync(1, 2), 3);
    });
});

Deno.test('module upstream: package imports wildcard works from CJS package internals', () => {
    return withTempDir('node-module-imports-wildcard', (root) => {
        const pkgDir = path.join(root, 'node_modules', 'imports-wildcard-package');
        Deno.mkdirSync(path.join(pkgDir, 'inner', 'add'), { recursive: true });
        Deno.mkdirSync(path.join(pkgDir, 'native'), { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: 'imports-wildcard-package',
            imports: {
                '#*': {
                    default: './inner/*/index.js',
                },
                '#native/*': {
                    default: './native/*.js',
                },
            },
        }));
        Deno.writeTextFileSync(path.join(pkgDir, 'index.js'), `
            module.exports.add = require("#add");
            module.exports.subtract = require("#native/subtract");
        `);
        Deno.writeTextFileSync(path.join(pkgDir, 'inner', 'add', 'index.js'), `
            module.exports = function add(a, b) { return a + b; };
        `);
        Deno.writeTextFileSync(path.join(pkgDir, 'native', 'subtract.js'), `
            module.exports = function subtract(a, b) { return a - b; };
        `);

        const req = module.createRequire(path.join(root, 'entry.cjs'));
        const pkg = req('imports-wildcard-package') as {
            add(a: number, b: number): number;
            subtract(a: number, b: number): number;
        };
        strictEqual(pkg.add(1, 2), 3);
        strictEqual(pkg.subtract(4, 2), 2);
    });
});

Deno.test('module upstream: empty package main falls back to index.js', () => {
    return withTempDir('node-module-empty-main', (root) => {
        const pkgDir = path.join(root, 'node_modules', 'empty-main-package');
        Deno.mkdirSync(pkgDir, { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: 'empty-main-package',
            main: '',
        }));
        Deno.writeTextFileSync(path.join(pkgDir, 'index.js'), 'module.exports.add = (a, b) => a + b;\n');

        const req = module.createRequire(path.join(root, 'entry.cjs'));
        const pkg = req('empty-main-package') as { add(a: number, b: number): number };
        strictEqual(pkg.add(1, 2), 3);
        strictEqual(req.resolve('empty-main-package'), path.join(pkgDir, 'index.js'));
    });
});

Deno.test('module upstream: no-type package js with ESM syntax is detected as ESM', async () => {
    await withTempDir('node-module-detect-esm-syntax', async (root) => {
        const pkgDir = path.join(root, 'node_modules', 'syntax-detected-package');
        Deno.mkdirSync(pkgDir, { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'syntax-detected-package' }));
        Deno.writeTextFileSync(path.join(pkgDir, 'index.js'), `
            export function add(a, b) {
                return a + b;
            }
        `);
        Deno.writeTextFileSync(path.join(root, 'entry.mjs'), `
            import { add } from "syntax-detected-package";
            export const result = add(1, 2);
        `);

        const ns = await import(pathToFileURL(path.join(root, 'entry.mjs')).href);
        strictEqual(ns.result, 3);
    });
});

Deno.test('module upstream: CJS re-export of required ESM preserves namespace and names', async () => {
    await withTempDir('node-module-require-esm-reexport', async (root) => {
        Deno.writeTextFileSync(path.join(root, 'add.mjs'), `
            export function add(a, b) {
                return a + b;
            }
        `);
        Deno.writeTextFileSync(path.join(root, 'mod2.cjs'), 'module.exports = require("./add.mjs");\n');
        Deno.writeTextFileSync(path.join(root, 'mod1.cjs'), 'module.exports = require("./mod2.cjs");\n');
        Deno.writeTextFileSync(path.join(root, 'entry.mjs'), `
            import mod, { add } from "./mod1.cjs";
            export const defaultResult = mod.add(1, 2);
            export const namedResult = add(1, 2);
        `);

        const ns = await import(pathToFileURL(path.join(root, 'entry.mjs')).href);
        strictEqual(ns.defaultResult, 3);
        strictEqual(ns.namedResult, 3);
    });
});

Deno.test('module upstream: ESM module.exports export survives CJS re-export chain', async () => {
    await withTempDir('node-module-require-esm-module-exports-reexport', async (root) => {
        Deno.writeTextFileSync(path.join(root, 'add.mjs'), `
            function add(a, b) {
                return a + b;
            }
            export { add as "module.exports" };
        `);
        Deno.writeTextFileSync(path.join(root, 'mod2.cjs'), 'module.exports = require("./add.mjs");\n');
        Deno.writeTextFileSync(path.join(root, 'mod1.cjs'), 'module.exports = require("./mod2.cjs");\n');
        Deno.writeTextFileSync(path.join(root, 'entry.mjs'), `
            import add from "./mod1.cjs";
            export const result = add(1, 2);
        `);

        const ns = await import(pathToFileURL(path.join(root, 'entry.mjs')).href);
        strictEqual(ns.result, 3);
    });
});

Deno.test('module upstream: node condition MJS re-export of CJS preserves named export', async () => {
    await withTempDir('node-module-cjs-reexport-node-condition', async (root) => {
        const pkgDir = path.join(root, 'node_modules', 'node-condition-reexport-package');
        Deno.mkdirSync(pkgDir, { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: 'node-condition-reexport-package',
            version: '1.0.0',
            type: 'module',
            exports: {
                '.': {
                    node: './mod.mjs',
                    default: './wrong.mjs',
                },
            },
        }));
        Deno.writeTextFileSync(path.join(pkgDir, 'mod.mjs'), 'export { hello } from "./node.cjs";\n');
        Deno.writeTextFileSync(path.join(pkgDir, 'node.cjs'), 'exports.hello = "from node";\n');
        Deno.writeTextFileSync(path.join(pkgDir, 'wrong.mjs'), 'export const hello = "wrong";\n');
        Deno.writeTextFileSync(path.join(root, 'entry.mjs'), `
            import { hello } from "node-condition-reexport-package";
            export const result = hello;
        `);

        const ns = await import(pathToFileURL(path.join(root, 'entry.mjs')).href);
        strictEqual(ns.result, 'from node');
    });
});

Deno.test('module upstream: CJS re-export getters from subfolder survive ESM namespace bridge', async () => {
    await withTempDir('node-module-cjs-reexport-same-specifier-subfolder', async (root) => {
        const pkgDir = path.join(root, 'node_modules', 'same-specifier-reexport-package');
        Deno.mkdirSync(path.join(pkgDir, 'sub'), { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: 'same-specifier-reexport-package',
            version: '1.0.0',
            main: './index.cjs',
        }));
        Deno.writeTextFileSync(path.join(pkgDir, 'index.cjs'), `
            const sub = require("./sub");
            Object.defineProperty(exports, "main", { enumerable: true, get() { return 1; } });
            Object.defineProperty(exports, "sub", { enumerable: true, get() { return sub.sub; } });
        `);
        Deno.writeTextFileSync(path.join(pkgDir, 'sub', 'index.cjs'), `
            Object.defineProperty(exports, "sub", { enumerable: true, get() { return 2; } });
        `);
        Deno.writeTextFileSync(path.join(root, 'entry.mjs'), `
            import * as module from "same-specifier-reexport-package";
            export const main = module.main;
            export const sub = module.sub;
            export const defaultMain = module.default.main;
            export const moduleExportsSub = module["module.exports"].sub;
        `);

        const ns = await import(pathToFileURL(path.join(root, 'entry.mjs')).href);
        strictEqual(ns.main, 1);
        strictEqual(ns.sub, 2);
        strictEqual(ns.defaultMain, 1);
        strictEqual(ns.moduleExportsSub, 2);
    });
});

Deno.test('module upstream: ESM import of extensionless package subpath can load CJS', async () => {
    await withTempDir('node-module-extensionless-cjs-subpath', async (root) => {
        const pkgDir = path.join(root, 'node_modules', 'extensionless-package');
        Deno.mkdirSync(pkgDir, { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: 'extensionless-package',
            type: 'module',
        }));
        Deno.writeTextFileSync(path.join(pkgDir, 'add'), `
            module.exports.add = require("./internal.cjs").add;
        `);
        Deno.writeTextFileSync(path.join(pkgDir, 'internal.cjs'), `
            module.exports.add = (a, b) => a + b;
        `);
        Deno.writeTextFileSync(path.join(root, 'entry.mjs'), `
            import { add } from "extensionless-package/add";
            export const result = add(1, 2);
        `);

        const ns = await import(pathToFileURL(path.join(root, 'entry.mjs')).href);
        strictEqual(ns.result, 3);
    });
});

Deno.test('module: Module._cache exposes the same object-like require cache proxy', () => {
    return withTempDir('node-module-cache', (root) => {
        const dep = path.join(root, 'cache-target.cjs');
        Deno.writeTextFileSync(dep, 'module.exports = { value: 42 };');

        const req = module.createRequire(path.join(root, 'entry.cjs'));
        req('./cache-target.cjs');
        const resolved = req.resolve('./cache-target.cjs');

        ok(resolved in Module._cache);
        strictEqual(Module._cache[resolved], module._cache[resolved]);
        ok(Object.keys(Module._cache).includes(resolved));
    });
});

Deno.test('module: createRequire rejects relative paths', () => {
    throws(() => module.createRequire('./relative.js'), TypeError);
});

Deno.test('module upstream: createRequire arity error stack uses node:module prefix', () => {
    throws(
        () => Reflect.apply(module.createRequire, undefined, []),
        (error: unknown) => {
            const stack = String((error as Error).stack);
            ok(stack.includes('node:module'));
            return true;
        },
    );
});

Deno.test('module: _nodeModulePaths includes root node_modules on POSIX', () => {
    if (process.platform === 'win32') return;
    deepStrictEqual(module._nodeModulePaths('/a/b/c'), [
        '/a/b/c/node_modules',
        '/a/b/node_modules',
        '/a/node_modules',
        '/node_modules',
    ]);
});

Deno.test('module: _nodeModulePaths resolves relative input from cwd', () => {
    const first = module._nodeModulePaths('relative/pkg')[0];
    strictEqual(first, path.join(path.resolve('relative/pkg'), 'node_modules'));
});

Deno.test('module: _nodeModulePaths avoids duplicate node_modules segments', () => {
    const paths = module._nodeModulePaths(path.join(process.cwd(), 'testdata', 'node_modules', 'foo'));
    ok(!paths.some((dir) => /node_modules[/\\]node_modules/.test(dir)));
    strictEqual(new Set(paths).size, paths.length);
    strictEqual(paths[1], path.join(process.cwd(), 'testdata', 'node_modules'));
    strictEqual(paths.includes(path.parse(paths[0]!).root + 'node_modules'), true);
});

Deno.test('module: findSourceMap and register are available no-op hooks', () => {
    strictEqual(module.findSourceMap('foo'), undefined);
    strictEqual(module.register('foo'), undefined);
});

Deno.test('module upstream: _preloadModules requires modules relative to cwd', () => {
    return withTempDir('node-module-preload', (root) => {
        const previous = Deno.cwd();
        const marker = '__cnoModulePreload';
        Deno.writeTextFileSync(path.join(root, 'preload.cjs'), `globalThis.${marker} = 'loaded';`);
        try {
            delete (globalThis as Record<string, unknown>)[marker];
            Deno.chdir(root);
            (module.Module as typeof module.Module & { _preloadModules(requests: string[]): void })._preloadModules(['./preload.cjs']);
            strictEqual((globalThis as Record<string, unknown>)[marker], 'loaded');
        } finally {
            Deno.chdir(previous);
            delete (globalThis as Record<string, unknown>)[marker];
        }
    });
});

Deno.test('module upstream: runMain loads the current process argv entry', () => {
    return withTempDir('node-module-run-main', (root) => {
        const previousCwd = Deno.cwd();
        const previousArgv = [...globalThis.process.argv];
        const marker = '__cnoModuleRunMain';
        Deno.writeTextFileSync(path.join(root, 'main.cjs'), `globalThis.${marker} = 'ran';`);
        try {
            delete (globalThis as Record<string, unknown>)[marker];
            Deno.chdir(root);
            globalThis.process.argv = [previousArgv[0] ?? 'cno', './main.cjs'];
            (module.Module as typeof module.Module & { runMain(): void }).runMain();
            strictEqual((globalThis as Record<string, unknown>)[marker], 'ran');
        } finally {
            globalThis.process.argv = previousArgv;
            Deno.chdir(previousCwd);
            delete (globalThis as Record<string, unknown>)[marker];
        }
    });
});

Deno.test('module: Module constructor links parent and initializes paths', () => {
    const parent = new module.Module('/tmp/parent.js');
    const child = new module.Module('/tmp/a/child.js', parent);

    strictEqual(child.id, '/tmp/a/child.js');
    strictEqual(child.filename, '/tmp/a/child.js');
    strictEqual(child.path, '/tmp/a');
    strictEqual(child.parent, parent);
    strictEqual(parent.children[0], child);
    ok(child.paths.includes('/tmp/a/node_modules'));
});

Deno.test('module: Module.wrap and _compile provide CommonJS wrapper variables', () => {
    const wrapped = module.wrap('return __filename;');
    ok(wrapped.startsWith('(function(exports, require, module, __filename, __dirname)'));
    ok(wrapped.endsWith('\n});'));

    const mod = new module.Module('/tmp/compiled.js');
    mod._compile(`
        const path = require('node:path');
        exports.basename = path.basename(__filename);
        exports.dirname = __dirname;
        exports.moduleId = module.id;
    `, '/tmp/compiled.js');

    deepStrictEqual(mod.exports, {
        basename: 'compiled.js',
        dirname: '/tmp',
        moduleId: '/tmp/compiled.js',
    });
});

Deno.test('module upstream: Module._compile with relative fake filename resolves package requires from cwd', () => {
    return withTempDir('node-module-compile-fake-filename', (root) => {
        const previous = Deno.cwd();
        const pkgDir = path.join(root, 'node_modules', '@denotest', 'cjs-multiple-exports');
        Deno.mkdirSync(pkgDir, { recursive: true });
        Deno.writeTextFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: '@denotest/cjs-multiple-exports',
            exports: {
                './add': './add.cjs',
            },
        }));
        Deno.writeTextFileSync(path.join(pkgDir, 'add.cjs'), 'module.exports = (a, b) => a + b;\n');

        try {
            Deno.chdir(root);
            const mod = new module.Module('fake.js');
            mod.paths = module.Module._nodeModulePaths(path.dirname('fake.js'));
            mod._compile(`
                const add = require("@denotest/cjs-multiple-exports/add");
                module.exports = add(1, 2);
            `, 'fake.js');
            strictEqual(mod.exports, 3);
        } finally {
            Deno.chdir(previous);
        }
    });
});

Deno.test('module upstream: Module.prototype._compile can be overridden', () => {
    const originalCompile = module.Module.prototype._compile;
    try {
        module.Module.prototype._compile = function (this: InstanceType<typeof module.Module>, content: string, filename: string) {
            const dirname = path.dirname(filename);
            const wrapped = module.wrap(content);
            const compiled = eval(wrapped) as (
                exports: unknown,
                require: NodeRequire,
                module: InstanceType<typeof module.Module>,
                __filename: string,
                __dirname: string,
            ) => void;
            compiled(this.exports, this.require.bind(this), this, filename, dirname);
            return this.exports;
        };

        const mod = new module.Module('/tmp/override.js');
        const result = mod._compile(`
            exports.clearImmediate = typeof clearImmediate;
            exports.clearTimeout = typeof clearTimeout;
            exports.setImmediate = typeof setImmediate;
            exports.global = typeof global;
        `, '/tmp/override.js') as Record<string, string>;

        deepStrictEqual(result, {
            clearImmediate: 'function',
            clearTimeout: 'function',
            setImmediate: 'function',
            global: 'object',
        });
    } finally {
        module.Module.prototype._compile = originalCompile;
    }
});

Deno.test('module: exported _compile returns module exports object', () => {
    const result = module._compile('exports.value = require("node:path").basename(__filename);', '/tmp/direct.js');
    deepStrictEqual(result, { value: 'direct.js' });
});
