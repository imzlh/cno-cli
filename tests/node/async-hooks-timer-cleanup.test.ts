import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { AsyncLocalStorage, AsyncResource, createHook, executionAsyncId, executionAsyncResource } from 'node:async_hooks';
import * as timers from 'node:timers';
import * as timersPromises from 'node:timers/promises';
import { nextTick } from 'node:process';
import { promisify } from 'node:util';

const engine = import.meta.use('engine');
const nativeTimers = import.meta.use('timers');
const os = import.meta.use('os');

type GlobalTimer = ReturnType<typeof setTimeout> & {
    close(): unknown;
    refresh(): unknown;
    [Symbol.dispose](): void;
};

Deno.test('async_hooks: global and module timers expose their handle as the async resource', async () => {
    const initialized = new Map<number, object>();
    const hook = createHook({
        init(id, type, _trigger, resource) {
            if (type === 'Timeout' || type === 'Interval' || type === 'Immediate') initialized.set(id, resource);
        },
    }).enable();
    try {
        for (const make of [globalThis, timers]) {
            for (const kind of ['timeout', 'interval', 'immediate'] as const) {
                let handle: unknown;
                const observed = await new Promise<{ current: object; initial: object | undefined }>(resolve => {
                    const callback = () => {
                        resolve({ current: executionAsyncResource(), initial: initialized.get(executionAsyncId()) });
                        if (kind === 'interval') timers.clearInterval(handle as NodeJS.Timeout);
                    };
                    handle = kind === 'immediate' ? make.setImmediate(callback)
                        : kind === 'interval' ? make.setInterval(callback, 1)
                        : make.setTimeout(callback, 1);
                });
                strictEqual(observed.current, handle!);
                strictEqual(observed.initial, handle!);
            }
        }
    } finally {
        hook.disable();
    }
});

Deno.test('async_hooks: every timer cancellation path destroys its resource once', () => {
    const initialized: number[] = [];
    const destroyed: number[] = [];
    const hook = createHook({
        init(id, type) { if (type === 'Timeout' || type === 'Interval' || type === 'Immediate') initialized.push(id); },
        destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
    }).enable();
    try {
        const byId = setTimeout(() => {}, 60_000);
        clearTimeout(Number(byId));
        const byModule = setTimeout(() => {}, 60_000);
        timers.clearTimeout(byModule as unknown as NodeJS.Timeout);
        const byClose = setTimeout(() => {}, 60_000) as GlobalTimer;
        byClose.close();
        byClose.close();
        const byDispose = setTimeout(() => {}, 60_000) as GlobalTimer;
        byDispose[Symbol.dispose]();
        const interval = setInterval(() => {}, 60_000);
        timers.clearInterval(interval as unknown as NodeJS.Timeout);
        const immediate = setImmediate(() => {});
        timers.clearImmediate(immediate as unknown as NodeJS.Immediate);
        const moduleTimeout = timers.setTimeout(() => {}, 60_000);
        timers.clearTimeout(moduleTimeout);
        const moduleImmediate = timers.setImmediate(() => {});
        timers.clearImmediate(moduleImmediate);
        strictEqual(initialized.length, 8);
        deepStrictEqual(destroyed, initialized);
    } finally {
        hook.disable();
    }
});

Deno.test('async_hooks: init hooks can cancel a timer before its constructor returns', async () => {
    for (const make of [globalThis, timers]) {
        for (const kind of ['timeout', 'interval', 'immediate'] as const) {
            for (const cancel of ['clear', 'numeric', 'close'] as const) {
                const initialized: number[] = [];
                const destroyed: number[] = [];
                let runs = 0;
                const hook = createHook({
                    init(id, type, _trigger, resource) {
                        if (type !== 'Timeout' && type !== 'Interval' && type !== 'Immediate') return;
                        initialized.push(id);
                        if (cancel === 'close') (resource as { close(): void }).close();
                        else if (kind === 'immediate') clearImmediate(cancel === 'numeric'
                            ? Number(resource) as unknown as NodeJS.Immediate : resource as NodeJS.Immediate);
                        else clearTimeout(cancel === 'numeric'
                            ? Number(resource) as unknown as GlobalTimer : resource as GlobalTimer);
                    },
                    destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
                }).enable();
                let handle: { close(): unknown } | undefined;
                try {
                    handle = (kind === 'immediate' ? make.setImmediate(() => runs++)
                        : kind === 'interval' ? make.setInterval(() => runs++, 1)
                        : make.setTimeout(() => runs++, 1)) as { close(): unknown };
                    strictEqual(initialized.length, 1);
                    deepStrictEqual(destroyed, initialized);
                } finally {
                    hook.disable();
                    handle?.close();
                }
                await new Promise<void>(resolve => nativeTimers.setTimeout(resolve, 10));
                strictEqual(runs, 0);
            }
        }
    }
});

