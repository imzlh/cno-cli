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

    strictEqual(typeof Bun.enableANSIColors, 'boolean');
    // The value is a non-writable snapshot of stdout's terminal status, not a
    // live getter re-reading the fd on every access.
    const descriptor = Object.getOwnPropertyDescriptor(Bun, 'enableANSIColors');
    ok(descriptor && 'value' in descriptor && descriptor.writable === false);
    const shrinkDescriptor = Object.getOwnPropertyDescriptor(Bun, 'shrink');
    ok(shrinkDescriptor && 'value' in shrinkDescriptor && shrinkDescriptor.writable === false);
});

Deno.test('bun: standalone feature detection remains truthful for cno executables', () => {
    strictEqual(isStandaloneExecutable, false);
    strictEqual(Bun.isStandaloneExecutable, isStandaloneExecutable);
    strictEqual(globalThis.Bun.isStandaloneExecutable, isStandaloneExecutable);

    strictEqual(embeddedFiles, Bun.embeddedFiles);
    strictEqual(Bun.embeddedFiles.length, 0);
    ok(Object.isFrozen(Bun.embeddedFiles));
    for (const name of ['isStandaloneExecutable', 'embeddedFiles'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(Bun, name);
        ok(descriptor && 'value' in descriptor && descriptor.writable === false, name);
    }
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

Deno.test('bun: sleep uses the intrinsic Promise and keeps Infinity pending', async () => {
    const NativePromise = Promise;
    let sleeping: Promise<void>;
    class PoisonPromise {
        constructor() {
            throw new Error('patched Promise called');
        }
    }
    Reflect.set(globalThis, 'Promise', PoisonPromise);
    try {
        sleeping = Bun.sleep(0);
    } finally {
        Reflect.set(globalThis, 'Promise', NativePromise);
    }
    ok(sleeping instanceof NativePromise);
    await sleeping;

    let settled = false;
    Bun.sleep(Infinity).then(
        () => { settled = true; },
        () => { settled = true; },
    );
    await Bun.sleep(0);
    strictEqual(settled, false);
});
