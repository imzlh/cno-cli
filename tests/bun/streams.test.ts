import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert';
import { concatArrayBuffers, readableStreamToArrayBuffer, readableStreamToBytes, readableStreamToFormData, readableStreamToJSON, readableStreamToText } from '../../cno/src/bun/utils/streams.ts';

function stream<T>(chunks: T[]): ReadableStream<T> {
    return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
}

Deno.test('bun: concatArrayBuffers honors offsets and length limits', () => {
    const bytes = new Uint8Array([9, 1, 2, 8]);
    const chunks = [new DataView(bytes.buffer, 1, 2), new Uint8Array([3, 4])];
    deepStrictEqual([...new Uint8Array(concatArrayBuffers(chunks))], [1, 2, 3, 4]);
    deepStrictEqual([...concatArrayBuffers(chunks, 3, true)], [1, 2, 3]);
    strictEqual(concatArrayBuffers(chunks, 0).byteLength, 0);
    strictEqual(concatArrayBuffers(chunks, 99).byteLength, 4);
    throws(() => concatArrayBuffers(chunks, -1), RangeError);
    throws(() => concatArrayBuffers(chunks, NaN), RangeError);
});

Deno.test('bun: stream conversions handle mixed bytes and UTF-8', async () => {
    const source = new Uint8Array([9, 65, 66, 9]);
    deepStrictEqual([...new Uint8Array(await readableStreamToArrayBuffer(stream([new DataView(source.buffer, 1, 2), '!'])))], [65, 66, 33]);
    deepStrictEqual([...await readableStreamToBytes(stream([source.subarray(1, 3)]))], [65, 66]);
    strictEqual(await readableStreamToText(stream([new Uint8Array([0xef, 0xbb]), new Uint8Array([0xbf, 0xc3]), new Uint8Array([0xa9])])), 'é');
    strictEqual(await readableStreamToText(stream([new Uint8Array([0xc3]), 'x', new Uint8Array([0xa9])])), '�x�');
    deepStrictEqual(await readableStreamToJSON(stream(['{"a":', new TextEncoder().encode('1}')])), { a: 1 });
    await rejects(readableStreamToJSON(stream(['invalid'])), SyntaxError);
});

Deno.test('bun: stream errors and locks propagate without leaking the reader', async () => {
    const error = new Error('source failure');
    const broken = new ReadableStream({ start(controller) { controller.error(error); } });
    await rejects(readableStreamToBytes(broken), value => value === error);
    strictEqual(broken.locked, false);
    const locked = stream([new Uint8Array([1])]);
    const reader = locked.getReader();
    await rejects(readableStreamToBytes(locked), TypeError);
    reader.releaseLock();
    const invalid = stream([{}]);
    await rejects(readableStreamToBytes(invalid as ReadableStream<Uint8Array>), TypeError);
    strictEqual(invalid.locked, false);
    let cancelled = false;
    const closed = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await closed.cancel();
    strictEqual(cancelled, true);
    strictEqual((await readableStreamToBytes(closed)).byteLength, 0);
    strictEqual(closed.locked, false);
});

const encode = (value: string) => new TextEncoder().encode(value);
const entries = (form: FormData) => [...form].map(([key, value]) => [key, typeof value === 'string' ? value : `${value.name}|${value.type}|${value.size}`]);

Deno.test('bun: readableStreamToFormData parses url-encoded bytes split across chunks', async () => {
    const bytes = encode('a=1&b=%E4%BD%A0&a=2+x&&flag&=empty&bad=%ZZ%4');
    const form = await readableStreamToFormData(stream([bytes.subarray(0, 12), bytes.subarray(12, 15), bytes.subarray(15)]));
    deepStrictEqual(entries(form), [['a', '1'], ['b', '你'], ['a', '2 x'], ['flag', ''], ['', 'empty'], ['bad', '%ZZ%4']]);
    deepStrictEqual(entries(await readableStreamToFormData(stream(['x=%C3', new Uint8Array([0xa9])]))), [['x', 'é']]);
    deepStrictEqual(entries(await readableStreamToFormData(stream([]))), []);
    deepStrictEqual(entries(await readableStreamToFormData(stream([new Uint8Array([97, 61, 0xff])]), undefined)), [['a', '\ufffd']]);
});

Deno.test('bun: readableStreamToFormData parses multipart with string and byte boundaries', async () => {
    const body = [
        'preamble\r\n',
        '--XX\r\nContent-Disposition: form-data; name="foo"\r\n\r\nbar\r\n',
        '--XX \t\r\ncontent-disposition: form-data; name="multi"\r\n\r\nline1\r\n--not-boundary\r\nline3\r\n',
        '--XX\r\nContent-Disposition: form-data; name="f%22q"; filename="a%22.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n',
        '--XX\r\nContent-Disposition: form-data; name="bin"; filename="b.bin"\r\n\r\n',
    ].join('');
    const raw = new Uint8Array([...encode(body), 0, 255, 13, 10, ...encode('--XX--\r\nepilogue')]);
    for (const boundary of ['XX', encode('XX'), new DataView(encode('?XX?').buffer, 1, 2)]) {
        const chunks = [raw.subarray(0, 7), raw.subarray(7, 100), raw.subarray(100, raw.length - 3), raw.subarray(raw.length - 3)];
        const form = await readableStreamToFormData(stream(chunks), boundary);
        deepStrictEqual(entries(form), [
            ['foo', 'bar'],
            ['multi', 'line1\r\n--not-boundary\r\nline3'],
            ['f"q', 'a".txt|text/plain|5'],
            ['bin', 'b.bin|text/plain|2'],
        ]);
        deepStrictEqual([...new Uint8Array(await (form.get('bin') as File).arrayBuffer())], [0, 255]);
    }
    deepStrictEqual(entries(await readableStreamToFormData(stream(['--B--\r\n']), 'B')), []);
    deepStrictEqual(entries(await readableStreamToFormData(stream(['--B\r\nContent-Disposition: form-data; name=x\r\n\r\n\r\n--B--']), 'B')), [['x', '']]);
});

Deno.test('bun: readableStreamToFormData rejects malformed forms and releases the stream', async () => {
    const part = (head: string) => `--B\r\n${head}\r\n\r\nv\r\n--B--\r\n`;
    for (const text of [
        '', 'no boundary here', '--B\r\nContent-Disposition: form-data; name="x"\r\n\r\nv\r\n',
        '--B\r\nContent-Disposition: form-data; name="x"\r\n\r\nv',
        part('Content-Type: text/plain'), part('Content-Disposition: attachment; name="x"'),
        part('Content-Disposition: form-data'), part('Content-Disposition form-data; name="x"'),
        part('Content-Disposition: form-data; name="x'), '--B\r\nContent-Disposition: form-data; name="x"\r\nv\r\n--B--',
    ]) {
        const source = stream([text]);
        await rejects(readableStreamToFormData(source, 'B'), TypeError, text);
        strictEqual(source.locked, false);
    }
    for (const boundary of ['', 'a\nb']) await rejects(readableStreamToFormData(stream(['x=1']), boundary), TypeError);
    const error = new Error('source failure');
    await rejects(readableStreamToFormData(new ReadableStream({ start(controller) { controller.error(error); } })), value => value === error);
    const locked = stream(['a=1']);
    const reader = locked.getReader();
    await rejects(readableStreamToFormData(locked), TypeError);
    reader.releaseLock();
    await rejects(readableStreamToFormData(stream([{}]) as ReadableStream<Uint8Array>), TypeError);
});