Deno.test('async_hooks: timer callbacks can reenter init with complete handles and contexts', async () => {
    for (const make of [globalThis, timers]) {
        for (const kind of ['timeout', 'interval', 'immediate'] as const) {
            const storage = new AsyncLocalStorage<string>();
            const events: string[] = [];
            const observed: unknown[][] = [];
            let asyncId: number | undefined;
            let resource: unknown;
            let handle: { close(): unknown; refresh(): unknown } | undefined;
            const hook = createHook({
                init(id, type, _trigger, current) {
                    if (type !== 'Timeout' && type !== 'Interval' && type !== 'Immediate') return;
                    asyncId = id;
                    resource = current;
                    events.push('init');
                    engine.waitIO(new Promise<void>(resolve => nativeTimers.setTimeout(resolve, 10)));
                    events.push('init-return');
                },
                before(id) { if (id === asyncId) events.push('before'); },
                after(id) { if (id === asyncId) events.push('after'); },
                destroy(id) { if (id === asyncId) events.push('destroy'); },
            }).enable();
            try {
                storage.run('captured', () => {
                    const callback = () => {
                        events.push('callback');
                        observed.push([storage.getStore(), executionAsyncId(), executionAsyncResource()]);
                        if (kind === 'interval') (resource as { close(): void }).close();
                        else if (kind === 'timeout' && observed.length === 1) {
                            (resource as { refresh(): void }).refresh();
                        }
                    };
                    handle = (kind === 'immediate' ? make.setImmediate(callback)
                        : kind === 'interval' ? make.setInterval(callback, 1)
                        : make.setTimeout(callback, 1)) as unknown as typeof handle;
                });
                await new Promise<void>(resolve => nativeTimers.setTimeout(resolve, 10));
                strictEqual(observed.length, kind === 'timeout' ? 2 : 1);
                for (const entry of observed) deepStrictEqual(entry, ['captured', asyncId, handle]);
                strictEqual(resource, handle);
                strictEqual(events.filter(event => event === 'destroy').length, 1);
                ok(events.indexOf('callback') < events.indexOf('init-return'));
                for (let index = 0; index < events.length; index++) {
                    if (events[index] !== 'callback') continue;
                    strictEqual(events[index - 1], 'before');
                    strictEqual(events[index + 1], 'after');
                }
            } finally {
                hook.disable();
                handle?.close();
                storage.disable();
            }
        }
    }
});

Deno.test('async_hooks: completed timer refresh starts before publishing its new init', async () => {
    for (const make of [globalThis, timers]) {
        const storage = new AsyncLocalStorage<string>();
        const initialized: number[] = [];
        const destroyed: number[] = [];
        const observed: unknown[][] = [];
        const hook = createHook({
            init(id, type) {
                if (type !== 'Timeout') return;
                initialized.push(id);
                if (initialized.length === 2) {
                    engine.waitIO(new Promise<void>(resolve => nativeTimers.setTimeout(resolve, 10)));
                    strictEqual(observed.length, 2);
                }
            },
            destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
        }).enable();
        let handle: { close(): unknown; refresh(): unknown } | undefined;
        try {
            storage.run('initial', () => {
                handle = make.setTimeout(() => {
                    observed.push([storage.getStore(), executionAsyncId(), executionAsyncResource()]);
                }, 1) as unknown as typeof handle;
            });
            await new Promise<void>(resolve => nativeTimers.setTimeout(resolve, 10));
            storage.run('refreshed', () => handle!.refresh());
            strictEqual(observed.length, 2);
            deepStrictEqual(observed, [
                ['initial', initialized[0], handle],
                ['refreshed', initialized[1], handle],
            ]);
            deepStrictEqual(destroyed, initialized);
        } finally {
            hook.disable();
            handle?.close();
            storage.disable();
        }
    }
});

Deno.test('async_hooks: global and module clear release native timers when destroy throws', () => {
    const failure = new Error('destroy hook failed');
    const operations = [
        [setTimeout, clearTimeout],
        [setInterval, clearInterval],
        [timers.setTimeout, timers.clearTimeout],
        [timers.setInterval, timers.clearInterval],
    ] as const;
    for (const [schedule, clear] of operations) {
        let timerResourceId: number | undefined;
        const hook = createHook({
            init(id, type) { if (type === 'Timeout' || type === 'Interval') timerResourceId = id; },
            destroy(id) { if (id === timerResourceId) throw failure; },
        }).enable();
        let nativeId: number | undefined;
        try {
            const handle = schedule(() => {}, 60_000);
            nativeId = Number(handle);
            throws(() => clear(handle), error => error === failure);
            throws(() => nativeTimers.hasRef(Number(handle)), /timer not found/);
        } finally {
            hook.disable();
            if (nativeId !== undefined) nativeTimers.clearTimeout(nativeId);
        }
    }
});

