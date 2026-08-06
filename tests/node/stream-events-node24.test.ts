import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import events, {
    EventEmitter,
    captureRejections,
    defaultMaxListeners,
    init,
    usingDomains,
} from 'node:events';
import stream, {
    PassThrough,
    Readable,
    Writable,
    destroy,
    duplexPair,
    isDestroyed,
    isErrored,
} from 'node:stream';
import { finished as finishedPromise } from 'node:stream/promises';

Deno.test('node24 events: common named exports match the EventEmitter default', () => {
    strictEqual(captureRejections, false);
    strictEqual(defaultMaxListeners, 10);
    strictEqual(usingDomains, false);
    strictEqual(init, EventEmitter.init);
    strictEqual(events.EventEmitter, EventEmitter);
    strictEqual(events.defaultMaxListeners, EventEmitter.defaultMaxListeners);
});

Deno.test('node24 events: synchronous listener exceptions propagate unchanged', () => {
    const emitter = new EventEmitter();
    let errorEvents = 0;
    const failure = new Error('listener failed');
    emitter.on('error', () => { errorEvents++; });
    emitter.on('work', () => { throw failure; });

    throws(() => emitter.emit('work'), (error: unknown) => error === failure);
    strictEqual(errorEvents, 0);
});

Deno.test('node24 events: once is removed before reentrant invocation', () => {
    const emitter = new EventEmitter();
    const order: string[] = [];
    const listener = () => {
        order.push('once');
        emitter.emit('ready');
    };

    emitter.on('removeListener', (name, removed) => {
        if (name === 'ready' && removed === listener) order.push('removed');
    });
    emitter.once('ready', listener);
    emitter.on('ready', () => order.push('normal'));
    emitter.emit('ready');

    deepStrictEqual(order, ['removed', 'once', 'normal', 'normal']);
});

Deno.test('node24 events: duplicate removal targets the most recent listener', () => {
    const emitter = new EventEmitter();
    const listener = () => {};
    emitter.on('ready', listener);
    emitter.once('ready', listener);
    emitter.on('ready', listener);

    emitter.removeListener('ready', listener);
    const raw = emitter.rawListeners('ready');
    strictEqual(raw.length, 2);
    strictEqual(raw[0], listener);
    ok(raw[1] !== listener);
    strictEqual(emitter.listenerCount('ready', raw[1]), 1);
});

Deno.test('node24 events: defaults stay dynamic until overridden per emitter', () => {
    const previousDefault = EventEmitter.defaultMaxListeners;
    const previousCapture = EventEmitter.captureRejections;
    const emitter = new EventEmitter();
    try {
        EventEmitter.defaultMaxListeners = 23;
        strictEqual(emitter.getMaxListeners(), 23);
        emitter.setMaxListeners(4);
        EventEmitter.defaultMaxListeners = 31;
        strictEqual(emitter.getMaxListeners(), 4);

        throws(
            () => { EventEmitter.defaultMaxListeners = -1; },
            (error: unknown) => Reflect.get(error as object, 'code') === 'ERR_OUT_OF_RANGE',
        );
        throws(
            () => { (EventEmitter as unknown as { captureRejections: unknown }).captureRejections = 1; },
            (error: unknown) => Reflect.get(error as object, 'code') === 'ERR_INVALID_ARG_TYPE',
        );
    } finally {
        EventEmitter.defaultMaxListeners = previousDefault;
        EventEmitter.captureRejections = previousCapture;
    }
});

Deno.test('node24 events: non-symbol event names use property-key coercion', () => {
    const emitter = new EventEmitter();
    let called = false;
    (emitter.on as (name: unknown, listener: () => void) => EventEmitter)(1, () => { called = true; });
    strictEqual(emitter.emit('1'), true);
    strictEqual(called, true);
});

Deno.test('node24 events: symbol names remain distinct and Infinity is a valid limit', () => {
    const emitter = new EventEmitter();
    const first = Symbol('ready');
    const second = Symbol('ready');
    let called = 0;
    emitter.on(first, () => { called++; });
    strictEqual(emitter.emit(second), false);
    strictEqual(emitter.emit(first), true);
    strictEqual(called, 1);

    strictEqual(emitter.setMaxListeners(Infinity), emitter);
    strictEqual(emitter.getMaxListeners(), Infinity);
    throws(
        () => emitter.setMaxListeners(NaN),
        (error: unknown) => Reflect.get(error as object, 'code') === 'ERR_OUT_OF_RANGE',
    );
});

