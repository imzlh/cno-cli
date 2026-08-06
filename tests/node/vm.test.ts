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

// ===========================================================================
// Regression coverage for the vm eager-compile / option-validation work.
// Every expectation below was measured against real Node v24.18.0 on Windows.
// Error CODES are asserted, never message text.
// ===========================================================================

/** Run `fn`, returning the thrown error's `code` (or a marker). */
const codeOf = (fn: () => unknown): string => {
    try {
        fn();
    } catch (error) {
        const code = (error as { code?: unknown }).code;
        return typeof code === 'string' ? code : `NO_CODE:${(error as Error).constructor.name}`;
    }
    return 'NO_THROW';
};

/** `[line, column]` of the first stack frame naming `tag`, from a throwing script. */
const posOf = (tag: string, options: vm.ScriptOptions): [number, number] => {
    try {
        new vm.Script('throw new Error("boom")', { ...options, filename: tag }).runInThisContext();
    } catch (error) {
        const match = new RegExp(`${tag.replace(/\./g, '\\.')}:(\\d+):(\\d+)`).exec(String((error as Error).stack));
        if (match) return [Number(match[1]), Number(match[2])];
    }
    throw new Error(`no stack frame naming ${tag}`);
};

// --- eager compilation ------------------------------------------------------

Deno.test('vm regression: Script compiles eagerly so a SyntaxError throws from the constructor', () => {
    // Node compiles in the constructor; a lazy implementation would not throw until run.
    throws(() => new vm.Script('foo bar baz'), SyntaxError);
    throws(() => new vm.Script('"unterminated'), SyntaxError);
    throws(() => new vm.Script('function f() {'), SyntaxError);
    throws(() => new vm.Script('return 1'), SyntaxError);
});

Deno.test('vm regression: a failed eager compile does not poison later compiles', () => {
    throws(() => new vm.Script('foo bar baz'), SyntaxError);
    strictEqual(new vm.Script('1 + 41').runInThisContext(), 42);
});

Deno.test('vm regression: the other entry points also reject a syntax error', () => {
    // Measured on Node v24.18: which realm the SyntaxError comes from differs
    // by entry point, so `instanceof` is only usable on the host-realm paths.
    // runInThisContext + compileFunction compile in the host realm.
    throws(() => vm.runInThisContext('foo bar baz'), SyntaxError);
    throws(() => vm.compileFunction('foo bar baz'), SyntaxError);

    // runInNewContext / runInContext compile inside the new context, so the
    // error is cross-realm: `name` is still SyntaxError but `instanceof` is
    // false. cno reproduces this exactly; do not "fix" it to instanceof.
    for (const run of [
        () => vm.runInNewContext('foo bar baz', {}),
        () => vm.runInContext('foo bar baz', vm.createContext({})),
    ]) {
        try {
            run();
        } catch (error) {
            strictEqual((error as Error).name, 'SyntaxError');
            strictEqual(error instanceof SyntaxError, false, 'a new-context compile error is cross-realm');
            continue;
        }
        throw new Error('expected a SyntaxError');
    }
});

// --- cached data ------------------------------------------------------------

Deno.test('vm regression: createCachedData returns a non-empty Buffer', () => {
    const script = new vm.Script('1 + 1');
    const data = script.createCachedData();
    ok(Buffer.isBuffer(data), 'createCachedData must return a Buffer');
    ok(data.length > 0, `createCachedData must be non-empty, got ${data.length}`);
    // Deterministic for one Script instance (Node: two 336-byte buffers, equal).
    ok(data.equals(script.createCachedData()), 'repeated createCachedData must agree');
});

Deno.test('vm regression: produceCachedData sets all three cached-data fields', () => {
    const script = new vm.Script('1 + 1', { produceCachedData: true }) as vm.Script & {
        cachedData?: Buffer;
        cachedDataProduced?: boolean;
    };
    // Node v24.18 measured: [true, true, true].
    strictEqual(Buffer.isBuffer(script.cachedData), true);
    strictEqual((script.cachedData as Buffer).length > 0, true);
    strictEqual(script.cachedDataProduced, true);
});

