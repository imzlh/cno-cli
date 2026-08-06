// Cycles that cross the require()/import boundary.
//
// Node refuses these outright with ERR_REQUIRE_CYCLE_MODULE rather than
// handing out a partially-initialized module. Measured against Node
// v24.18.0; every expectation below is a pasted Node result, not a guess.
//
//   fixtures/cycle-cjs-esm: a.cjs -> require b.mjs -> import a.cjs
//     node: throws "Cannot import CommonJS Module ./a.cjs in a cycle."
//   fixtures/cycle-esm-cjs: a.mjs -> import b.cjs -> require a.mjs
//     node: the inner require() throws "Cannot require() ES Module ... in a
//           cycle."; a.mjs itself still finishes loading.
//
// Pure-CJS cycles are NOT affected: Node returns partial exports there, and
// tests/cjs/require-esm-interop.test.ts pins that. The guard must only fire
// when the cycle crosses into the ESM loader.
import { ok, strictEqual } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function catchRequire(id: string): { code: unknown; message: string; threw: boolean; value: unknown } {
    try {
        const value = require(id);
        return { code: undefined, message: '', threw: false, value };
    } catch (e: any) {
        return { code: e?.code, message: String(e?.message ?? ''), threw: true, value: undefined };
    }
}

// --- 1. import of a mid-execution CJS module must throw --------------------

Deno.test('cjs cycle: ESM importing a mid-require() CJS module throws ERR_REQUIRE_CYCLE_MODULE', () => {
    const r = catchRequire('./fixtures/cycle-cjs-esm/a.cjs');
    ok(r.threw, 'require() of a CJS module whose ESM dep imports it back must throw, ' +
        `got exports: ${JSON.stringify(r.value)}`);
    strictEqual(r.code, 'ERR_REQUIRE_CYCLE_MODULE', `wrong code, message was: ${r.message}`);
});

// --- 2. the thrown error names the cycle, not something incidental ---------

Deno.test('cjs cycle: import-cjs cycle error message matches Node shape', () => {
    const r = catchRequire('./fixtures/cycle-cjs-esm/a.cjs');
    ok(r.threw, 'must throw');
    ok(/in a cycle/.test(r.message), `message must say "in a cycle", got: ${r.message}`);
    ok(/CommonJS Module/.test(r.message),
        `import-cjs cycle must be reported as a CommonJS Module cycle, got: ${r.message}`);
    ok(/a\.cjs/.test(r.message), `message must name a.cjs, got: ${r.message}`);
});

// --- 3. no partially-initialized module may escape -------------------------
//
// The hazard the throw exists to prevent: b.mjs must never observe a.cjs
// with only the pre-require() half of its exports. Node never evaluates
// b.mjs at all, so a.cjs must not be in require.cache as a loaded module.
Deno.test('cjs cycle: failed import-cjs cycle leaves no half-built module in cache', () => {
    catchRequire('./fixtures/cycle-cjs-esm/a.cjs');
    const key = Object.keys(require.cache).find((k) => k.replaceAll('\\', '/').endsWith('cycle-cjs-esm/a.cjs'));
    if (key !== undefined) {
        const mod: any = require.cache[key];
        ok(!mod?.loaded, 'a.cjs must not be cached as fully loaded after a cycle throw');
    }
});

// --- 4. require(esm) of an in-flight ESM module must throw -----------------
//
// b.cjs catches the error itself, so the assertion reads its exports.
// Node: b.cycleCode === 'ERR_REQUIRE_CYCLE_MODULE', namespaceLeaked null.
Deno.test('cjs cycle: require() of a mid-compile ESM module throws ERR_REQUIRE_CYCLE_MODULE', () => {
    const a: any = require('./fixtures/cycle-esm-cjs/a.mjs');
    const b: any = require('./fixtures/cycle-esm-cjs/b.cjs');
    strictEqual(b.cycleCode, 'ERR_REQUIRE_CYCLE_MODULE',
        `require(esm) into an in-flight ESM module must throw; leaked: ${JSON.stringify(b.namespaceLeaked)}`);
    strictEqual(b.namespaceLeaked, null, 'no ESM namespace may escape the cycle');
    ok(/Cannot require\(\) ES Module/.test(b.cycleMessage),
        `require-esm cycle needs the require() message shape, got: ${b.cycleMessage}`);
    // Node still completes a.mjs after b.cjs swallows the cycle error.
    strictEqual(a.aVal, 'a-value', 'a.mjs must still finish loading');
    strictEqual(a.default, 'a-default');
});

// --- 5. regression guard: the fix must not break non-cyclic require(esm) ---

Deno.test('cjs cycle: a non-cyclic require(esm) is untouched by the cycle guard', () => {
    const m: any = require('./fixtures/cjs-require-esm/vite.config.js');
    strictEqual(m.__esModule, true);
    strictEqual(m.default.answer, 42);
});

// --- 6. regression guard: pure-CJS cycles still yield partial exports ------
//
// Node does NOT throw for these. Over-firing the guard here would break
// the require-esm-interop gate and every CJS package with a cycle.
Deno.test('cjs cycle: pure CJS cycle still returns partial exports, no throw', () => {
    const a: any = require('./fixtures/circular-cjs/a.cjs');
    const b: any = require('./fixtures/circular-cjs/b.cjs');
    strictEqual(a.fromA, 'A');
    strictEqual(a.bValue, 'B');
    strictEqual(b.aSeen, 'A', 'b must have seen the partial a during the cycle');
});