Deno.test('node24 stream: missing common exports are present on named and default APIs', () => {
    strictEqual(typeof destroy, 'function');
    strictEqual(typeof duplexPair, 'function');
    strictEqual(typeof isDestroyed, 'function');
    strictEqual(stream.destroy, destroy);
    strictEqual(stream.duplexPair, duplexPair);
    strictEqual(stream.isDestroyed, isDestroyed);
});

Deno.test('node24 stream: destroy uses AbortError and isDestroyed reads stream state', async () => {
    const target = new PassThrough();
    let seen: Error & { code?: string } | undefined;
    target.on('error', (error) => { seen = error as Error & { code?: string }; });

    strictEqual(destroy(target), undefined);
    strictEqual(isDestroyed(target), true);
    strictEqual(isDestroyed({}), null);
    // Node defers the 'error' emit past the microtask queue (destroy() schedules
    // emitErrorCloseNT), so the error is not observable synchronously.
    strictEqual(seen, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    strictEqual(seen?.name, 'AbortError');
    strictEqual(seen?.code, 'ABORT_ERR');
});

Deno.test('node24 stream: isErrored distinguishes normal completion from failure', () => {
    const normal = new Readable({ read() {} });
    normal.push(null);
    normal.read();
    strictEqual(isErrored(normal), false);

    const failed = new Readable({ read() {} });
    failed.on('error', () => {});
    failed.destroy(new Error('boom'));
    strictEqual(isErrored(failed), true);
});

Deno.test('node24 stream: synchronous write callbacks run after write returns', async () => {
    const order: string[] = [];
    const writable = new Writable({
        write(_chunk, _encoding, callback) {
            order.push('write');
            callback();
        },
    });

    order.push('before');
    writable.write('x', () => order.push('callback'));
    order.push('after');
    deepStrictEqual(order, ['before', 'write', 'after']);
    // Node defers the write callback via process.nextTick, which is not drained
    // by a single microtask turn; assert on the macrotask boundary instead.
    await new Promise((resolve) => setImmediate(resolve));
    deepStrictEqual(order, ['before', 'write', 'after', 'callback']);
});

Deno.test('node24 stream: autoDestroy closes a completed Writable by default', async () => {
    const order: string[] = [];
    const writable = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    writable.on('finish', () => order.push('finish'));
    writable.on('close', () => order.push('close'));
    writable.end('done');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    deepStrictEqual(order, ['finish', 'close']);
    strictEqual(writable.destroyed, true);
});

Deno.test('node24 stream: corked writes use writev and drain before callbacks', async () => {
    const order: string[] = [];
    const writable = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) { callback(); },
        writev(chunks, callback) {
            order.push(`writev:${chunks.length}`);
            callback();
        },
    });
    writable.on('drain', () => order.push('drain'));
    writable.cork();
    strictEqual(writable.write('a', () => order.push('a')), false);
    strictEqual(writable.write('b', () => order.push('b')), false);
    strictEqual(writable.writableNeedDrain, true);
    writable.uncork();
    deepStrictEqual(order, ['writev:2']);
    // 'drain' and the per-write callbacks are nextTick-deferred in Node, so they
    // are not visible after a single microtask turn.
    await new Promise((resolve) => setImmediate(resolve));

    deepStrictEqual(order, ['writev:2', 'drain', 'a', 'b']);
    strictEqual(writable.writableLength, 0);
    strictEqual(writable.writableNeedDrain, false);
});

Deno.test('node24 stream: duplexPair applies directional options', () => {
    const [first, second] = duplexPair({
        allowHalfOpen: false,
        readableObjectMode: true,
        writableObjectMode: false,
        readableHighWaterMark: 3,
        writableHighWaterMark: 5,
    });

    for (const endpoint of [first, second]) {
        strictEqual(endpoint.allowHalfOpen, false);
        strictEqual(endpoint.readableObjectMode, true);
        strictEqual(endpoint.writableObjectMode, false);
        strictEqual(endpoint.readableHighWaterMark, 3);
        strictEqual(endpoint.writableHighWaterMark, 5);
    }
    first.destroy();
});

