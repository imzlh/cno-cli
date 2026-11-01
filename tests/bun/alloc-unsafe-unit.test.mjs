import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocUnsafe } from '../../cno/src/bun/utils/alloc-unsafe.ts';

test('allocUnsafe returns a Uint8Array of the requested length', () => {
    for (const size of [0, 1, 7, 4096]) {
        const buffer = allocUnsafe(size);
        assert.ok(buffer instanceof Uint8Array);
        assert.equal(buffer.length, size);
    }
});

test('allocUnsafe zero-fills, so no stale bytes are observable', () => {
    const buffer = allocUnsafe(1024);
    assert.equal(buffer.every((byte) => byte === 0), true);
});

test('allocUnsafe returns independent buffers without pooling', () => {
    const a = allocUnsafe(16);
    const b = allocUnsafe(16);
    assert.notEqual(a.buffer, b.buffer);
    a[0] = 0xff;
    assert.equal(b[0], 0);
});

test('allocUnsafe validates size', () => {
    assert.throws(() => allocUnsafe(-1), RangeError);
    assert.throws(() => allocUnsafe(1.5), TypeError);
    assert.throws(() => allocUnsafe(Number.NaN), TypeError);
    assert.throws(() => allocUnsafe('8'), TypeError);
});
