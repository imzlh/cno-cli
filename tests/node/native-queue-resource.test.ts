import { deepStrictEqual, strictEqual } from 'node:assert';
import { AsyncLocalStorage, AsyncResource, createHook, executionAsyncResource, triggerAsyncId } from 'node:async_hooks';
import {
    _cancelNativeQueueResource,
    _createNativeQueueResource,
    _registerNativeQueueContextFactory,
} from '../../cno/src/utils/native-queue-resource.ts';

Deno.test('native queue resource: all live async context factories wrap one callback', () => {
    const events: string[] = [];
    const disposers = ['first', 'second'].map(name => _registerNativeQueueContextFactory(() => ({
        invoke(callback, thisArg, args) {
            events.push(`${name}:before`);
            try { return Reflect.apply(callback, thisArg, args); }
            finally { events.push(`${name}:after`); }
        },
        destroy() { events.push(`${name}:destroy`); },
        release() { events.push(`${name}:release`); },
    })));
    let calls = 0;
    let resource: ReturnType<typeof _createNativeQueueResource> | undefined;
    try {
        resource = _createNativeQueueResource('multi-context-factory', () => { calls++; });
        resource.invoke(undefined, []);
        strictEqual(calls, 1, 'wrapping multiple async contexts must not repeat the callback');
        deepStrictEqual(events, [
            'first:before', 'second:before', 'second:after', 'first:after',
            'first:destroy', 'second:destroy', 'first:release', 'second:release',
        ]);
    } finally {
        resource?.destroy();
        for (const dispose of disposers) dispose();
    }
});

Deno.test('native queue resource: contexts are prepared before start and initialized before reentry', () => {
    const events: string[] = [];
    let resource!: ReturnType<typeof _createNativeQueueResource>;
    const disposers = ['first', 'second'].map(name => _registerNativeQueueContextFactory(() => {
        events.push(`${name}:prepare`);
        return {
            init() {
                events.push(`${name}:init`);
                if (name === 'first') resource.invoke(undefined, []);
                events.push(`${name}:init-return`);
            },
            invoke(callback, thisArg, args) {
                events.push(`${name}:before`);
                try { return Reflect.apply(callback, thisArg, args); }
                finally { events.push(`${name}:after`); }
            },
            destroy() { events.push(`${name}:destroy`); },
            release() { events.push(`${name}:release`); },
        };
    }));
    try {
        resource = _createNativeQueueResource('native-queue-init-reentry', () => events.push('callback'), {
            onStart(current) {
                events.push('start');
                resource = current;
            },
        });
        deepStrictEqual(events, [
            'first:prepare', 'second:prepare', 'start', 'first:init',
            'second:init', 'second:init-return', 'first:before', 'second:before',
            'callback', 'second:after', 'first:after', 'first:init-return',
            'first:destroy', 'second:destroy', 'first:release', 'second:release',
        ]);
        strictEqual(resource.destroyed, true);
    } finally {
        resource?.destroy();
        for (const dispose of disposers) dispose();
    }
});

Deno.test('native queue resource: an init error releases every context and cancels started work', () => {
    const expected = new Error('context init failed');
    const events: string[] = [];
    const disposers = ['first', 'second'].map(name => _registerNativeQueueContextFactory(() => ({
        init() {
            events.push(`${name}:init`);
            if (name === 'first') throw expected;
        },
        invoke(callback, thisArg, args) { return Reflect.apply(callback, thisArg, args); },
        destroy() { events.push(`${name}:destroy`); },
        release() { events.push(`${name}:release`); },
    })));
    let thrown: unknown;
    try {
        try {
            _createNativeQueueResource('native-queue-init-error', () => {}, {
                onStart(resource) {
                    events.push('start');
                    resource.bind(-9);
                },
                clearNative(id) { events.push(`clear:${id}`); },
            });
        } catch (error) {
            thrown = error;
        }
        strictEqual(thrown, expected);
        deepStrictEqual(events, [
            'start', 'first:init', 'clear:-9', 'first:destroy', 'second:destroy',
            'first:release', 'second:release',
        ]);
    } finally {
        for (const dispose of disposers) dispose();
    }
});

