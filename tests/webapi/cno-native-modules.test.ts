import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

Deno.test('CNO native algorithm: byte transforms encodings and search helpers', () => {
    const algorithm = import.meta.use('algorithm');

    const input = bytes(0x10, 0x20, 0x30, 0x40, 0x50);
    const key = bytes(0xff, 0x00, 0x0f, 0xf0);
    const masked = algorithm.wsMask(input, key);
    deepStrictEqual([...masked], [0xef, 0x20, 0x3f, 0xb0, 0xaf]);
    deepStrictEqual([...algorithm.wsMask(masked, key)], [...input]);

    const out = bytes(0, 0, 0, 0, 0, 0, 0);
    strictEqual(algorithm.wsMaskInto(input.subarray(0, 3), key, out, 2), out);
    deepStrictEqual([...out], [0, 0, 0xef, 0x20, 0x3f, 0, 0]);

    strictEqual(algorithm.bytesCompare(bytes(1, 2), bytes(1, 3)), -1);
    strictEqual(algorithm.bytesCompare(bytes(1, 3), bytes(1, 2)), 1);
    strictEqual(algorithm.bytesCompare(bytes(1, 2), bytes(1, 2)), 0);
    strictEqual(algorithm.bytesEqual(bytes(1, 2), bytes(1, 2)), true);
    strictEqual(algorithm.bytesEqual(bytes(1, 2), bytes(2, 1)), false);
    strictEqual(algorithm.bytesIsAscii(bytes(0x41, 0x7f)), true);
    strictEqual(algorithm.bytesIsAscii(bytes(0x80)), false);
    strictEqual(algorithm.bytesIsUtf8(new TextEncoder().encode('ok')), true);
    strictEqual(algorithm.bytesIsUtf8(bytes(0xff)), false);

    deepStrictEqual([...algorithm.bytesInvert(bytes(0x00, 0xff, 0x55))], [0xff, 0x00, 0xaa]);
    deepStrictEqual([...algorithm.bytesReverse(bytes(1, 2, 3, 4))], [4, 3, 2, 1]);
    strictEqual(new TextDecoder().decode(algorithm.base64DecodeLoose('aGVsbG8')), 'hello');
    strictEqual(algorithm.base64UrlEncode(bytes(0xff, 0xee)), '_-4');
    strictEqual(new TextDecoder().decode(algorithm.hexDecodeLoose('68656c6c6f')), 'hello');
    deepStrictEqual([...algorithm.bytesFromArrayLike({ 0: 257, 1: -1, length: 2 })], [1, 255]);
    strictEqual(algorithm.asciiDecodeLoose(bytes(0xc1)), 'A');
    strictEqual(algorithm.latin1DecodeLoose(bytes(0xe9)), '\u00e9');
    deepStrictEqual([...algorithm.asciiEncodeLoose('\u00c1A')], [0x41, 0x41]);
    deepStrictEqual([...algorithm.latin1EncodeLoose('A\u00e9')], [0x41, 0xe9]);

    deepStrictEqual([...algorithm.bytesConcat([bytes(1), bytes(2, 3)])], [1, 2, 3]);
    deepStrictEqual([...algorithm.bytesRepeatInto(bytes(0, 0, 0, 0, 0), bytes(1, 2))], [1, 2, 1, 2, 1]);
    deepStrictEqual([...algorithm.bytesSwap16(bytes(1, 2, 3, 4))], [2, 1, 4, 3]);
    deepStrictEqual([...algorithm.bytesSwap32(bytes(1, 2, 3, 4))], [4, 3, 2, 1]);
    strictEqual(algorithm.bytesIndexOf(bytes(1, 2, 3, 2), bytes(2, 3)), 1);
    strictEqual(algorithm.bytesIndexOf(bytes(1, 2, 3), 3), 2);
    strictEqual(algorithm.bytesLastIndexOf(bytes(1, 2, 3, 2), 2), 3);
});

