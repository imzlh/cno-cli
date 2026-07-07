import { strictEqual, ok, throws } from 'node:assert';
import {
    EventEmitter,
    EventEmitterAsyncResource,
    addAbortListener,
    captureRejectionSymbol,
    errorMonitor,
    getEventListeners,
    getMaxListeners,
    listenerCount,
    on,
    once,
    setMaxListeners,
} from 'node:events';

// --- 1. once() fires exactly once -------------------------------------------

Deno.test('events: once fires exactly once', () => {
    const ee = new EventEmitter();
    let n = 0;
    ee.once('e', () => { n++; });
    ee.emit('e');
    ee.emit('e');
    ee.emit('e');
    strictEqual(n, 1);
});

// --- 2. prependListener runs before normal listeners ------------------------

Deno.test('events: prependListener runs first', () => {
    const ee = new EventEmitter();
    const order: string[] = [];
    ee.on('e', () => order.push('a'));
    ee.prependListener('e', () => order.push('b'));
    ee.emit('e');
    strictEqual(order.join(','), 'b,a');
});

// --- 3. prependOnceListener runs first and only once ------------------------

Deno.test('events: prependOnceListener runs first and once', () => {
    const ee = new EventEmitter();
    const order: string[] = [];
    ee.on('e', () => order.push('a'));
    ee.prependOnceListener('e', () => order.push('b'));
    ee.emit('e');
    ee.emit('e');
    strictEqual(order.join(','), 'b,a,a');
});

// --- 4. removeListener removes a specific listener --------------------------

Deno.test('events: removeListener removes only the matching listener', () => {
    const ee = new EventEmitter();
    const a = () => {};
    const b = () => {};
    ee.on('e', a);
    ee.on('e', b);
    strictEqual(ee.listenerCount('e'), 2);
    ee.removeListener('e', a);
    strictEqual(ee.listenerCount('e'), 1);
    ok(ee.listeners('e').includes(b));
    ok(!ee.listeners('e').includes(a));
});

// --- 5. removeAllListeners clears all events --------------------------------

Deno.test('events: removeAllListeners clears all events', () => {
    const ee = new EventEmitter();
    ee.on('a', () => {});
    ee.on('b', () => {});
    ee.removeAllListeners();
    strictEqual(ee.listenerCount('a'), 0);
    strictEqual(ee.listenerCount('b'), 0);
});

// --- 6. setMaxListeners / getMaxListeners -----------------------------------

Deno.test('events: setMaxListeners updates the limit', () => {
    const ee = new EventEmitter();
    ee.setMaxListeners(25);
    strictEqual(ee.getMaxListeners(), 25);
});

// --- 7. defaultMaxListeners is 10 -------------------------------------------

Deno.test('events: defaultMaxListeners is 10', () => {
    strictEqual(EventEmitter.defaultMaxListeners, 10);
});

// --- 8. emit returns true when listeners exist, false otherwise -------------

Deno.test('events: emit returns boolean indicating listeners', () => {
    const ee = new EventEmitter();
    strictEqual(ee.emit('x'), false);
    ee.on('x', () => {});
    strictEqual(ee.emit('x'), true);
});

// --- 9. on() async iterator yields events -----------------------------------

Deno.test('events: on() async iterator yields events', async () => {
    const ee = new EventEmitter();
    const collected: number[] = [];
    const ac = new AbortController();
    setTimeout(() => {
        ee.emit('data', 1);
        ee.emit('data', 2);
        ac.abort();
    }, 10);
    try {
        for await (const [value] of on(ee, 'data', { signal: ac.signal })) {
            collected.push(value as number);
        }
    } catch (err: any) {
        strictEqual(err?.name, 'AbortError');
    }
    strictEqual(collected.join(','), '1,2');
});

// --- 10. on() yields full argument arrays and cleans up on return -----------

Deno.test('events: on() async iterator preserves all event arguments', async () => {
    const ee = new EventEmitter();
    const iter = on(ee, 'data');
    ee.emit('data', 1, 2);
    ee.emit('data', 'x');

    const first = await iter.next();
    ok(Array.isArray(first.value));
    strictEqual(first.done, false);
    strictEqual(first.value[0], 1);
    strictEqual(first.value[1], 2);

    const second = await iter.next();
    ok(Array.isArray(second.value));
    strictEqual(second.done, false);
    strictEqual(second.value[0], 'x');
    strictEqual(second.value.length, 1);

    await iter.return?.();
    strictEqual(ee.listenerCount('data'), 0);
    strictEqual(ee.listenerCount('error'), 0);
});

