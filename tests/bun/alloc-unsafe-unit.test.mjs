import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocUnsafe } from '../../cno/src/bun/utils/alloc-unsafe.ts';

test('allocUnsafe has the Bun function shape', () => {
    assert.equal(allocUnsafe.name, 'allocUnsafe');
    assert.equal(allocUnsafe.length, 1);
    assert.deepEqual(Reflect.ownKeys(allocUnsafe), ['length', 'name']);
    assert.equal(Object.hasOwn(allocUnsafe, 'prototype'), false);
    assert.deepEqual(Object.getOwnPropertyDescriptor(allocUnsafe, 'name'), {
        value: 'allocUnsafe', writable: false, enumerable: false, configurable: true,
    });
    assert.deepEqual(Object.getOwnPropertyDescriptor(allocUnsafe, 'length'), {
        value: 1, writable: false, enumerable: false, configurable: true,
    });
    assert.throws(() => Reflect.construct(allocUnsafe, [1]), TypeError);
});

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
    for (const [value, received] of [
        [undefined, 'undefined'],
        [null, 'null'],
        [false, 'type boolean (false)'],
        ['8', "type string ('8')"],
        [1n, 'type bigint (1n)'],
        [Symbol('size'), 'type symbol (Symbol(size))'],
        [{}, 'an instance of Object'],
        [Object.create(null), '[Object: null prototype] {}'],
        [new Number(8), 'an instance of Number'],
        [function example() {}, 'function example'],
    ]) {
        assert.throws(() => allocUnsafe(value), {
            name: 'TypeError',
            code: 'ERR_INVALID_ARG_TYPE',
            message: `The "size" argument must be of type number. Received ${received}`,
        });
    }
    for (const value of [Number.NaN, Infinity, -Infinity, -1.5, 0.5, 0x1_0000_0000 + 0.5]) {
        assert.throws(() => allocUnsafe(value), {
            name: 'RangeError',
            code: 'ERR_OUT_OF_RANGE',
            message: `The value of "size" is out of range. It must be an integer. Received ${value}`,
        });
    }
    for (const [value, received] of [
        [-1, '-1'],
        [0x1_0000_0000, '4294967296'],
        [0x1_0000_0001, '4_294_967_297'],
        [Number.MAX_SAFE_INTEGER, '9_007_199_254_740_991'],
    ]) {
        assert.throws(() => allocUnsafe(value), {
            name: 'RangeError',
            code: 'ERR_OUT_OF_RANGE',
            message: `The value of "size" is out of range. It must be >= 0 && <= 4294967295. Received ${received}`,
        });
    }
    assert.equal(allocUnsafe(-0).length, 0);
});

test('allocUnsafe rejects by type before touching numeric coercion hooks', () => {
    let calls = 0;
    const value = {
        valueOf() { calls++; return 1; },
        [Symbol.toPrimitive]() { calls++; return 1; },
    };

    assert.throws(() => allocUnsafe(value), {
        name: 'TypeError',
        code: 'ERR_INVALID_ARG_TYPE',
        message: 'The "size" argument must be of type number. Received an instance of Object',
    });
    assert.equal(calls, 0);
});
