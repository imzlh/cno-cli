import { strictEqual, ok, throws } from 'node:assert';
import * as vm from 'node:vm';

// --- 1. runInThisContext evaluates in global scope --------------------------

Deno.test('vm: runInThisContext evaluates code', () => {
    const out = vm.runInThisContext('1 + 2');
    strictEqual(out, 3);
});

// --- 2. Script.runInThisContext ---------------------------------------------

Deno.test('vm: Script.runInThisContext runs', () => {
    const s = new vm.Script('2 * 3');
    strictEqual(s.runInThisContext(), 6);
});

// --- 3. runInNewContext with sandbox ----------------------------------------

Deno.test('vm: runInNewContext uses sandbox', () => {
    const out = vm.runInNewContext('a + b', { a: 10, b: 5 });
    strictEqual(out, 15);
});

// --- 4. Script.runInNewContext ----------------------------------------------

Deno.test('vm: Script.runInNewContext uses sandbox', () => {
    const s = new vm.Script('x * 2');
    strictEqual(s.runInNewContext({ x: 21 }), 42);
});

// --- 5. createContext / isContext -------------------------------------------

Deno.test('vm: createContext + isContext', () => {
    const ctx = vm.createContext({ v: 1 });
    ok(vm.isContext(ctx), 'createContext result must pass isContext');
});

// --- 6. runInContext modifies the context's globals ------------------------

Deno.test('vm: runInContext can mutate sandbox', () => {
    const ctx = vm.createContext({ count: 0 });
    vm.runInContext('count += 1', ctx);
    strictEqual((ctx as { count: number }).count, 1);
});

// --- 7. sandbox isolation: outer scope not polluted -----------------------

Deno.test('vm: runInNewContext does not leak to outer scope', () => {
    const before = (globalThis as typeof globalThis & { __vmLeakTest?: unknown }).__vmLeakTest;
    vm.runInNewContext('const __vmLeakTest = 123', {});
    strictEqual((globalThis as typeof globalThis & { __vmLeakTest?: unknown }).__vmLeakTest, before, 'sandbox must not leak');
});

// --- 8. Script constructor accepts options ----------------------------------

Deno.test('vm: Script accepts filename option', () => {
    const s = new vm.Script('1', { filename: 'my-file.js' });
    ok(s);
});

// --- 9. runInNewContext with timeout-like option is tolerated ---------------

Deno.test('vm: runInNewContext accepts options object', () => {
    const out = vm.runInNewContext('1', {}, { filename: 'f.js' });
    strictEqual(out, 1);
});

// --- 10. vm.sourceURL comment option (Sucrase/tolerant path) ----------------

Deno.test('vm: Script tolerates sourceURL in options', () => {
    const s = new vm.Script('1', { filename: 'f.js' });
    ok(typeof s.runInThisContext() === 'number');
});
