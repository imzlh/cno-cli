import { ok, strictEqual } from 'node:assert';
import { PassThrough, Readable, Transform, Writable, promises as streamPromises } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';

Deno.test('stream.promises: pipeline resolves after all chunks are written', async () => {
    let out = '';
    await pipeline(
        Readable.from(['a', 'b']),
        new Transform({
            transform(chunk, _encoding, callback) {
                callback(null, String(chunk).toUpperCase());
            },
        }),
        new Writable({
            write(chunk, _encoding, callback) {
                out += String(chunk);
                callback();
            },
        }),
    );

    strictEqual(out, 'AB');
});

Deno.test('stream.promises: pipeline accepts transform factory functions', async () => {
    let out = '';
    await pipeline(
        Readable.from(['x', 'y']),
        () => new Transform({
            transform(chunk, _encoding, callback) {
                callback(null, `${chunk}!`);
            },
        }),
        new Writable({
            write(chunk, _encoding, callback) {
                out += String(chunk);
                callback();
            },
        }),
    );

    strictEqual(out, 'x!y!');
});

Deno.test('stream.promises: pipeline rejects on transform errors', async () => {
    let error: Error | null = null;
    try {
        await pipeline(
            Readable.from(['x']),
            new Transform({
                transform(_chunk, _encoding, callback) {
                    callback(new Error('transform-error'));
                },
            }),
            new Writable({
                write(_chunk, _encoding, callback) {
                    callback();
                },
            }),
        );
    } catch (e) {
        error = e as Error;
    }

    ok(error);
    strictEqual(error.message, 'transform-error');
});

Deno.test('stream.promises: finished resolves for writable finish', async () => {
    const stream = new PassThrough();
    const done = finished(stream);
    stream.end('payload');
    await done;
});

Deno.test('stream.promises: finished rejects on stream error', async () => {
    const stream = new PassThrough();
    const done = finished(stream);
    stream.destroy(new Error('finish-error'));

    let error: Error | null = null;
    try {
        await done;
    } catch (e) {
        error = e as Error;
    }

    ok(error);
    strictEqual(error.message, 'finish-error');
});

Deno.test('stream.promises: finished rejects when AbortSignal aborts', async () => {
    const controller = new AbortController();
    const done = finished(new PassThrough(), { signal: controller.signal })
        .then(() => null, (e) => e as Error);
    controller.abort();

    const error = await done;
    ok(error);
    ok(error.message.includes('aborted'));
});

Deno.test('stream.promises: finished resolves for Web ReadableStream after consumption', async () => {
    const stream = new ReadableStream<string>({
        start(controller) {
            controller.enqueue('asd');
            controller.close();
        },
    });

    const done = finished(stream as unknown as NodeJS.ReadableStream);
    let out = '';
    for await (const chunk of stream) out += chunk;

    strictEqual(out, 'asd');
    await done;
});

Deno.test('stream.promises: namespace finished also supports Web ReadableStream', async () => {
    const stream = new ReadableStream<string>({
        start(controller) {
            controller.enqueue('asd');
            controller.close();
        },
    });

    const done = streamPromises.finished(stream as unknown as NodeJS.ReadableStream);
    let out = '';
    for await (const chunk of stream) out += chunk;

    strictEqual(out, 'asd');
    await done;
});