Deno.test('native queue resource: completed handles can be cancelled without retaining native ids', () => {
    const owner = {};
    let cancelled = 0;
    const completed = _createNativeQueueResource('test', () => {}, {
        refreshable: true,
        onCancel() { cancelled++; },
    });
    completed.bind(-1, owner);
    completed.invoke(undefined, []);
    strictEqual(completed.destroyed, true);

    const active = _createNativeQueueResource('test', () => {});
    active.bind(-1);
    _cancelNativeQueueResource(-1, owner);
    strictEqual(cancelled, 1);
    strictEqual(completed.refresh(), false);
    strictEqual(active.destroyed, false, 'an old handle must not cancel a reused native id');
    _cancelNativeQueueResource(-1);
    strictEqual(active.destroyed, true);
});

Deno.test('native queue resource: destroy during invoke cannot be refreshed', () => {
    let refreshed: boolean | undefined;
    let resource!: ReturnType<typeof _createNativeQueueResource>;
    resource = _createNativeQueueResource('test', () => {
        resource.destroy();
        refreshed = resource.refresh();
    }, { refreshable: true });

    resource.invoke(undefined, []);

    strictEqual(refreshed, false);
    strictEqual(resource.destroyed, true);
});

Deno.test('native queue resource: context factory errors preserve their cause', () => {
    const owner = {};
    const expected = new Error('context factory failed');
    const hook = createHook({
        init(_id, _type, _trigger, resource) {
            if (resource === owner) throw expected;
        },
    }).enable();
    try {
        let thrown: unknown;
        try {
            _createNativeQueueResource('native-queue-context-error', () => {}, { resource: owner });
        } catch (error) {
            thrown = error;
        }
        strictEqual(thrown, expected);
    } finally {
        hook.disable();
    }
});

Deno.test('native queue resource: init cancellation finds the owner before the factory returns', () => {
    const owner = {};
    const initialized: number[] = [];
    const destroyed: number[] = [];
    let cancelled = 0;
    let runs = 0;
    const hook = createHook({
        init(id, _type, _trigger, resource) {
            if (resource !== owner) return;
            initialized.push(id);
            _cancelNativeQueueResource(-2, owner);
        },
        destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
    }).enable();
    let resource: ReturnType<typeof _createNativeQueueResource> | null = null;
    try {
        resource = _createNativeQueueResource('native-queue-initial-cancel', () => runs++, {
            resource: owner,
            refreshable: true,
            onCancel() { cancelled++; },
        });
        resource.bind(-2, owner);
        resource.invoke(null, []);
        strictEqual(resource.destroyed, true);
        strictEqual(resource.refresh(), false);
        strictEqual(runs, 0);
        strictEqual(cancelled, 1);
        strictEqual(initialized.length, 1);
        deepStrictEqual(destroyed, initialized);
    } finally {
        resource?.destroy();
        hook.disable();
    }
});

Deno.test('native queue resource: completed refresh cannot undo reentrant cancellation or destruction', () => {
    for (const action of ['owner', 'cancel', 'destroy'] as const) {
        const owner = {};
        const initialized: number[] = [];
        const destroyed: number[] = [];
        let runs = 0;
        let nestedRefresh: boolean | null = null;
        let resource!: ReturnType<typeof _createNativeQueueResource>;
        const hook = createHook({
            init(id, _type, _trigger, current) {
                if (current !== owner) return;
                initialized.push(id);
                if (initialized.length !== 2) return;
                nestedRefresh = resource.refresh();
                if (action === 'owner') _cancelNativeQueueResource(-3, owner);
                else if (action === 'cancel') resource.cancel();
                else resource.destroy();
            },
            destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
        }).enable();
        try {
            resource = _createNativeQueueResource('native-queue-refresh-cancel', () => runs++, {
                resource: owner,
                refreshable: true,
            });
            resource.bind(-3, owner);
            resource.invoke(null, []);
            strictEqual(resource.refresh(), false, action);
            strictEqual(nestedRefresh, false, action);
            resource.bind(-4, owner);
            resource.invoke(null, []);
            strictEqual(resource.refresh(), false, action);
            strictEqual(resource.destroyed, true, action);
            strictEqual(runs, 1, action);
            strictEqual(initialized.length, 2, action);
            deepStrictEqual(destroyed, initialized, action);
        } finally {
            resource?.destroy();
            hook.disable();
        }
    }
});