Deno.test('node24 stream: duplexPair propagates backpressure in both directions', () => {
    const [left, right] = duplexPair({ objectMode: true, highWaterMark: 1 });
    const callbacks: string[] = [];
    left.on('drain', () => callbacks.push('drain'));

    strictEqual(left.write(1, () => callbacks.push('one')), false);
    strictEqual(left.write(2, () => callbacks.push('two')), false);
    strictEqual(left.writableLength, 2);
    strictEqual(right.readableLength, 1);

    strictEqual(right.read(), 1);
    deepStrictEqual(callbacks, ['one']);
    strictEqual(left.writableLength, 1);
    strictEqual(right.readableLength, 1);

    strictEqual(right.read(), 2);
    deepStrictEqual(callbacks, ['one', 'drain', 'two']);
    strictEqual(left.writableLength, 0);

    right.write('reply');
    strictEqual(left.read(), 'reply');
    left.destroy();
});

Deno.test('node24 stream: duplexPair retains every queued write under pressure', () => {
    const [left, right] = duplexPair({ objectMode: true, highWaterMark: 1 });
    const callbacks: number[] = [];
    strictEqual(left.write(1, () => callbacks.push(1)), false);
    strictEqual(left.write(2, () => callbacks.push(2)), false);
    strictEqual(left.write(3, () => callbacks.push(3)), false);

    strictEqual(right.read(), 1);
    strictEqual(right.read(), 2);
    strictEqual(right.read(), 3);
    deepStrictEqual(callbacks, [1, 2, 3]);
    left.destroy();
});

Deno.test('node24 stream: duplexPair half-open and error lifecycle matches Node', async () => {
    const [left, right] = duplexPair({ objectMode: true, allowHalfOpen: false });
    const events: string[] = [];
    left.on('error', () => events.push('left-error'));
    left.on('close', () => events.push('left-close'));
    right.on('close', () => events.push('right-close'));
    right.resume();
    left.end('payload');

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    ok(right.writableEnded, 'allowHalfOpen=false ends the opposite writable side');
    ok(!events.includes('right-close'), 'pair waits for both readable sides before closing');
    left.resume();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    ok(events.includes('right-close'));
    ok(events.includes('left-close'));
    left.destroy();

    const [failed, peer] = duplexPair({ objectMode: true });
    const failure = new Error('pair failure');
    let peerError = false;
    failed.on('error', (error) => {
        strictEqual(error, failure);
    });
    peer.on('error', () => { peerError = true; });
    failed.destroy(failure);
    strictEqual(failed.destroyed, true);
    // Node defers propagation of an errored destroy() to the opposite endpoint,
    // so the peer is still alive synchronously and never sees the error itself.
    strictEqual(peer.destroyed, false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    strictEqual(peer.destroyed, true);
    strictEqual(peerError, false);
});

Deno.test('node24 stream: Readable.from rejects null iterator values', async () => {
    const readable = Readable.from([1, null, 2]);
    let failure: unknown;
    try {
        for await (const _value of readable) {}
    } catch (error) {
        failure = error;
    }
    ok(failure instanceof TypeError);
    strictEqual(Reflect.get(failure as object, 'code'), 'ERR_STREAM_NULL_VALUES');
});

Deno.test('node24 stream: finished waits for both Duplex sides', async () => {
    const target = new PassThrough();
    let settled = false;
    const completion = finishedPromise(target).then(() => { settled = true; });
    target.end('payload');
    await Promise.resolve();
    strictEqual(settled, false);
    target.resume();
    await completion;
    strictEqual(settled, true);
});

Deno.test('node24 stream: finished reports abort and premature close codes', async () => {
    const prematurelyClosed = new PassThrough();
    const premature = finishedPromise(prematurelyClosed);
    prematurelyClosed.destroy();
    let prematureError: unknown;
    try {
        await premature;
    } catch (error) {
        prematureError = error;
    }
    strictEqual(Reflect.get(prematureError as object, 'code'), 'ERR_STREAM_PREMATURE_CLOSE');

    const pending = new PassThrough();
    const controller = new AbortController();
    const aborted = finishedPromise(pending, { signal: controller.signal });
    controller.abort('stop');
    let abortError: unknown;
    try {
        await aborted;
    } catch (error) {
        abortError = error;
    }
    strictEqual(Reflect.get(abortError as object, 'name'), 'AbortError');
    strictEqual(Reflect.get(abortError as object, 'code'), 'ABORT_ERR');
    strictEqual(Reflect.get(abortError as object, 'cause'), 'stop');
    pending.destroy();
});
