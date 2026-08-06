import { ok, strictEqual, throws } from 'node:assert';

Deno.test('AbortSignal upstream: constructor is illegal', () => {
    throws(() => new AbortSignal(), TypeError);
    throws(() => new (class extends AbortSignal {})(), TypeError);
});

Deno.test('AbortSignal.abort: creates already-aborted signal with reason', () => {
    const reason = new Error('stop');
    const signal = AbortSignal.abort(reason);

    strictEqual(signal.aborted, true);
    strictEqual(signal.reason, reason);
    throws(() => signal.throwIfAborted(), reason);
});

Deno.test('AbortController upstream: default abort reason is AbortError and toStringTag is web-compatible', () => {
    const controller = new AbortController();
    strictEqual(Object.prototype.toString.call(controller), '[object AbortController]');
    strictEqual(Object.prototype.toString.call(controller.signal), '[object AbortSignal]');

    controller.abort();
    strictEqual(controller.signal.aborted, true);
    ok(controller.signal.reason instanceof DOMException);
    strictEqual(controller.signal.reason.name, 'AbortError');
    throws(() => controller.signal.throwIfAborted(), controller.signal.reason);
});

Deno.test('AbortController: abort fires listeners once and preserves first reason', () => {
    const controller = new AbortController();
    const events: Event[] = [];
    let onabort = 0;
    controller.signal.onabort = () => { onabort++; };
    controller.signal.addEventListener('abort', (event) => events.push(event));

    controller.abort('first');
    controller.abort('second');

    strictEqual(controller.signal.aborted, true);
    strictEqual(controller.signal.reason, 'first');
    strictEqual(onabort, 1);
    strictEqual(events.length, 1);
    strictEqual(events[0].type, 'abort');
});

Deno.test('AbortSignal.any: returns first already-aborted signal reason', () => {
    const first = AbortSignal.abort('first');
    const second = new AbortController();
    const signal = AbortSignal.any([second.signal, first]);

    strictEqual(signal.aborted, true);
    strictEqual(signal.reason, 'first');
});

Deno.test('AbortSignal.any: aborts when one source aborts and keeps first reason', () => {
    const first = new AbortController();
    const second = new AbortController();
    const signal = AbortSignal.any([first.signal, second.signal]);
    let fired = 0;
    signal.addEventListener('abort', () => { fired++; });

    second.abort('second');
    first.abort('first');

    strictEqual(signal.aborted, true);
    strictEqual(signal.reason, 'second');
    strictEqual(fired, 1);
});

Deno.test('AbortSignal.any: accepts any iterable and rejects non-iterables', () => {
    // Spec takes an iterable of signals, so a Set and a generator are both valid.
    const controller = new AbortController();
    strictEqual(AbortSignal.any(new Set([controller.signal])).aborted, false);
    strictEqual(AbortSignal.any(new Set()).aborted, false);
    throws(() => AbortSignal.any(5 as unknown as AbortSignal[]), TypeError);
    throws(() => AbortSignal.any(null as unknown as AbortSignal[]), TypeError);
});

Deno.test('AbortSignal.timeout: aborts asynchronously with TimeoutError', async () => {
    const signal = AbortSignal.timeout(1);
    strictEqual(signal.aborted, false);
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));

    strictEqual(signal.aborted, true);
    ok(signal.reason instanceof DOMException);
    strictEqual(signal.reason.name, 'TimeoutError');
});

Deno.test('AbortSignal.timeout: rejects invalid timeout values', () => {
    // Spec/Node use RangeError for an out-of-range delay.
    throws(() => AbortSignal.timeout(-1), RangeError);
    throws(() => AbortSignal.timeout(Infinity), RangeError);
});

Deno.test('AbortSignal/AbortController: default reason and prototype string tag', () => {
    const controller = new AbortController();
    controller.abort();
    ok(controller.signal.reason instanceof DOMException);
    strictEqual(controller.signal.reason.name, 'AbortError');
    strictEqual(controller.signal.reason.message, 'This operation was aborted');
    strictEqual(AbortSignal.abort().reason.message, 'This operation was aborted');

    // Symbol.toStringTag belongs on the prototype, not on each instance.
    ok(Object.prototype.hasOwnProperty.call(AbortSignal.prototype, Symbol.toStringTag));
    ok(!Object.prototype.hasOwnProperty.call(controller.signal, Symbol.toStringTag));
    ok(!Object.prototype.hasOwnProperty.call(controller, Symbol.toStringTag));
});
