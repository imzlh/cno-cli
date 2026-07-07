import { strictEqual, ok, deepStrictEqual, throws } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// --- 1. require() of async ESM must throw, NOT return a half-init namespace --
//
// The module below has a sync export AND a top-level await. A naive bridge
// would see a non-empty namespace and return it, causing a silent dead-lock.
Deno.test('cjs: require() of async ESM throws instead of returning partial namespace', () => {
    let threw = false;
    let msg = '';
    try {
        require('./fixtures/async-esm-with-sync-export/async.mjs');
    } catch (e: any) {
        threw = true;
        msg = String(e.message);
    }
    ok(threw, 'require() of async ESM must throw');
    ok(/async ESM|require\(\) async|top-level await/i.test(msg),
        `error must mention async ESM, got: ${msg}`);
});

// --- 2. require() of sync ESM returns live namespace with default ----------

Deno.test('cjs: require() of sync ESM exposes default export', () => {
    const m = require('./fixtures/cjs-require-esm/vite.config.js');
    deepStrictEqual(m, { kind: 'esm-js', answer: 42 });
});

// --- 3. require() of ESM is cached: same object on repeat require ---------

Deno.test('cjs: require() of ESM returns cached identity', () => {
    const first = require('./fixtures/cjs-require-esm/vite.config.js');
    const second = require('./fixtures/cjs-require-esm/vite.config.js');
    strictEqual(first, second, 'repeat require must yield same object');
});

// --- 4. require() of ESM exposes named exports as keys ---------------------

Deno.test('cjs: require() of ESM exposes named exports', () => {
    const m = require('./fixtures/cjs-require-esm/named.js');
    strictEqual(m.a, 1);
    strictEqual(m.b, 2);
});

// --- 5. circular CJS: partial exports visible during cycle -----------------
//
// Node semantics: when a requires b and b requires a, b sees a's exports
// as they exist *so far* (a.fromA is set; a.bValue is not yet).
Deno.test('cjs: circular require returns partial exports', () => {
    const a = require('./fixtures/circular-cjs/a.cjs');
    const b = require('./fixtures/circular-cjs/b.cjs');
    // After full load both should be fully populated.
    strictEqual(a.fromA, 'A');
    strictEqual(a.bValue, 'B');
    strictEqual(b.fromB, 'B');
    strictEqual(b.aSeen, 'A', 'b must have seen a.fromA during the cycle');
});

// --- 6. __esModule bridge: transpiled ESM keeps named keys, no default wrap -

Deno.test('cjs: __esModule flag preserves named exports without double-wrapping default', () => {
    const m = require('./fixtures/esm-esmodule-bridge/transpiled.cjs');
    strictEqual(m.foo, 'foo');
    deepStrictEqual(m.default, { d: 1 });
    // The default must NOT be wrapped again under m.default.default.
    ok(m.default?.default === undefined, 'default must not be double-wrapped');
});

// --- 7. require.cache is an object and exposes loaded modules --------------

Deno.test('cjs: require.cache is populated', () => {
    const cache = require.cache;
    ok(cache && typeof cache === 'object');
    const key = require.resolve('./fixtures/cjs-require-esm/vite.config.js');
    ok(cache[key] !== undefined, 'loaded module must appear in require.cache');
});

Deno.test('cjs: default exports object has Object.prototype like Node', () => {
    const shape = require('./fixtures/cjs-exports-shape/exports-shape.cjs');
    strictEqual(shape.hasObjectPrototype, true);
    strictEqual(shape.constructorIsObject, true);
});

Deno.test('cjs upstream: ESM import of CJS preserves reserved export names', async () => {
    const spec = './fixtures/cjs-exports-shape/module-exports-key.cjs';
    const ns = await import(spec);
    strictEqual(ns['module.exports'], 6);
    strictEqual(ns.class, 'class');
    strictEqual(ns.default['module.exports'], 6);
});

