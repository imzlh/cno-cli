import { strictEqual, throws, ok } from 'node:assert';
import { randomUUIDv7 } from '../../cno/src/bun/uuid/index.ts';

Deno.test('bun: UUIDv7 timestamp, version, variant and encodings', () => {
    const bytes = randomUUIDv7('buffer', 0x123456789abc);
    strictEqual(bytes.length, 16);
    strictEqual(bytes.subarray(0, 6).toString('hex'), '123456789abc');
    strictEqual(bytes[6] >> 4, 7);
    strictEqual(bytes[8] >> 6, 2);
    ok(/^12345678-9abc-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(randomUUIDv7('hex', new Date(0x123456789abc))));
    strictEqual(Buffer.from(randomUUIDv7('base64', 42), 'base64').length, 16);
    strictEqual(Buffer.from(randomUUIDv7('base64url', 42), 'base64url').length, 16);
    ok(randomUUIDv7(42).startsWith('00000000-002a-7'));
});

Deno.test('bun: UUIDv7 is ordered within a timestamp including counter rollover', () => {
    let previous = randomUUIDv7('hex', 123456);
    for (let i = 0; i < 5000; i++) {
        const next = randomUUIDv7('hex', 123456);
        ok(previous < next);
        previous = next;
    }
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
