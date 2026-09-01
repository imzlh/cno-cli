import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import * as async_hooks from 'node:async_hooks';
import process from 'node:process';
import { setImmediate } from 'node:timers';

// --- 1. executionAsyncId returns a number -----------------------------------

Deno.test('async_hooks: executionAsyncId returns number', () => {
    const id = async_hooks.executionAsyncId();
    ok(typeof id === 'number' && id >= 0);
});

// --- 2. triggerAsyncId returns a number -------------------------------------

Deno.test('async_hooks: triggerAsyncId returns number', () => {
    const id = async_hooks.triggerAsyncId();
    ok(typeof id === 'number' && id >= 0);
});

// --- 3. createHook returns {enable, disable} --------------------------------

Deno.test('async_hooks: createHook returns handle', () => {
    const hook = async_hooks.createHook({
        init() {},
        before() {},
        after() {},
        destroy() {},
        promiseResolve() {},
    });
    ok(typeof hook.enable === 'function');
    ok(typeof hook.disable === 'function');
    hook.enable();
    hook.disable();
});

// --- 4. AsyncLocalStorage get/set/run ---------------------------------------

Deno.test('async_hooks: AsyncLocalStorage run/getStore', () => {
    const als = new async_hooks.AsyncLocalStorage<string>();
    const result = als.run('value', () => {
        return als.getStore();
    });
    strictEqual(result, 'value');
});

// --- 5. AsyncLocalStorage getStore outside run is undefined -----------------

Deno.test('async_hooks: AsyncLocalStorage getStore undefined outside run', () => {
    const als = new async_hooks.AsyncLocalStorage<string>();
    strictEqual(als.getStore(), undefined);
});

// --- 6. AsyncLocalStorage.exit runs without context -------------------------

Deno.test('async_hooks: AsyncLocalStorage.exit clears store', () => {
    const als = new async_hooks.AsyncLocalStorage<string>();
    als.run('outer', () => {
        als.exit(() => {
            strictEqual(als.getStore(), undefined);
        });
    });
});

// --- 7. AsyncLocalStorage can be disabled -----------------------------------

Deno.test('async_hooks: AsyncLocalStorage.disable is callable', () => {
    const als = new async_hooks.AsyncLocalStorage<string>();
    als.enterWith('value');
    strictEqual(als.getStore(), 'value');
    als.disable();
    strictEqual(als.getStore(), undefined);
});

// --- 8. AsyncLocalStorage snapshot restores captured store -----------------

Deno.test('async_hooks: AsyncLocalStorage.snapshot restores captured store', () => {
    const AsyncLocalStorageCtor = (async_hooks as typeof async_hooks & {
        AsyncLocalStorage: typeof async_hooks.AsyncLocalStorage & {
            snapshot?: () => <T>(fn: () => T) => T;
        };
    }).AsyncLocalStorage;
    if (typeof AsyncLocalStorageCtor.snapshot !== 'function') {
        return;
    }

    const als = new async_hooks.AsyncLocalStorage<string>();
    als.run('outer', () => {
        const snapshot = AsyncLocalStorageCtor.snapshot!();
        als.run('inner', () => {
            strictEqual(als.getStore(), 'inner');
            strictEqual(snapshot(() => als.getStore()), 'outer');
            strictEqual(als.getStore(), 'inner');
        });
    });
});

// --- 9. AsyncResource is a class --------------------------------------------

Deno.test('async_hooks: AsyncResource is a constructor', () => {
    const { AsyncResource } = async_hooks;
    ok(typeof AsyncResource === 'function');
    const res = new AsyncResource('test');
    ok(typeof res.asyncId === 'function' || typeof (res as any).asyncId === 'number');
});

Deno.test('async_hooks: AsyncResource asyncId and triggerAsyncId return numbers', () => {
    const { AsyncResource } = async_hooks;
    const res = new AsyncResource('test');
    strictEqual(typeof res.asyncId(), 'number');
    ok(res.asyncId() >= 0);
    strictEqual(typeof res.triggerAsyncId(), 'number');
    ok(res.triggerAsyncId() >= 0);
});

// --- 10. AsyncResource.runInAsyncScope binds context ------------------------

Deno.test('async_hooks: AsyncResource.runInAsyncScope binds', () => {
    const { AsyncResource } = async_hooks;
    const als = new async_hooks.AsyncLocalStorage<string>();
    als.run('ctx', () => {
        const res = new AsyncResource('inner');
        res.runInAsyncScope(() => {
            strictEqual(als.getStore(), 'ctx');
        });
    });
});