// --- 11. once() promise resolves on first emit -----------------------------

Deno.test('events: once(ee, name) returns a promise resolving on emit', async () => {
    const ee = new EventEmitter();
    const p = once(ee, 'ready');
    setTimeout(() => ee.emit('ready', 42), 10);
    const [value] = await p;
    strictEqual(value, 42);
});

Deno.test('events upstream: once and on support EventTarget', async () => {
    const target = new EventTarget();
    const ready = once(target, 'ready');
    target.dispatchEvent(new Event('ready'));
    const [event] = await ready;
    ok(event instanceof Event);
    strictEqual(event.type, 'ready');

    const iter = on(target, 'data');
    target.dispatchEvent(new Event('data'));
    const first = await iter.next();
    strictEqual(first.done, false);
    ok(first.value[0] instanceof Event);
    strictEqual(first.value[0].type, 'data');
    await iter.return?.();
});

Deno.test('events upstream: EventTarget once rejects on abort and removes listener', async () => {
    const target = new EventTarget();
    const ac = new AbortController();
    const promise = once(target, 'ready', { signal: ac.signal });
    ac.abort('stop');

    let err: any;
    try {
        await promise;
    } catch (e) {
        err = e;
    }

    ok(err);
    strictEqual(err.name, 'AbortError');
    strictEqual(err.code, 'ABORT_ERR');
    strictEqual(err.cause, 'stop');
    strictEqual(getEventListeners(target, 'ready').length, 0);
});

// --- 12. once() rejects on error before target event -----------------------

Deno.test('events: once rejects if error fires before the target event', async () => {
    const ee = new EventEmitter();
    const p = once(ee, 'ready');
    ee.emit('error', new Error('boom'));

    let err: Error | null = null;
    try {
        await p;
    } catch (e) {
        err = e as Error;
    }

    ok(err, 'once promise must reject on error');
    strictEqual(err!.message, 'boom');
    strictEqual(ee.listenerCount('ready'), 0);
    strictEqual(ee.listenerCount('error'), 0);
});

// --- 13. on() throws immediately for an already-aborted signal ------------

Deno.test('events: on throws synchronously for an already-aborted signal', () => {
    const ee = new EventEmitter();
    const ac = new AbortController();
    ac.abort('stop');

    let err: any;
    try {
        on(ee, 'data', { signal: ac.signal });
    } catch (e) {
        err = e;
    }

    ok(err, 'on() must throw for an already-aborted signal');
    strictEqual(err?.name, 'AbortError');
    strictEqual(err?.code, 'ABORT_ERR');
    strictEqual(err?.cause, 'stop');
    strictEqual(ee.listenerCount('data'), 0);
    strictEqual(ee.listenerCount('error'), 0);
});

Deno.test('events: once rejects with AbortError for an already-aborted signal', async () => {
    const ee = new EventEmitter();
    const ac = new AbortController();
    ac.abort('stop');

    let err: any;
    try {
        await once(ee, 'data', { signal: ac.signal });
    } catch (e) {
        err = e;
    }

    ok(err, 'once() must reject for an already-aborted signal');
    strictEqual(err?.name, 'AbortError');
    strictEqual(err?.code, 'ABORT_ERR');
    strictEqual(err?.cause, 'stop');
    strictEqual(ee.listenerCount('data'), 0);
    strictEqual(ee.listenerCount('error'), 0);
});

// --- 15. getEventListeners returns registered listeners --------------------

Deno.test('events: getEventListeners returns array', () => {
    const ee = new EventEmitter();
    const fn = () => {};
    ee.on('e', fn);
    const list = getEventListeners(ee, 'e') as unknown as { listeners?: unknown[] } | unknown[];
    const arr = Array.isArray(list) ? list : (list as { listeners: unknown[] }).listeners;
    ok(Array.isArray(arr));
});

// --- 16. rawListeners exposes once wrappers --------------------------------

Deno.test('events: rawListeners exposes once wrapper with original listener', () => {
    const ee = new EventEmitter();
    const fn = () => {};
    ee.once('ready', fn);

    const raw = ee.rawListeners('ready');
    strictEqual(raw.length, 1);
    ok(raw[0] !== fn, 'raw once listener must be the wrapper');
    strictEqual((raw[0] as any).listener, fn);
    strictEqual(ee.listeners('ready')[0], fn);
});