Deno.test('vm regression: compileFunction produceCachedData sets all three fields', () => {
    const fn = vm.compileFunction('return 1', [], { produceCachedData: true }) as (() => number) & {
        cachedData?: Buffer;
        cachedDataProduced?: boolean;
    };
    strictEqual(Buffer.isBuffer(fn.cachedData), true);
    strictEqual((fn.cachedData as Buffer).length > 0, true);
    strictEqual(fn.cachedDataProduced, true);
});

Deno.test('vm regression: cachedDataRejected is false for valid cached data and absent without it', () => {
    const script = new vm.Script('1 + 1') as vm.Script & { cachedDataRejected?: boolean };
    // No cachedData option -> Node never reports a rejection verdict.
    strictEqual(script.cachedDataRejected, undefined);

    const reused = new vm.Script('1 + 1', { cachedData: script.createCachedData() }) as vm.Script & {
        cachedDataRejected?: boolean;
    };
    strictEqual(reused.cachedDataRejected, false, 'valid cached data must not be rejected');
    strictEqual(reused.runInThisContext(), 2);
});

Deno.test('vm regression: cachedDataRejected is true when the cached data cannot serve the source', () => {
    // Node v24.18 keys its verdict on the recorded source LENGTH, so a
    // different-length source is the one corruption it reliably reports.
    const data = new vm.Script('1 + 1').createCachedData();
    const longer = new vm.Script('1 + 1 + 1', { cachedData: data }) as vm.Script & { cachedDataRejected?: boolean };
    strictEqual(longer.cachedDataRejected, true);
    strictEqual(longer.runInThisContext(), 3, 'a rejected cache must fall back to compiling the source');
});

Deno.test('vm regression: garbage cached data yields a boolean verdict and still runs the source', () => {
    // MEASURED DIVERGENCE, deliberately not asserted as a value:
    // Node v24.18 reports `false` here (V8 only compares the recorded source
    // length, so it never notices the corruption); cno reports `true`.
    // Both agree the script still evaluates correctly, which is the contract
    // that matters, so only that plus the property's type is locked in.
    const script = new vm.Script('1 + 1', {
        cachedData: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    }) as vm.Script & { cachedDataRejected?: boolean };
    strictEqual(typeof script.cachedDataRejected, 'boolean');
    strictEqual(script.runInThisContext(), 2);
});

Deno.test('vm regression: cachedData accepts any BufferSource but rejects other types', () => {
    const data = new vm.Script('1 + 1').createCachedData();
    ok(new vm.Script('1 + 1', { cachedData: new Uint8Array(data) as unknown as Buffer }));
    strictEqual(codeOf(() => new vm.Script('1', { cachedData: 'nope' as unknown as Buffer })), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => new vm.Script('1', { cachedData: 42 as unknown as Buffer })), 'ERR_INVALID_ARG_TYPE');
});

// --- option validation ------------------------------------------------------

Deno.test('vm regression: timeout is range-checked on every run path', () => {
    // Node validates `timeout` at RUN time (not in the Script constructor).
    for (const timeout of [0, -1, 4294967296, 1.5, NaN]) {
        const label = String(timeout);
        strictEqual(codeOf(() => vm.runInThisContext('1', { timeout })), 'ERR_OUT_OF_RANGE', label);
        strictEqual(codeOf(() => vm.runInNewContext('1', {}, { timeout })), 'ERR_OUT_OF_RANGE', label);
        strictEqual(codeOf(() => vm.runInContext('1', vm.createContext({}), { timeout })), 'ERR_OUT_OF_RANGE', label);
        strictEqual(codeOf(() => new vm.Script('1').runInThisContext({ timeout })), 'ERR_OUT_OF_RANGE', label);
        strictEqual(codeOf(() => new vm.Script('1').runInNewContext({}, { timeout })), 'ERR_OUT_OF_RANGE', label);
    }
});

