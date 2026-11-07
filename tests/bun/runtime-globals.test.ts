import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import Bun, { embeddedFiles, isStandaloneExecutable, shrink, sleep } from 'bun';

Deno.test({ name: 'bun: gc and enableANSIColors globals', timeout: 5000 }, () => {
    strictEqual(typeof Bun.gc, 'function');
    strictEqual(Bun.gc, globalThis.Bun.gc);
    Bun.gc();
    Bun.gc(true);
    strictEqual(typeof Bun.shrink, 'function');
    strictEqual(Bun.shrink, shrink);
    strictEqual(globalThis.Bun.shrink, shrink);
    shrink();
    // Bun 1.4.4 ignores the runtime value of the advisory force argument.
    Bun.gc('yes' as never);
    Bun.gc(Symbol('force') as never);
    Reflect.apply(Bun.gc, Bun, [true, false]);
    Bun.gc(false);
    strictEqual(Bun.gc.name, 'gc');
    strictEqual(Bun.gc.length, 1);
    strictEqual(Object.hasOwn(Bun.gc, 'prototype'), false);
    throws(() => Reflect.construct(Bun.gc as never, []), TypeError);

    strictEqual(typeof Bun.enableANSIColors, 'boolean');
    // The value is a replaceable snapshot of stdout's terminal status, not a
    // live getter re-reading the fd on every access.
    const descriptor = Object.getOwnPropertyDescriptor(Bun, 'enableANSIColors');
    ok(descriptor && 'value' in descriptor && descriptor.writable === true);
    const shrinkDescriptor = Object.getOwnPropertyDescriptor(Bun, 'shrink');
    ok(shrinkDescriptor && 'value' in shrinkDescriptor && shrinkDescriptor.writable === true);
});

Deno.test('bun: standalone feature detection remains truthful for cno executables', () => {
    strictEqual(isStandaloneExecutable, false);
    strictEqual(Bun.isStandaloneExecutable, isStandaloneExecutable);
    strictEqual(globalThis.Bun.isStandaloneExecutable, isStandaloneExecutable);

    strictEqual(embeddedFiles, Bun.embeddedFiles);
    strictEqual(Bun.embeddedFiles.length, 0);
    ok(Object.isFrozen(Bun.embeddedFiles));
    const standaloneDescriptor = Object.getOwnPropertyDescriptor(Bun, 'isStandaloneExecutable');
    ok(standaloneDescriptor && 'value' in standaloneDescriptor && standaloneDescriptor.writable === false);
    const embeddedDescriptor = Object.getOwnPropertyDescriptor(Bun, 'embeddedFiles');
    ok(embeddedDescriptor && 'value' in embeddedDescriptor && embeddedDescriptor.writable === true);
});

Deno.test('bun: namespace slots match Bun descriptors and lifecycle replacement', () => {
    strictEqual(Object.prototype.toString.call(Bun), '[object Bun]');
    deepStrictEqual(Object.getOwnPropertyDescriptor(Bun, Symbol.toStringTag), {
        value: 'Bun',
        writable: false,
        enumerable: false,
        configurable: true,
    });
    for (const name of Object.keys(Bun)) {
        strictEqual(Object.getOwnPropertyDescriptor(Bun, name)?.configurable, false, name);
    }
    for (const name of ['fetch', 'isMainThread', 'isStandaloneExecutable', 'Cookie', 'CookieMap', 'dns', 'JSONL', 'semver']) {
        const descriptor = Object.getOwnPropertyDescriptor(Bun, name);
        ok(descriptor && 'value' in descriptor && descriptor.writable === false, name);
    }
    for (const name of ['stdout', 'gc', 'shrink', 'enableANSIColors', 'embeddedFiles', 'unsafe']) {
        const descriptor = Object.getOwnPropertyDescriptor(Bun, name);
        ok(descriptor && 'value' in descriptor && descriptor.writable === true, name);
    }

    const originalArgv = Bun.argv;
    const originalMain = Bun.main;
    const replacementArgv = ['replacement'];
    Bun.argv = replacementArgv;
    Bun.main = 'replacement-main';
    strictEqual(Bun.argv, replacementArgv);
    strictEqual(Bun.main, 'replacement-main');
    Bun.argv = originalArgv;
    Bun.main = originalMain;
});

