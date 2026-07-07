import { strictEqual, ok, throws } from 'node:assert';
import * as vm from 'node:vm';

const stripAnsi = (value: string) => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

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

Deno.test('vm: createContext and isContext reject non-object inputs', () => {
    throws(() => vm.createContext(null as any), TypeError);
    throws(() => vm.createContext((() => {}) as any), TypeError);
    throws(() => vm.isContext(null as any), TypeError);
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

Deno.test('vm: runInNewContext does not expose process by default', () => {
    strictEqual(vm.runInNewContext('typeof process', {}), 'undefined');
});

Deno.test('vm upstream: new contexts expose standard intrinsics without process', () => {
    const result = vm.runInNewContext(`
        [
            typeof Date,
            new Date("2018-12-10T02:26:59.002Z").toISOString(),
            new RegExp("deno", "i").test("Deno"),
            JSON.stringify({ map: new Map([["x", 1]]).get("x"), set: new Set([1, 1]).size }),
            new Uint8Array([1, 2, 3]).byteLength,
            typeof console,
            typeof process,
        ].join("\\n")
    `, {});

    strictEqual(result, [
        'function',
        '2018-12-10T02:26:59.002Z',
        'true',
        '{"map":1,"set":1}',
        '3',
        'object',
        'undefined',
    ].join('\n'));
});

Deno.test('vm upstream: Deno.inspect handles common values from new contexts', () => {
    ok(stripAnsi(Deno.inspect(vm.runInNewContext('new Error("This is an error")'))).includes('Error: This is an error'));
    ok(stripAnsi(Deno.inspect(vm.runInNewContext('new AggregateError([], "This is an error")'))).includes('AggregateError: This is an error'));
    ok(stripAnsi(Deno.inspect(vm.runInNewContext('new Date("2018-12-10T02:26:59.002Z")'))).includes('2018'));
});

Deno.test('vm: runInThisContext rethrows native error types', () => {
    throws(() => vm.runInThisContext("throw new Error('plain error')"), Error);
    throws(() => vm.runInThisContext("throw new TypeError('typed error')"), TypeError);
});

Deno.test('vm upstream: runInThisContext can write through global alias', () => {
    const globalObject = globalThis as typeof globalThis & { foo?: number };
    const previous = globalObject.foo;
    try {
        strictEqual(vm.runInThisContext('global.foo = 1'), 1);
        strictEqual(globalObject.foo, 1);
    } finally {
        if (previous === undefined) {
            delete globalObject.foo;
        } else {
            globalObject.foo = previous;
        }
    }
});

Deno.test('vm upstream: Script.runInNewContext accepts dynamic import expressions', async () => {
    const script = new vm.Script("import('node:process')");
    await script.runInNewContext();
});

Deno.test('vm: runInNewContext parses webpack-style magic comment keys', () => {
    const comments = [
        'webpackChunkName: "chunk-a"',
        'webpackMode: "lazy"',
        'webpackPrefetch: true',
        'webpackPreload: true',
        'webpackExports: ["default", "named"]',
    ];

    for (const comment of comments) {
        const result = vm.runInNewContext(`(function(){return {${comment}};})()`) as Record<string, unknown>;
        const [[key]] = Object.entries(result);
        strictEqual(key, comment.split(':')[0]!.trim());
    }
});

Deno.test('vm: sandbox globalThis aliases this and writes back to sandbox', () => {
    const sandbox: Record<string, unknown> = { value: 1 };
    strictEqual(vm.runInNewContext('globalThis === this', sandbox), true);
    vm.runInNewContext('globalThis.added = 42', sandbox);
    strictEqual(sandbox.added, 42);
});

Deno.test('vm: Script.runInContext mutates existing context', () => {
    const ctx = vm.createContext({ value: 1 });
    const script = new vm.Script('value += 2; value');
    strictEqual(script.runInContext(ctx), 3);
    strictEqual((ctx as { value: number }).value, 3);
});

Deno.test('vm: compileFunction compiles callable code', () => {
    const fn = vm.compileFunction('return a + b', ['a', 'b']);
    strictEqual(fn(1, 2), 3);
});

Deno.test('vm: compileFunction can use parsingContext globals', () => {
    const ctx = vm.createContext({ factor: 10 });
    const fn = vm.compileFunction('return value * factor', ['value'], { parsingContext: ctx });
    strictEqual(fn(3), 30);
});

Deno.test('vm: compileFunction combines parsingContext with contextExtensions', () => {
    const ctx = vm.createContext({});
    const fn = vm.compileFunction('return value + x', ['value'], {
        parsingContext: ctx,
        contextExtensions: [{ x: 4 }],
    });
    strictEqual(fn(1), 5);
    strictEqual((ctx as { x?: number }).x, undefined);
});

Deno.test('vm: compileFunction writes extension-owned globals back to extension', () => {
    const ctx = vm.createContext({ x: 2 });
    const extension = { x: 1 };
    const fn = vm.compileFunction('x = 9; return x', [], {
        parsingContext: ctx,
        contextExtensions: [extension],
    });
    strictEqual(fn(), 9);
    strictEqual(extension.x, 9);
    strictEqual((ctx as { x: number }).x, 2);
});

Deno.test('vm: measureMemory resolves with numeric memory fields', async () => {
    const result = await vm.measureMemory();
    strictEqual(typeof result.total.jsMemoryEstimate, 'number');
    strictEqual(typeof result.total.jsMemoryAllocated, 'number');
    strictEqual(typeof result.native.jsMemoryEstimate, 'number');
    strictEqual(typeof result.native.jsMemoryAllocated, 'number');
    strictEqual(typeof result.external, 'number');
});

Deno.test('vm: runInContext requires a contextified object', () => {
    throws(() => vm.runInContext('1', {}), TypeError);
});

Deno.test('vm: async runInContext writes back after promise settles', async () => {
    const ctx = vm.createContext({ value: 1 });
    const result = await vm.runInContext('Promise.resolve().then(() => { value = 5; return value; })', ctx);
    strictEqual(result, 5);
    strictEqual((ctx as { value: number }).value, 5);
});

Deno.test('vm: Script produceCachedData exposes cached data fields', () => {
    const script = new vm.Script('1 + 1', { produceCachedData: true }) as vm.Script & {
        cachedData?: Buffer;
        cachedDataProduced?: boolean;
    };
    ok(Buffer.isBuffer(script.cachedData));
    strictEqual(script.cachedDataProduced, true);
});

Deno.test('vm: compileFunction supports contextExtensions and cachedData fields', () => {
    const fn = vm.compileFunction('return x + y', ['y'], {
        contextExtensions: [{ x: 4 }],
        produceCachedData: true,
    }) as ((y: number) => number) & { cachedData?: Buffer; cachedDataProduced?: boolean };

    strictEqual(fn(3), 7);
    ok(Buffer.isBuffer(fn.cachedData));
    strictEqual(fn.cachedDataProduced, true);
});
