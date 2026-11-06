import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const calls = [];
const source = (await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['cno/src/bun/sleep-sync.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2024',
    write: false,
    define: { 'import.meta.use': '__sleepSyncUse__' },
})).outputFiles[0].text;
const module = { exports: {} };
runInNewContext(source, {
    module,
    exports: module.exports,
    __sleepSyncUse__(name) {
        assert.equal(name, 'os');
        return { sleep: (duration) => calls.push(duration) };
    },
});
const { sleepSync } = module.exports;

test('sleepSync has the Bun function shape', () => {
    assert.equal(sleepSync.name, 'sleepSync');
    assert.equal(sleepSync.length, 1);
    assert.equal(Object.hasOwn(sleepSync, 'prototype'), false);
    assert.deepEqual(Object.getOwnPropertyDescriptor(sleepSync, 'name'), {
        value: 'sleepSync', writable: false, enumerable: false, configurable: true,
    });
    assert.deepEqual(Object.getOwnPropertyDescriptor(sleepSync, 'length'), {
        value: 1, writable: false, enumerable: false, configurable: true,
    });
    assert.throws(() => Reflect.construct(sleepSync, [0]), { name: 'TypeError' });
});

test('sleepSync validates before coercion or native sleep', () => {
    calls.length = 0;
    let traps = 0;
    const value = new Proxy({
        valueOf() { traps++; return 0; },
        [Symbol.toPrimitive]() { traps++; return 0; },
    }, {
        get(target, property, receiver) {
            traps++;
            return Reflect.get(target, property, receiver);
        },
    });

    for (const input of [undefined, null, false, '0', 0n, Symbol('x'), value, new Number(0)]) {
        assert.throws(() => sleepSync(input), {
            name: 'TypeError',
            message: 'milliseconds must be a number',
            code: 'ERR_INVALID_ARG_TYPE',
        });
    }
    assert.equal(traps, 0);
    assert.deepEqual(calls, []);
});

test('sleepSync truncates and saturates without actually waiting', () => {
    calls.length = 0;
    for (const input of [0, -0, NaN, -0.9, 0.9, 1.9, 2147483646.9, 2147483647, 2147483648, Number.MAX_VALUE, Infinity]) {
        assert.equal(sleepSync(input), undefined);
    }

    assert.equal(calls.length, 11);
    assert.deepEqual(calls.slice(4), [0, 1, 2147483646, 2147483647, 2147483647, 2147483647, 2147483647]);
    for (const duration of calls.slice(0, 4)) assert.equal(duration === 0, true);
});

test('sleepSync rejects saturated negative durations before native sleep', () => {
    calls.length = 0;
    for (const [input, duration] of [[-1, -1], [-1.9, -1], [-2147483647.9, -2147483647], [-2147483649, -2147483648], [-Infinity, -2147483648]]) {
        assert.throws(() => sleepSync(input), {
            name: 'TypeError',
            message: `argument to sleepSync must not be negative, got ${duration}`,
            code: 'ERR_INVALID_ARG_TYPE',
        });
    }
    assert.deepEqual(calls, []);
});
