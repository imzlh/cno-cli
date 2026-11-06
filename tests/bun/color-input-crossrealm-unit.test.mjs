// @cno-host: false
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const bundled = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['cno/src/bun/utils/color.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    write: false,
    define: { 'import.meta.use': '__test_use__' },
});
globalThis.__test_use__ = name => name === 'engine'
    ? { isProxy: () => false }
    : undefined;
const { color } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('Bun.color recognizes indexed typed arrays across realms', () => {
    const foreign = runInNewContext(`({
        bytes: new Uint8Array([7, 8, 9, 10]),
        floats: new Float64Array([1.9, 256, -5, .5]),
        view: new DataView(new ArrayBuffer(3)),
    })`);
    assert.equal(foreign.bytes instanceof Uint8Array, false);
    assert.equal(ArrayBuffer.isView(foreign.bytes), true);
    assert.equal(ArrayBuffer.isView(foreign.floats), true);
    assert.equal(ArrayBuffer.isView(foreign.view), true);
    assert.deepEqual(color(foreign.bytes, '[rgba]'), [7, 8, 9, 10]);
    assert.deepEqual(color(foreign.floats, '[rgba]'), [1, 255, 0, 0]);
    assert.throws(() => color(foreign.view), /Expected r to be a integer/);
});