Deno.test('vm regression: a non-numeric timeout is a type error, not a range error', () => {
    const timeout = 'x' as unknown as number;
    strictEqual(codeOf(() => vm.runInThisContext('1', { timeout })), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => vm.runInNewContext('1', {}, { timeout })), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => vm.runInContext('1', vm.createContext({}), { timeout })), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => new vm.Script('1').runInNewContext({}, { timeout })), 'ERR_INVALID_ARG_TYPE');
});

Deno.test('vm regression: an in-range timeout is accepted at both ends', () => {
    // 1 and 2**32-1 are the inclusive bounds Node enforces.
    strictEqual(vm.runInNewContext('1 + 1', {}, { timeout: 4294967295 }), 2);
    strictEqual(vm.runInThisContext('1 + 1', { timeout: 5000 }), 2);
    strictEqual(new vm.Script('1 + 1').runInContext(vm.createContext({}), { timeout: 5000 }), 2);
});

Deno.test('vm regression: filename must be a string', () => {
    const filename = 42 as unknown as string;
    strictEqual(codeOf(() => new vm.Script('1', { filename })), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => vm.runInThisContext('1', { filename })), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => vm.runInNewContext('1', {}, { filename })), 'ERR_INVALID_ARG_TYPE');
});

Deno.test('vm regression: lineOffset and columnOffset must be integral numbers', () => {
    // Non-integer number -> ERR_OUT_OF_RANGE; wrong type -> ERR_INVALID_ARG_TYPE.
    strictEqual(codeOf(() => new vm.Script('1', { lineOffset: 1.5 })), 'ERR_OUT_OF_RANGE');
    strictEqual(codeOf(() => new vm.Script('1', { columnOffset: 1.5 })), 'ERR_OUT_OF_RANGE');
    strictEqual(codeOf(() => new vm.Script('1', { lineOffset: '2' as unknown as number })), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => new vm.Script('1', { columnOffset: '2' as unknown as number })), 'ERR_INVALID_ARG_TYPE');
    // A negative integer is in range for Node -- do not tighten this.
    ok(new vm.Script('1', { lineOffset: -5, columnOffset: -5 }));
});

Deno.test('vm regression: compileFunction requires params to be an array', () => {
    strictEqual(codeOf(() => vm.compileFunction('return 1', 'a' as unknown as string[])), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => vm.compileFunction('return 1', 42 as unknown as string[])), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => vm.compileFunction('return 1', {} as unknown as string[])), 'ERR_INVALID_ARG_TYPE');
    // Omitted params stays legal.
    strictEqual((vm.compileFunction('return 1') as () => number)(), 1);
});

// --- newly present surface --------------------------------------------------

Deno.test('vm regression: vm.constants exposes the two documented symbols and is frozen', () => {
    strictEqual(typeof vm.constants, 'object');
    strictEqual(Object.keys(vm.constants).sort().join(','), 'DONT_CONTEXTIFY,USE_MAIN_CONTEXT_DEFAULT_LOADER');
    strictEqual(typeof vm.constants.DONT_CONTEXTIFY, 'symbol');
    strictEqual(typeof vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER, 'symbol');
    strictEqual(Object.isFrozen(vm.constants), true);
});

Deno.test('vm regression: vm.createScript builds a real Script', () => {
    strictEqual(typeof vm.createScript, 'function');
    const script = vm.createScript('3 * 4');
    ok(script instanceof vm.Script, 'createScript must return a vm.Script');
    strictEqual(script.runInThisContext(), 12);
    strictEqual(typeof script.createCachedData, 'function');
});

