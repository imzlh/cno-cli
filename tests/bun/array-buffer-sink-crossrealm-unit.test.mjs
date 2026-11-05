// @cno-host: false
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const result = await build({
    absWorkingDir: repository,
    entryPoints: ['cno/src/bun/array-buffer-sink.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2024',
    write: false,
    define: { 'import.meta.use': '__test_use__' },
});
const source = result.outputFiles[0].text;
const module = { exports: {} };
runInNewContext(source, {
    module,
    exports: module.exports,
    __test_use__: name => name === 'engine'
        ? { encodeString: value => new TextEncoder().encode(value) }
        : undefined,
});
const { ArrayBufferSink } = module.exports;

function sinkBytes(sink) {
    return Array.from(new Uint8Array(sink.end()));
}

test('ArrayBufferSink accepts cross-realm buffers and preserves a view byte window', () => {
    const foreign = runInNewContext(`(() => {
        const buffer = new ArrayBuffer(8);
        new Uint8Array(buffer).set([10, 11, 12, 13, 14, 15, 16, 17]);
        return {
            buffer,
            typed: new Uint16Array(buffer, 2, 2),
            data: new DataView(buffer, 5, 2),
        };
    })()`);
    assert.equal(foreign.buffer instanceof ArrayBuffer, false);
    assert.equal(ArrayBuffer.isView(foreign.typed), true);
    assert.equal(ArrayBuffer.isView(foreign.data), true);

    const sink = new ArrayBufferSink();
    assert.equal(sink.write(foreign.buffer), 8);
    assert.equal(sink.write(foreign.typed), 4);
    assert.equal(sink.write(foreign.data), 2);
    assert.deepEqual(sinkBytes(sink), [10, 11, 12, 13, 14, 15, 16, 17, 12, 13, 14, 15, 15, 16]);
});

test('ArrayBufferSink accepts cross-realm SharedArrayBuffer inputs when available', t => {
    if (typeof SharedArrayBuffer !== 'function') {
        t.skip('SharedArrayBuffer is unavailable');
        return;
    }
    const foreign = runInNewContext(`(() => {
        const buffer = new SharedArrayBuffer(4);
        new Uint8Array(buffer).set([21, 22, 23, 24]);
        return { buffer, view: new Uint8Array(buffer, 1, 2) };
    })()`);
    assert.equal(foreign.buffer instanceof SharedArrayBuffer, false);
    assert.equal(ArrayBuffer.isView(foreign.view), true);

    const sink = new ArrayBufferSink();
    assert.equal(sink.write(foreign.buffer), 4);
    assert.equal(sink.write(foreign.view), 2);
    assert.deepEqual(sinkBytes(sink), [21, 22, 23, 24, 22, 23]);
});

test('ArrayBufferSink does not coerce array-like or iterable inputs into bytes', () => {
    const sink = new ArrayBufferSink();
    const values = [
        {},
        [1, 2],
        { 0: 1, 1: 2, length: 2 },
        new Set([1, 2]),
        { [Symbol.iterator]: function* () { yield 1; } },
    ];
    for (const value of values) {
        assert.throws(() => sink.write(value), error => error?.name === 'TypeError');
    }
    assert.equal(sink.write('ok'), 2);
    assert.deepEqual(sinkBytes(sink), [111, 107]);
});
