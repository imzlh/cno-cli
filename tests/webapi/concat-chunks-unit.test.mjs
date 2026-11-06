// @cno-host: false
// Run with: node --test tests/webapi/concat-chunks-unit.test.mjs
// The native bridge is stubbed to plain JS concatenation so Node can exercise
// the copies and buffer-view decisions made by the JS wrapper.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundled = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    stdin: {
        contents: `
            export { concatChunks, arrayBufferBackedBytes, toOwnedBytes } from './cno/src/utils/bytes';
        `,
        resolveDir: fileURLToPath(new URL('../..', import.meta.url)),
        loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2024',
    define: { 'import.meta.use': '__test_use__' },
    write: false,
});

// The bundled source binds `import.meta.use` to __test_use__; provide a tiny
// in-realm stand-in for the algorithm/engine modules the bytes helpers use.
const realmEngine = {
    isArrayBuffer(value) {
        try {
            Reflect.apply(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get, value, []);
            return true;
        } catch {
            return false;
        }
    },
};
const realmAlgorithm = {
    bytesConcat(chunks) {
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
        return out;
    },
};
const context = {
    module: { exports: {} },
    __test_use__: (name) => {
        if (name === 'engine') return realmEngine;
        if (name === 'algorithm') return realmAlgorithm;
        return undefined;
    },
};
runInNewContext(bundled.outputFiles[0].text, context);
const { concatChunks, arrayBufferBackedBytes } = context.module.exports;

test('concatChunks: empty, single, multiple, and offset-view inputs', () => {
    assert.equal(concatChunks([]).byteLength, 0);
    const single = concatChunks([new Uint8Array([1, 2, 3])]);
    assert.deepEqual([...single], [1, 2, 3]);
    const multi = concatChunks([new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4])]);
    assert.deepEqual([...multi], [1, 2, 3, 4]);
    const base = new Uint8Array([9, 8, 7, 6, 5]);
    const offsetView = concatChunks([base.subarray(1, 3), base.subarray(4)]);
    assert.deepEqual([...offsetView], [8, 7, 5]);
});

test('concatChunks: result is ArrayBuffer-backed and mutation-independent', () => {
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
    const joined = concatChunks([first, second]);
    assert.equal(joined.buffer instanceof ArrayBuffer, true);
    joined[0] = 99;
    assert.equal(first[0], 1, 'source chunk must not alias the result');
    first[0] = 1;
    // Same source buffer twice: the copies must stay independent.
    const twice = concatChunks([first, first]);
    twice[0] = 50;
    assert.equal(twice[1], 1);
});

test('arrayBufferBackedBytes: ArrayBuffer-backed views stay views, others copy', () => {
    const buffer = new ArrayBuffer(4);
    const view = new Uint8Array(buffer, 1, 2);
    view[0] = 7;
    const same = arrayBufferBackedBytes(view);
    assert.equal(same.buffer, buffer, 'ArrayBuffer-backed input must not copy');
    assert.equal(same[0], 7);
    // A SharedArrayBuffer-backed view cannot be kept as-is; it must copy.
    const sab = new SharedArrayBuffer(4);
    const sabView = new Uint8Array(sab);
    sabView[0] = 5;
    const copied = arrayBufferBackedBytes(sabView);
    assert.notEqual(copied.buffer, sab);
    assert.equal(copied[0], 5);
    copied[0] = 6;
    assert.equal(sabView[0], 5, 'SAB-backed input must be copied');

    const foreign = runInNewContext('new Uint8Array([8, 9])');
    const foreignView = arrayBufferBackedBytes(foreign);
    assert.equal(foreignView.buffer, foreign.buffer, 'foreign-realm ArrayBuffer must pass the native-style brand check');
    assert.deepEqual([...foreignView], [8, 9]);
});