Deno.test('vm regression: the documented module surface is complete', () => {
    const missing = ([
        'Script', 'createContext', 'createScript', 'isContext', 'runInContext',
        'runInNewContext', 'runInThisContext', 'compileFunction', 'measureMemory', 'constants',
    ] as const).filter((key) => (vm as Record<string, unknown>)[key] === undefined);
    strictEqual(missing.join(','), '');
});

// --- constants.DONT_CONTEXTIFY ---------------------------------------------

Deno.test('vm regression: createContext(DONT_CONTEXTIFY) yields a usable context', () => {
    const ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY as unknown as vm.Context);
    strictEqual(typeof ctx, 'object');
    ok(vm.isContext(ctx), 'DONT_CONTEXTIFY result must pass isContext');
    strictEqual(Object.keys(ctx).length, 0, 'a fresh context has no own enumerable keys');
    strictEqual(vm.runInContext('1 + 1', ctx), 2);
});

Deno.test('vm regression: DONT_CONTEXTIFY declarations persist and stay isolated', () => {
    const ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY as unknown as vm.Context);
    vm.runInContext('var zz = 7', ctx);
    strictEqual((ctx as { zz?: number }).zz, 7);
    strictEqual(vm.runInContext('zz + 1', ctx), 8);
    // No host leakage, and no sharing with a second such context.
    strictEqual(vm.runInContext('typeof process', ctx), 'undefined');
    const other = vm.createContext(vm.constants.DONT_CONTEXTIFY as unknown as vm.Context);
    strictEqual(vm.runInContext('typeof zz', other), 'undefined');
    ok(ctx !== other, 'each call must produce a distinct context');
});

Deno.test('vm regression: DONT_CONTEXTIFY works through runInNewContext', () => {
    strictEqual(vm.runInNewContext('1 + 1', vm.constants.DONT_CONTEXTIFY as unknown as vm.Context), 2);
});

// --- compileFunction shape under a parsingContext --------------------------

Deno.test('vm regression: compileFunction reports an empty name and the declared arity', () => {
    // Node v24.18: name "" and length === params.length, on every path.
    const ctx = vm.createContext({ factor: 10 });
    const scoped = vm.compileFunction('return value * factor', ['value'], { parsingContext: ctx });
    strictEqual(scoped.name, '', 'compiled function name must be empty, not "anonymous"');
    strictEqual(scoped.length, 1, 'compiled function length must be the declared arity, not 0');
    strictEqual(scoped(3), 30);

    const plain = vm.compileFunction('return a + b', ['a', 'b']);
    strictEqual(plain.name, '');
    strictEqual(plain.length, 2);

    const extended = vm.compileFunction('return x + y', ['y'], { contextExtensions: [{ x: 4 }] });
    strictEqual(extended.name, '');
    strictEqual(extended.length, 1);
    strictEqual(extended(3), 7);
});

// --- compileFunction scoping / this / arguments ----------------------------

Deno.test('vm regression: compileFunction honours its this-binding', () => {
    const fn = vm.compileFunction('return this && this.v');
    strictEqual(fn.call({ v: 5 }), 5);
});

Deno.test('vm regression: compileFunction exposes arguments and sees intrinsics', () => {
    const fn = vm.compileFunction('return arguments.length', ['a']);
    strictEqual(fn(1, 2), 2, 'arguments.length reflects the call, not the arity');
    strictEqual(fn(), 0);
    strictEqual(vm.compileFunction('return typeof Math')(), 'object');
});

