/**
 * Contract for require() ↔ node:module interop: patched Module._load /
 * _resolveFilename must be observed, require.extensions must be one shared
 * table that the loader actually consults, require.cache must be identical to
 * Module._cache, and registerHooks() must fire.
 *
 * This is what ts-node, @babel/register, pirates and require-in-the-middle
 * depend on — and therefore every APM agent.
 *
 * The CJS cases pin requires produced by Module.createRequire(). The ESM cases
 * pin the shared CTS resolve chain used by import.meta.resolve and import().
 * The `require` injected into a .cjs module body is manufactured by CjsLoader,
 * but its cache and extension views must be the same process-wide objects as
 * node:module's createRequire() views.
 */
import { ok, strictEqual } from 'node:assert';
import Module, * as module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withTempDir } from '../_helpers/temp.ts';

/**
 * Without a package.json the runtime treats bare `.js` as ESM and `module` is
 * undefined, so every fixture directory needs an explicit CommonJS marker.
 */
function markCommonJS(root: string): void {
    Deno.writeTextFileSync(path.join(root, 'package.json'), '{"name":"fixture","type":"commonjs"}');
}

Deno.test('module hooks: patched Module._load observes createRequire loads', () => {
    return withTempDir('module-hooks-load', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(path.join(root, 'dep.js'), 'module.exports = { v: 1 };');
        const req = module.createRequire(path.join(root, 'entry.cjs'));

        const orig = Module._load;
        let calls = 0;
        try {
            Module._load = function (request: string, parent: unknown, isMain: boolean) {
                calls++;
                return orig.call(this, request, parent, isMain);
            };
            const loaded = req('./dep.js') as { v: number };
            strictEqual(loaded.v, 1);
        } finally {
            Module._load = orig;
        }
        strictEqual(calls, 1);
    });
});

Deno.test('module hooks: require-in-the-middle style _load patch can rewrite exports', () => {
    return withTempDir('module-hooks-ritm', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(path.join(root, 'dep.js'), 'module.exports = { original: true };');
        const req = module.createRequire(path.join(root, 'entry.cjs'));

        const orig = Module._load;
        try {
            Module._load = function (request: string, parent: unknown, isMain: boolean) {
                const exports = orig.call(this, request, parent, isMain);
                if (String(request).includes('dep') && exports && typeof exports === 'object') {
                    return { ...(exports as object), instrumented: true };
                }
                return exports;
            };
            const loaded = req('./dep.js') as { original: boolean; instrumented: boolean };
            strictEqual(loaded.original, true);
            strictEqual(loaded.instrumented, true);
        } finally {
            Module._load = orig;
        }
    });
});

Deno.test('module hooks: patched Module._resolveFilename observes require.resolve', () => {
    return withTempDir('module-hooks-resolve', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(path.join(root, 'dep.js'), 'module.exports = 1;');
        const req = module.createRequire(path.join(root, 'entry.cjs'));

        const orig = Module._resolveFilename;
        let calls = 0;
        try {
            Module._resolveFilename = function (request: string, parent: unknown, isMain: boolean, options: unknown) {
                calls++;
                return orig.call(this, request, parent, isMain, options);
            };
            req.resolve('./dep.js');
        } finally {
            Module._resolveFilename = orig;
        }
        strictEqual(calls, 1);
    });
});

Deno.test('module hooks: require.extensions is one shared table', () => {
    const a = module.createRequire(path.join(Deno.cwd(), 'a.cjs')) as unknown as { extensions: unknown; cache: unknown };
    const b = module.createRequire(path.join(Deno.cwd(), 'b.cjs')) as unknown as { extensions: unknown; cache: unknown };
    strictEqual(a.extensions, b.extensions, 'two createRequire() results must share one extensions table');
    strictEqual(a.extensions, Module._extensions, 'require.extensions must be Module._extensions');
    strictEqual(a.cache, Module._cache, 'require.cache must be Module._cache');
    ok(typeof (Module._extensions as Record<string, unknown>)['.js'] === 'function');
    ok(typeof (Module._extensions as Record<string, unknown>)['.json'] === 'function');
    ok(typeof (Module._extensions as Record<string, unknown>)['.node'] === 'function');
});

