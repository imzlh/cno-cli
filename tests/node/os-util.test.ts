import { strictEqual, ok, match, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
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
    strictEqual(cpus.length, navigator.hardwareConcurrency);
    const c = cpus[0]!;
    ok(typeof c.model === 'string');
    ok(typeof c.speed === 'number');
    ok(typeof c.times === 'object');
    ok(c.times.user >= 0);
    ok(c.times.sys >= 0);
    ok(c.times.idle >= 0);
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

Deno.test('os: userInfo supports buffer encoding', () => {
    const u = os.userInfo({ encoding: 'buffer' });
    ok(Buffer.isBuffer(u.username));
    ok(Buffer.isBuffer(u.homedir));
    ok(u.shell === null || Buffer.isBuffer(u.shell));
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
    ok(typeof os.tmpdir === 'function');
    ok(typeof os.type === 'function');
    ok(typeof os.uptime === 'function');
    ok(typeof os.hostname() === 'string' && os.hostname().length > 0);
    ok(typeof os.release() === 'string' && os.release().length > 0);
    ok(typeof os.tmpdir() === 'string' && os.tmpdir().length > 0);
    ok(typeof os.type() === 'string' && os.type().length > 0);
    ok(os.uptime() >= 0);
    ok(['LE', 'BE'].includes(os.endianness()));
});

Deno.test('os upstream: arch and machine follow Deno.build mappings', () => {
    if (Deno.build.arch === 'x86_64') {
        strictEqual(os.arch(), 'x64');
    } else if (Deno.build.arch === 'aarch64') {
        strictEqual(os.arch(), 'arm64');
    } else {
        strictEqual(os.arch(), Deno.build.arch);
    }

    if (Deno.build.arch === 'aarch64') {
        strictEqual(os.machine(), 'arm64');
    } else {
        strictEqual(os.machine(), Deno.build.arch);
    }
});

Deno.test('os upstream: homedir remains a string when HOME is unset', () => {
    const previous = Deno.env.get('HOME');
    try {
        Deno.env.delete('HOME');
        strictEqual(typeof os.homedir(), 'string');
    } finally {
        if (previous === undefined) {
            Deno.env.delete('HOME');
        } else {
            Deno.env.set('HOME', previous);
        }
    }
});

Deno.test('os upstream: selected methods coerce to their return values', () => {
    strictEqual(`${os.arch}`, os.arch());
    strictEqual(`${os.endianness}`, os.endianness());
    strictEqual(`${os.platform}`, os.platform());
});

Deno.test('os: getPriority validates pid range before native call', () => {
    throws(() => os.getPriority(3.15), RangeError);
    throws(() => os.getPriority(9999999999), RangeError);
});

Deno.test('os: setPriority validates pid and priority ranges before native call', () => {
    throws(() => os.setPriority(3.15), RangeError);
    throws(() => os.setPriority(-21), RangeError);
    throws(() => os.setPriority(20), RangeError);
    throws(() => os.setPriority(0, 3.15), RangeError);
    throws(() => os.setPriority(9999999999, 0), RangeError);
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

Deno.test('util: formatWithOptions still performs printf-style substitution', () => {
    strictEqual(util.formatWithOptions({ colors: false }, 'x:%s %d', 'a', 2), 'x:a 2');
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

Deno.test('util: promisify honors util.promisify.custom', async () => {
    const custom = async (value: number) => value * 3;
    const fn = (_value: number, cb: (e: any, r: number) => void) => cb(null, 0);
    (fn as any)[util.promisify.custom] = custom;
    strictEqual(util.promisify(fn), custom);
    strictEqual(await util.promisify(fn)(14), 42);
});

Deno.test('util: promisify preserves this binding when called with .call', async () => {
    const obj = {
        value: 42,
        method(this: { value: number }, cb: (e: any, r: number) => void) {
            cb(null, this.value);
        },
    };
    const pfn = util.promisify(obj.method);
    strictEqual(await pfn.call(obj), 42);
});

Deno.test('util: promisify rejects callback errors and exposes custom symbol on wrapper', async () => {
    const fn = (cb: (e: Error | null, r?: number) => void) => cb(new Error('bad'));
    const pfn = util.promisify(fn);
    strictEqual((pfn as any)[util.promisify.custom], pfn);
    let err: Error | null = null;
    try {
        await pfn();
    } catch (e) {
        err = e as Error;
    }
    strictEqual(err?.message, 'bad');
});

// --- util: callbackify wraps async API -------------------------------------

Deno.test('util: callbackify converts async function to callback', async () => {
    const asyncFn = async (a: number) => a + 1;
    const cbFn = util.callbackify(asyncFn);
    await new Promise<void>((resolve, reject) => {
        cbFn(1, (err: any, result: number) => {
            try {
                ok(!err);
                strictEqual(result, 2);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
});

Deno.test('util: callbackify wraps falsy rejection reasons', async () => {
    const cbFn = util.callbackify(async () => { throw null; });
    await new Promise<void>((resolve, reject) => {
        cbFn((err: Error & { reason?: unknown }) => {
            try {
                ok(err instanceof Error);
                strictEqual(err.reason, null);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
});

Deno.test('util: callbackify wraps undefined rejection with ERR_FALSY_VALUE_REJECTION', async () => {
    const cbFn = util.callbackify(async () => { throw undefined; });
    await new Promise<void>((resolve, reject) => {
        cbFn((err: Error & { reason?: unknown; code?: string }) => {
            try {
                ok(err instanceof Error);
                strictEqual(err.reason, undefined);
                strictEqual(err.code, 'ERR_FALSY_VALUE_REJECTION');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
});

Deno.test('util: callbackify invokes callback asynchronously', async () => {
    const cbFn = util.callbackify(async () => 'ok');
    let sync = true;
    await new Promise<void>((resolve, reject) => {
        cbFn((err: Error | null, value: string) => {
            try {
                strictEqual(sync, false);
                strictEqual(err, null);
                strictEqual(value, 'ok');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
        sync = false;
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
    strictEqual((Derived as any).super_, Base);
});

// --- util: types helper ----------------------------------------------------

Deno.test('util.types.isPromise exists', () => {
    const types = (util as typeof util & { types: { isPromise: (v: unknown) => boolean } }).types;
    ok(typeof types === 'object');
    ok(typeof types.isPromise === 'function');
    ok(types.isPromise(Promise.resolve()));
    ok(!types.isPromise({ then: 1 }));
});

Deno.test('util.types recognizes typed arrays and boxed primitives', () => {
    const types = util.types;
    ok(types.isTypedArray(new Uint16Array(2)));
    ok(!types.isTypedArray(new DataView(new ArrayBuffer(4))));
    ok(types.isArrayBufferView(new DataView(new ArrayBuffer(4))));
    ok(types.isBoxedPrimitive(new Number(1)));
    ok(types.isBoxedPrimitive(Object(Symbol('x'))));
    ok(!types.isBoxedPrimitive(Symbol('x')));
});

Deno.test('util: stripVTControlCharacters removes ANSI escape sequences', () => {
    strictEqual(util.stripVTControlCharacters('\x1b[31mred\x1b[0m'), 'red');
});

Deno.test('util: toUSVString replaces lone surrogates', () => {
    strictEqual(util.toUSVString('\uD800ok\uDC00'), '\uFFFDok\uFFFD');
});

Deno.test('util: parseArgs parses string and boolean options', () => {
    const utilExt = util as typeof util & {
        parseArgs: (options: {
            args: string[];
            options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean; default?: unknown }>;
            strict?: boolean;
            allowPositionals?: boolean;
            allowNegative?: boolean;
            tokens?: boolean;
        }) => { values: Record<string, unknown>; positionals: string[] };
    };
    const parsed = utilExt.parseArgs({
        args: ['--name', 'x', '--flag'],
        options: {
            name: { type: 'string' },
            flag: { type: 'boolean' },
        },
    });
    strictEqual(parsed.values.name, 'x');
    strictEqual(parsed.values.flag, true);
    strictEqual(parsed.positionals.length, 0);
});

Deno.test('util: parseArgs supports loose unknown options and option terminator', () => {
    const utilExt = util as typeof util & {
        parseArgs: (options: {
            args: string[];
            options?: Record<string, { type: 'string' | 'boolean' }>;
            strict?: boolean;
            allowPositionals?: boolean;
            tokens?: boolean;
        }) => { values: Record<string, unknown>; positionals: string[] };
    };
    const parsed = utilExt.parseArgs({
        args: ['--name=alice', '--flag=false', '--unknown', '--', '--literal', 'file.txt'],
        options: {
            name: { type: 'string' },
            flag: { type: 'boolean' },
        },
        strict: false,
    });
    strictEqual(parsed.values.name, 'alice');
    strictEqual(parsed.values.flag, 'false');
    strictEqual(parsed.values.unknown, true);
    strictEqual(parsed.positionals.join(','), '--literal,file.txt');
});

Deno.test('util: parseArgs supports short names multiple defaults and negative booleans', () => {
    const utilExt = util as typeof util & {
        parseArgs: (options: {
            args: string[];
            options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean; default?: unknown }>;
            allowNegative?: boolean;
        }) => { values: Record<string, unknown>; positionals: string[] };
    };
    const parsed = utilExt.parseArgs({
        args: ['-n', 'alice', '--tag=a', '--tag', 'b', '--no-color'],
        options: {
            name: { type: 'string', short: 'n' },
            tag: { type: 'string', multiple: true, default: ['base'] },
            color: { type: 'boolean', default: true },
        },
        allowNegative: true,
    });
    strictEqual(parsed.values.name, 'alice');
    strictEqual((parsed.values.tag as string[]).join(','), 'base,a,b');
    strictEqual(parsed.values.color, false);
});

Deno.test('util: parseArgs reports strict boolean inline values', () => {
    const utilExt = util as typeof util & {
        parseArgs: (options: {
            args: string[];
            options: Record<string, { type: 'string' | 'boolean' }>;
        }) => { values: Record<string, unknown>; positionals: string[] };
    };
    let err: any;
    try {
        utilExt.parseArgs({
            args: ['--flag=false'],
            options: { flag: { type: 'boolean' } },
        });
    } catch (e) {
        err = e;
    }
    strictEqual(err?.code, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE');
});

Deno.test('util: MIMEType parses type subtype and params', () => {
    const MIMETypeCtor = (util as typeof util & {
        MIMEType: new (value: string) => {
            type: string;
            subtype: string;
            essence: string;
            params: { get: (key: string) => string | null; set: (key: string, value: string) => void };
            toString(): string;
        };
    }).MIMEType;
    const mime = new MIMETypeCtor('Text/Plain;Charset=utf-8');
    strictEqual(mime.type, 'text');
    strictEqual(mime.subtype, 'plain');
    strictEqual(mime.essence, 'text/plain');
    strictEqual(mime.params.get('charset'), 'utf-8');
    mime.params.set('boundary', 'abc');
    strictEqual(mime.toString(), 'text/plain;charset=utf-8;boundary=abc');
});

Deno.test('util: transferableAbortController returns abort controller with signal', () => {
    const controller = (util as typeof util & {
        transferableAbortController: () => AbortController;
    }).transferableAbortController();
    ok(typeof controller.abort === 'function');
    strictEqual(controller.signal.aborted, false);
    controller.abort('stop');
    strictEqual(controller.signal.aborted, true);
    strictEqual(controller.signal.reason, 'stop');
});

Deno.test('util: transferableAbortSignal returns signal-like object', () => {
    const signal = (util as typeof util & {
        transferableAbortSignal: (signal: AbortSignal) => AbortSignal;
    }).transferableAbortSignal(new AbortController().signal);
    strictEqual(typeof signal.aborted, 'boolean');
    strictEqual(typeof signal.addEventListener, 'function');
});

Deno.test('util: aborted resolves with abort event when signal aborts', async () => {
    const controller = new AbortController();
    const pending = (util as typeof util & {
        aborted: (signal: AbortSignal, resource: object) => Promise<Event>;
    }).aborted(controller.signal, {});
    controller.abort('why');
    const event = await pending;
    strictEqual(event.type, 'abort');
});
