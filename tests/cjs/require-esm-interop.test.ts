import { strictEqual, ok, deepStrictEqual } from 'node:assert';
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
