import assert from 'node:assert/strict';
import { ArrayBufferSink } from '../../cno/src/bun/array-buffer-sink.ts';

const test = Deno.test;

type SinkResult = number | ArrayBuffer | Uint8Array;

const bytes = (value: SinkResult): number[] => {
    assert.notEqual(typeof value, 'number');
    return [...(value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer))];
};

function asView(value: SinkResult): Uint8Array {
    if (!(value instanceof Uint8Array)) throw new assert.AssertionError({ message: 'expected a Uint8Array' });
    return value;
}

function started(options?: Parameters<ArrayBufferSink['start']>[0]): ArrayBufferSink {
    const sink = new ArrayBufferSink();
    sink.start(options);
    return sink;
}

test('bun: ArrayBufferSink end() returns an exactly sized ArrayBuffer by default', () => {
    const sink = started();
    assert.equal(sink.write('abc'), 3);
    assert.equal(sink.write(new Uint8Array([1, 2])), 2);
    const result = sink.end();
    assert.ok(result instanceof ArrayBuffer);
    assert.deepEqual(bytes(result), [97, 98, 99, 1, 2]);
    assert.equal(result.byteLength, 5);
});

test('bun: ArrayBufferSink asUint8Array makes end() return a Uint8Array', () => {
    const sink = started({ asUint8Array: true, highWaterMark: 1024 });
    sink.write('hi');
    const result = asView(sink.end());
    assert.deepEqual(bytes(result), [104, 105]);
    // A preallocated buffer must not leak its spare capacity.
    assert.equal(result.byteOffset, 0);
    assert.equal(result.buffer.byteLength, 2);
});

test('bun: ArrayBufferSink end() on an empty sink returns an empty result of the configured type', () => {
    assert.equal((started().end() as ArrayBuffer).byteLength, 0);
    assert.ok(started().end() instanceof ArrayBuffer);
    assert.equal(asView(started({ asUint8Array: true }).end()).length, 0);
});

test('bun: ArrayBufferSink write() accepts strings, buffers and views and returns byte counts', () => {
    const sink = started();
    assert.equal(sink.write(''), 0);
    assert.equal(sink.write('é'), 2);
    assert.equal(sink.write('\u{1F600}'), 4);
    assert.equal(sink.write('\ud800'), 3, 'lone surrogate is encoded as U+FFFD');
    assert.equal(sink.write(new ArrayBuffer(0)), 0);
    assert.equal(sink.write(new Uint8Array(0)), 0);
    const backing = new Uint8Array([9, 1, 2, 3, 9]).buffer;
    assert.equal(sink.write(new DataView(backing, 1, 3)), 3);
    assert.equal(sink.write(new Uint8Array(backing, 4, 1)), 1);
    assert.equal(sink.write(new Uint16Array([0x0201, 0x0403])), 4);
    assert.equal(sink.write(backing.slice(1, 3)), 2);
    assert.deepEqual(bytes(sink.end()), [
        0xc3, 0xa9,
        0xf0, 0x9f, 0x98, 0x80,
        0xef, 0xbf, 0xbd,
        1, 2, 3,
        9,
        1, 2, 3, 4,
        1, 2,
    ]);
});

test('bun: ArrayBufferSink write() accepts SharedArrayBuffer and views over it', () => {
    const shared = new SharedArrayBuffer(4);
    new Uint8Array(shared).set([5, 6, 7, 8]);
    const sink = started();
    assert.equal(sink.write(shared), 4);
    assert.equal(sink.write(new Uint8Array(shared, 1, 2)), 2);
    assert.deepEqual(bytes(sink.end()), [5, 6, 7, 8, 6, 7]);
});

test('bun: ArrayBufferSink write() copies its input immediately', () => {
    const source = new Uint8Array([1, 2, 3]);
    const sink = started();
    sink.write(source);
    source.fill(0xff);
    sink.write(source);
    assert.deepEqual(bytes(sink.end()), [1, 2, 3, 255, 255, 255]);
});

test('bun: ArrayBufferSink write() rejects unsupported chunks with TypeError', () => {
    const sink = started();
    for (const value of [undefined, null, 1, true, {}, [1, 2], Symbol('x'), 1n, new Blob(['a'])]) {
        assert.throws(() => sink.write(value as never), TypeError);
    }
    // Rejected chunks leave the sink usable and unchanged.
    sink.write('ok');
    assert.deepEqual(bytes(sink.end()), [111, 107]);
});

test('bun: ArrayBufferSink grows across many small and large writes', () => {
    const sink = started();
    const expected: number[] = [];
    for (let i = 0; i < 2000; i++) {
        const chunk = new Uint8Array(i % 7).fill(i & 0xff);
        sink.write(chunk);
        expected.push(...chunk);
    }
    const large = new Uint8Array(100_000).map((_, i) => i & 0xff);
    assert.equal(sink.write(large), 100_000);
    const result = new Uint8Array(sink.end() as ArrayBuffer);
    assert.equal(result.length, expected.length + large.length);
    assert.deepEqual([...result.subarray(0, expected.length)], expected);
    assert.deepEqual(result.subarray(expected.length), large);
});