Deno.test('cjs upstream: ESM import of CJS preserves escaped whitespace export names', async () => {
    const ns = await import('./fixtures/cjs-exports-shape/escaped-whitespace-keys.cjs');
    strictEqual(ns['\nx'], 'test');
    strictEqual(ns['\ty'], 'test');
    strictEqual(ns['\rz'], 'test');
    strictEqual(ns['"a'], 'test');
    deepStrictEqual(ns.default, {
        '\nx': 'test',
        '\ty': 'test',
        '\rz': 'test',
        '"a': 'test',
    });
    deepStrictEqual(ns['module.exports'], ns.default);
});

Deno.test('cjs upstream: ESM import of CJS preserves non-identifier export names', async () => {
    const ns = await import('./fixtures/cjs-exports-shape/invalid-name-exports.cjs');
    strictEqual(ns['wow "double quotes"'], 'double quotes');
    strictEqual(ns["another 'case'"], 'example');
    strictEqual(ns['a \\ b'], 'a \\ b');
    strictEqual(ns['name variable'], 'a');
    strictEqual(ns['foo - bar'], 'foo - bar');
    deepStrictEqual(ns.default, {
        'wow "double quotes"': 'double quotes',
        "another 'case'": 'example',
        'a \\ b': 'a \\ b',
        'name variable': 'a',
        'foo - bar': 'foo - bar',
    });
    deepStrictEqual(ns['module.exports'], ns.default);
});

Deno.test('cjs upstream: ESM import of CJS module.exports object assignment exposes named keys', async () => {
    const ns = await import('./fixtures/cjs-exports-shape/module-export-assignment.cjs');
    strictEqual(ns.default.func(), 5);
    strictEqual(ns.func(), 5);
    deepStrictEqual(ns['module.exports'], ns.default);
});

Deno.test('cjs upstream: static named import from CJS sees bridged export names', async () => {
    const ns = await import('./fixtures/cjs-exports-shape/static-import-module-export-assignment.mjs');
    strictEqual(ns.defaultResult, 5);
    strictEqual(ns.namedResult, 5);
});

Deno.test('cjs upstream: ESM import of primitive CJS module.exports keeps default only', async () => {
    const ns = await import('./fixtures/cjs-exports-shape/module-export-number.cjs');
    strictEqual(ns.default, 5);
    strictEqual(ns['module.exports'], 5);
    strictEqual('func' in ns, false);
});

Deno.test('cjs upstream: named CJS function export loses this context when called bare', async () => {
    const defaultImport = (await import('./fixtures/cjs-exports-shape/this-in-exports.cjs')).default;
    const namespaceImport = await import('./fixtures/cjs-exports-shape/this-in-exports.cjs');
    const { getValue } = namespaceImport;

    strictEqual(defaultImport.getValue(), 1);
    strictEqual(namespaceImport.getValue(), 1);
    throws(
        () => getValue(),
        TypeError,
    );
});

Deno.test('cjs: new Function dynamic import resolves relative to current module', async () => {
    const mod = require('./fixtures/cjs-dynamic-import-function/entry.cjs');
    strictEqual(await mod.value, 42);
});

Deno.test('cjs: JSDoc import comments do not break Function.prototype exports', () => {
    const call = require('./fixtures/cjs-jsdoc-import-function-prototype/function-call.cjs');
    strictEqual(call, Function.prototype.call);
});

Deno.test('cjs upstream: require(esm) honors the module.exports named export', () => {
    strictEqual(require('./fixtures/esm-module-exports/string.mjs'), 'value');
    strictEqual(require('./fixtures/esm-module-exports/undefined.mjs'), undefined);

    const add = require('./fixtures/esm-module-exports/mod1.cjs');
    strictEqual(typeof add, 'function');
    strictEqual(add(1, 2), 3);
});

// --- 8. require of missing module throws MODULE_NOT_FOUND ------------------

Deno.test('cjs: require() of missing module throws', () => {
    let threw = false;
    try {
        // @ts-ignore - not exists
        require('./fixtures/cjs-require-esm/does-not-exist.js');
    } catch (e: any) {
        threw = true;
        ok(/MODULE_NOT_FOUND|cannot find|Cannot find/i.test(String(e.message)),
            `expected MODULE_NOT_FOUND, got: ${e.message}`);
    }
    ok(threw, 'missing module must throw');
});