Deno.test('module hooks: a registered extension handler is actually consulted', () => {
    return withTempDir('module-hooks-ext', (root) => {
        markCommonJS(root);
        // Deliberately not JavaScript: only a custom handler can load it.
        Deno.writeTextFileSync(path.join(root, 'data.custom'), 'not javascript {{{');
        const req = module.createRequire(path.join(root, 'entry.cjs'));
        const table = Module._extensions as Record<string, unknown>;

        table['.custom'] = (mod: { exports: unknown }, filename: string) => {
            mod.exports = { handled: true, filename };
        };
        try {
            const loaded = req('./data.custom') as { handled: boolean; filename: string };
            strictEqual(loaded.handled, true, 'custom extension handler must run');
            ok(loaded.filename.endsWith('data.custom'));
        } finally {
            delete table['.custom'];
        }
    });
});

Deno.test('module hooks: pirates-style .js handler wrapping transforms source', () => {
    return withTempDir('module-hooks-pirates', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(path.join(root, 'dep.js'), 'module.exports = { base: true };');
        const req = module.createRequire(path.join(root, 'entry.cjs'));
        const table = Module._extensions as Record<string, (m: unknown, f: string) => void>;

        const originalJs = table['.js']!;
        let handlerCalls = 0;
        table['.js'] = function (mod: unknown, filename: string) {
            handlerCalls++;
            const m = mod as { _compile: (code: string, f: string) => void };
            const originalCompile = m._compile;
            m._compile = function (code: string, f: string) {
                return originalCompile.call(this, `${code}\nmodule.exports.transformed = true;`, f);
            };
            return originalJs.call(this, mod, filename);
        };
        try {
            const loaded = req('./dep.js') as { base: boolean; transformed: boolean };
            strictEqual(handlerCalls, 1, 'wrapped .js handler must be invoked');
            strictEqual(loaded.base, true, 'original module body must still run');
            strictEqual(loaded.transformed, true, 'pirates-style transform must apply');
        } finally {
            table['.js'] = originalJs;
        }
    });
});

Deno.test('module hooks: registerHooks resolve and load hooks fire', () => {
    return withTempDir('module-hooks-register', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(path.join(root, 'dep.js'), 'module.exports = { real: true };');
        const req = module.createRequire(path.join(root, 'entry.cjs'));

        let resolveFired = 0;
        let loadFired = 0;
        const controller = module.registerHooks({
            resolve(spec: string, ctx: unknown, next: (s: string, c?: unknown) => unknown) {
                resolveFired++;
                return next(spec, ctx);
            },
            load(url: string, ctx: unknown, next: (u: string, c?: unknown) => unknown) {
                loadFired++;
                return next(url, ctx);
            },
        } as never);
        try {
            const loaded = req('./dep.js') as { real: boolean };
            strictEqual(loaded.real, true);
            ok(resolveFired > 0, 'resolve hook must fire');
            ok(loadFired > 0, 'load hook must fire');
        } finally {
            controller.deregister();
        }
    });
});

