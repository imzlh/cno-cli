// @cno-host: false
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const bundled = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['cno/src/bun/file-path.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2024',
    write: false,
});
const module = { exports: {} };
runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    ArrayBuffer,
    SharedArrayBuffer,
    Uint8Array,
    DataView,
    Symbol,
});
const { isBunBytePath } = module.exports;

test('Bun byte-path brand checks accept cross-realm supported buffers', () => {
    const foreign = runInNewContext(`(() => {
        const buffer = new ArrayBuffer(4);
        const bytes = new Uint8Array(buffer);
        bytes.set([1, 2, 3, 4]);
        return {
            buffer,
            bytes,
            view: new DataView(buffer, 1, 2),
            words: new Uint16Array(buffer),
        };
    })()`);

    assert.equal(foreign.buffer instanceof ArrayBuffer, false);
    assert.equal(foreign.bytes instanceof Uint8Array, false);
    assert.equal(foreign.view instanceof DataView, false);
    assert.equal(isBunBytePath(foreign.buffer), true);
    assert.equal(isBunBytePath(foreign.bytes), true);
    assert.equal(isBunBytePath(foreign.view), true);
    assert.equal(isBunBytePath(foreign.words), false);
});

test('Bun byte-path brand checks accept cross-realm SharedArrayBuffer', t => {
    if (typeof SharedArrayBuffer !== 'function') {
        t.skip('SharedArrayBuffer is unavailable');
        return;
    }
    const foreign = runInNewContext(`(() => {
        const buffer = new SharedArrayBuffer(2);
        new Uint8Array(buffer).set([9, 8]);
        return { buffer, bytes: new Uint8Array(buffer) };
    })()`);
    assert.equal(foreign.buffer instanceof SharedArrayBuffer, false);
    assert.equal(isBunBytePath(foreign.buffer), true);
    assert.equal(isBunBytePath(foreign.bytes), true);
});

test('Bun byte-path brand checks reject array-like and iterable values', () => {
    for (const value of [
        {},
        [1, 2],
        { 0: 1, length: 1 },
        new Set([1, 2]),
        { [Symbol.iterator]: function* () { yield 1; } },
        new Uint16Array(1),
        new Uint8ClampedArray(1),
    ]) {
        assert.equal(isBunBytePath(value), false);
    }
});
