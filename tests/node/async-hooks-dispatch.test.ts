import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { AsyncLocalStorage, AsyncResource, createHook, executionAsyncId } from 'node:async_hooks';
import * as timers from 'node:timers';

Deno.test('async_hooks: hooks sharing callbacks have independent registrations', () => {
    const calls: string[] = [];
    let resourceId = 0;
    const callbacks = {
        init(id: number, type: string) {
            if (type !== 'shared-callbacks') return;
            resourceId = id;
            calls.push('init');
        },
        before(id: number) { if (id === resourceId) calls.push('before'); },
        after(id: number) { if (id === resourceId) calls.push('after'); },
    };
    const first = createHook(callbacks).enable();
    const second = createHook(callbacks).enable();
    try {
        first.enable();
        const resource = new AsyncResource('shared-callbacks');
        resource.runInAsyncScope(() => {});
        first.disable();
        resource.runInAsyncScope(() => {});
        first.enable();
        resource.runInAsyncScope(() => {});
        deepStrictEqual(calls, [
            'init', 'init',
            'before', 'before', 'after', 'after',
            'before', 'after',
            'before', 'before', 'after', 'after',
        ]);
        resource.emitDestroy();
    } finally {
        first.disable();
        second.disable();
    }
});

Deno.test('async_hooks: callbacks are captured and validated when the hook is created', () => {
    const calls: string[] = [];
    const callbacks = {
        init(_id: number, type: string) { if (type === 'captured-callback') calls.push('original'); },
    };
    const hook = createHook(callbacks);
    callbacks.init = (_id, type) => { if (type === 'captured-callback') calls.push('changed'); };
    hook.enable();
    try {
        new AsyncResource('captured-callback').emitDestroy();
        deepStrictEqual(calls, ['original']);
    } finally {
        hook.disable();
    }
    for (const name of ['init', 'before', 'after', 'destroy', 'promiseResolve']) {
        throws(() => createHook({ [name]: null }), {
            name: 'TypeError',
            code: 'ERR_ASYNC_CALLBACK',
            message: `hook.${name} must be a function`,
        });
    }
});

Deno.test('async_hooks: late enable and disable apply to existing resources', () => {
    const resource = new AsyncResource('late-enable');
    const id = resource.asyncId();
    const calls: string[] = [];
    const hook = createHook({
        init(current) { if (current === id) calls.push('init'); },
        before(current) { if (current === id) calls.push('before'); },
        after(current) { if (current === id) calls.push('after'); },
    }).enable();
    try {
        resource.runInAsyncScope(() => {});
        hook.disable();
        resource.runInAsyncScope(() => {});
        hook.enable();
        resource.runInAsyncScope(() => {});
        deepStrictEqual(calls, ['before', 'after', 'before', 'after']);
    } finally {
        hook.disable();
        resource.emitDestroy();
    }
});

Deno.test('async_hooks: late hooks observe queued timer execution and cancellation', async () => {
    const calls: string[] = [];
    let activeId = 0;
    const cancelled = timers.setTimeout(() => {}, 60_000);
    const completed = new Promise<void>(resolve => timers.setTimeout(() => {
        activeId = executionAsyncId();
        resolve();
    }, 1));
    const hook = createHook({
        init(_id, type) { if (type === 'Timeout') calls.push('init'); },
        before() { calls.push('before'); },
        after() { calls.push('after'); },
        destroy(id) { calls.push(id === activeId ? 'completed' : 'cancelled'); },
    }).enable();
    try {
        timers.clearTimeout(cancelled);
        await completed;
        hook.disable();
        deepStrictEqual(calls, ['cancelled', 'before', 'after', 'completed']);
    } finally {
        timers.clearTimeout(cancelled);
        hook.disable();
    }
});

Deno.test('async_hooks: microtasks capture context without patching the global function', async () => {
    const queue = globalThis.queueMicrotask;
    const storage = new AsyncLocalStorage<string>();
    const events = new Map<number, string[]>();
    const hook = createHook({
        init(id, type) { if (type === 'Microtask') events.set(id, ['init']); },
        before(id) { events.get(id)?.push('before'); },
        after(id) { events.get(id)?.push('after'); },
        destroy(id) { events.get(id)?.push('destroy'); },
        promiseResolve(id) { events.get(id)?.push('promiseResolve'); },
    }).enable();
    try {
        strictEqual(globalThis.queueMicrotask, queue);
        const seen: Array<string | undefined> = [];
        await new Promise<void>(resolve => {
            storage.run('first', () => queue(() => { seen.push(storage.getStore()); }));
            storage.run('second', () => queue(() => { seen.push(storage.getStore()); resolve(); }));
        });
        deepStrictEqual(seen, ['first', 'second']);
        strictEqual(events.size, 2);
        for (const values of events.values()) deepStrictEqual(values, ['init', 'before', 'after', 'destroy']);
    } finally {
        hook.disable();
        storage.disable();
    }
});

Deno.test('async_hooks: hook changes do not skip callbacks in the current dispatch', () => {
    const calls: string[] = [];
    let resourceId = 0;
    let first!: ReturnType<typeof createHook>;
    const second = createHook({
        init(id, type) {
            if (type === 'dispatch-snapshot') {
                resourceId = id;
                calls.push('init-second');
            }
        },
        before(id) { if (id === resourceId) calls.push('before-second'); },
        after(id) { if (id === resourceId) calls.push('after-second'); },
    });
    first = createHook({
        init(id, type) {
            if (type === 'dispatch-snapshot') {
                resourceId = id;
                calls.push('init-first');
            }
        },
        before(id) {
            if (id !== resourceId) return;
            calls.push('before-first');
            first.disable();
        },
        after(id) { if (id === resourceId) calls.push('after-first'); },
    });

    first.enable();
    second.enable();
    try {
        new AsyncResource('dispatch-snapshot').runInAsyncScope(() => {});
        deepStrictEqual(calls, [
            'init-first', 'init-second',
            'before-first', 'before-second',
            'after-second',
        ]);
    } finally {
        first.disable();
        second.disable();
    }
});

Deno.test('async_hooks: before and after hook errors restore the current async state', () => {
    const resource = new AsyncResource('hook-error');
    const resourceId = resource.asyncId();
    const previousId = executionAsyncId();
    let failAt: 'before' | 'after' = 'before';
    const hook = createHook({
        before(id) {
            if (id === resourceId && failAt === 'before') throw new Error('before failed');
        },
        after(id) {
            if (id === resourceId && failAt === 'after') throw new Error('after failed');
        },
    }).enable();

    try {
        let beforeError: unknown;
        try {
            resource.runInAsyncScope(() => {});
        } catch (error) {
            beforeError = error;
        }
        strictEqual((beforeError as Error)?.message, 'before failed');
        strictEqual(executionAsyncId(), previousId);

        failAt = 'after';
        let afterError: unknown;
        try {
            resource.runInAsyncScope(() => {});
        } catch (error) {
            afterError = error;
        }
        strictEqual((afterError as Error)?.message, 'after failed');
        strictEqual(executionAsyncId(), previousId);
    } finally {
        hook.disable();
        resource.emitDestroy();
    }
});
