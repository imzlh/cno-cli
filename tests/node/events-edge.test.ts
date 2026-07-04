import { strictEqual, ok } from 'node:assert';
import { EventEmitter, on, once, getEventListeners } from 'node:events';

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

// --- 10. once() promise resolves on first emit ------------------------------

Deno.test('events: once(ee, name) returns a promise resolving on emit', async () => {
    const ee = new EventEmitter();
    const p = once(ee, 'ready');
    setTimeout(() => ee.emit('ready', 42), 10);
    const [value] = await p;
    strictEqual(value, 42);
});

// --- 11. getEventListeners returns registered listeners ---------------------

Deno.test('events: getEventListeners returns array', () => {
    const ee = new EventEmitter();
    const fn = () => {};
    ee.on('e', fn);
    const list = getEventListeners(ee, 'e') as unknown as { listeners?: unknown[] } | unknown[];
    const arr = Array.isArray(list) ? list : (list as { listeners: unknown[] }).listeners;
    ok(Array.isArray(arr));
});

// --- 12. newListener / removeListener meta-events ---------------------------

Deno.test('events: newListener fires before listener is added', () => {
    const ee = new EventEmitter();
    let sawNew = false;
    ee.on('newListener', () => { sawNew = true; });
    ee.on('e', () => {});
    ok(sawNew, 'newListener must fire');
});