Deno.test('module hooks: resolve hook is shared with CTS import.meta.resolve', () => {
    return withTempDir('module-hooks-meta-resolve', (root) => {
        const importer = path.join(root, 'vite.config.mjs');
        const dependency = path.join(root, 'dep.mjs');
        Deno.writeTextFileSync(importer, 'export default {};\n');
        Deno.writeTextFileSync(dependency, 'export const value = 42;\n');

        const prefix = 'vite-module-runner:import-meta-resolve/v1/';
        let calls = 0;
        const controller = module.registerHooks({
            resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c?: unknown) => { url: string }) {
                calls++;
                if (specifier.startsWith(prefix)) {
                    const [nextSpecifier, parentURL] = JSON.parse(specifier.slice(prefix.length)) as [string, string];
                    specifier = nextSpecifier;
                    context.parentURL = parentURL;
                }
                return nextResolve(specifier, context);
            },
        } as never);

        let resolved: string;
        try {
            const request = prefix + JSON.stringify(['./dep.mjs', pathToFileURL(importer).href]);
            resolved = import.meta.resolve(request);
        } finally {
            controller.deregister();
        }

        strictEqual(fileURLToPath(resolved), dependency);
        strictEqual(calls, 1, 'CTS import.meta.resolve must traverse the registered hook exactly once');
        import.meta.resolve('./module.test.ts');
        strictEqual(calls, 1, 'deregister must detach the hook from CTS');
    });
});

Deno.test('module hooks: resolve hook is shared with CTS dynamic import', async () => {
    await withTempDir('module-hooks-dynamic-import', async (root) => {
        const importer = path.join(root, 'entry.mjs');
        const dependency = path.join(root, 'dep.mjs');
        Deno.writeTextFileSync(importer, 'export default {};\n');
        Deno.writeTextFileSync(dependency, 'export const value = 42;\n');

        const prefix = 'cno-module-hook:dynamic-import/';
        let calls = 0;
        const controller = module.registerHooks({
            resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c?: unknown) => { url: string }) {
                calls++;
                if (specifier.startsWith(prefix)) {
                    const [nextSpecifier, parentURL] = JSON.parse(specifier.slice(prefix.length)) as [string, string];
                    specifier = nextSpecifier;
                    context.parentURL = parentURL;
                }
                return nextResolve(specifier, context);
            },
        } as never);

        try {
            const request = prefix + JSON.stringify(['./dep.mjs', pathToFileURL(importer).href]);
            const namespace = await import(request) as { value?: number };
            strictEqual(namespace.value, 42);
            strictEqual(calls, 1, 'CTS dynamic import must traverse the registered hook exactly once');
        } finally {
            controller.deregister();
        }
    });
});

Deno.test('module hooks: CTS honors an in-place nextResolve URL rewrite', () => {
    return withTempDir('module-hooks-result-rewrite', (root) => {
        const importer = path.join(root, 'entry.mjs');
        const first = path.join(root, 'first.mjs');
        const second = path.join(root, 'second.mjs');
        Deno.writeTextFileSync(importer, 'export default {};\n');
        Deno.writeTextFileSync(first, 'export const value = 1;\n');
        Deno.writeTextFileSync(second, 'export const value = 2;\n');

        const controller = module.registerHooks({
            resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c?: unknown) => { url: string }) {
                if (specifier !== 'cno-hook:rewrite-result') return nextResolve(specifier, context);
                context.parentURL = pathToFileURL(importer).href;
                const result = nextResolve('./first.mjs', context);
                result.url = pathToFileURL(second).href;
                return result;
            },
        } as never);

        try {
            const resolved = import.meta.resolve('cno-hook:rewrite-result');
            strictEqual(fileURLToPath(resolved), second);
        } finally {
            controller.deregister();
        }
    });
});

Deno.test('module hooks: a load hook may replace module source', () => {
    return withTempDir('module-hooks-loadsrc', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(path.join(root, 'dep.js'), 'module.exports = { real: true };');
        const req = module.createRequire(path.join(root, 'entry.cjs'));

        const controller = module.registerHooks({
            load(url: string, ctx: unknown, next: (u: string, c?: unknown) => unknown) {
                if (String(url).includes('dep')) {
                    return { format: 'commonjs', source: 'module.exports = { swapped: true };', shortCircuit: true };
                }
                return next(url, ctx);
            },
        } as never);
        let swapped: { swapped?: boolean };
        try {
            swapped = req('./dep.js') as { swapped?: boolean };
        } finally {
            controller.deregister();
        }
        strictEqual(swapped.swapped, true, 'load hook source must be honored');

        // After deregister the real file must load again.
        delete (Module._cache as Record<string, unknown>)[req.resolve('./dep.js')];
        const real = req('./dep.js') as { real?: boolean };
        strictEqual(real.real, true, 'deregister must restore default loading');
    });
});