test('bun: ArrayBufferSink without stream flush() returns bytes written since the last flush and keeps data', () => {
    const sink = started();
    assert.equal(sink.flush(), 0);
    sink.write('abc');
    sink.write('de');
    assert.equal(sink.flush(), 5);
    assert.equal(sink.flush(), 0);
    sink.write('f');
    assert.equal(sink.flush(), 1);
    // flush() never drains in this mode: end() still returns everything.
    assert.deepEqual(bytes(sink.end()), [97, 98, 99, 100, 101, 102]);
});

test('bun: ArrayBufferSink stream flush() returns the pending bytes and restarts the buffer', () => {
    const sink = started({ stream: true });
    assert.ok(sink.flush() instanceof ArrayBuffer);
    assert.equal((sink.flush() as ArrayBuffer).byteLength, 0);
    sink.write('ab');
    const first = sink.flush();
    assert.ok(first instanceof ArrayBuffer);
    assert.deepEqual(bytes(first), [97, 98]);
    sink.write('c');
    sink.write('d');
    assert.deepEqual(bytes(sink.flush()), [99, 100]);
    // Earlier flush results are independent copies.
    assert.deepEqual(bytes(first), [97, 98]);
    sink.write('e');
    assert.deepEqual(bytes(sink.end()), [101], 'end() returns only what was not flushed');
});

test('bun: ArrayBufferSink stream with asUint8Array flush() returns an exactly sized Uint8Array', () => {
    const sink = started({ stream: true, asUint8Array: true, highWaterMark: 64 });
    sink.write('xyz');
    const chunk = asView(sink.flush());
    assert.deepEqual(bytes(chunk), [120, 121, 122]);
    assert.equal(chunk.byteOffset, 0);
    assert.equal(chunk.buffer.byteLength, 3);
    sink.write('w');
    assert.equal(bytes(chunk).length, 3, 'a later write cannot alias a returned chunk');
    assert.deepEqual(bytes(asView(sink.end())), [119]);
});

test('bun: ArrayBufferSink highWaterMark is only a hint', () => {
    for (const highWaterMark of [0, 1, 3, 4096, 2 ** 40, Infinity, -5, NaN, 1.9, '8', null, {}]) {
        const sink = started({ highWaterMark: highWaterMark as number });
        sink.write('hello world');
        assert.deepEqual(bytes(sink.end()), [...new TextEncoder().encode('hello world')], String(highWaterMark));
    }
});

test('bun: ArrayBufferSink option flags only honor real booleans and non-object options are ignored', () => {
    for (const options of [undefined, null, 0, 'x', true, [], {}, { asUint8Array: 1, stream: 'yes' }]) {
        const sink = started(options as never);
        sink.write('a');
        assert.equal(sink.flush(), 1, 'stream stays off');
        assert.ok(sink.end() instanceof ArrayBuffer, 'asUint8Array stays off');
    }
});

test('bun: ArrayBufferSink works before start() with default options', () => {
    const sink = new ArrayBufferSink();
    assert.equal(sink.write('ab'), 2);
    assert.equal(sink.flush(), 2);
    assert.deepEqual(bytes(sink.end()), [97, 98]);
});

test('bun: ArrayBufferSink end resets the sink without closing it', () => {
    const sink = started({ asUint8Array: true });
    sink.write('a');
    assert.deepEqual(bytes(sink.end()), [97]);
    assert.equal(sink.write('b'), 1);
    assert.equal(sink.flush(), 1);
    assert.deepEqual(bytes(sink.end()), [98]);
    assert.equal(asView(sink.end()).length, 0);
    assert.ok(started().end() instanceof ArrayBuffer);
});

test('bun: ArrayBufferSink start() resets data and options, and reopens a closed sink', () => {
    const sink = started({ stream: true, asUint8Array: true });
    sink.write('old');
    sink.start();
    sink.write('new');
    assert.equal(sink.flush(), 3, 'stream and asUint8Array reset to defaults');
    const result = sink.end();
    assert.ok(result instanceof ArrayBuffer);
    assert.deepEqual(bytes(result), [110, 101, 119]);

    sink.start({ asUint8Array: true });
    assert.equal(sink.write('again'), 5);
    assert.deepEqual(bytes(sink.end()), [97, 103, 97, 105, 110]);
});

test('bun: ArrayBufferSink instances are independent and methods reject foreign receivers', () => {
    const a = started();
    const b = started();
    a.write('a');
    b.write('b');
    assert.deepEqual(bytes(a.end()), [97]);
    assert.deepEqual(bytes(b.end()), [98]);
    for (const method of ['start', 'write', 'flush', 'end'] as const) {
        assert.throws(() => (ArrayBufferSink.prototype[method] as (...args: unknown[]) => unknown).call({}, 'x'), TypeError, method);
    }
});

test('bun: ArrayBufferSink start() is atomic against throwing getters', () => {
    const sink = started();
    sink.write('keep');
    const boom = new Error('boom');
    assert.throws(() => sink.start({ get stream(): boolean { throw boom; } }), boom);
    assert.deepEqual(bytes(sink.end()), [107, 101, 101, 112], 'failed start() leaves the sink untouched');
});