Deno.test('async_hooks: timers/promises abort settles when destroy throws', async () => {
    const failure = new Error('destroy hook failed');
    let onAbort!: () => void;
    let timerAsyncId: number | undefined;
    let timerHandle: NodeJS.Timeout | undefined;
    const signal = {
        aborted: false,
        reason: undefined,
        addEventListener(_type: string, listener: () => void) { onAbort = listener; },
        removeEventListener() { onAbort = undefined as unknown as () => void; },
    } as AbortSignal;
    const hook = createHook({
        init(id, type, _trigger, resource) {
            if (type === 'Timeout') {
                timerAsyncId = id;
                timerHandle = resource as NodeJS.Timeout;
            }
        },
        destroy(id) { if (id === timerAsyncId) throw failure; },
    }).enable();
    try {
        const promise = timersPromises.setTimeout(60_000, 'unused', { signal });
        ok(timerAsyncId !== undefined);
        ok(timerHandle !== undefined);
        throws(() => onAbort(), error => error === failure);
        await rejects(promise, error => error instanceof Error && error.name === 'AbortError');
        throws(() => nativeTimers.hasRef(Number(timerHandle)), /timer not found/);
    } finally {
        hook.disable();
        if (timerHandle !== undefined) nativeTimers.clearTimeout(Number(timerHandle));
    }
});

