import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { runInNewContext } from 'node:vm';
import { deflateRawSync as nodeDeflateRawSync } from 'node:zlib';
import {
    deflateSync,
    gunzipSync,
    gzipSync,
    inflateSync,
} from '../../cno/src/bun/compression/index.ts';

const decoder = new TextDecoder();

Deno.test('bun: compression helper function shape matches Bun', () => {
    for (const [name, fn] of Object.entries({ gzipSync, gunzipSync, deflateSync, inflateSync })) {
        strictEqual(fn.name, name);
        strictEqual(fn.length, 1);
        strictEqual(Object.hasOwn(fn, 'prototype'), false);
        throws(() => Reflect.construct(fn, []), TypeError);
    }
});

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
    const gzip = gzipSync('hello');
    deepStrictEqual(gzip, gzipSync('hello'));
    strictEqual(Buffer.from(gzip.subarray(0, 9)).toString('hex'), '1f8b08000000000000');
    strictEqual(gzip[9], { linux: 3, darwin: 19, windows: 10 }[Deno.build.os]);
    strictEqual(Buffer.from(gzip.subarray(10)).toString('hex'), 'cb48cdc9c9070086a6103605000000');
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

    const shadowed = new Uint8Array(backing.buffer, 5, text.byteLength);
    Object.defineProperties(shadowed, {
        buffer: { value: new Uint8Array([98, 97, 100]).buffer },
        byteOffset: { value: 0 },
        byteLength: { value: 3 },
    });
    strictEqual(decoder.decode(gunzipSync(gzipSync(shadowed))), 'view-offset-payload');
});

Deno.test('bun: compression accepts shared buffers and rejects forged buffer shapes', () => {
    const rawShared = new SharedArrayBuffer(5);
    new Uint8Array(rawShared).set([104, 101, 108, 108, 111]);
    const shared = new SharedArrayBuffer(9);
    new Uint8Array(shared).set([0xee, 0xee, 104, 101, 108, 108, 111, 0xee, 0xee]);
    strictEqual(decoder.decode(gunzipSync(gzipSync(rawShared as unknown as ArrayBuffer))), 'hello');
    strictEqual(decoder.decode(gunzipSync(gzipSync(new Uint8Array(shared, 2, 5)))), 'hello');
    strictEqual(
        decoder.decode(gunzipSync(gzipSync(new DataView(shared, 2, 5) as unknown as Uint8Array))),
        'hello',
    );

    for (const fake of [
        { [Symbol.toStringTag]: 'ArrayBuffer' },
        { [Symbol.toStringTag]: 'SharedArrayBuffer' },
        { buffer: new ArrayBuffer(1), byteOffset: 0, byteLength: 1 },
    ]) {
        throws(() => gzipSync(fake as never), (error: Error & { code?: string }) =>
            error.name === 'TypeError' && error.code === 'ERR_INVALID_ARG_TYPE');
    }
});

Deno.test('bun: compression accepts cross-realm buffers and view windows', () => {
    const foreign = runInNewContext(`(() => {
        const buffer = new ArrayBuffer(7);
        new Uint8Array(buffer).set([0, 104, 101, 108, 108, 111, 0]);
        return { buffer, typed: new Uint8Array(buffer, 1, 5), data: new DataView(buffer, 1, 5) };
    })()`);
    strictEqual(decoder.decode(gunzipSync(gzipSync(foreign.typed))), 'hello');
    strictEqual(decoder.decode(gunzipSync(gzipSync(foreign.data as never))), 'hello');
    strictEqual(gunzipSync(gzipSync(foreign.buffer)).byteLength, 7);
});

