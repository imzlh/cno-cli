import { strictEqual, ok, throws } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

// --- 1. Deno exists on globalThis ------------------------------------------

Deno.test('deno: globalThis.Deno is defined', () => {
    ok(Deno, 'Deno must be installed on globalThis');
});

Deno.test('deno upstream: selected global object descriptors and aliases match Deno', () => {
    strictEqual(globalThis.self, globalThis);
    strictEqual(globalThis.window, globalThis);
    strictEqual(globalThis.navigator instanceof Navigator, true);
    throws(() => new Navigator(), TypeError);

    const denoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
    ok(denoDescriptor);
    strictEqual(denoDescriptor.configurable, true);
    strictEqual(denoDescriptor.writable, false);

    const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'global');
    ok(globalDescriptor);
    strictEqual(globalDescriptor.writable, true);
    const originalGlobal = globalThis.global;
    try {
        globalThis.global = 'can write global' as unknown as typeof globalThis;
        strictEqual(globalThis.global, 'can write global' as unknown as typeof globalThis);
    } finally {
        globalThis.global = originalGlobal;
    }

    strictEqual(typeof globalThis.name, 'string');
    const originalName = globalThis.name;
    try {
        globalThis.name = 'cno-name';
        strictEqual(name, 'cno-name');
    } finally {
        globalThis.name = originalName;
    }
});

Deno.test('deno upstream: ES global helpers Promise.withResolvers and groupBy work', async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    resolve(true);
    strictEqual(await promise, true);

    strictEqual(typeof Symbol.metadata, 'symbol');

    const grouped = Object.groupBy([
        { kind: 'a', value: 1 },
        { kind: 'b', value: 2 },
        { kind: 'a', value: 3 },
    ], (entry) => entry.kind);
    strictEqual(grouped.a?.length, 2);
    strictEqual(grouped.b?.[0].value, 2);

    const restock = { restock: true };
    const enough = { restock: false };
    const map = Map.groupBy([
        { name: 'low', quantity: 1 },
        { name: 'high', quantity: 10 },
    ], (entry) => entry.quantity < 5 ? restock : enough);
    strictEqual(map.get(restock)?.[0].name, 'low');
    strictEqual(map.get(enough)?.[0].name, 'high');
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
    strictEqual(Object.getPrototypeOf(obj), null);
    strictEqual(obj['CNO_TO_OBJECT'], 'x');
    Deno.env.delete('CNO_TO_OBJECT');
});

Deno.test('deno: Deno.env.toObject is a snapshot and empty values stay present', () => {
    const key = 'CNO_ENV_SNAPSHOT_EMPTY';
    Deno.env.delete(key);
    Deno.env.set(key, '');
    const snapshot = Deno.env.toObject();
    Deno.env.set(key, 'later');
    try {
        strictEqual(snapshot[key], '');
        strictEqual(Deno.env.has(key), true);
        strictEqual(Deno.env.get(key), 'later');
    } finally {
        Deno.env.delete(key);
    }
});

// --- 3. Deno.env.get on unset returns undefined (not throw) ----------------

Deno.test('deno: Deno.env.get on unset key returns undefined', () => {
    strictEqual(Deno.env.get('CNO_DOES_NOT_EXIST_XYZ'), undefined);
});

Deno.test('deno: Deno.env rejects invalid keys and values before touching the host env', () => {
    for (const key of ['', '=', 'a=a', 'a\0a']) {
        throws(() => Deno.env.get(key), TypeError);
        throws(() => Deno.env.set(key, 'value'), TypeError);
        throws(() => Deno.env.delete(key), TypeError);
    }
    throws(() => Deno.env.set('CNO_BAD_ENV_VALUE', 'v\0v'), TypeError);
    strictEqual(Deno.env.get('CNO_BAD_ENV_VALUE'), undefined);
});