Deno.test('async_hooks: module timers and nextTick own one resource and capture ALS', async () => {
    const als = new AsyncLocalStorage<string>();
    const resources = new Map<number, string>();
    const events = new Map<number, string[]>();
    const observed: number[] = [];
    const hook = createHook({
        init(id, type) {
            if (type === 'TickObject' || type === 'Timeout' || type === 'Immediate') {
                resources.set(id, type);
                events.set(id, ['init']);
            }
        },
        before(id) { events.get(id)?.push('before'); },
        after(id) { events.get(id)?.push('after'); },
        destroy(id) { events.get(id)?.push('destroy'); },
    }).enable();

    try {
        await new Promise<void>((resolve, reject) => {
            als.run('tick', () => nextTick(() => {
                try {
                    strictEqual(als.getStore(), 'tick');
                    observed.push(executionAsyncId());
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }));
        });

        await new Promise<void>((resolve, reject) => {
            als.run('timer', () => timers.setTimeout(() => {
                try {
                    strictEqual(als.getStore(), 'timer');
                    observed.push(executionAsyncId());
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }, 1));
        });

        await new Promise<void>((resolve, reject) => {
            als.run('global-timer', () => setTimeout(() => {
                try {
                    strictEqual(als.getStore(), 'global-timer');
                    observed.push(executionAsyncId());
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }, 1));
        });

        await new Promise<void>((resolve, reject) => {
            als.run('immediate', () => timers.setImmediate(() => {
                try {
                    strictEqual(als.getStore(), 'immediate');
                    observed.push(executionAsyncId());
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }));
        });

        await new Promise<void>((resolve, reject) => {
            als.run('global-immediate', () => setImmediate(() => {
                try {
                    strictEqual(als.getStore(), 'global-immediate');
                    observed.push(executionAsyncId());
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }));
        });

        let promiseTimer!: Promise<string>;
        const beforePromiseTimer = new Set(resources.keys());
        als.run('promise-immediate', () => { promiseTimer = timersPromises.setImmediate('ok'); });
        const promiseTimerId = [...resources.keys()].find(id => !beforePromiseTimer.has(id) && resources.get(id) === 'Immediate');
        ok(promiseTimerId !== undefined, 'timers/promises did not create an Immediate resource');
        strictEqual(await promiseTimer, 'ok');
        observed.push(promiseTimerId);

        strictEqual(new Set(observed).size, 6, 'each callback must have its own async resource');
        for (const id of observed) {
            deepStrictEqual(events.get(id), ['init', 'before', 'after', 'destroy'], `${resources.get(id)} ${id}`);
        }
        deepStrictEqual(observed.map(id => resources.get(id)), [
            'TickObject', 'Timeout', 'Timeout', 'Immediate', 'Immediate', 'Immediate',
        ]);
    } finally {
        hook.disable();
        als.disable();
    }
});

Deno.test('async_hooks: global setTimeout promisify owns and destroys its Timeout resource', async () => {
    const events = new Map<number, string[]>();
    const hook = createHook({
        init(id, type) { if (type === 'Timeout') events.set(id, ['init']); },
        before(id) { events.get(id)?.push('before'); },
        after(id) { events.get(id)?.push('after'); },
        destroy(id) { events.get(id)?.push('destroy'); },
    }).enable();
    try {
        const promisify = Reflect.get(globalThis.setTimeout, '__promisify__') as
            (delay: number, value: string, options?: { signal?: AbortSignal }) => Promise<string>;
        const before = new Set(events.keys());
        strictEqual(await promisify(1, 'ok'), 'ok');
        const id = [...events.keys()].find(candidate => !before.has(candidate));
        ok(id !== undefined, 'global setTimeout.__promisify__ did not create a Timeout resource');
        deepStrictEqual(events.get(id), ['init', 'before', 'after', 'destroy']);

        const controller = new AbortController();
        const beforeAbort = new Set(events.keys());
        const aborted = promisify(60_000, 'unused', { signal: controller.signal });
        const abortedId = [...events.keys()].find(candidate => !beforeAbort.has(candidate));
        ok(abortedId !== undefined, 'aborted promisify did not create a Timeout resource');
        controller.abort();
        try {
            await aborted;
            throw new Error('aborted promisify resolved');
        } catch (error) {
            strictEqual((error as Error).name, 'AbortError');
        }
        deepStrictEqual(events.get(abortedId), ['init', 'destroy']);
    } finally {
        hook.disable();
    }
});

Deno.test('async_hooks: timers/promises observes abort during resource init', async () => {
    for (const type of ['Timeout', 'Immediate'] as const) {
        const controller = new AbortController();
        const events: number[] = [];
        const hook = createHook({
            init(id, resourceType) {
                if (resourceType === type) {
                    events.push(id);
                    controller.abort('during init');
                }
            },
        }).enable();
        try {
            const promise = type === 'Timeout'
                ? timersPromises.setTimeout(60_000, 'unused', { signal: controller.signal })
                : timersPromises.setImmediate('unused', { signal: controller.signal });
            let error: unknown;
            try {
                await promise;
            } catch (caught) {
                error = caught;
            }
            ok(events.length > 0, `${type} promise did not create an async resource`);
            strictEqual((error as Error)?.name, 'AbortError', `${type} must reject when init aborts`);
        } finally {
            hook.disable();
        }
    }
});

Deno.test('async_hooks: promisified global setTimeout observes abort during init', async () => {
    const delay = promisify(globalThis.setTimeout);
    const controller = new AbortController();
    const reason = new Error('during Timeout init');
    const initialized: number[] = [];
    const destroyed: number[] = [];
    const hook = createHook({
        init(id, type) {
            if (type === 'Timeout') {
                initialized.push(id);
                controller.abort(reason);
            }
        },
        destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
    }).enable();
    try {
        await rejects(delay(1, 'unused', { signal: controller.signal }), error => error === reason);
        strictEqual(initialized.length, 1);
        deepStrictEqual(destroyed, initialized);
    } finally {
        hook.disable();
    }
});

Deno.test('async_hooks: canceled timers release request stores after GC', () => {
    const als = new AsyncLocalStorage<Uint8Array>();
    const retained: unknown[] = [];
    const hook = createHook({}).enable();
    try {
        engine.gc.run();
        const before = os.memoryUsage()['vm.used'];
        for (let i = 0; i < 128; i++) {
            als.run(new Uint8Array(64 * 1024), () => {
                const handle = (i % 2 === 0
                    ? setTimeout(() => {}, 60_000, new Uint8Array(64 * 1024))
                    : timers.setTimeout(() => {}, 60_000, new Uint8Array(64 * 1024))) as GlobalTimer;
                retained.push(handle);
                if (i % 2 === 0) handle.close();
                else timers.clearTimeout(handle as unknown as NodeJS.Timeout);
            });
        }
        engine.gc.run();
        const growth = os.memoryUsage()['vm.used'] - before;
        ok(growth < 2 * 1024 * 1024, `canceled timer stores retained ${growth} bytes`);
    } finally {
        hook.disable();
        als.disable();
    }
});

Deno.test('async_hooks: refresh preserves tracking until the last timer callback', async () => {
    const initialized: number[] = [];
    const destroyed: number[] = [];
    const hook = createHook({
        init(id, type) { if (type === 'Timeout') initialized.push(id); },
        destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
    }).enable();
    let count = 0;
    let handle: GlobalTimer | undefined;
    let deadline: number | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            deadline = nativeTimers.setTimeout(() => reject(new Error('refreshed timer did not fire')), 1000);
            handle = setTimeout(() => {
                if (++count === 1) handle!.refresh();
                else resolve();
            }, 1) as GlobalTimer;
            handle.refresh();
            strictEqual(destroyed.length, 0, 'refresh is not cancellation');
        });
        strictEqual(count, 2);
        deepStrictEqual(destroyed, initialized);
    } finally {
        if (deadline !== undefined) nativeTimers.clearTimeout(deadline);
        handle?.close();
        hook.disable();
    }
});

Deno.test('async_hooks: refreshing an already fired timer creates a new lifetime', async () => {
    const initialized: number[] = [];
    const destroyed: number[] = [];
    const hook = createHook({
        init(id, type) { if (type === 'Timeout') initialized.push(id); },
        destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
    }).enable();
    let handle: GlobalTimer | undefined;
    let deadline: number | undefined;
    try {
        let complete: () => void;
        const first = new Promise<void>(resolve => { complete = resolve; });
        handle = setTimeout(() => complete(), 1) as GlobalTimer;
        await first;
        deepStrictEqual(destroyed, initialized);
        strictEqual(initialized.length, 1);
        await new Promise<void>((resolve, reject) => {
            deadline = nativeTimers.setTimeout(() => reject(new Error('refreshed timer did not fire')), 1000);
            complete = resolve;
            handle!.refresh();
            strictEqual(initialized.length, 2);
            strictEqual(destroyed.length, 1);
        });
        deepStrictEqual(destroyed, initialized);
        ok(initialized[0] !== initialized[1], 'a timer rearmed after destruction gets a new async id');
    } finally {
        if (deadline !== undefined) nativeTimers.clearTimeout(deadline);
        handle?.close();
        hook.disable();
    }
});

Deno.test('async_hooks: completed refresh captures its new store and trigger', async () => {
    const als = new AsyncLocalStorage<string>();
    const initialized = new Map<number, number>();
    const hook = createHook({
        init(id, type, trigger) { if (type === 'Timeout') initialized.set(id, trigger); },
    }).enable();
    try {
        for (const make of [globalThis.setTimeout, timers.setTimeout]) {
            const observed: { store: string | undefined; id: number; trigger: number | undefined }[] = [];
            let notify!: () => void;
            let handle!: GlobalTimer;
            const callback = () => {
                const id = executionAsyncId();
                observed.push({ store: als.getStore(), id, trigger: initialized.get(id) });
                notify();
            };
            await new Promise<void>(resolve => {
                notify = resolve;
                als.run('initial', () => { handle = make(callback, 1) as GlobalTimer; });
            });
            const source = new AsyncResource('refresh-source');
            let trigger!: number;
            try {
                await new Promise<void>(resolve => {
                    notify = resolve;
                    source.runInAsyncScope(() => als.run('refreshed', () => {
                        trigger = executionAsyncId();
                        handle.refresh();
                    }));
                });
                deepStrictEqual(observed.map(value => value.store), ['initial', 'refreshed']);
                strictEqual(observed[1]!.trigger, trigger);
                ok(observed[0]!.id !== observed[1]!.id);
            } finally {
                handle.close();
                source.emitDestroy();
            }
        }
    } finally {
        hook.disable();
        als.disable();
    }
});

Deno.test('async_hooks: a refreshed interval releases its current native id on cancellation', async () => {
    const initialized: number[] = [];
    const destroyed: number[] = [];
    const hook = createHook({
        init(id, type) { if (type === 'Interval') initialized.push(id); },
        destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
    }).enable();
    let handle: GlobalTimer | undefined;
    let deadline: number | undefined;
    let count = 0;
    try {
        await new Promise<void>((resolve, reject) => {
            deadline = nativeTimers.setTimeout(() => reject(new Error('refreshed interval did not fire')), 1000);
            handle = setInterval(() => {
                if (++count === 1) handle!.refresh();
                else {
                    timers.clearInterval(Number(handle));
                    resolve();
                }
            }, 1) as GlobalTimer;
            handle.refresh();
            strictEqual(destroyed.length, 0);
        });
        strictEqual(count, 2);
        strictEqual(initialized.length, 1);
        deepStrictEqual(destroyed, initialized);
    } finally {
        if (deadline !== undefined) nativeTimers.clearTimeout(deadline);
        handle?.close();
        hook.disable();
    }
});
