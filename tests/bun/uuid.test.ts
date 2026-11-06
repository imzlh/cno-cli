import { deepStrictEqual, strictEqual, throws, ok } from 'node:assert';
import { runInNewContext } from 'node:vm';
import { randomUUIDv7 } from '../../cno/src/bun/uuid/index.ts';

Deno.test('bun: UUIDv7 timestamp, version, variant and encodings', () => {
    const bytes = randomUUIDv7('buffer', 0x123456789abc);
    strictEqual(bytes.length, 16);
    strictEqual(bytes.byteOffset, 0);
    strictEqual(bytes.buffer.byteLength, 16);
    strictEqual(bytes.subarray(0, 6).toString('hex'), '123456789abc');
    strictEqual(bytes[6] >> 4, 7);
    strictEqual(bytes[8] >> 6, 2);
    ok(/^12345678-9abc-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(randomUUIDv7('hex', new Date(0x123456789abc))));
    strictEqual(Buffer.from(randomUUIDv7('base64', 42), 'base64').length, 16);
    strictEqual(Buffer.from(randomUUIDv7('base64url', 42), 'base64url').length, 16);
    ok(randomUUIDv7(42).startsWith('00000000-002a-7'));
});

Deno.test('bun: UUIDv7 increments within a repeated timestamp', () => {
    const first = randomUUIDv7('buffer', 123456);
    const second = randomUUIDv7('buffer', 123456);
    const firstTime = first.subarray(0, 6).toString('hex');
    const secondTime = second.subarray(0, 6).toString('hex');
    const firstCounter = ((first[6] & 0x0f) << 8) | first[7];
    const secondCounter = ((second[6] & 0x0f) << 8) | second[7];
    ok(first.compare(second) < 0);
    strictEqual(firstTime, '00000001e240');
    strictEqual(secondTime, firstTime);
    ok(firstCounter <= 0x7ff);
    strictEqual(secondCounter, firstCounter + 1);
});

Deno.test('bun: UUIDv7 follows Bun coercion across realms', () => {
    const foreign = runInNewContext(`(() => {
        const bytes = new Uint8Array([0, 104, 101, 120, 0]);
        return {
            date: new Date(0x123456789abc),
            invalidDate: new Date(NaN),
            encoding: new String('buffer'),
            view: new DataView(bytes.buffer, 1, 3),
        };
    })()`);
    strictEqual(randomUUIDv7(foreign.date).slice(0, 13), '12345678-9abc');
    strictEqual(randomUUIDv7('buffer', foreign.date).subarray(0, 6).toString('hex'), '123456789abc');
    throws(() => randomUUIDv7('hex', foreign.invalidDate), { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' });

    const calls: string[] = [];
    Object.defineProperty(foreign.encoding, Symbol.toPrimitive, {
        value(hint: string) {
            calls.push(hint);
            return 'buffer';
        },
    });
    strictEqual(Buffer.isBuffer((randomUUIDv7 as any)(foreign.encoding, 42)), true);
    deepStrictEqual(calls, ['string']);

    strictEqual((randomUUIDv7 as any)(41, 42).slice(0, 13), '00000000-002a');
    strictEqual((randomUUIDv7 as any)(foreign.view, 42).slice(0, 13), '00000000-002a');
    throws(() => (randomUUIDv7 as any)(foreign.view), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });

    const date = new Date(42);
    Object.defineProperty(date, 'getTime', { value: () => 43 });
    strictEqual(randomUUIDv7(date).slice(0, 13), '00000000-002a');
});

Deno.test('bun: UUIDv7 has Bun function shape', () => {
    strictEqual(randomUUIDv7.name, 'randomUUIDv7');
    strictEqual(randomUUIDv7.length, 2);
    deepStrictEqual(Reflect.ownKeys(randomUUIDv7), ['length', 'name']);
    strictEqual(Object.hasOwn(randomUUIDv7, 'prototype'), false);
    deepStrictEqual(Object.getOwnPropertyDescriptor(randomUUIDv7, 'length'), {
        value: 2,
        writable: false,
        enumerable: false,
        configurable: true,
    });
    deepStrictEqual(Object.getOwnPropertyDescriptor(randomUUIDv7, 'name'), {
        value: 'randomUUIDv7',
        writable: false,
        enumerable: false,
        configurable: true,
    });
    throws(() => new (randomUUIDv7 as any)(), TypeError);
});

Deno.test('bun: UUIDv7 rejects invalid encoding and timestamps', () => {
    throws(() => randomUUIDv7('invalid' as 'hex'), { name: 'TypeError', code: 'ERR_UNKNOWN_ENCODING' });
    strictEqual(Buffer.isBuffer(randomUUIDv7('BUFFER' as 'buffer', 0)), true);
    ok(/^00000000-0000-7/.test(randomUUIDv7('HEX' as 'hex', 0)));
    ok(/^00000000-0000-7/.test((randomUUIDv7 as any)({}, 0)));
    throws(() => (randomUUIDv7 as any)(null), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
    throws(() => (randomUUIDv7 as any)('hex', null), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
    throws(() => (randomUUIDv7 as any)('hex', 1.5), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
    for (const time of [-1, NaN, Infinity, 2 ** 48, 1.5]) {
        throws(() => randomUUIDv7('hex', time), time === 1.5
            ? { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }
            : { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' });
    }
    throws(() => randomUUIDv7('hex', new Date(NaN)), { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' });
});
