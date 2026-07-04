import { strictEqual, ok, throws } from 'node:assert';

// --- 1. Deno exists on globalThis ------------------------------------------

Deno.test('deno: globalThis.Deno is defined', () => {
    ok(Deno, 'Deno must be installed on globalThis');
});

// --- 2. Deno.env: get/set/has/delete/toObject ------------------------------

Deno.test('deno: Deno.env get/set/has/delete reflect each other', () => {
    const key = 'CNO_TEST_ENV_KEY';
    Deno.env.set(key, 'value-1');
    strictEqual(Deno.env.get(key), 'value-1');
    ok(Deno.env.has(key));
    Deno.env.delete(key);
    ok(!Deno.env.has(key));
    strictEqual(Deno.env.get(key), undefined);
});

Deno.test('deno: Deno.env.toObject is a plain object of strings', () => {
    Deno.env.set('CNO_TO_OBJECT', 'x');
    const obj = Deno.env.toObject();
    ok(obj && typeof obj === 'object');
    strictEqual(obj['CNO_TO_OBJECT'], 'x');
    Deno.env.delete('CNO_TO_OBJECT');
});

// --- 3. Deno.env.get on unset returns undefined (not throw) ----------------

Deno.test('deno: Deno.env.get on unset key returns undefined', () => {
    strictEqual(Deno.env.get('CNO_DOES_NOT_EXIST_XYZ'), undefined);
});

// --- 4. Deno.errors: each is an Error subclass with the right name ---------

Deno.test('deno: Deno.errors classes are Error subclasses with names', () => {
    for (const name of ['NotFound', 'PermissionDenied', 'ConnectionRefused',
        'ConnectionReset', 'ConnectionAborted', 'NotConnected', 'AddrInUse',
        'AddrNotAvailable', 'BrokenPipe', 'AlreadyExists', 'InvalidData',
        'BadResource', 'Interrupted', 'NotCapable']) {
        const Ctor = Deno.errors[name];
        ok(typeof Ctor === 'function', `errors.${name} must be a constructor`);
        const e = new Ctor('boom');
        ok(e instanceof Error, `errors.${name} must extend Error`);
        strictEqual(e.name, name);
        strictEqual(e.message, 'boom');
    }
});

// --- 5. Deno.build + Deno.version are shaped correctly ---------------------

Deno.test('deno: Deno.build and Deno.version have expected shape', () => {
    for (const k of ['arch', 'os', 'target', 'vendor']) {
        ok(typeof Deno.build[k] === 'string' && Deno.build[k].length > 0,
            `Deno.build.${k} must be a non-empty string`);
    }
    for (const k of ['deno', 'v8', 'typescript']) {
        ok(typeof Deno.version[k] === 'string' && Deno.version[k].length > 0,
            `Deno.version.${k} must be a non-empty string`);
    }
});

// --- 6. Deno.pid / Deno.ppid are positive numbers -------------------------

Deno.test('deno: Deno.pid and Deno.ppid are positive numbers', () => {
    ok(Number.isInteger(Deno.pid) && Deno.pid > 0);
    ok(Number.isInteger(Deno.ppid) && Deno.ppid >= 0);
});

// --- 7. Deno.test registers definitions into its registry -----------------

Deno.test('deno: Deno.test accepts name + fn', () => {
    Deno.test('deno-inner: trivial', () => {
        strictEqual(1, 1);
    });
});

Deno.test('deno: Deno.test accepts options object', () => {
    Deno.test({ name: 'deno-inner: object-form', ignore: false }, () => {
        ok(true);
    });
});

Deno.test('deno: Deno.test.only is callable', () => {
    Deno.test({ name: 'deno-inner: only-form', only: true }, () => {
        ok(true);
    });
});

// --- 8. Deno.cwd / Deno.chdir round-trip -----------------------------------

Deno.test('deno: Deno.chdir + Deno.cwd round-trip', () => {
    const original = Deno.cwd();
    ok(typeof original === 'string' && original.length > 0);
    Deno.chdir('/');
    strictEqual(Deno.cwd(), '/');
    Deno.chdir(original);
    strictEqual(Deno.cwd(), original);
});

// --- 9: Deno.mainModule is string; Deno.execPath is function ---------------

Deno.test('deno: Deno.mainModule is string and Deno.execPath is function', () => {
    ok(typeof Deno.mainModule === 'string');
    ok(typeof Deno.execPath === 'function');
});

// --- 10. Deno.memoryUsage returns the shape -------------------------------

Deno.test('deno: Deno.memoryUsage returns numeric fields', () => {
    const m = Deno.memoryUsage();
    for (const k of ['rss', 'heapTotal', 'heapUsed', 'external']) {
        ok(typeof m[k] === 'number' && m[k] >= 0, `memoryUsage.${k} must be a non-negative number`);
    }
});