Deno.test('bun: compression captures binary input after option coercion', () => {
    const backing = new ArrayBuffer(5);
    new Uint8Array(backing).set([104, 101, 108, 108, 111]);
    const compressed = gzipSync(new DataView(backing) as unknown as Uint8Array, {
        get level() {
            structuredClone(backing, { transfer: [backing] });
            return 6;
        },
    });
    strictEqual(gunzipSync(compressed).byteLength, 0);

    const shared = new SharedArrayBuffer(5);
    new Uint8Array(shared).set([104, 101, 108, 108, 111]);
    const changed = gzipSync(shared as unknown as ArrayBuffer, {
        get level() {
            new Uint8Array(shared).set([119, 111, 114, 108, 100]);
            return 6;
        },
    });
    strictEqual(decoder.decode(gunzipSync(changed)), 'world');
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
    strictEqual(
        invalid(() => gzipSync('x', { memLevel: false } as never), 'TypeError', 'ERR_INVALID_ARG_TYPE').message,
        'The "ZlibCompressionOptions.memLevel" property must be of type number. Received type boolean (false)',
    );
    strictEqual(
        invalid(() => gzipSync('x', { strategy: 1n } as never), 'TypeError', 'ERR_INVALID_ARG_TYPE').message,
        'The "ZlibCompressionOptions.strategy" property must be of type number. Received type bigint (1n)',
    );
    invalid(() => deflateSync('x', { strategy: 5 } as never), 'RangeError', 'ERR_OUT_OF_RANGE');
    invalid(
        () => gzipSync('x', { library: 'libdeflate', memLevel: 0 } as never),
        'RangeError',
        'ERR_OUT_OF_RANGE',
    );
    invalid(() => gzipSync('x', { library: 'unknown' } as never), 'TypeError', 'ERR_INVALID_ARG_TYPE');
    deepStrictEqual(gzipSync('x', { library: new String('zlib') } as never), gzipSync('x'));
    deepStrictEqual(gzipSync(new String('x') as never), gzipSync('x'));
    throws(() => gzipSync('x', { level: 10 } as never), /Zlib error: Invalid argument/);
    throws(
        () => gzipSync('x', { library: 'libdeflate', level: 13 } as never),
        /Compression level must be between 0 and 12/,
    );
    throws(() => gzipSync('x', { windowBits: Symbol('bits') } as never), /convert symbol to number/i);
    throws(() => gunzipSync(gzipSync('x'), { strategy: Symbol('strategy') } as never), /convert symbol to number/i);
});

Deno.test('bun: compression helpers read and convert option fields in declaration order', () => {
    const events: string[] = [];
    gzipSync('x', {
        get windowBits() {
            events.push('get windowBits');
            return { valueOf() { events.push('coerce windowBits'); return 15; } } as never;
        },
        get library() { events.push('get library'); return 'zlib'; },
        get level() {
            events.push('get level');
            return { valueOf() { events.push('coerce level'); return 1; } } as never;
        },
        get memLevel() { events.push('get memLevel'); return 8; },
        get strategy() { events.push('get strategy'); return 0; },
    });
    deepStrictEqual(events, [
        'get windowBits', 'coerce windowBits', 'get library', 'get level',
        'coerce level', 'get memLevel', 'get strategy',
    ]);

    const decompressionEvents: string[] = [];
    const numeric = (name: string, value: number) => ({
        valueOf() { decompressionEvents.push(`coerce ${name}`); return value; },
    });
    gunzipSync(gzipSync('x'), {
        get windowBits() { decompressionEvents.push('get windowBits'); return numeric('windowBits', 31) as never; },
        get level() { decompressionEvents.push('get level'); return numeric('level', 1) as never; },
        get memLevel() { decompressionEvents.push('get memLevel'); return numeric('memLevel', 1) as never; },
        get strategy() { decompressionEvents.push('get strategy'); return numeric('strategy', 1) as never; },
        get library() { decompressionEvents.push('get library'); return 'zlib'; },
    });
    deepStrictEqual(decompressionEvents, [
        'get windowBits', 'coerce windowBits', 'get level', 'coerce level',
        'get memLevel', 'coerce memLevel', 'get strategy', 'coerce strategy',
        'get library',
    ]);

    const abruptEvents: string[] = [];
    throws(() => gunzipSync(gzipSync('x'), {
        get level() {
            abruptEvents.push('get level');
            return { valueOf() { abruptEvents.push('coerce level'); throw new Error('level conversion'); } } as never;
        },
        get memLevel() { abruptEvents.push('get memLevel'); return 1; },
    }), /level conversion/);
    deepStrictEqual(abruptEvents, ['get level', 'coerce level']);
});

