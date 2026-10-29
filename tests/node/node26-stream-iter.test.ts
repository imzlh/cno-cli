import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { Readable, Writable } from 'node:stream';
import {
    arrayBufferSync,
    bytes,
    bytesSync,
    from,
    pull,
    pullSync,
    fromReadable,
    fromWritable,
    pipeTo,
    tap,
    text,
    textSync,
    toReadable,
    toWritable,
} from 'node:stream/iter';
import {
    compressZstd,
    compressDeflateSync,
    compressGzip,
    decompressDeflateSync,
    decompressGzip,
} from 'node:zlib/iter';

Deno.test('node26 stream/iter: byte sources flatten into batches and consumers', async () => {
    async function* source() {
        yield 'hello ';
        yield [new Uint8Array([0x77, 0x6f]), 'rld'];
    }

    const batches: number[][][] = [];
    for await (const batch of from(source())) batches.push(batch.map(chunk => [...chunk]));

    strictEqual(batches.length, 3);
    strictEqual(await text(source()), 'hello world');
    const asyncBytes = await bytes(['a', new Uint8Array([0x62]), 'c']);
    deepStrictEqual([...asyncBytes], [0x61, 0x62, 0x63]);
    ok(!Buffer.isBuffer(asyncBytes));
    strictEqual(textSync(['sync ', ['bytes']]), 'sync bytes');
    const syncBytes = bytesSync(new Uint16Array([0x6261]));
    deepStrictEqual([...syncBytes], [0x61, 0x62]);
    ok(!Buffer.isBuffer(syncBytes));
    deepStrictEqual([...new Uint8Array(arrayBufferSync('buffer'))], [...Buffer.from('buffer')]);
});

Deno.test('node26 stream/iter: pull transforms batches and receives a final null', async () => {
    const seen: Array<number | null> = [];
    const transformed = pull(['a', 'b'], tap((batch) => {
        seen.push(batch?.length ?? null);
        return null;
    }));

    strictEqual(await text(transformed), 'ab');
    deepStrictEqual(seen, [1, 1, null]);
});

Deno.test('node26 stream/iter: limits and aborts stop consumption', async () => {
    await rejects(() => bytes('too long', { limit: 3 }), RangeError);

    const controller = new AbortController();
    controller.abort('stop');
    await rejects(() => text('x', { signal: controller.signal }), (error: Error & { code?: string }) => {
        strictEqual(error.name, 'AbortError');
        strictEqual(error.code, 'ABORT_ERR');
        return true;
    });
});

Deno.test('node26 zlib/iter: sync deflate pipeline round-trips', () => {
    const compressed = pullSync(['deflate ', 'payload'], compressDeflateSync());
    const restored = pullSync(compressed, decompressDeflateSync());
    strictEqual(textSync(restored), 'deflate payload');
});

Deno.test('node26 zlib/iter: async gzip pipeline round-trips', async () => {
    const compressed = pull(['gzip ', 'payload'], compressGzip());
    const restored = pull(compressed, decompressGzip());
    strictEqual(await text(restored), 'gzip payload');
});

Deno.test('node26 stream/iter: classic stream adapters cover common pipelines', async () => {
    strictEqual(await text(fromReadable(Readable.from(['classic ', 'readable']))), 'classic readable');
    strictEqual(await text(toReadable(['classic ', 'output'])), 'classic output');

    const chunks: Buffer[] = [];
    const classic = new Writable({
        write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
        },
    });
    await pipeTo('writer adapter', fromWritable(classic));
    strictEqual(Buffer.concat(chunks).toString(), 'writer adapter');

    const writerChunks: Buffer[] = [];
    const writable = toWritable({
        async write(chunk) { writerChunks.push(Buffer.from(chunk)); },
    });
    writable.end('classic writable');
    await new Promise<void>((resolve, reject) => {
        writable.once('finish', resolve);
        writable.once('error', reject);
    });
    strictEqual(Buffer.concat(writerChunks).toString(), 'classic writable');
});

Deno.test('node26 zlib/iter: unsupported Zstd has an explicit runtime error', () => {
    throws(
        () => compressZstd(),
        (error: unknown) => (error as Error & { code?: string }).code === 'ERR_METHOD_NOT_IMPLEMENTED',
    );
});
