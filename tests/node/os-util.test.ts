import { strictEqual, ok, match } from 'node:assert';
import * as os from 'node:os';
import * as util from 'node:util';

// --- os: EOL matches platform ------------------------------------------------

Deno.test('os: EOL is \\n on non-Windows', () => {
    if (os.platform() !== 'win32') {
        strictEqual(os.EOL, '\n');
    }
});

// --- os: totalmem / freemem are positive, totalmem >= freemem ---------------

Deno.test('os: totalmem >= freemem and both positive', () => {
    ok(os.totalmem() > 0);
    ok(os.freemem() > 0);
    ok(os.totalmem() >= os.freemem());
});

// --- os: loadavg returns 3 numbers on non-Windows ---------------------------

Deno.test('os: loadavg returns array of 3 numbers', () => {
    const la = os.loadavg();
    ok(Array.isArray(la));
    strictEqual(la.length, 3);
    for (const v of la) ok(typeof v === 'number');
});

// --- os: cpus returns non-empty array with expected shape -------------------

Deno.test('os: cpus returns array of CpuInfo objects', () => {
    const cpus = os.cpus();
    ok(Array.isArray(cpus));
    ok(cpus.length > 0, 'must have at least one CPU entry');
    const c = cpus[0]!;
    ok(typeof c.model === 'string');
    ok(typeof c.speed === 'number');
    ok(typeof c.times === 'object');
});

// --- os: networkInterfaces returns object of arrays -------------------------

Deno.test('os: networkInterfaces returns object of interface arrays', () => {
    const nis = os.networkInterfaces();
    ok(nis && typeof nis === 'object');
    const keys = Object.keys(nis);
    ok(keys.length > 0, 'must have at least one interface family');
    for (const k of keys) {
        const arr = (nis as Record<string, unknown>)[k];
        ok(Array.isArray(arr), `${k} must be an array`);
    }
});

// --- os: userInfo returns object -------------------------------------------

Deno.test('os: userInfo returns object with uid/gid/homedir', () => {
    const u = os.userInfo();
    ok(u && typeof u === 'object');
    ok('uid' in u && 'gid' in u);
    ok(typeof u.homedir === 'string' && u.homedir.length > 0);
});

// --- os: availableParallelism / cpus().length -------------------------------

Deno.test('os: availableParallelism is a positive integer', () => {
    const n = (os as typeof os & { availableParallelism?: () => number }).availableParallelism?.();
    if (n !== undefined) {
        ok(Number.isInteger(n) && n > 0);
    }
});

// --- os: devNull / hostname() / release() -----------------------------------

Deno.test('os: devNull is string; hostname() and release() return strings', () => {
    ok(typeof os.devNull === 'string' && os.devNull.length > 0);
    ok(typeof os.hostname === 'function');
    ok(typeof os.release === 'function');
    ok(typeof os.hostname() === 'string' && os.hostname().length > 0);
    ok(typeof os.release() === 'string' && os.release().length > 0);
});

// --- util: format interpolates ---------------------------------------------

Deno.test('util: format interpolates %s %d %j %%', () => {
    strictEqual(util.format('%s:%d', 'a', 1), 'a:1');
    strictEqual(util.format('%j', { a: 1 }), JSON.stringify({ a: 1 }));
    strictEqual(util.format('100%%'), '100%');
});

// --- util: inspect formats objects and options -----------------------------

Deno.test('util: inspect formats object with colors option', () => {
    const s = util.inspect({ a: 1, b: 'two' }, { colors: false });
    ok(s.includes('a: 1') || s.includes("'a'"));
    ok(s.includes('two'));
});

// --- util: isDeepStrictEqual -----------------------------------------------

Deno.test('util: isDeepStrictEqual compares structurally', () => {
    ok(util.isDeepStrictEqual({ a: 1 }, { a: 1 }));
    ok(!util.isDeepStrictEqual({ a: 1 }, { a: 2 }));
});

// --- util: promisify wraps callback API ------------------------------------

Deno.test('util: promisify converts callback API to promise', async () => {
    const fn = (a: number, cb: (e: any, r: number) => void) => cb(null, a * 2);
    const pfn = util.promisify(fn);
    strictEqual(await pfn(21), 42);
});

// --- util: callbackify wraps async API -------------------------------------

Deno.test('util: callbackify converts async function to callback', (done) => {
    const asyncFn = async (a: number) => a + 1;
    const cbFn = util.callbackify(asyncFn);
    cbFn(1, (err: any, result: number) => {
        ok(!err);
        strictEqual(result, 2);
    });
});

// --- util: inherits sets prototype chain -----------------------------------

Deno.test('util: inherits sets up prototype chain', () => {
    interface BaseInst { base: boolean; baseMethod(): string }
    interface BaseCtor { new (): BaseInst; prototype: BaseInst }
    const Base = function (this: BaseInst) { this.base = true; } as unknown as BaseCtor;
    Base.prototype.baseMethod = () => 'base';
    interface DerivedCtor extends BaseCtor {}
    const Derived = function (this: BaseInst) { Base.call(this); } as unknown as DerivedCtor;
    (util as typeof util & { inherits: (a: unknown, b: unknown) => void }).inherits(Derived, Base);
    const d = new Derived();
    ok(d instanceof (Derived as unknown as BaseCtor));
    strictEqual(d.baseMethod(), 'base');
});

// --- util: types helper ----------------------------------------------------

Deno.test('util.types.isPromise exists', () => {
    const types = (util as typeof util & { types: { isPromise: (v: unknown) => boolean } }).types;
    ok(typeof types === 'object');
    ok(typeof types.isPromise === 'function');
    ok(types.isPromise(Promise.resolve()));
    ok(!types.isPromise({ then: 1 }));
});