Deno.test('CNO native bjson: stable value round-trips and rejects unsafe shapes', () => {
    const bjson = import.meta.use('bjson');
    const date = new Date('2026-07-05T00:00:00.123Z');
    const input = {
        falsy: {
            empty: '',
            zero: 0,
            negZero: -0,
            no: false,
            nil: null,
            missing: undefined,
        },
        nums: [NaN, Infinity, -Infinity, 1.5],
        ints: [1n, -2n, 0x123456789abcdef123456789n],
        bytes: bytes(0, 1, 2, 255).subarray(1, 4),
        date,
        nested: [{ ok: true }],
    };

    const encoded = bjson.encode(input);
    strictEqual(encoded[0], 0x43);
    strictEqual(bjson.decode<bigint>(bjson.encode(-2n)), -2n);
    const out = bjson.decode<any>(encoded);
    strictEqual(out.falsy.empty, '');
    strictEqual(out.falsy.zero, 0);
    strictEqual(Object.is(out.falsy.negZero, -0), true);
    strictEqual(out.falsy.no, false);
    strictEqual(out.falsy.nil, null);
    strictEqual(out.falsy.missing, undefined);
    strictEqual(Number.isNaN(out.nums[0]), true);
    strictEqual(out.nums[1], Infinity);
    strictEqual(out.nums[2], -Infinity);
    strictEqual(out.nums[3], 1.5);
    deepStrictEqual(out.ints, input.ints);
    deepStrictEqual([...out.bytes], [1, 2, 255]);
    strictEqual(out.date instanceof Date, true);
    strictEqual(out.date.getTime(), date.getTime());
    deepStrictEqual(out.nested, [{ ok: true }]);

    const encodedDate = bjson.encode(date);
    const RealDate = Date;
    (globalThis as any).Date = function BrokenDate() {
        throw new Error('global Date constructor must not run');
    };
    try {
        const decodedDate = bjson.decode<Date>(encodedDate);
        strictEqual(decodedDate instanceof RealDate, true);
        strictEqual(decodedDate.getTime(), date.getTime());
    } finally {
        globalThis.Date = RealDate;
    }

    let setterCalled = false;
    Object.defineProperty(Object.prototype, 'setterProbe', {
        configurable: true,
        set() {
            setterCalled = true;
        },
    });
    try {
        const decoded = bjson.decode<any>(bjson.encode({ setterProbe: 1 }));
        strictEqual(decoded.setterProbe, 1);
        strictEqual(setterCalled, false);
    } finally {
        delete (Object.prototype as any).setterProbe;
    }

    const cyclic: any = {};
    cyclic.self = cyclic;
    throws(() => bjson.encode(cyclic), /cyclic/);
    throws(() => bjson.decode(bytes(1, 2, 3)), /expected CNOBJSON v1/);
    throws(() => bjson.decode(encoded.slice(0, encoded.length - 1)), /truncated BJSON value/);
    throws(() => bjson.decode(new Uint8Array([...encoded, 0])), /trailing bytes/);
    throws(() => bjson.encode({ get nope() { return 1; } }), /accessor properties/);
    throws(() => bjson.encode(new Proxy({ ok: true }, {})), /Proxy/);
    throws(() => bjson.encode(new Map()), /plain objects/);
});

Deno.test('CNO native algorithm: hashes and Xoshiro RNG are deterministic for same inputs', () => {
    const algorithm = import.meta.use('algorithm');
    const payload = new TextEncoder().encode('deterministic');

    strictEqual(algorithm.fnv1a32(payload), algorithm.fnv1a32(payload));
    strictEqual(algorithm.fnv1a64(payload), algorithm.fnv1a64(payload));
    strictEqual(algorithm.murmur3(payload, 123), algorithm.murmur3(payload, 123));
    strictEqual(algorithm.xxHash32(payload, 123), algorithm.xxHash32(payload, 123));
    ok(algorithm.murmur3(payload, 123) !== algorithm.murmur3(payload, 456));

    const rng = new algorithm.XoshiroRNG([1, 2, 3, 4]);
    const clone = rng.clone();
    strictEqual(clone.next(), rng.next());
    const value = rng.nextDouble();
    ok(value >= 0 && value < 1);
    rng.jump();
    rng.longJump();
    ok(typeof rng.next() === 'bigint');
});