Deno.test('native queue resource: only completed refresh captures a new store and trigger', () => {
    const storage = new AsyncLocalStorage<string>();
    const firstScope = new AsyncResource('native-queue-first-scope');
    const nextScope = new AsyncResource('native-queue-next-scope');
    const owner = {};
    const initialized: number[] = [];
    const destroyed: number[] = [];
    const observed: unknown[][] = [];
    const hook = createHook({
        init(id, _type, _trigger, current) { if (current === owner) initialized.push(id); },
        destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
    }).enable();
    let resource!: ReturnType<typeof _createNativeQueueResource>;
    try {
        firstScope.runInAsyncScope(() => storage.run('first', () => {
            resource = _createNativeQueueResource('native-queue-capture', () => {
                observed.push([storage.getStore(), triggerAsyncId(), executionAsyncResource()]);
            }, { resource: owner, refreshable: true });
        }));
        resource.bind(-5, owner);
        nextScope.runInAsyncScope(() => storage.run('active-refresh', () => {
            strictEqual(resource.refresh(), true);
        }));
        strictEqual(initialized.length, 1);
        resource.invoke(null, []);
        nextScope.runInAsyncScope(() => storage.run('completed-refresh', () => {
            strictEqual(resource.refresh(), true);
        }));
        resource.bind(-6, owner);
        _cancelNativeQueueResource(-5);
        strictEqual(resource.destroyed, false, 'a completed numeric alias must not cancel the next lifetime');
        resource.invoke(null, []);
        deepStrictEqual(observed, [
            ['first', firstScope.asyncId(), owner],
            ['completed-refresh', nextScope.asyncId(), owner],
        ]);
        strictEqual(initialized.length, 2);
        deepStrictEqual(destroyed, initialized);
    } finally {
        resource?.destroy();
        hook.disable();
        firstScope.emitDestroy();
        nextScope.emitDestroy();
        storage.disable();
    }
});

Deno.test('native queue resource: destroy hook refresh keeps the new context and registry', () => {
    for (const action of ['refresh', 'cancel', 'destroy'] as const) {
        const owner = {};
        const initialized: number[] = [];
        const destroyed: number[] = [];
        const observed: object[] = [];
        let refreshed: boolean | null = null;
        let resource!: ReturnType<typeof _createNativeQueueResource>;
        const hook = createHook({
            init(id, _type, _trigger, current) { if (current === owner) initialized.push(id); },
            destroy(id) {
                if (!initialized.includes(id)) return;
                destroyed.push(id);
                if (id !== initialized[0]) return;
                refreshed = resource.refresh();
                resource.bind(-8, owner);
                if (action === 'cancel') _cancelNativeQueueResource(-8);
                else if (action === 'destroy') resource.destroy();
            },
        }).enable();
        try {
            resource = _createNativeQueueResource('native-queue-destroy-refresh', () => {
                observed.push(executionAsyncResource());
            }, { resource: owner, refreshable: true });
            resource.bind(-7, owner);
            resource.invoke(null, []);
            strictEqual(refreshed, true, action);
            strictEqual(resource.destroyed, action !== 'refresh', action);
            _cancelNativeQueueResource(-7);
            resource.invoke(null, []);
            strictEqual(observed.length, action === 'refresh' ? 2 : 1, action);
            for (const current of observed) strictEqual(current, owner, action);
            strictEqual(initialized.length, 2, action);
            deepStrictEqual(destroyed, initialized, action);
            if (action !== 'refresh') strictEqual(resource.refresh(), false, action);
        } finally {
            resource?.destroy();
            hook.disable();
        }
    }
});