Deno.test('module hooks: hook machinery does not break ordinary loads', () => {
    return withTempDir('module-hooks-regression', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(path.join(root, 'dep.js'), 'module.exports = { n: 7 };');
        Deno.writeTextFileSync(path.join(root, 'data.json'), '{"name":"pkg"}');
        const req = module.createRequire(path.join(root, 'entry.cjs'));

        strictEqual((req('./dep.js') as { n: number }).n, 7);
        strictEqual((req('./data.json') as { name: string }).name, 'pkg');
        strictEqual(typeof (req('node:path') as { join: unknown }).join, 'function');
    });
});

Deno.test('module hooks: deleting from require.cache re-executes the module', () => {
    return withTempDir('module-hooks-cache', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(
            path.join(root, 'counter.js'),
            'globalThis.__moduleHookRuns = (globalThis.__moduleHookRuns || 0) + 1; module.exports = { runs: globalThis.__moduleHookRuns };',
        );
        const req = module.createRequire(path.join(root, 'entry.cjs'));

        const first = (req('./counter.js') as { runs: number }).runs;
        strictEqual((req('./counter.js') as { runs: number }).runs, first, 'cached second require must not re-run');

        // Both spellings must hit the same store.
        delete (req as unknown as { cache: Record<string, unknown> }).cache[req.resolve('./counter.js')];
        strictEqual((req('./counter.js') as { runs: number }).runs, first + 1);
        delete (Module._cache as Record<string, unknown>)[req.resolve('./counter.js')];
        strictEqual((req('./counter.js') as { runs: number }).runs, first + 2);
    });
});

Deno.test('module hooks: Module._cache replacement is the live CJS loader backend', () => {
    return withTempDir('module-hooks-cache-replace', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(
            path.join(root, 'counter.js'),
            'globalThis.__moduleCacheReplaceRuns = (globalThis.__moduleCacheReplaceRuns || 0) + 1; module.exports = { runs: globalThis.__moduleCacheReplaceRuns };',
        );
        const a = module.createRequire(path.join(root, 'a.cjs')) as unknown as { cache: Record<string, unknown>; resolve(id: string): string; (id: string): unknown };
        const b = module.createRequire(path.join(root, 'b.cjs')) as unknown as { cache: Record<string, unknown>; (id: string): unknown };
        const original = Module._cache;
        const replacement = Object.create(null) as Record<string, unknown>;
        try {
            strictEqual((a('./counter.js') as { runs: number }).runs, 1);
            Module._cache = replacement;
            strictEqual(Module._cache, replacement);
            strictEqual(a.cache, replacement);
            strictEqual(b.cache, replacement);

            strictEqual((a('./counter.js') as { runs: number }).runs, 2, 'replacement must not retain the old cache entry');
            const resolved = a.resolve('./counter.js');
            original[resolved] = { exports: { runs: 77 } };
            strictEqual((b('./counter.js') as { runs: number }).runs, 2, 'a saved cache object must not mutate the replacement backend');
            delete replacement[resolved];
            strictEqual((b('./counter.js') as { runs: number }).runs, 3, 'delete on replacement must evict the loader entry');

            replacement[resolved] = { exports: { runs: 99 } };
            strictEqual((a('./counter.js') as { runs: number }).runs, 99, 'manual cache entries must be read directly');
            Module._cache = original;
            strictEqual(a.cache, original);
            strictEqual((b('./counter.js') as { runs: number }).runs, 77, 'restoring a saved cache object must restore its current entries');
        } finally {
            Module._cache = original;
        }
    });
});

