import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';

Deno.test('webapi upstream: TextDecoder decodes utf8 ascii label and SharedArrayBuffer views', () => {
    const fixture = new Uint8Array([
        0xf0, 0x9d, 0x93, 0xbd,
        0xf0, 0x9d, 0x93, 0xae,
        0xf0, 0x9d, 0x94, 0x81,
        0xf0, 0x9d, 0x93, 0xbd,
    ]);
    strictEqual(new TextDecoder().decode(fixture), '𝓽𝓮𝔁𝓽');
    strictEqual(new TextDecoder('ascii').decode(new Uint8Array([0x89, 0x95, 0x9f, 0xbf])), '‰•Ÿ¿');

    const shared = new SharedArrayBuffer(8);
    const view = new DataView(shared);
    for (let i = 0; i < shared.byteLength; i++) view.setUint8(i, 'A'.charCodeAt(0) + i);
    strictEqual(new TextDecoder().decode(new Uint8Array(shared, 0, 6)), 'ABCDEF');
    strictEqual(new TextDecoder().decode(new Int32Array(shared)), 'ABCDEFGH');
    strictEqual(new TextDecoder().encoding, 'utf-8');
    strictEqual(new TextDecoder('ascii').encoding, 'windows-1252');

    throws(() => new TextDecoder('Foo'), Error);
});

Deno.test('webapi upstream: TextEncoder encode and encodeInto handle surrogate boundaries', () => {
    const encoder = new TextEncoder();
    const cjkBytes = new Uint8Array(64);
    const cjk = encoder.encodeInto('异世界悠闲农家 第二季', cjkBytes);
    deepStrictEqual(cjk, { read: 11, written: 31 });
    strictEqual(
        new TextDecoder().decode(cjkBytes.subarray(0, cjk.written)),
        '异世界悠闲农家 第二季',
    );

    deepStrictEqual([...encoder.encode('𝓽𝓮𝔁𝓽')], [
        0xf0, 0x9d, 0x93, 0xbd,
        0xf0, 0x9d, 0x93, 0xae,
        0xf0, 0x9d, 0x94, 0x81,
        0xf0, 0x9d, 0x93, 0xbd,
    ]);

    let bytes = new Uint8Array(17);
    strictEqual(encoder.encodeInto('𝓽𝓮𝔁𝓽', bytes).read, 8);
    deepStrictEqual([...bytes], [
        0xf0, 0x9d, 0x93, 0xbd,
        0xf0, 0x9d, 0x93, 0xae,
        0xf0, 0x9d, 0x94, 0x81,
        0xf0, 0x9d, 0x93, 0xbd,
        0x00,
    ]);

    bytes = new Uint8Array(20);
    const result = encoder.encodeInto('lone𝄞\ud888surrogate', bytes);
    deepStrictEqual(result, { read: 16, written: 20 });
    deepStrictEqual([...bytes], [
        0x6c, 0x6f, 0x6e, 0x65,
        0xf0, 0x9d, 0x84, 0x9e,
        0xef, 0xbf, 0xbd, 0x73,
        0x75, 0x72, 0x72, 0x6f,
        0x67, 0x61, 0x74, 0x65,
    ]);

    bytes = new Uint8Array(8);
    deepStrictEqual(encoder.encodeInto('\udc00\ud800', bytes), { read: 2, written: 6 });
    deepStrictEqual([...bytes], [0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd, 0x00, 0x00]);
});

Deno.test('webapi upstream: TextEncoder coerces input and toString tags are web-compatible', () => {
    const encoder = new TextEncoder();
    const input = { toString: () => 'text' };
    strictEqual(new TextDecoder().decode(encoder.encode(input as unknown as string)), 'text');
    strictEqual(TextEncoder.length, 0);
    strictEqual(TextDecoder.length, 0);
    strictEqual(TextEncoder.prototype.encode.length, 0);
    strictEqual(TextEncoder.prototype.encodeInto.length, 2);
    strictEqual(TextDecoder.prototype.decode.length, 0);
    strictEqual(Object.prototype.hasOwnProperty.call(TextDecoder.prototype, 'toString'), false);
    strictEqual(encoder.toString(), '[object TextEncoder]');
    strictEqual(new TextDecoder().toString(), '[object TextDecoder]');
    ok(encoder.encode() instanceof Uint8Array);
    strictEqual(encoder.encode().length, 0);
});

Deno.test('webapi upstream: TextDecoderStream cancels the source when iteration stops early', async () => {
    let cancelled = false;
    const readable = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(12));
        },
        cancel() {
            cancelled = true;
        },
    }).pipeThrough(new TextDecoderStream());

    const chunks: string[] = [];
    for await (const chunk of readable) {
        chunks.push(chunk);
        break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    strictEqual(chunks.length, 1);
    strictEqual(chunks[0]!.length, 12);
    strictEqual(cancelled, true);

    let manualCancelled = false;
    const manual = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(4));
        },
        cancel() {
            manualCancelled = true;
        },
    }).pipeThrough(new TextDecoderStream());
    const reader = manual.getReader();
    await reader.read();
    await reader.cancel();
    strictEqual(manualCancelled, true);
});

Deno.test('webapi upstream: TextDecoder handles empty chunk in stream mode for legacy encodings', () => {
    const cases: Array<[string, Uint8Array, string]> = [
        ['big5', new Uint8Array([0xa4, 0xa4]), '\u4e2d'],
        ['shift_jis', new Uint8Array([0x82, 0xa0]), '\u3042'],
        ['euc-kr', new Uint8Array([0xb0, 0xa1]), '\uac00'],
    ];

    for (const [encoding, bytes, expected] of cases) {
        const decoder = new TextDecoder(encoding);
        const chunks = [
            decoder.decode(bytes.subarray(0, 1), { stream: true }),
            decoder.decode(bytes.subarray(1), { stream: true }),
            decoder.decode(new Uint8Array(), { stream: true }),
            decoder.decode(),
        ];
        strictEqual(chunks.join(''), expected);
    }
});
