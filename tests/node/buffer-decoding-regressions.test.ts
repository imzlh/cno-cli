import { strictEqual } from 'node:assert';
import { Buffer } from 'node:buffer';

Deno.test('buffer: toString clamps negative and excessive byte offsets', () => {
    const buffer = Buffer.from('abcdef');
    const cases: [number, number, string][] = [
        [-1, 6, 'abcdef'], [0, 100, 'abcdef'], [100, 101, ''],
        [0, -1, ''], [-Infinity, Infinity, 'abcdef'], [Infinity, Infinity, ''],
        [1.9, 4.9, 'bcd'], [NaN, 3, 'abc'], [1, NaN, ''],
        [0, 2 ** 32 + 1, 'abcdef'], [2 ** 32, Infinity, ''],
    ];
    for (const [start, end, expected] of cases) {
        strictEqual(buffer.toString('utf8', start, end), expected, `${start}:${end}`);
    }
});

Deno.test('buffer: UTF-8 replacement rejects overlong and out-of-range prefixes byte by byte', () => {
    const cases: [number[], string][] = [
        [[0xe0, 0x80, 0x80], '\ufffd\ufffd\ufffd'],
        [[0xe0, 0x9f, 0xbf], '\ufffd\ufffd\ufffd'],
        [[0xf0, 0x80, 0x80, 0x80], '\ufffd\ufffd\ufffd\ufffd'],
        [[0xf0, 0x8f, 0xbf, 0xbf], '\ufffd\ufffd\ufffd\ufffd'],
        [[0xe0, 0x80, 0x41], '\ufffd\ufffdA'],
        [[0xed, 0xa0, 0x80], '\ufffd\ufffd\ufffd'],
        [[0xf4, 0x90, 0x80, 0x80], '\ufffd\ufffd\ufffd\ufffd'],
        [[0xe0, 0xa0], '\ufffd'],
        [[0xf0, 0x90, 0x80], '\ufffd'],
        [[0xe4, 0xbd, 0x41], '\ufffdA'],
        [[0xe0, 0xa0, 0x80], '\u0800'],
        [[0xf0, 0x90, 0x80, 0x80], '\u{10000}'],
    ];
    for (const [bytes, expected] of cases) {
        strictEqual(Buffer.from(bytes).toString(), expected, bytes.join(','));
        strictEqual(Buffer.from([0x41, ...bytes, 0x42]).toString(), `A${expected}B`, bytes.join(','));
    }
});