Deno.test('module hooks: require.cache replacement is process-wide', () => {
    return withTempDir('module-hooks-require-cache-replace', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(
            path.join(root, 'counter.js'),
            'globalThis.__requireCacheReplaceRuns = (globalThis.__requireCacheReplaceRuns || 0) + 1; module.exports = { runs: globalThis.__requireCacheReplaceRuns };',
        );
        const a = module.createRequire(path.join(root, 'a.cjs')) as unknown as { cache: Record<string, unknown>; (id: string): unknown };
        const b = module.createRequire(path.join(root, 'b.cjs')) as unknown as { cache: Record<string, unknown>; (id: string): unknown };
        const original = Module._cache;
        const replacement = Object.create(null) as Record<string, unknown>;
        try {
            strictEqual((a('./counter.js') as { runs: number }).runs, 1);
            a.cache = replacement;
            strictEqual(a.cache, replacement);
            strictEqual(b.cache, replacement);
            strictEqual(Module._cache, replacement);
            strictEqual((b('./counter.js') as { runs: number }).runs, 2, 'replacement must evict prior entries for every createRequire view');
            strictEqual((a('./counter.js') as { runs: number }).runs, 2, 'all createRequire views must use the same replacement');
        } finally {
            Module._cache = original;
        }
    });
});

Deno.test('module hooks: in-body require.extensions replacement remains shared and live', () => {
    return withTempDir('module-hooks-inbody-extensions-replace', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(path.join(root, 'data.js'), 'ignored');
        Deno.writeTextFileSync(
            path.join(root, 'probe.cjs'),
            `const M = require('module');
             const table = Object.create(null);
             require.extensions = table;
             table['.js'] = (mod, filename) => { mod.exports = { handled: true, filename }; };
             const value = require('./data.js');
             module.exports = {
                 sameRequire: require.extensions === table,
                 sameModule: M._extensions === table,
                 handled: value.handled === true,
                 filename: value.filename,
             };`,
        );
        const req = module.createRequire(path.join(root, 'entry.cjs'));
        const original = Module._extensions;
        try {
            const result = req('./probe.cjs') as { sameRequire: boolean; sameModule: boolean; handled: boolean; filename: string };
            strictEqual(result.sameRequire, true);
            strictEqual(result.sameModule, true);
            strictEqual(result.handled, true);
            ok(result.filename.endsWith('data.js'));
            strictEqual(req.extensions, Module._extensions, 'new createRequire views must observe the replacement');
        } finally {
            Module._extensions = original;
        }
    });
});

/**
 * require-in-the-middle's actual technique: patch `Module._resolveFilename` and
 * inspect what a plain `require()` resolves. Distinct from patching it and
 * calling `require.resolve()` — only the former proves the load path consults it.
 */
Deno.test('module hooks: patched Module._resolveFilename fires for require(), not just require.resolve()', () => {
    return withTempDir('module-hooks-resolve-load', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(path.join(root, 'dep.js'), 'module.exports = { base: true };');
        const req = module.createRequire(path.join(root, 'entry.cjs'));

        const orig = Module._resolveFilename;
        let calls = 0;
        let seen = '';
        try {
            Module._resolveFilename = function (request: string, parent: unknown, isMain: boolean, options: unknown) {
                calls++;
                const resolved = orig.call(this, request, parent, isMain, options);
                seen = resolved;
                return resolved;
            };
            const loaded = req('./dep.js') as { base: boolean };
            strictEqual(loaded.base, true, 'module must still load');
        } finally {
            Module._resolveFilename = orig;
        }
        strictEqual(calls, 1, 'require() must consult Module._resolveFilename');
        ok(seen.endsWith('dep.js'), `resolver must see the target, got ${seen}`);
    });
});

/**
 * pirates / ts-node / @babel/register patch `Module.prototype._compile` — a
 * prototype-level patch, with no involvement of require.extensions.
 */