Deno.test('vm regression: compileFunction does not capture the enclosing scope', () => {
    // A local binding of the caller must be invisible, while real globals stay
    // visible. `require` is deliberately not probed here: cts installs it as a
    // genuine global, so it is visible in cno and not in Node's CJS module
    // scope -- a global-surface difference, nothing to do with vm.
    const localOnly = 5;
    void localOnly;
    strictEqual(vm.compileFunction('return typeof localOnly')(), 'undefined');
    strictEqual(vm.compileFunction('return typeof __vmTotallyAbsent')(), 'undefined');
    strictEqual(vm.compileFunction('return typeof module')(), 'undefined');

    const host = globalThis as typeof globalThis & { __vmProbeGlobal?: number };
    host.__vmProbeGlobal = 9;
    try {
        strictEqual(vm.compileFunction('return typeof __vmProbeGlobal + ":" + __vmProbeGlobal')(), 'number:9');
    } finally {
        delete host.__vmProbeGlobal;
    }
});

Deno.test('vm regression: compileFunction still compiles with offsets applied', () => {
    strictEqual((vm.compileFunction('return 7', [], { lineOffset: 3 }) as () => number)(), 7);
    strictEqual((vm.compileFunction('return 8', [], { columnOffset: 5 }) as () => number)(), 8);
    const ctx = vm.createContext({ k: 2 });
    const fn = vm.compileFunction('return k * 3', [], { parsingContext: ctx, lineOffset: 2 });
    strictEqual(fn(), 6);
    strictEqual(fn.length, 0);
    strictEqual(fn.name, '');
});

// --- script reuse ----------------------------------------------------------

Deno.test('vm regression: one Script can be reused across independent new contexts', () => {
    const script = new vm.Script('n = (typeof n === "undefined" ? 0 : n) + 1; n');
    strictEqual(script.runInNewContext({}), 1);
    strictEqual(script.runInNewContext({}), 1, 'each new context starts clean');
    strictEqual(script.runInNewContext({ n: 10 }), 11);
});

Deno.test('vm regression: one Script accumulates state in a single reused context', () => {
    const ctx = vm.createContext({ n: 0 });
    const script = new vm.Script('n += 1; n');
    strictEqual(script.runInContext(ctx), 1);
    strictEqual(script.runInContext(ctx), 2);
    strictEqual((ctx as { n: number }).n, 2);
});

// --- lineOffset / columnOffset effect on reported positions ----------------

Deno.test('vm regression: lineOffset shifts the reported line by exactly that much', () => {
    const [baseLine] = posOf('vmoff-base.js', {});
    strictEqual(baseLine, 1);
    strictEqual(posOf('vmoff-l10.js', { lineOffset: 10 })[0], 11);
    strictEqual(posOf('vmoff-l3.js', { lineOffset: 3 })[0], 4);
    strictEqual(posOf('vmoff-l0.js', { lineOffset: 0 })[0], 1);
});

Deno.test('vm regression: lineOffset adds to the real line of a multi-line script', () => {
    const posOfMultiline = (tag: string, lineOffset: number): number => {
        try {
            new vm.Script('\nthrow new Error("boom")', { filename: tag, lineOffset }).runInThisContext();
        } catch (error) {
            const match = new RegExp(`${tag.replace(/\./g, '\\.')}:(\\d+):`).exec(String((error as Error).stack));
            if (match) return Number(match[1]);
        }
        throw new Error(`no stack frame naming ${tag}`);
    };
    strictEqual(posOfMultiline('vmml-base.js', 0), 2);
    strictEqual(posOfMultiline('vmml-l10.js', 10), 12);
});

Deno.test('vm regression: columnOffset shifts the reported column by exactly that much', () => {
    // Absolute columns are engine-specific (Node 7, QuickJS 10 for this source),
    // so only the delta is asserted. Restricted to lineOffset 0: QuickJS reports
    // one extra column on lines >= 2 for *any* eval'd code, vm or not.
    const [, baseColumn] = posOf('vmcol-base.js', {});
    let index = 0;
    for (const columnOffset of [0, 1, 2, 5, 20]) {
        const [line, column] = posOf(`vmcol-${index++}.js`, { columnOffset });
        strictEqual(line, 1);
        strictEqual(column - baseColumn, columnOffset, `columnOffset ${columnOffset}`);
    }
});