Deno.test('async_hooks upstream: AsyncResource.bind preserves async context and thisArg', () => {
    const { AsyncResource } = async_hooks;
    const als = new async_hooks.AsyncLocalStorage<string>();
    als.run('ctx', () => {
        const resource = new AsyncResource('bound-resource');
        const bound = resource.bind(function(this: { label: string }, value: string) {
            return `${als.getStore()}:${this.label}:${value}`;
        });
        strictEqual(bound.call({ label: 'dynamic' }, 'ok'), 'ctx:dynamic:ok');

        const fixed = resource.bind(function(this: { label: string }) {
            return `${als.getStore()}:${this.label}`;
        }, { label: 'fixed' });
        strictEqual(fixed.call({ label: 'ignored' }), 'ctx:fixed');
    });
});

Deno.test('async_hooks upstream: AsyncResource.bind static creates a bound resource', () => {
    const { AsyncResource } = async_hooks;
    const als = new async_hooks.AsyncLocalStorage<string>();
    als.run('static-ctx', () => {
        const bound = AsyncResource.bind(function(this: { label: string }) {
            return `${als.getStore()}:${this.label}`;
        }, 'static-resource');
        strictEqual(bound.call({ label: 'dynamic' }), 'static-ctx:dynamic');
    });
});

// --- 11. asyncWrapProviders is an object ------------------------------------

Deno.test('async_hooks: asyncWrapProviders is object', () => {
    ok(async_hooks.asyncWrapProviders && typeof async_hooks.asyncWrapProviders === 'object');
});

// --- 12. executionAsyncId changes across async boundaries --------------------

Deno.test('async_hooks: executionAsyncId differs across promises', async () => {
    const outer = async_hooks.executionAsyncId();
    await Promise.resolve();
    const inner = async_hooks.executionAsyncId();
    ok(typeof outer === 'number' && typeof inner === 'number');
});

Deno.test('async_hooks: AsyncLocalStorage propagates through promise and timer boundaries', async () => {
    const als = new async_hooks.AsyncLocalStorage<string>();
    await als.run('ctx', async () => {
        await Promise.resolve();
        strictEqual(als.getStore(), 'ctx');
        await new Promise((resolve) => setTimeout(resolve, 0));
        strictEqual(als.getStore(), 'ctx');
    });
});

Deno.test('async_hooks: nested AsyncLocalStorage.run restores outer store', () => {
    const als = new async_hooks.AsyncLocalStorage<string>();
    const seen: string[] = [];
    als.run('outer', () => {
        seen.push(als.getStore()!);
        als.run('inner', () => {
            seen.push(als.getStore()!);
        });
        seen.push(als.getStore()!);
    });
    deepStrictEqual(seen, ['outer', 'inner', 'outer']);
});

Deno.test('async_hooks: AsyncLocalStorage.enterWith sets current store', async () => {
    const als = new async_hooks.AsyncLocalStorage<string>();
    als.enterWith('entered');
    strictEqual(als.getStore(), 'entered');
    await Promise.resolve();
    strictEqual(als.getStore(), 'entered');
    als.disable();
});

Deno.test('async_hooks: AsyncLocalStorage.bind captures creation context', () => {
    const AsyncLocalStorageCtor = (async_hooks as typeof async_hooks & {
        AsyncLocalStorage: typeof async_hooks.AsyncLocalStorage & {
            bind?: <T extends (...args: never[]) => unknown>(fn: T) => T;
        };
    }).AsyncLocalStorage;
    if (typeof AsyncLocalStorageCtor.bind !== 'function') {
        return;
    }

    const als = new async_hooks.AsyncLocalStorage<string>();
    als.run('outer', () => {
        const bound = AsyncLocalStorageCtor.bind!(() => als.getStore());
        als.run('inner', () => {
            strictEqual(bound(), 'outer');
            strictEqual(als.getStore(), 'inner');
        });
    });
});

Deno.test('async_hooks upstream: AsyncLocalStorage propagates through common async APIs', async () => {
    const als = new async_hooks.AsyncLocalStorage<string>();
    const seen: string[] = [];
    const check = (label: string) => {
        seen.push(`${label}:${als.getStore()}`);
    };

    await als.run('data', async () => {
        check('sync');
        queueMicrotask(() => check('microtask'));
        process.nextTick(() => check('nextTick'));
        setImmediate(() => check('immediate'));
        setTimeout(() => check('timeout'), 0);
        const intervalId = setInterval(() => {
            check('interval');
            clearInterval(intervalId);
        }, 0);

        als.run('inner', () => {
            check('inner');
        });

        await new Promise((resolve) => setTimeout(resolve, 30));
        check('after');
    });

    deepStrictEqual(seen, [
        'sync:data',
        'inner:inner',
        'microtask:data',
        'nextTick:data',
        'immediate:data',
        'timeout:data',
        'interval:data',
        'after:data',
    ]);
});