Deno.test('CNO native text: iconv encoder decoder streaming and conversion semantics', () => {
    const text = import.meta.use('text');

    const utf8 = new text.Encoder('utf-8');
    const utf8Bytes = utf8.encode('Hi \u4e16\u754c');
    strictEqual(new text.Decoder('utf-8').decode(utf8Bytes), 'Hi \u4e16\u754c');

    const target = new Uint8Array(8);
    const into = utf8.encodeInto('Hello', target);
    deepStrictEqual(into, { read: 5, written: 5 });
    strictEqual(new TextDecoder().decode(target.subarray(0, into.written)), 'Hello');

    const streaming = new text.Decoder('utf-8');
    strictEqual(streaming.decode(bytes(0xe4, 0xb8), { stream: true }), '');
    strictEqual(streaming.decode(bytes(0xad), { stream: false }), '\u4e2d');

    const gbk = new text.Encoder('GBK').encode('\u4f60\u597d');
    deepStrictEqual([...gbk], [0xc4, 0xe3, 0xba, 0xc3]);
    strictEqual(new text.Decoder('GBK').decode(gbk), '\u4f60\u597d');
    strictEqual(text.convert('GBK', 'UTF-8', gbk), '\u4f60\u597d');
    ok(text.listEncodings().some((encoding: string) => encoding.toLowerCase() === 'utf-8'));
});

Deno.test('CNO native xml: parser streams elements character data comments and cdata', () => {
    const xml = import.meta.use('xml');
    const events: string[] = [];
    const parser = new xml.Parser();

    strictEqual(parser
        .on('startElement', (name: string, attrs: Record<string, string>) => events.push(`start:${name}:${attrs.id ?? ''}`))
        .on('characterData', (data: string) => {
            if (data) events.push(`text:${data}`);
        })
        .on('startCDATA', () => events.push('cdata:start'))
        .on('endCDATA', () => events.push('cdata:end'))
        .on('comment', (data: string) => events.push(`comment:${data}`))
        .on('processingInstruction', (target: string, data: string) => events.push(`pi:${target}:${data}`))
        .on('endElement', (name: string) => events.push(`end:${name}`)), parser);

    strictEqual(parser.parse('<root><item id="1">hi', false), true);
    strictEqual(parser.parse('<![CDATA[<x>]]><!--c--><?pi ok?></item></root>', true), true);
    deepStrictEqual(events, [
        'start:root:',
        'start:item:1',
        'text:hi',
        'cdata:start',
        'text:<x>',
        'cdata:end',
        'comment:c',
        'pi:pi:ok',
        'end:item',
        'end:root',
    ]);
    ok(parser.line >= 1);
    ok(parser.column >= 0);
    strictEqual(xml.escape('<>&"\''), '&lt;&gt;&amp;&quot;&apos;');
});

Deno.test('CNO native sourcemap: load lookup and remove simple mappings', () => {
    const sourcemap = import.meta.use('sourcemap');
    const file = `/virtual/cno-native-${Deno.pid}-${Date.now()}.js`;
    const map = {
        version: 3,
        file: 'out.js',
        sources: ['source.ts'],
        names: [],
        mappings: 'AAAA',
    };

    strictEqual(sourcemap.has(file), false);
    strictEqual(sourcemap.loadJSON(file, JSON.stringify(map)), 1);
    strictEqual(sourcemap.has(file), true);

    const mapping = sourcemap.getMapping(file, 1, 0);
    strictEqual(mapping.found, true);
    strictEqual(mapping.original_file, 'source.ts');
    strictEqual(mapping.original_line, 1);
    strictEqual(mapping.original_column, 0);

    strictEqual(sourcemap.remove(file), true);
    strictEqual(sourcemap.has(file), false);
    strictEqual(sourcemap.remove(file), false);
});