Deno.test('vm regression: a bare string in the options position is the filename', () => {
    try {
        vm.runInThisContext('throw new Error("boom")', 'vmstr-file.js');
    } catch (error) {
        ok(String((error as Error).stack).includes('vmstr-file.js:1:'), 'string options must set the filename');
        return;
    }
    throw new Error('expected a throw');
});

// --- compile options do not inherit run-only timeout validation -------------
// `timeout` is a *run* option. Node v24.18 does not validate it in the Script
// constructor at all -- `new vm.Script('1', { timeout: 0 })` is accepted, and
// only `runInThisContext`/`runInNewContext`/`runInContext` range-check it
// (see the run-path tests above, which pass).
Deno.test('vm regression: the Script constructor ignores timeout (Node does not validate it there)', () => {
    for (const timeout of [0, -1, 4294967296, 1.5, NaN]) {
        strictEqual(codeOf(() => new vm.Script('1', { timeout })), 'NO_THROW', `ctor timeout ${String(timeout)}`);
    }
    strictEqual(codeOf(() => new vm.Script('1', { timeout: 'x' as unknown as number })), 'NO_THROW');
    // compileFunction likewise ignores timeout entirely in Node.
    strictEqual(
        codeOf(() => vm.compileFunction('return 1', [], { timeout: 0 } as unknown as Record<string, never>)),
        'NO_THROW',
    );
});

// --- createContext() options validation -------------------------------------
// Every expectation measured against real Node v24.18.0. Before this landed,
// cno accepted all of these silently.
Deno.test('vm regression: createContext validates the options bag', () => {
    strictEqual(codeOf(() => vm.createContext({}, 5 as never)), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => vm.createContext({}, null as never)), 'ERR_INVALID_ARG_TYPE');
    // undefined stays legal and means "no options".
    strictEqual(codeOf(() => vm.createContext({}, undefined)), 'NO_THROW');
});

Deno.test('vm regression: createContext validates name and origin as strings', () => {
    strictEqual(codeOf(() => vm.createContext({}, { name: 5 } as never)), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => vm.createContext({}, { origin: 5 } as never)), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => vm.createContext({}, { name: 'n', origin: 'https://x' })), 'NO_THROW');
    strictEqual(codeOf(() => vm.createContext({}, { name: undefined, origin: undefined })), 'NO_THROW');
});

Deno.test('vm regression: createContext validates codeGeneration', () => {
    strictEqual(codeOf(() => vm.createContext({}, { codeGeneration: 5 } as never)), 'ERR_INVALID_ARG_TYPE');
    strictEqual(codeOf(() => vm.createContext({}, { codeGeneration: null } as never)), 'ERR_INVALID_ARG_TYPE');
    strictEqual(
        codeOf(() => vm.createContext({}, { codeGeneration: { strings: 5 } } as never)),
        'ERR_INVALID_ARG_TYPE',
    );
    strictEqual(
        codeOf(() => vm.createContext({}, { codeGeneration: { wasm: 5 } } as never)),
        'ERR_INVALID_ARG_TYPE',
    );
    // An empty bag and real booleans are both accepted.
    strictEqual(codeOf(() => vm.createContext({}, { codeGeneration: {} })), 'NO_THROW');
    strictEqual(
        codeOf(() => vm.createContext({}, { codeGeneration: { strings: true, wasm: false } })),
        'NO_THROW',
    );
});

// --- codeGeneration is ENFORCED, not just validated --------------------------
// The tests above only pinned validation. cno validated both flags and then
// ignored them: with {strings:false, wasm:false} a context still evaluated
// eval('1+1') to 2, new Function('return 2')() to 2, and compiled a
// WebAssembly.Module. Messages below are Node v24.18.0 verbatim.

const CODEGEN_MSG = 'Code generation from strings disallowed for this context';