Deno.test('bun: cwd is a hidden replaceable startup snapshot', () => {
    const bun = Bun as typeof Bun & { cwd: string };
    const originalCwd = Deno.cwd();
    strictEqual(bun.cwd, originalCwd);
    strictEqual((globalThis.Bun as typeof bun).cwd, originalCwd);
    deepStrictEqual(Object.getOwnPropertyDescriptor(bun, 'cwd'), {
        value: originalCwd,
        writable: true,
        enumerable: false,
        configurable: false,
    });
    strictEqual(Object.keys(bun).includes('cwd'), false);
    strictEqual(Object.getOwnPropertyNames(bun).includes('cwd'), true);

    const alternateCwd = originalCwd === '/' ? new URL('../..', import.meta.url) : '/';
    try {
        Deno.chdir(alternateCwd);
        strictEqual(bun.cwd, originalCwd);
    } finally {
        Deno.chdir(originalCwd);
    }

    bun.cwd = 'replacement-cwd';
    strictEqual(bun.cwd, 'replacement-cwd');
    bun.cwd = originalCwd;
});

Deno.test('bun: sleep validates inputs synchronously and uses Date internal slots', async () => {
    for (const value of [
        undefined,
        null,
        true,
        '1',
        1n,
        Symbol('x'),
        {},
        new Number(1),
        Object.create(Date.prototype),
        { [Symbol.toStringTag]: 'Date' },
        new Proxy(new Date(), {}),
    ]) {
        throws(() => Bun.sleep(value as never), {
            name: 'TypeError',
            message: 'sleep expects a number (milliseconds)',
        });
    }

    const originalGetTime = Date.prototype.getTime;
    const originalNow = Date.now;
    const target = new Date(originalNow() + 4);
    target.getTime = () => { throw new Error('shadowed getTime called'); };
    Date.prototype.getTime = () => { throw new Error('patched getTime called'); };
    Date.now = () => { throw new Error('patched Date.now called'); };
    try {
        await Bun.sleep(target);
    } finally {
        Date.prototype.getTime = originalGetTime;
        Date.now = originalNow;
    }

    const nullPrototypeDate = new Date(originalNow() + 2);
    Object.setPrototypeOf(nullPrototypeDate, null);
    await Bun.sleep(nullPrototypeDate);
    await Bun.sleep(NaN);
    await Bun.sleep(-1);
    await Bun.sleep(new Date(0));
    await Bun.sleep(new Date(NaN));
});

Deno.test('bun: sleep preserves native metadata and asynchronous ordering', async () => {
    strictEqual(sleep, Bun.sleep);
    strictEqual(Bun.sleep.name, 'sleep');
    strictEqual(Bun.sleep.length, 1);
    strictEqual(Object.hasOwn(Bun.sleep, 'prototype'), false);
    throws(() => Reflect.construct(Bun.sleep as never, [0]), TypeError);
    deepStrictEqual(Object.getOwnPropertyDescriptor(Bun, 'sleep'), {
        value: Bun.sleep,
        writable: true,
        enumerable: true,
        configurable: false,
    });

    const events: string[] = [];
    const sleeping = Bun.sleep(0).then((value) => {
        strictEqual(value, undefined);
        events.push('sleep');
    });
    const timer = new Promise<void>((resolve) => setTimeout(() => {
        events.push('timer');
        resolve();
    }, 0));
    queueMicrotask(() => events.push('microtask'));
    events.push('sync');
    await Promise.all([sleeping, timer]);
    deepStrictEqual(events, ['sync', 'microtask', 'sleep', 'timer']);
});

Deno.test('bun: sleep uses intrinsic globals and keeps Infinity pending', async () => {
    const NativePromise = Promise;
    const nativeMathMin = Math.min;
    let mathMinCalls = 0;
    let sleeping: Promise<void>;
    class PoisonPromise {
        constructor() {
            throw new Error('patched Promise called');
        }
    }
    Math.min = () => {
        mathMinCalls++;
        throw new Error('patched Math.min called');
    };
    Reflect.set(globalThis, 'Promise', PoisonPromise);
    try {
        sleeping = Bun.sleep(1);
    } finally {
        Reflect.set(globalThis, 'Promise', NativePromise);
        Math.min = nativeMathMin;
    }
    ok(sleeping instanceof NativePromise);
    strictEqual(mathMinCalls, 0);
    await sleeping;

    let settled = false;
    Bun.sleep(Infinity).then(
        () => { settled = true; },
        () => { settled = true; },
    );
    await Bun.sleep(0);
    strictEqual(settled, false);
});
