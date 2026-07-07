import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { Buffer } from 'node:buffer';
import { Duplex, Readable, Writable } from 'node:stream';
import * as web from 'node:stream/web';
import { decodeUtf8 } from '../_helpers/bytes.ts';

type StreamWebExtensions = typeof web & {
    readableFromWeb(stream: ReadableStream, options?: { objectMode?: boolean }): Readable;
    readableToWeb(stream: Readable): ReadableStream;
    writableFromWeb(stream: WritableStream): Writable;
    writableToWeb(stream: Writable): WritableStream;
    duplexFromWeb(stream: TransformStream | { readable: ReadableStream; writable: WritableStream }, options?: { objectMode?: boolean }): Duplex;
};

const streamWeb = web as StreamWebExtensions;

Deno.test('stream.web: exports Web Stream constructors from global scope', () => {
    strictEqual(web.ReadableStream, globalThis.ReadableStream);
    strictEqual(web.WritableStream, globalThis.WritableStream);
    strictEqual(web.TransformStream, globalThis.TransformStream);
    strictEqual(web.ReadableStreamDefaultReader, globalThis.ReadableStreamDefaultReader);
    strictEqual(web.WritableStreamDefaultWriter, globalThis.WritableStreamDefaultWriter);
    strictEqual(web.ByteLengthQueuingStrategy, globalThis.ByteLengthQueuingStrategy);
    strictEqual(web.CountQueuingStrategy, globalThis.CountQueuingStrategy);
});

Deno.test('stream.web: readableFromWeb converts Web ReadableStream to Node Readable', async () => {
    const nodeReadable = streamWeb.readableFromWeb(new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array([0x61]));
            controller.enqueue(Buffer.from('b'));
            controller.close();
        },
    }));

    const chunks: Buffer[] = [];
    for await (const chunk of nodeReadable) chunks.push(Buffer.from(chunk));
    strictEqual(Buffer.concat(chunks).toString(), 'ab');
});

Deno.test('stream.web: readableToWeb converts Node Readable to Web ReadableStream', async () => {
    const webReadable = streamWeb.readableToWeb(Readable.from([Buffer.from('x'), Buffer.from('y')]));
    ok(webReadable instanceof ReadableStream);
    strictEqual(await new Response(webReadable).text(), 'xy');
});

Deno.test('stream.web: writableFromWeb forwards Node writes into Web WritableStream', async () => {
    const chunks: string[] = [];
    const nodeWritable = streamWeb.writableFromWeb(new WritableStream({
        write(chunk) {
            chunks.push(decodeUtf8(chunk as Uint8Array));
        },
    }));

    await new Promise<void>((resolve, reject) => {
        nodeWritable.end(Buffer.from('done'), (err?: Error | null) => err ? reject(err) : resolve());
    });

    deepStrictEqual(chunks, ['done']);
});

Deno.test('stream.web: writableToWeb forwards Web writes into Node Writable', async () => {
    const chunks: string[] = [];
    const nodeWritable = new Writable({
        write(chunk, _encoding, callback) {
            chunks.push(decodeUtf8(chunk));
            callback();
        },
    });

    const writer = streamWeb.writableToWeb(nodeWritable).getWriter();
    await writer.write(new Uint8Array([0x41]));
    await writer.write(Buffer.from('b'));
    await writer.close();

    deepStrictEqual(chunks, ['A', 'b']);
});

Deno.test('stream upstream: Writable.toWeb waits for delayed Node write callbacks', async () => {
    const chunks: string[] = [];
    const nodeWritable = new Writable({
        write(chunk, _encoding, callback) {
            setTimeout(() => {
                chunks.push(decodeUtf8(chunk));
                callback();
            }, 10);
        },
    });

    const webWritable = Writable.toWeb(nodeWritable);
    await ReadableStream.from(['line1', 'line2', 'line3'])
        .pipeThrough(new TextEncoderStream())
        .pipeTo(webWritable);

    deepStrictEqual(chunks, ['line1', 'line2', 'line3']);
});

Deno.test('stream.web: duplexFromWeb bridges a TransformStream', async () => {
    const transform = new TransformStream({
        transform(chunk, controller) {
            controller.enqueue(String(chunk).toUpperCase());
        },
    });
    const duplex = streamWeb.duplexFromWeb(transform, { objectMode: true });
    const chunks: string[] = [];

    await new Promise<void>((resolve, reject) => {
        duplex.on('data', chunk => chunks.push(String(chunk)));
        duplex.on('end', resolve);
        duplex.on('error', reject);
        duplex.write('a');
        duplex.end('b');
    });

    deepStrictEqual(chunks, ['A', 'B']);
});