Deno.test('module hooks: patched Module.prototype._compile fires and can transform source', () => {
    return withTempDir('module-hooks-proto-compile', (root) => {
        markCommonJS(root);
        Deno.writeTextFileSync(path.join(root, 'dep.js'), 'module.exports = { base: true };');
        const req = module.createRequire(path.join(root, 'entry.cjs'));

        const proto = Module.prototype as unknown as { _compile: (code: string, f: string) => unknown };
        const orig = proto._compile;
        let calls = 0;
        let loaded: { base?: boolean; transformed?: boolean };
        try {
            proto._compile = function (code: string, filename: string) {
                calls++;
                return orig.call(this, `${code}\nmodule.exports.transformed = true;`, filename);
            };
            loaded = req('./dep.js') as { base?: boolean; transformed?: boolean };
        } finally {
            proto._compile = orig;
        }
        strictEqual(calls, 1, 'Module.prototype._compile must be called once for a fresh .js module');
        strictEqual(loaded.base, true, 'original module body must still run');
        strictEqual(loaded.transformed, true, 'prototype-level transform must apply');
    });
});

/**
 * The JS load path must not break ESM. A `.js` file that is really ESM cannot be
 * wrapped as CommonJS, so it has to fall back to the native loader even while a
 * prototype `_compile` patch is installed.
 */
Deno.test('module hooks: a prototype _compile patch does not break requiring ESM', () => {
    return withTempDir('module-hooks-esm-guard', (root) => {
        Deno.writeTextFileSync(path.join(root, 'package.json'), '{"name":"fixture","type":"module"}');
        Deno.writeTextFileSync(path.join(root, 'esmdep.js'), 'export const v = 41;\nexport default { d: 1 };\n');
        const req = module.createRequire(path.join(root, 'entry.cjs'));

        const proto = Module.prototype as unknown as { _compile: (code: string, f: string) => unknown };
        const orig = proto._compile;
        let loaded: { v?: number };
        try {
            proto._compile = function (code: string, filename: string) {
                return orig.call(this, code, filename);
            };
            loaded = req('./esmdep.js') as { v?: number };
        } finally {
            proto._compile = orig;
        }
        strictEqual(loaded.v, 41, 'ESM .js must still load under a _compile patch');
    });
});

/**
 * The in-body `require` half: both identity and actual extension dispatch are
 * covered here because ts-node / pirates register from inside CJS modules and
 * then expect to intercept their siblings.
 */
Deno.test({
    name: 'module hooks: in-body require shares node:module cache and extensions',
    ignore: false,
    fn: () => {
        return withTempDir('module-hooks-inbody', (root) => {
            markCommonJS(root);
            Deno.writeTextFileSync(
                path.join(root, 'probe.cjs'),
                `const M = require('module');
                 const original = M._extensions['.js'];
                 let hookCalls = 0;
                 M._extensions['.js'] = (mod, filename) => {
                     hookCalls++;
                     original(mod, filename);
                     mod.exports.fromInBodyHook = true;
                 };
                 const sibling = require('./sibling.cjs');
                 M._extensions['.js'] = original;
                 delete require.cache[require.resolve('./sibling.cjs')];
                 const restored = require('./sibling.cjs');
                 module.exports = {
                     sameExtensions: require.extensions === M._extensions,
                     sameCache: require.cache === M._cache,
                     hookCalls,
                     siblingHooked: sibling.fromInBodyHook === true,
                     handlerRestored: restored.fromInBodyHook === undefined,
                 };`,
            );
            Deno.writeTextFileSync(path.join(root, 'sibling.cjs'), 'module.exports = { sibling: true };');
            const req = module.createRequire(path.join(root, 'entry.cjs'));
            const result = req('./probe.cjs') as { sameExtensions: boolean; sameCache: boolean };
            strictEqual(result.sameExtensions, true);
            strictEqual(result.sameCache, true);
            strictEqual((result as typeof result & { hookCalls: number }).hookCalls, 1);
            strictEqual((result as typeof result & { siblingHooked: boolean }).siblingHooked, true);
            strictEqual((result as typeof result & { handlerRestored: boolean }).handlerRestored, true);
        });
    },
});
