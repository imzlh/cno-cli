import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nanoseconds } from '../../cno/src/bun/utils/nanoseconds.ts';

test('nanoseconds has Bun function shape', () => {
    assert.equal(nanoseconds.name, 'nanoseconds');
    assert.equal(nanoseconds.length, 0);
    assert.equal(Object.hasOwn(nanoseconds, 'prototype'), false);
    assert.throws(() => Reflect.construct(nanoseconds, []), TypeError);
});

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

test('nanoseconds ignores later performance overrides', () => {
    const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    assert.ok(performanceDescriptor);
    const originalPerformance = globalThis.performance;
    const nowDescriptor = Object.getOwnPropertyDescriptor(originalPerformance, 'now');
    let calls = 0;

    try {
        const first = nanoseconds();
        Object.defineProperty(globalThis, 'performance', {
            configurable: true,
            value: { now() { calls++; return -1; } },
            writable: true,
        });
        const afterGlobalOverride = nanoseconds();
        assert.equal(calls, 0);
        assert.ok(afterGlobalOverride >= first);

        Object.defineProperty(globalThis, 'performance', performanceDescriptor);
        Object.defineProperty(originalPerformance, 'now', {
            configurable: true,
            value() { calls++; return -2; },
            writable: true,
        });
        const afterNowOverride = nanoseconds();
        assert.equal(calls, 0);
        assert.ok(afterNowOverride >= afterGlobalOverride);
    } finally {
        if (nowDescriptor) Object.defineProperty(originalPerformance, 'now', nowDescriptor);
        else Reflect.deleteProperty(originalPerformance, 'now');
        Object.defineProperty(globalThis, 'performance', performanceDescriptor);
    }
});