Deno.test('deno upstream: Deno.env coerces non-symbol keys and values to strings', () => {
    const key = 123 as unknown as string;
    strictEqual(Deno.env.get(key), undefined);
    strictEqual(Deno.env.has(key), false);
    Deno.env.delete(key);

    Deno.env.set('CNO_ENV_COERCE_NULL', null as unknown as string);
    Deno.env.set('CNO_ENV_COERCE_NUMBER', 123 as unknown as string);
    Deno.env.set({ toString: () => 'CNO_ENV_OBJECT_KEY' } as unknown as string, { toString: () => 'object-value' } as unknown as string);
    try {
        strictEqual(Deno.env.get('CNO_ENV_COERCE_NULL'), 'null');
        strictEqual(Deno.env.get('CNO_ENV_COERCE_NUMBER'), '123');
        strictEqual(Deno.env.get('CNO_ENV_OBJECT_KEY'), 'object-value');
        strictEqual(Deno.env.has({ toString: () => 'CNO_ENV_OBJECT_KEY' } as unknown as string), true);
    } finally {
        Deno.env.delete('CNO_ENV_COERCE_NULL');
        Deno.env.delete('CNO_ENV_COERCE_NUMBER');
        Deno.env.delete('CNO_ENV_OBJECT_KEY');
    }

    throws(() => Deno.env.get(Symbol('key') as unknown as string), TypeError);
    throws(() => Deno.env.set('CNO_ENV_SYMBOL_VALUE', Symbol('value') as unknown as string), TypeError);
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

Deno.test('deno upstream: Deno.errors constructors preserve cause and errno-style codes', () => {
    const cause = new Error('root-cause');
    for (const name of Object.keys(Deno.errors)) {
        const Ctor = Deno.errors[name as keyof typeof Deno.errors] as new (
            message?: string,
            options?: { cause?: unknown },
        ) => Error & { cause?: unknown; code?: string };
        const error = new Ctor('with-cause', { cause });
        ok(error instanceof Error, `Deno.errors.${name} must extend Error`);
        strictEqual(error.name, name);
        strictEqual(error.message, 'with-cause');
        strictEqual(error.cause, cause);
    }

    strictEqual(new Deno.errors.NotFound().code, 'ENOENT');
    strictEqual(new Deno.errors.AlreadyExists().code, 'EEXIST');
    strictEqual(new Deno.errors.PermissionDenied().code, 'EACCES');
    strictEqual(new Deno.errors.IsADirectory().code, 'EISDIR');
    strictEqual(new Deno.errors.NotADirectory().code, 'ENOTDIR');
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

Deno.test('deno: Deno.chdir accepts file URL paths', async () => {
    const original = Deno.cwd();
    await withTempDir('deno-chdir', async (root) => {
        const spaced = join(root, 'space dir');
        Deno.mkdirSync(spaced);
        try {
            Deno.chdir(new URL(`file://${spaced}`));
            strictEqual(Deno.cwd(), spaced);
            throws(() => Deno.chdir(new URL('https://example.com/not-file')), TypeError);
        } finally {
            Deno.chdir(original);
        }
    });
    strictEqual(Deno.cwd(), original);
});

Deno.test({
    name: 'deno upstream: cwd reports NotFound after current directory is removed',
    ignore: Deno.build.os === 'windows',
}, () => {
    const original = Deno.cwd();
    const root = Deno.makeTempDirSync({ prefix: 'cno-cwd-removed-' });
    try {
        Deno.chdir(root);
        Deno.removeSync(root);
        throws(() => Deno.cwd(), Deno.errors.NotFound);
    } finally {
        Deno.chdir(original);
    }
});

Deno.test('deno upstream: chdir rejects missing directories', () => {
    const missing = `${Deno.makeTempDirSync({ prefix: 'cno-chdir-missing-' })}-missing`;
    throws(() => Deno.chdir(missing), Deno.errors.NotFound);
});

// --- 9: Deno.mainModule is string; Deno.execPath is function ---------------

Deno.test('deno: Deno.mainModule is string and Deno.execPath is function', () => {
    ok(typeof Deno.mainModule === 'string');
    ok(typeof Deno.execPath === 'function');
    ok(Deno.execPath().length > 0);
});

// --- 10. Deno.memoryUsage returns the shape -------------------------------

Deno.test('deno: Deno.memoryUsage returns numeric fields', () => {
    const m = Deno.memoryUsage();
    for (const k of ['rss', 'heapTotal', 'heapUsed', 'external']) {
        ok(typeof m[k] === 'number' && m[k] >= 0, `memoryUsage.${k} must be a non-negative number`);
    }
    ok(m.rss >= m.heapTotal, 'rss should include the runtime heap allocation');
});

Deno.test({ name: 'deno upstream: mainModule and execPath are observable in file subprocesses', timeout: 10000 }, async () => {
    await withTempDir('deno-main-module', async (root) => {
        const script = join(root, 'main.ts');
        Deno.writeTextFileSync(script, `
            console.log(JSON.stringify({
                mainModule: Deno.mainModule,
                execPath: Deno.execPath(),
                argv0: Deno.args[0] ?? null
            }));
        `);

        const output = await new Deno.Command(Deno.execPath(), {
            args: ['run', script, 'arg0'],
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        strictEqual(output.success, true, decodeUtf8(output.stderr));
        const result = JSON.parse(decodeUtf8(output.stdout));
        strictEqual(result.mainModule, new URL(`file://${script}`).href);
        strictEqual(result.execPath, Deno.execPath());
        strictEqual(result.argv0, 'arg0');
    });
});

Deno.test('deno: args is enumerable and returns a read-only snapshot', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Deno, 'args');
    ok(descriptor, 'Deno.args must have an own descriptor');
    strictEqual(descriptor.enumerable, true);
    strictEqual(descriptor.configurable, true);
    strictEqual(typeof descriptor.get, 'function');
    strictEqual(typeof descriptor.set, 'function');
    ok(Object.keys(Deno).includes('args'));

    const before = Deno.args.join('\0');
    const snapshot = Deno.args;
    ok(Array.isArray(snapshot));
    snapshot.push('mutated');
    strictEqual(Deno.args.includes('mutated'), false);

    (Deno as unknown as { args: string[] }).args = ['ignored'];
    strictEqual(Deno.args.join('\0'), before);
});

Deno.test('deno: isatty and cpuUsage expose stable public shapes', () => {
    strictEqual(Deno.isatty(0), Deno.stdin.isTerminal());
    strictEqual(Deno.isatty(1), Deno.stdout.isTerminal());
    strictEqual(Deno.isatty(2), Deno.stderr.isTerminal());
    strictEqual(Deno.isatty(999999), false);

    const usage = Deno.cpuUsage();
    ok(Number.isFinite(usage.user) && usage.user >= 0);
    ok(Number.isFinite(usage.system) && usage.system >= 0);
});

Deno.test('deno: refTimer and unrefTimer accept timer handles and reject invalid handles', async () => {
    let fired = false;
    const timer = setTimeout(() => { fired = true; }, 1);
    Deno.unrefTimer(timer);
    Deno.refTimer(timer);
    Deno.unrefTimer(Number(timer));
    Deno.refTimer(Number(timer));
    Deno.unrefTimer(NaN);
    Deno.refTimer(NaN);
    throws(() => Deno.refTimer({} as unknown as number), /Invalid timer/);
    throws(() => Deno.unrefTimer({} as unknown as number), /Invalid timer/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    strictEqual(fired, true);
});

Deno.test({ name: 'deno upstream: unrefTimer does not keep the event loop alive', timeout: 10000 }, async () => {
    const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            const timer = setTimeout(() => console.log('unexpected'), 200);
            Deno.unrefTimer(timer);
        `],
        stdout: 'piped',
        stderr: 'piped',
    }).output();

    strictEqual(output.code, 0, decodeUtf8(output.stderr));
    strictEqual(decodeUtf8(output.stdout), '');
});

Deno.test({ name: 'deno upstream: refTimer restores a previously unrefed timer', timeout: 10000 }, async () => {
    const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            const timer = setTimeout(() => console.log('fired'), 10);
            Deno.unrefTimer(timer);
            Deno.refTimer(timer);
        `],
        stdout: 'piped',
        stderr: 'piped',
    }).output();

    strictEqual(output.code, 0, decodeUtf8(output.stderr));
    strictEqual(decodeUtf8(output.stdout), 'fired\n');
});

Deno.test({ name: 'deno upstream: mixed ref and unref timers exit after referenced work', timeout: 10000 }, async () => {
    const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            setTimeout(() => console.log('1'), 20);
            setTimeout(() => console.log('2'), 40);
            const timer = setTimeout(() => console.log('unexpected'), 80);
            Deno.unrefTimer(timer);
        `],
        stdout: 'piped',
        stderr: 'piped',
    }).output();

    strictEqual(output.code, 0, decodeUtf8(output.stderr));
    strictEqual(decodeUtf8(output.stdout), '1\n2\n');
});

Deno.test({ name: 'deno: exitCode accepts only integer numbers and drives Deno.exit', timeout: 10000 }, async () => {
    const check = await new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            Deno.exitCode = 7;
            console.log('number=' + Deno.exitCode);
            for (const value of ['8', NaN, Infinity, {}, null, 1n]) {
                try {
                    Deno.exitCode = value;
                    console.log('accepted');
                } catch (error) {
                    console.log(error instanceof TypeError ? 'type-error' : error instanceof RangeError ? 'range-error' : 'other-error');
                }
            }
            try {
                Deno.exitCode = 3.14;
                console.log('accepted');
            } catch (error) {
                console.log(error instanceof RangeError ? 'range-error' : 'other-error');
            }
        `],
    }).output();
    strictEqual(check.success, false);
    strictEqual(check.code, 7);
    strictEqual(decodeUtf8(check.stderr), '');
    strictEqual(decodeUtf8(check.stdout).trim(), [
        'number=7',
        'type-error',
        'range-error',
        'range-error',
        'type-error',
        'type-error',
        'type-error',
        'range-error',
    ].join('\n'));

    const exited = await new Deno.Command(Deno.execPath(), {
        args: ['eval', `Deno.exitCode = 9; Deno.exit();`],
    }).output();
    strictEqual(exited.success, false);
    strictEqual(exited.code, 9);
    strictEqual(exited.signal, null);
});