Deno.test('bun: compression option conversion uses captured numeric intrinsics', () => {
    const OriginalNumber = Number;
    const OriginalString = String;
    const numberIsNaN = Number.isNaN;
    const numberIsInteger = Number.isInteger;
    const mathTrunc = Math.trunc;
    const mathMax = Math.max;
    const mathMin = Math.min;
    const objectIs = Object.is;
    const packed = gzipSync('x');
    let compressionWindowCalls = 0;
    let levelCalls = 0;
    let decompressionWindowCalls = 0;
    const events: string[] = [];
    try {
        globalThis.Number = (() => { throw new Error('replacement Number called'); }) as unknown as NumberConstructor;
        globalThis.String = (() => { throw new Error('replacement String called'); }) as unknown as StringConstructor;
        OriginalNumber.isNaN = () => { throw new Error('replacement Number.isNaN called'); };
        OriginalNumber.isInteger = () => { throw new Error('replacement Number.isInteger called'); };
        Math.trunc = () => { throw new Error('replacement Math.trunc called'); };
        Math.max = () => { throw new Error('replacement Math.max called'); };
        Math.min = () => { throw new Error('replacement Math.min called'); };
        Object.is = () => { throw new Error('replacement Object.is called'); };

        const compressed = gzipSync('x', {
            get windowBits() {
                events.push('get windowBits');
                return { valueOf() { compressionWindowCalls++; events.push('coerce windowBits'); return 15; } } as never;
            },
            get library() { events.push('get library'); return 'libdeflate'; },
            get level() {
                events.push('get level');
                return { valueOf() { levelCalls++; events.push('coerce level'); return 12; } } as never;
            },
            get memLevel() { events.push('get memLevel'); return 8; },
            get strategy() { events.push('get strategy'); return 0; },
        });
        if (decoder.decode(gunzipSync(compressed)) !== 'x') throw new Error('compressed result mismatch');
        if (decoder.decode(gunzipSync(packed, {
            windowBits: { valueOf() { decompressionWindowCalls++; return 31.9; } } as never,
        })) !== 'x') throw new Error('decompressed result mismatch');
        const expectedEvents = [
            'get windowBits', 'coerce windowBits', 'get library', 'get level',
            'coerce level', 'get memLevel', 'get strategy',
        ];
        if (events.length !== expectedEvents.length || events.some((event, index) => event !== expectedEvents[index])) {
            throw new Error(`option order mismatch: ${events.join(',')}`);
        }
        if (compressionWindowCalls !== 1 || levelCalls !== 1 || decompressionWindowCalls !== 1) {
            throw new Error('option coercion count mismatch');
        }
        const invalid = (run: () => unknown, name: string, message: string, code: string) => {
            try {
                run();
            } catch (error) {
                const actual = error as Error & { code?: string };
                if (actual.name === name && actual.message === message && actual.code === code) return;
                throw error;
            }
            throw new Error('expected compression option error');
        };
        invalid(
            () => gzipSync('x', { memLevel: false } as never),
            'TypeError',
            'The "ZlibCompressionOptions.memLevel" property must be of type number. Received type boolean (false)',
            'ERR_INVALID_ARG_TYPE',
        );
        invalid(
            () => gzipSync('x', { memLevel: -0 } as never),
            'RangeError',
            'The value of "ZlibCompressionOptions.memLevel" is out of range. It must be >= 1 && <= 9. Received -0',
            'ERR_OUT_OF_RANGE',
        );
    } finally {
        OriginalNumber.isNaN = numberIsNaN;
        OriginalNumber.isInteger = numberIsInteger;
        Math.trunc = mathTrunc;
        Math.max = mathMax;
        Math.min = mathMin;
        Object.is = objectIs;
        globalThis.Number = OriginalNumber;
        globalThis.String = OriginalString;
    }
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