// --- 17. newListener / removeListener meta-events --------------------------

Deno.test('events: newListener fires before listener is added', () => {
    const ee = new EventEmitter();
    let countDuringNewListener = -1;
    const fn = () => {};
    ee.on('newListener', (name) => {
        if (name === 'e') countDuringNewListener = ee.listenerCount('e');
    });
    ee.on('e', fn);
    strictEqual(countDuringNewListener, 0);
});

Deno.test('events: meta-events are skipped when unobserved on emit-overriding subclasses', () => {
    class StrictEmitter extends EventEmitter {
        emit(eventName: string | symbol, ...args: unknown[]): boolean {
            if (eventName === 'newListener' || eventName === 'removeListener') {
                throw new Error(`unexpected ${String(eventName)}`);
            }
            return super.emit(eventName, ...args);
        }
    }

    const ee = new StrictEmitter();
    const fn = () => {};
    ee.on('data', fn);
    ee.off('data', fn);
    strictEqual(ee.listenerCount('data'), 0);
});

Deno.test('events: errorMonitor observes errors before regular error listeners', () => {
    const ee = new EventEmitter();
    const seen: string[] = [];
    ee.on(errorMonitor, (err) => seen.push(`monitor:${(err as Error).message}`));
    ee.on('error', (err) => seen.push(`error:${(err as Error).message}`));
    ee.emit('error', new Error('boom'));
    strictEqual(seen.join(','), 'monitor:boom,error:boom');
});

Deno.test('events: captureRejections emits error when async listener rejects', async () => {
    const ee = new EventEmitter({ captureRejections: true });
    const got = new Promise<Error>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), 100);
        ee.on('error', (err) => {
            clearTimeout(timer);
            resolve(err as Error);
        });
    });
    ee.on('task', async (value) => {
        throw new Error(`bad:${value}`);
    });
    strictEqual(ee.emit('task', 42), true);
    strictEqual((await got).message, 'bad:42');
});

Deno.test('events upstream: static captureRejections applies to new emitters', async () => {
    const previous = EventEmitter.captureRejections;
    EventEmitter.captureRejections = true;
    try {
        const ee = new EventEmitter();
        const got = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out')), 500);
            ee.on('error', (err) => {
                clearTimeout(timer);
                resolve(err);
            });
        });

        ee.on('foo', () => Promise.reject(new Error('captured')));
        strictEqual(ee.emit('foo'), true);
        strictEqual((await got as Error).message, 'captured');
    } finally {
        EventEmitter.captureRejections = previous;
    }
});

Deno.test('events: captureRejectionSymbol method handles rejected listeners', async () => {
    const ee = new EventEmitter({ captureRejections: true }) as EventEmitter & {
        [captureRejectionSymbol]?: (err: Error, event: string, value: number) => void;
    };
    let errorFired = false;
    ee.on('error', () => { errorFired = true; });
    const got = new Promise<{ message: string; event: string; value: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), 100);
        ee[captureRejectionSymbol] = (err, event, value) => {
            clearTimeout(timer);
            resolve({ message: err.message, event, value });
        };
    });
    ee.on('task', async () => {
        throw new Error('handled');
    });
    ee.emit('task', 7);
    const result = await got;
    strictEqual(result.message, 'handled');
    strictEqual(result.event, 'task');
    strictEqual(result.value, 7);
    strictEqual(errorFired, false);
});

Deno.test('events: static listenerCount accepts an optional listener', () => {
    const ee = new EventEmitter();
    const fn = () => {};
    ee.once('ready', fn);
    ee.once('ready', fn);
    ee.on('ready', fn);
    strictEqual(listenerCount(ee, 'ready'), 3);
    strictEqual((listenerCount as any)(ee, 'ready', fn), 3);
});

Deno.test('events: static helpers support EventTarget listeners', () => {
    const target = new EventTarget();
    const fn = () => {};
    target.addEventListener('ready', fn);
    strictEqual(getEventListeners(target, 'ready')[0], fn);
    strictEqual(getMaxListeners(target), 10);
    setMaxListeners(2, target);
    strictEqual(getMaxListeners(target), 2);
    target.removeEventListener('ready', fn);
    strictEqual(getEventListeners(target, 'ready').length, 0);
});

Deno.test('events: static helpers reject invalid targets', () => {
    throws(() => getEventListeners({} as any, 'ready'), TypeError);
    throws(() => getMaxListeners({} as any), TypeError);
    throws(() => setMaxListeners(2, {} as any), TypeError);
});

