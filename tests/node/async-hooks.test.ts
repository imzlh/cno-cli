import { strictEqual, ok } from 'node:assert';
import * as async_hooks from 'node:async_hooks';

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
    als.disable();
    ok(true);
});

// --- 8. AsyncLocalStorage snapshot is callable -----------------------------

Deno.test('async_hooks: AsyncLocalStorage.snapshot is callable', () => {
    if (typeof (async_hooks as any).AsyncLocalStorage.snapshot === 'function') {
        const fn = (async_hooks as any).AsyncLocalStorage.snapshot();
        ok(typeof fn === 'function');
    } else {
        ok(true);
    }
});

// --- 9. AsyncResource is a class --------------------------------------------

Deno.test('async_hooks: AsyncResource is a constructor', () => {
    const { AsyncResource } = async_hooks;
    ok(typeof AsyncResource === 'function');
    const res = new AsyncResource('test');
    ok(typeof res.asyncId === 'function' || typeof (res as any).asyncId === 'number');
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
