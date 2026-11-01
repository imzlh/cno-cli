import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nanoseconds } from '../../cno/src/bun/utils/nanoseconds.ts';

test('nanoseconds returns a non-negative integer', () => {
    const value = nanoseconds();
    assert.equal(Number.isInteger(value), true);
    assert.ok(value >= 0);
});

test('nanoseconds is monotonic and advances across a delay', async () => {
    const first = nanoseconds();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = nanoseconds();
    assert.ok(second >= first);
    assert.ok(second - first >= 4_000_000, `expected at least ~4ms, got ${second - first}ns`);
});

test('nanoseconds is on the same scale as performance.now', () => {
    const before = performance.now() * 1_000_000;
    const value = nanoseconds();
    const after = performance.now() * 1_000_000;
    assert.ok(value >= Math.floor(before) && value <= Math.ceil(after) + 1);
});