Deno.test('events: addAbortListener fires once and remove cancels it', () => {
    const first = new AbortController();
    let fired = 0;
    addAbortListener(first.signal, () => { fired++; });
    first.abort();
    first.abort();
    strictEqual(fired, 1);

    const second = new AbortController();
    let removed = false;
    const disposable = addAbortListener(second.signal, () => { removed = true; });
    disposable.remove();
    second.abort();
    strictEqual(removed, false);
});

Deno.test('events: addAbortListener runs for already-aborted signals unless removed', async () => {
    const first = new AbortController();
    first.abort('done');
    let fired = 0;
    addAbortListener(first.signal, () => { fired++; });
    strictEqual(fired, 0);
    await Promise.resolve();
    strictEqual(fired, 1);

    const second = new AbortController();
    second.abort('done');
    let removed = false;
    const disposable = addAbortListener(second.signal, () => { removed = true; });
    disposable.remove();
    await Promise.resolve();
    strictEqual(removed, false);
});

Deno.test('events: EventEmitterAsyncResource behaves like EventEmitter', () => {
    const ee = new EventEmitterAsyncResource({ name: 'resource', captureRejections: true });
    const values: number[] = [];
    ee.on('value', (value) => values.push(value));

    strictEqual(ee.emit('value', 1), true);
    strictEqual(ee.emit('missing'), false);
    strictEqual(values[0], 1);
    ok(ee instanceof EventEmitter);
    ok(ee instanceof EventEmitterAsyncResource);
});

Deno.test('events: listener registration does not depend on Array push or unshift', () => {
    const arrayPrototype = Array.prototype as unknown as Record<string, unknown>;
    const pushDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'push')!;
    const unshiftDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'unshift')!;

    let order = '';
    let onceCount = 0;
    let firstEmit = false;
    let secondEmit = false;
    let thrown: unknown;

    delete arrayPrototype.push;
    delete arrayPrototype.unshift;
    try {
        const ee = new EventEmitter();
        ee.on('value', () => { order += 'b'; });
        ee.prependListener('value', () => { order += 'a'; });
        ee.once('value', () => { onceCount++; });
        ee.prependOnceListener('value', () => { order += '0'; });
        firstEmit = ee.emit('value');
        secondEmit = ee.emit('value');
    } catch (error) {
        thrown = error;
    } finally {
        Object.defineProperty(Array.prototype, 'push', pushDescriptor);
        Object.defineProperty(Array.prototype, 'unshift', unshiftDescriptor);
    }

    if (thrown) throw thrown;
    strictEqual(firstEmit, true);
    strictEqual(secondEmit, true);
    strictEqual(order, '0abab');
    strictEqual(onceCount, 1);
});

Deno.test('events upstream: EventEmitter construction does not depend on mutable Object helpers', () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(Object, 'create')!;
    const setPrototypeOfDescriptor = Object.getOwnPropertyDescriptor(Object, 'setPrototypeOf')!;

    let firstCalled = false;
    let secondCalled = false;
    let thrown: unknown;
    try {
        Object.defineProperty(Object, 'create', { value: undefined, configurable: true, writable: true });
        const first = new EventEmitter();
        first.on('foo', () => { firstCalled = true; });
        first.emit('foo');

        Object.defineProperty(Object, 'setPrototypeOf', { value: undefined, configurable: true, writable: true });
        const second = new EventEmitter();
        second.on('bar', () => { secondCalled = true; });
        second.emit('bar');
    } catch (error) {
        thrown = error;
    } finally {
        Object.defineProperty(Object, 'create', createDescriptor);
        Object.defineProperty(Object, 'setPrototypeOf', setPrototypeOfDescriptor);
    }

    if (thrown) throw thrown;
    strictEqual(firstCalled, true);
    strictEqual(secondCalled, true);
});

Deno.test('events: on() async iterator rejects on error and removes listeners', async () => {
    const ee = new EventEmitter();
    const iter = on(ee, 'data');
    const pending = iter.next();
    ee.emit('error', new Error('iter-error'));

    let error: Error | null = null;
    try {
        await pending;
    } catch (e) {
        error = e as Error;
    }

    ok(error);
    strictEqual(error.message, 'iter-error');
    strictEqual(ee.listenerCount('data'), 0);
    strictEqual(ee.listenerCount('error'), 0);
});
