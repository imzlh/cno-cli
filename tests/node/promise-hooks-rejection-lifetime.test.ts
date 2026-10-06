import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { promiseHooks } from 'node:v8';

const nativeTimers = import.meta.use('timers');
const engine = import.meta.use('engine');
const os = import.meta.use('os');
const tick = () => new Promise<void>(resolve => nativeTimers.setTimeout(resolve, 1));

Deno.test('promise hooks: direct rejection forms settle exactly once', async () => {
    const reason = new Error('handled rejection');
    const factories = [
        () => Promise.reject(reason),
        () => new Promise((_, reject) => reject(reason)),
        () => new Promise(() => { throw reason; }),
    ];
    const counts = new Map<Promise<unknown>, number>();
    let capture = false;
    const stop = promiseHooks.createHook({
        init(promise) { if (capture) counts.set(promise, 0); },
        settled(promise) {
            const count = counts.get(promise);
            if (count !== undefined) counts.set(promise, count + 1);
        },
    });
    try {
        for (const factory of factories) {
            capture = true;
            const promise = factory();
            capture = false;
            const caught = promise.catch(error => error);
            strictEqual(counts.get(promise), 1, 'settled must run before the rejecting call returns');
            strictEqual(await caught, reason);
            strictEqual(counts.get(promise), 1);
        }
    } finally {
        capture = false;
        stop();
    }
});

Deno.test('promise hooks: reactions registered during settlement preserve registration order', async () => {
    for (const rejected of [false, true]) {
        let resolve!: (value: unknown) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        const events: string[] = [];
        const reason = new Error('original rejection');
        const observe = (name: string) => promise.then(
            () => { events.push(name); },
            error => { strictEqual(error, reason); events.push(name); },
        );
        const first = observe('preexisting');
        let fromHook: Promise<void> | undefined;
        let notifications = 0;
        const stop = promiseHooks.onSettled(current => {
            if (current !== promise) return;
            notifications++;
            events.push('settled');
            fromHook = observe('from-hook');
            resolve('reentrant resolution');
            reject(new Error('reentrant rejection'));
        });
        try {
            if (rejected) reject(reason);
            else resolve('value');
            events.push('after-settle');
            resolve('second resolution');
            reject(new Error('second rejection'));
            strictEqual(notifications, 1);
            await Promise.all([first, fromHook]);
            deepStrictEqual(events, ['settled', 'after-settle', 'preexisting', 'from-hook']);
            strictEqual(notifications, 1);
        } finally {
            stop();
        }
    }
});

Deno.test('promise hooks: adopted rejected promises and thenables settle exactly once', async () => {
    const reason = new Error('adopted rejection');
    const factories: Array<() => unknown> = [
        () => Promise.reject(reason),
        () => ({ then(_resolve: unknown, reject: (error: unknown) => void) {
            reject(reason);
            reject(new Error('ignored second rejection'));
            throw new Error('ignored throw after rejection');
        } }),
        () => ({ get then() { throw reason; } }),
        () => ({ then() { throw reason; } }),
    ];
    for (const factory of factories) {
        let resolve!: (value: unknown) => void;
        const promise = new Promise(res => { resolve = res; });
        let notifications = 0;
        const stop = promiseHooks.onSettled(current => {
            if (current === promise) notifications++;
        });
        try {
            const caught = promise.catch(error => error);
            resolve(factory());
            strictEqual(await caught, reason);
            strictEqual(notifications, 1);
        } finally {
            stop();
        }
    }
});

Deno.test('promise hooks: rejection settlement hooks cannot recurse through nested rejection', async () => {
    let reject!: (reason: unknown) => void;
    const promise = new Promise((_, rej) => { reject = rej; });
    const reason = new Error('outer rejection');
    const caught = promise.catch(error => error);
    let depth = 0;
    let maxDepth = 0;
    let notifications = 0;
    let nested: Promise<unknown> | undefined;
    const stop = promiseHooks.onSettled(current => {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        try {
            if (current === promise) {
                notifications++;
                nested = Promise.reject(reason).catch(error => error);
            }
        } finally {
            depth--;
        }
    });
    try {
        reject(reason);
        strictEqual(await caught, reason);
        strictEqual(await nested, reason);
        strictEqual(notifications, 1);
        strictEqual(maxDepth, 1);
    } finally {
        stop();
    }
});

Deno.test('promise hooks: a throwing hook preserves rejection and permits later notifications', async () => {
    const reason = new Error('original rejection');
    let reject!: (reason: unknown) => void;
    const promise = new Promise((_, rej) => { reject = rej; });
    const caught = promise.catch(error => error);
    let calls = 0;
    const stopThrowing = promiseHooks.onSettled(current => {
        if (current === promise) {
            calls++;
            throw new Error('hook failed');
        }
    });
    try {
        reject(reason);
        strictEqual(await caught, reason);
        strictEqual(calls, 1);
    } finally {
        stopThrowing();
    }
    let rejectLater!: (reason: unknown) => void;
    const later = new Promise((_, rej) => { rejectLater = rej; });
    const laterCaught = later.catch(error => error);
    const stopLater = promiseHooks.onSettled(current => {
        if (current === later) calls++;
    });
    try {
        rejectLater(reason);
        strictEqual(await laterCaught, reason);
        strictEqual(calls, 2);
    } finally {
        stopLater();
    }
});

Deno.test('promise hooks: handled rejections leave no pending records or ALS payloads', async () => {
    const als = new AsyncLocalStorage<Uint8Array>();
    const pending = new Set<Promise<unknown>>();
    let capture = false;
    const asyncHook = createHook({}).enable();
    const stop = promiseHooks.createHook({
        init(promise) { if (capture) pending.add(promise); },
        settled(promise) { pending.delete(promise); },
    });
    try {
        engine.gc.run();
        const before = os.memoryUsage()['vm.used'];
        for (let batch = 0; batch < 3; batch++) {
            for (let i = 0; i < 128; i++) {
                als.run(new Uint8Array(64 * 1024), () => {
                    capture = true;
                    Promise.reject(new Error('handled')).catch(() => {});
                    capture = false;
                });
            }
            await tick();
            engine.gc.run();
            strictEqual(pending.size, 0, 'settled must remove rejected promises from monitoring records');
            const growth = os.memoryUsage()['vm.used'] - before;
            ok(growth < 2 * 1024 * 1024, `batch ${batch} retained ${growth} bytes`);
        }
    } finally {
        capture = false;
        pending.clear();
        stop();
        asyncHook.disable();
        als.disable();
    }
});
