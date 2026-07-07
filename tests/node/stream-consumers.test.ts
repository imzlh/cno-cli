import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { Readable } from 'node:stream';
import { arrayBuffer, blob, buffer, json, text } from 'node:stream/consumers';
import { decodeUtf8, encodeUtf8 } from '../_helpers/bytes.ts';

Deno.test('stream.consumers: text consumes Node Readable strings and buffers', async () => {
    const value = await text(Readable.from(['hello ', Buffer.from('world')]));
    strictEqual(value, 'hello world');
});

Deno.test('stream.consumers: buffer consumes async iterable mixed chunks', async () => {
    async function* chunks() {
        yield 'a';
        yield new Uint8Array([0x62]);
        yield new DataView(new Uint8Array([0x63]).buffer);
    }

    const value = await buffer(chunks());
    ok(Buffer.isBuffer(value));
    strictEqual(value.toString(), 'abc');
});

Deno.test('stream.consumers: arrayBuffer returns a trimmed standalone buffer', async () => {
    const source = Buffer.from('xxpayloadyy');
    const view = source.subarray(2, 9);
    const value = await arrayBuffer(Readable.from([view]));
    const bytes = new Uint8Array(value);

    strictEqual(value.byteLength, 7);
    strictEqual(decodeUtf8(bytes), 'payload');
});

Deno.test('stream.consumers: json parses chunked JSON text', async () => {
    const value = await json(Readable.from(['{"ok":', 'true,', '"items":[1,2]}']));
    deepStrictEqual(value, { ok: true, items: [1, 2] });
});

Deno.test('stream.consumers: blob consumes Web ReadableStream chunks', async () => {
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encodeUtf8('web '));
            controller.enqueue(new Blob(['blob']));
            controller.close();
        },
    });

    const value = await blob(stream);
    strictEqual(value.size, 8);
    strictEqual(await value.text(), 'web blob');
});

Deno.test('stream.consumers: invalid stream argument rejects with TypeError', async () => {
    let error: Error | null = null;
    try {
        await text({} as unknown as Readable);
    } catch (e) {
        error = e as Error;
    }

    ok(error instanceof TypeError);
    ok(error.message.includes('stream'));
});

Deno.test('stream.consumers: Node Readable errors reject pending consumers', async () => {
    const readable = new Readable({
        read() {
            this.push('before');
            this.destroy(new Error('read-failed'));
        },
    });

    let error: Error | null = null;
    try {
        await text(readable);
    } catch (e) {
        error = e as Error;
    }

    ok(error);
    strictEqual(error.message, 'read-failed');
});
