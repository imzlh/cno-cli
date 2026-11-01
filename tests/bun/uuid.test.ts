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
    throws(() => randomUUIDv7('invalid' as 'hex'), TypeError);
    for (const time of [-1, NaN, Infinity, 2 ** 48, 1.5]) {
        throws(() => randomUUIDv7('hex', time), RangeError);
    }
    throws(() => randomUUIDv7('hex', new Date(NaN)), RangeError);
});