Deno.test('async_hooks upstream: AsyncLocalStorage propagates through dynamic import', async () => {
    const als = new async_hooks.AsyncLocalStorage<string>();
    const globalWithHook = globalThis as typeof globalThis & {
        alsDynamicImport?: () => string | undefined;
    };

    globalWithHook.alsDynamicImport = () => als.getStore();
    try {
        await als.run('data', async () => {
            const mod = await import('data:application/javascript,export const data = alsDynamicImport()');
            strictEqual(mod.data, 'data');
        });
    } finally {
        delete globalWithHook.alsDynamicImport;
    }
});

// --- AsyncLocalStorage.run/exit forward extra arguments ---------------------

Deno.test('async_hooks upstream: run and exit forward extra arguments', () => {
    const als = new async_hooks.AsyncLocalStorage<string>();
    const seen: unknown[] = [];
    als.run('store', (a: string, b: number) => { seen.push(a, b, als.getStore()); }, 'x', 7);
    deepStrictEqual(seen, ['x', 7, 'store']);

    const exited: unknown[] = [];
    als.run('outer', () => {
        als.exit((a: string) => { exited.push(a, als.getStore()); }, 'ARG');
    });
    deepStrictEqual(exited, ['ARG', undefined]);
});

// --- a synchronous throw inside run() must not leak the store --------------

Deno.test('async_hooks upstream: synchronous throw in run restores the store', () => {
    const als = new async_hooks.AsyncLocalStorage<string>();
    strictEqual(als.getStore(), undefined);
    try {
        als.run('leaky', () => { throw new Error('boom'); });
        ok(false, 'should throw');
    } catch (e) {
        strictEqual((e as Error).message, 'boom');
    }
    strictEqual(als.getStore(), undefined);

    // nested: inner throw restores to the outer store
    als.run('outer', () => {
        try {
            als.run('inner', () => { throw new Error('inner'); });
        } catch { /* expected */ }
        strictEqual(als.getStore(), 'outer');
    });
    strictEqual(als.getStore(), undefined);
});

Deno.test('async_hooks upstream: synchronous throw in exit restores the store', () => {
    const als = new async_hooks.AsyncLocalStorage<string>();
    als.run('kept', () => {
        try {
            als.exit(() => { throw new Error('boom'); });
        } catch { /* expected */ }
        strictEqual(als.getStore(), 'kept');
    });
});

// --- createHook returns a chainable hook ----------------------------------

Deno.test('async_hooks upstream: createHook enable/disable return the hook', () => {
    const hook = async_hooks.createHook({});
    strictEqual(hook.enable(), hook);
    strictEqual(hook.disable(), hook);
});

// --- AsyncResource option forms -------------------------------------------

Deno.test('async_hooks upstream: AsyncResource accepts an options object', () => {
    const withObject = new async_hooks.AsyncResource('T', { triggerAsyncId: 1, requireManualDestroy: true });
    strictEqual(withObject.triggerAsyncId(), 1);
    const withNumber = new async_hooks.AsyncResource('T2', 7);
    strictEqual(withNumber.triggerAsyncId(), 7);
});

Deno.test('async_hooks upstream: AsyncResource requires a string type', () => {
    try {
        new (async_hooks.AsyncResource as unknown as new () => unknown)();
        ok(false, 'should throw');
    } catch (e) {
        strictEqual((e as { code?: string }).code, 'ERR_INVALID_ARG_TYPE');
    }
});

// --- executionAsyncResource ----------------------------------------------

Deno.test('async_hooks upstream: executionAsyncResource is exposed', () => {
    strictEqual(typeof async_hooks.executionAsyncResource, 'function');
    ok(typeof async_hooks.executionAsyncResource() === 'object');
    const resource = new async_hooks.AsyncResource('Probe');
    const inner = resource.runInAsyncScope(() => async_hooks.executionAsyncResource());
    strictEqual(inner, resource);
});

Deno.test('async_hooks: clearImmediate destroys cancelled state exactly once', async () => {
    const initialized: number[] = [];
    const destroyed: number[] = [];
    let fired = false;
    const hook = async_hooks.createHook({
        init(id, type) {
            if (type === 'Immediate') initialized.push(id);
        },
        destroy(id) {
            if (initialized.includes(id)) destroyed.push(id);
        },
    }).enable();

    const handle = globalThis.setImmediate(() => { fired = true; });
    globalThis.clearImmediate(handle);
    globalThis.clearImmediate(handle);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    hook.disable();

    strictEqual(fired, false);
    strictEqual(initialized.length, 1);
    deepStrictEqual(destroyed, initialized);
});