Deno.test('vm: codeGeneration.strings=false blocks direct and indirect eval', () => {
    const ctx = vm.createContext({}, { codeGeneration: { strings: false } });
    vm.runInContext(
        `r = {};
         try { r.direct = eval('1+1'); } catch (e) { r.direct = e.name + ': ' + e.message; }
         try { r.indirect = (0, eval)('1+1'); } catch (e) { r.indirect = e.name + ': ' + e.message; }`,
        ctx,
    );
    strictEqual((ctx.r as Record<string, unknown>).direct, `EvalError: ${CODEGEN_MSG}`);
    strictEqual((ctx.r as Record<string, unknown>).indirect, `EvalError: ${CODEGEN_MSG}`);
});

Deno.test('vm: codeGeneration.strings=false blocks every Function constructor alias', () => {
    const ctx = vm.createContext({}, { codeGeneration: { strings: false } });
    vm.runInContext(
        `r = {};
         try { r.fn = new Function('return 1')(); } catch (e) { r.fn = e.name + ': ' + e.message; }
         try { r.call = Function('return 1')(); } catch (e) { r.call = e.name + ': ' + e.message; }
         // A second live reference to the same capability, reachable without the
         // global binding.
         try { r.proto = (function(){}).constructor('return 1')(); }
         catch (e) { r.proto = e.name + ': ' + e.message; }
         // No global binding at all; only reachable through a sample instance.
         try { r.gen = (function*(){}).constructor('yield 1'); }
         catch (e) { r.gen = e.name + ': ' + e.message; }`,
        ctx,
    );
    const r = ctx.r as Record<string, unknown>;
    strictEqual(r.fn, `EvalError: ${CODEGEN_MSG}`);
    strictEqual(r.call, `EvalError: ${CODEGEN_MSG}`);
    strictEqual(r.proto, `EvalError: ${CODEGEN_MSG}`);
    strictEqual(r.gen, `EvalError: ${CODEGEN_MSG}`);
});

Deno.test('vm: codeGeneration.strings=false throws the realm own EvalError', () => {
    const ctx = vm.createContext({}, { codeGeneration: { strings: false } });
    vm.runInContext(
        `try { eval('1'); } catch (e) { ok = (e instanceof EvalError) && (e instanceof Error); }`,
        ctx,
    );
    strictEqual(ctx.ok, true, 'the thrown error must belong to the sandbox realm');
});

Deno.test('vm: codeGeneration.wasm=false blocks wasm compilation', () => {
    const ctx = vm.createContext({}, { codeGeneration: { wasm: false } });
    vm.runInContext(
        `r = {};
         const bytes = new Uint8Array([0,97,115,109,1,0,0,0]);
         try { new WebAssembly.Module(bytes); } catch (e) { r.mod = e.name; }
         r.typeofWA = typeof WebAssembly;`,
        ctx,
    );
    const r = ctx.r as Record<string, unknown>;
    strictEqual(r.mod, 'CompileError');
    // Node keeps the namespace object present; only compilation is disallowed.
    strictEqual(r.typeofWA, 'object');
});

Deno.test('vm: codeGeneration restrictions do not leak to the host', () => {
    const ctx = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(`try { eval('1'); } catch (e) { /* expected */ }`, ctx);
    // The sandbox's WebAssembly and Function ARE the host's objects, so a
    // careless implementation would disable them process-wide.
    strictEqual(eval('1+1'), 2);
    strictEqual(new Function('return 3')(), 3);
    ok(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
    // An unrestricted context stays unrestricted.
    strictEqual(vm.runInNewContext(`eval('1+1')`, {}), 2);
});

Deno.test('vm: Proxy is available inside a context', () => {
    // Was undefined: the Sandbox ctor adds only base objects + eval, and Proxy
    // was missing from the list of host intrinsics copied in.
    strictEqual(vm.runInNewContext('typeof Proxy', {}), 'function');
    strictEqual(vm.runInNewContext('new Proxy({}, { get: () => 7 }).anything', {}), 7);
});
