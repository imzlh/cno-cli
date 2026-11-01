import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { deflateRawSync as nodeDeflateRawSync } from 'node:zlib';
import {
    deflateSync,
    gunzipSync,
    gzipSync,
    inflateSync,
} from '../../cno/src/bun/compression/index.ts';

const decoder = new TextDecoder();

Deno.test('bun: compression helpers round-trip gzip and raw deflate', () => {
    const text = 'Bun compression compatibility payload. '.repeat(64);
    const input = new TextEncoder().encode(text);
    const gzip = gzipSync(input);
    const deflate = deflateSync(input);

    strictEqual(Buffer.isBuffer(gzip), false);
    strictEqual(Buffer.isBuffer(deflate), false);
    ok(gzip instanceof Uint8Array);
    ok(deflate instanceof Uint8Array);
    deepStrictEqual(Array.from(gzip.subarray(0, 3)), [0x1f, 0x8b, 0x08]);
    strictEqual(decoder.decode(gunzipSync(gzip)), text);
    strictEqual(decoder.decode(inflateSync(deflate)), text);
});

Deno.test('bun: deflateSync uses raw DEFLATE and gzip output is deterministic', () => {
    const deflated = deflateSync('hello');
    const expectedRaw = nodeDeflateRawSync('hello');
    deepStrictEqual(Array.from(deflated), Array.from(expectedRaw));
    strictEqual(Buffer.from(deflated).toString('hex'), 'cb48cdc9c90700');
    strictEqual(
        Buffer.from(gzipSync('hello')).toString('hex'),
        '1f8b0800000000000003cb48cdc9c9070086a6103605000000',
    );
    strictEqual(
        Buffer.from(gzipSync('hello', { library: 'libdeflate' })).toString('hex'),
        '1f8b08000000000000ffcb48cdc9c9070086a6103605000000',
    );
});

Deno.test('bun: compression consumes only the selected ArrayBufferView bytes', () => {
    const text = new TextEncoder().encode('view-offset-payload');
    const backing = new Uint8Array(text.byteLength + 12);
    backing.fill(0xee);
    backing.set(text, 5);

    const bytes = backing.subarray(5, 5 + text.byteLength);
    const dataView = new DataView(backing.buffer, 5, text.byteLength);
    const words = new Uint16Array(backing.buffer, 6, 4);

    strictEqual(decoder.decode(gunzipSync(gzipSync(bytes))), 'view-offset-payload');
    strictEqual(decoder.decode(gunzipSync(gzipSync(dataView as unknown as Uint8Array))), 'view-offset-payload');
    deepStrictEqual(
        Array.from(inflateSync(deflateSync(words as unknown as Uint8Array))),
        Array.from(new Uint8Array(words.buffer, words.byteOffset, words.byteLength)),
    );

    const packed = gzipSync(bytes);
    const packedBacking = new Uint8Array(packed.byteLength + 9);
    packedBacking.fill(0xcc);
    packedBacking.set(packed, 4);
    strictEqual(
        decoder.decode(gunzipSync(new DataView(packedBacking.buffer, 4, packed.byteLength) as unknown as Uint8Array)),
        'view-offset-payload',
    );
});

Deno.test('bun: compression levels, memory level, and strategy reach zlib', () => {
    const input = 'compressible '.repeat(200);
    const stored = gzipSync(input, { level: 0 });
    const compressed = gzipSync(input, { level: 9, memLevel: 9, strategy: 0 });

    ok(stored.byteLength > compressed.byteLength);
    strictEqual(decoder.decode(gunzipSync(stored)), input);
    strictEqual(decoder.decode(gunzipSync(compressed)), input);
    // Bun truncates level rather than applying the strict integer validation
    // used for memLevel and strategy.
    deepStrictEqual(gzipSync(input, { level: 1.9 }), gzipSync(input, { level: 1 }));
    strictEqual(decoder.decode(inflateSync(deflateSync(input, { library: 'libdeflate', level: 12 }))), input);
});

Deno.test('bun: compression validates options with Bun-compatible errors', () => {
    const invalid = (callback: () => unknown, name: string, code: string) => {
        let error: (Error & { code?: string }) | undefined;
        try {
            callback();
        } catch (caught) {
            error = caught as Error & { code?: string };
        }
        ok(error);
        strictEqual(error.name, name);
        strictEqual(error.code, code);
        return error;
    };

    invalid(() => gzipSync('x', null as never), 'TypeError', 'ERR_INVALID_ARG_TYPE');
    invalid(() => gzipSync('x', { memLevel: 0 } as never), 'RangeError', 'ERR_OUT_OF_RANGE');
    invalid(() => gzipSync('x', { memLevel: 1.5 } as never), 'RangeError', 'ERR_OUT_OF_RANGE');
    invalid(() => deflateSync('x', { strategy: 5 } as never), 'RangeError', 'ERR_OUT_OF_RANGE');
    invalid(
        () => gzipSync('x', { library: 'libdeflate', memLevel: 0 } as never),
        'RangeError',
        'ERR_OUT_OF_RANGE',
    );
    invalid(() => gzipSync('x', { library: 'unknown' } as never), 'TypeError', 'ERR_INVALID_ARG_TYPE');
    throws(() => gzipSync('x', { level: 10 } as never), /Zlib error: Invalid argument/);
    throws(
        () => gzipSync('x', { library: 'libdeflate', level: 13 } as never),
        /Compression level must be between 0 and 12/,
    );
    throws(() => gzipSync('x', { windowBits: Symbol('bits') } as never), /convert symbol to number/i);
    throws(() => gunzipSync(gzipSync('x'), { strategy: Symbol('strategy') } as never), /convert symbol to number/i);
});

Deno.test('bun: compression rejects invalid input and incomplete streams', () => {
    let invalid: (Error & { code?: string }) | undefined;
    try {
        gzipSync(undefined as never);
    } catch (caught) {
        invalid = caught as Error & { code?: string };
    }
    ok(invalid);
    strictEqual(invalid.name, 'TypeError');
    strictEqual(invalid.code, 'ERR_INVALID_ARG_TYPE');
    strictEqual(invalid.message, 'data must be a string, ArrayBuffer or ArrayBufferView');

    const gzip = gzipSync('must have a complete trailer');
    const deflate = deflateSync('must have a complete trailer');
    throws(() => gunzipSync(new Uint8Array()), /Zlib returned an error/);
    throws(() => inflateSync(new Uint8Array()), /Zlib returned an error/);
    throws(() => gunzipSync(gzip.subarray(0, -1)), /Zlib returned an error/);
    throws(() => inflateSync(deflate.subarray(0, -1)), /Zlib returned an error/);
});

Deno.test('bun: decompression stops after the first stream and ignores trailing bytes', () => {
    const firstGzip = gzipSync('first');
    const secondGzip = gzipSync('second');
    const joinedGzip = new Uint8Array(firstGzip.length + secondGzip.length + 3);
    joinedGzip.set(firstGzip);
    joinedGzip.set(secondGzip, firstGzip.length);
    joinedGzip.set([1, 2, 3], firstGzip.length + secondGzip.length);
    strictEqual(decoder.decode(gunzipSync(joinedGzip)), 'first');

    const firstRaw = deflateSync('raw-first');
    const secondRaw = deflateSync('raw-second');
    const joinedRaw = new Uint8Array(firstRaw.length + secondRaw.length);
    joinedRaw.set(firstRaw);
    joinedRaw.set(secondRaw, firstRaw.length);
    strictEqual(decoder.decode(inflateSync(joinedRaw)), 'raw-first');
});
