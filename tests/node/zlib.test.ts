import { strictEqual, ok, throws } from 'node:assert';
import { Readable, pipeline } from 'node:stream';
import * as zlib from 'node:zlib';
import { decodeUtf8, encodeUtf8 } from '../_helpers/bytes.ts';

// zlib: (1) gzip/deflate/raw sync round-trip, (2) brotli when native present,
// (3) empty-buffer, (4) large buffer. Brotli soft-skip only if C lacked brotli.

Deno.test('zlib: gzipSync then gunzipSync round-trips', () => {
    const s = 'the quick brown fox jumps over the lazy dog';
    const gz = zlib.gzipSync(encodeUtf8(s));
    ok(Buffer.isBuffer(gz));
    ok(gz.length > 0);
    const back = zlib.gunzipSync(gz);
    ok(Buffer.isBuffer(back));
    strictEqual(decodeUtf8(back), s);
});

Deno.test('zlib: deflateSync then inflateSync round-trips', () => {
    const s = 'deflate me';
    const d = zlib.deflateSync(encodeUtf8(s));
    ok(Buffer.isBuffer(d));
    const back = zlib.inflateSync(d);
    ok(Buffer.isBuffer(back));
    strictEqual(decodeUtf8(back), s);
});

Deno.test('zlib: inflateSync info reports consumed bytes before trailing data', () => {
    const compressed = zlib.deflateSync(Buffer.from('payload'));
    const input = Buffer.concat([compressed, Buffer.from('trailing')]);
    const result = zlib.inflateSync(input, { info: true });
    strictEqual(result.buffer.toString(), 'payload');
    strictEqual(result.engine.bytesWritten, compressed.byteLength);
});

Deno.test('zlib: deflateRawSync then inflateRawSync round-trips', () => {
    const s = 'raw deflate payload';
    const d = zlib.deflateRawSync(encodeUtf8(s));
    ok(Buffer.isBuffer(d));
    const back = zlib.inflateRawSync(d);
    ok(Buffer.isBuffer(back));
    strictEqual(decodeUtf8(back), s);
});

Deno.test('zlib: empty buffer round-trips', () => {
    const gz = zlib.gzipSync(new Uint8Array(0));
    const back = zlib.gunzipSync(gz);
    strictEqual(back.length, 0);
});

Deno.test('zlib: large buffer round-trips', () => {
    const big = new Uint8Array(1_000_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const gz = zlib.gzipSync(big);
    ok(gz.length < big.length, 'compressed should be smaller than random-ish data');
    const back = zlib.gunzipSync(gz);
    ok(uint8Equal(back, big));
});

function brotliNativeAvailable(): boolean {
    try {
        const probe = zlib.brotliCompressSync(Buffer.from('probe'));
        ok(Buffer.isBuffer(probe) && probe.length > 0);
        return true;
    } catch (e: any) {
        if (/not supported/i.test(String(e?.message ?? e))) return false;
        throw e;
    }
}

Deno.test('zlib: brotli compress then decompress round-trips', () => {
    if (!brotliNativeAvailable()) return;
    const s = 'brotli payload ' + 'x'.repeat(200);
    const c = zlib.brotliCompressSync(encodeUtf8(s));
    ok(Buffer.isBuffer(c));
    ok(c.length > 0);
    ok(c.length < encodeUtf8(s).length + 64);
    const back = zlib.brotliDecompressSync(c);
    strictEqual(decodeUtf8(back), s);
    // empty + empty-ish edges
    strictEqual(zlib.brotliDecompressSync(zlib.brotliCompressSync(new Uint8Array(0))).length, 0);
});

Deno.test('zlib upstream: BrotliCompress and BrotliDecompress classes stream data', async () => {
    if (!brotliNativeAvailable()) return;

    const brotliCompress = new zlib.BrotliCompress();
    const brotliDecompress = new zlib.BrotliDecompress();
    const chunks: Buffer[] = [];

    brotliDecompress.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve, reject) => {
        brotliDecompress.on('end', resolve);
        brotliCompress.on('error', reject);
        brotliDecompress.on('error', reject);
    });

    brotliCompress.pipe(brotliDecompress);
    brotliCompress.write('hello');
    brotliCompress.end();

    await done;
    strictEqual(Buffer.concat(chunks).toString(), 'hello');
});

Deno.test('zlib: gzip is byte-different from deflate (header/footer)', () => {
    const data = encodeUtf8('sample data for header check');
    const gz = zlib.gzipSync(data);
    const df = zlib.deflateSync(data);
    ok(gz[0] === 0x1f && gz[1] === 0x8b, 'gzip must start with magic 1f 8b');
    ok(!(df[0] === 0x1f && df[1] === 0x8b), 'deflate must NOT have gzip magic');
});

Deno.test('zlib: unzipSync auto-detects gzip and deflate payloads', () => {
    const data = encodeUtf8('hello');
    strictEqual(decodeUtf8(zlib.unzipSync(zlib.gzipSync(data))), 'hello');
    strictEqual(decodeUtf8(zlib.unzipSync(zlib.deflateSync(data))), 'hello');
});

Deno.test('zlib: sync APIs accept string and DataView inputs', () => {
    strictEqual(decodeUtf8(zlib.gunzipSync(zlib.gzipSync('hello'))), 'hello');
    const view = new DataView(encodeUtf8('view-input').buffer);
    strictEqual(decodeUtf8(zlib.inflateSync(zlib.deflateSync(view))), 'view-input');
});

Deno.test('zlib upstream: gzip accepts ArrayBuffer in callback and sync forms', async () => {
    const input = new ArrayBuffer(0);
    const compressed = await new Promise<Buffer>((resolve, reject) => {
        zlib.gzip(input, (err, out) => {
            err ? reject(err) : resolve(out);
        });
    });
    ok(Buffer.isBuffer(compressed));
    ok(Buffer.isBuffer(zlib.gzipSync(input)));
});

Deno.test('zlib upstream: crc32 supports seeds and large repeated empty input', () => {
    strictEqual(zlib.crc32('hello world'), 222957957);
    let checksum = zlib.crc32(Buffer.from('H4sIAAAAAAAACg==', 'base64'), 0);
    checksum = zlib.crc32('aaa', checksum);
    strictEqual(checksum, 1466848669);

    let repeated = 0xffffffff;
    for (let i = 0; i < 2 ** 16; i++) repeated = zlib.crc32('', repeated);
    strictEqual(repeated, 0xffffffff);
    throws(() => zlib.crc32({} as unknown as string), TypeError);
});

Deno.test('zlib upstream: invalid flush option and maxOutputLength throw', () => {
    throws(() => zlib.createDeflate({ flush: '' as unknown as number }), TypeError);
    throws(
        () => zlib.deflateSync(Buffer.alloc(1024), { maxOutputLength: 1 }),
        /Cannot create a Buffer larger than 1 bytes/,
    );
});

Deno.test('zlib upstream: createDeflate accepts an empty dictionary and closes cleanly', async () => {
    const deflate = zlib.createDeflate({ dictionary: Buffer.alloc(0) });
    const closed = new Promise<void>((resolve, reject) => {
        deflate.on('close', resolve);
        deflate.on('error', reject);
    });
    deflate.end();
    deflate.destroy();
    await closed;
});

Deno.test('zlib: gzip callback API yields compressed output', async () => {
    const input = Buffer.from('hello');
    const compressed = await new Promise<Buffer>((resolve, reject) => {
        zlib.gzip(input, (err, out) => {
            if (err) reject(err);
            else resolve(out);
        });
    });
    ok(Buffer.isBuffer(compressed));
    strictEqual(decodeUtf8(zlib.gunzipSync(compressed)), 'hello');
});

Deno.test('zlib: streaming gunzip pipeline finishes split gzip payload', async () => {
    const compressed = zlib.gzipSync('streamed-ok');
    const source = new Readable({ read() {} });
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];

    gunzip.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve, reject) => {
        pipeline(source, gunzip, (err) => err ? reject(err) : resolve());
    });

    source.push(compressed.subarray(0, 10));
    source.push(compressed.subarray(10));
    source.push(null);

    await done;
    strictEqual(Buffer.concat(chunks).toString('utf8'), 'streamed-ok');
});

Deno.test('zlib: callback APIs require a callback', () => {
    throws(() => (zlib.gzip as any)(Buffer.from('x')), TypeError);
});

Deno.test('zlib upstream: createUnzip auto-detects split gzip and zlib headers', async () => {
    for (const compressed of [zlib.gzipSync('gzip-data'), zlib.deflateSync('zlib-data')]) {
        const unzip = zlib.createUnzip();
        const chunks: Buffer[] = [];
        unzip.on('data', chunk => chunks.push(Buffer.from(chunk)));
        const done = new Promise<void>((resolve, reject) => {
            unzip.on('end', resolve);
            unzip.on('error', reject);
        });
        unzip.write(compressed.subarray(0, 1));
        unzip.write(compressed.subarray(1, 3));
        unzip.end(compressed.subarray(3));
        await done;
        ok(['gzip-data', 'zlib-data'].includes(Buffer.concat(chunks).toString()));
    }
});

Deno.test('zlib upstream: Brotli streams preserve state across input chunks', async () => {
    if (!brotliNativeAvailable()) return;
    const compress = zlib.createBrotliCompress({
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
    });
    const decompress = zlib.createBrotliDecompress();
    const output: Buffer[] = [];
    decompress.on('data', chunk => output.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve, reject) => {
        decompress.on('end', resolve);
        compress.on('error', reject);
        decompress.on('error', reject);
    });
    compress.pipe(decompress);
    compress.write('hello');
    compress.write(' ');
    compress.end('world');
    await done;
    strictEqual(Buffer.concat(output).toString(), 'hello world');
});

Deno.test('zlib upstream: BrotliDecompress accepts a split compressed frame', async () => {
    if (!brotliNativeAvailable()) return;
    const compressed = zlib.brotliCompressSync('split-brotli-payload');
    const decompress = zlib.createBrotliDecompress();
    const output: Buffer[] = [];
    decompress.on('data', chunk => output.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve, reject) => {
        decompress.on('end', resolve);
        decompress.on('error', reject);
    });
    decompress.write(compressed.subarray(0, 2));
    decompress.write(compressed.subarray(2, 7));
    decompress.end(compressed.subarray(7));
    await done;
    strictEqual(Buffer.concat(output).toString(), 'split-brotli-payload');
});

Deno.test('zlib upstream: flush, reset, params, and close are functional', async () => {
    const deflate = zlib.createDeflate();
    const compressed: Buffer[] = [];
    deflate.on('data', chunk => compressed.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve, reject) => {
        deflate.on('end', resolve);
        deflate.on('error', reject);
    });
    deflate.write('first');
    await new Promise<void>(resolve => deflate.flush(zlib.constants.Z_SYNC_FLUSH, resolve));
    await new Promise<void>(resolve => deflate.params(1, zlib.constants.Z_DEFAULT_STRATEGY, resolve));
    deflate.end('-second');
    await done;
    strictEqual(zlib.inflateSync(Buffer.concat(compressed)).toString(), 'first-second');

    const reusable = zlib.createDeflate();
    reusable._processChunk(Buffer.from('discarded'), zlib.constants.Z_NO_FLUSH);
    reusable.reset();
    const head = reusable._processChunk(Buffer.from('kept'), zlib.constants.Z_NO_FLUSH);
    const tail = reusable._processChunk(Buffer.alloc(0), zlib.constants.Z_FINISH);
    strictEqual(zlib.inflateSync(Buffer.concat([head, tail])).toString(), 'kept');

    for (const closable of [
        zlib.createDeflate(),
        zlib.createInflate(),
        zlib.createGzip(),
        zlib.createGunzip(),
        zlib.createDeflateRaw(),
        zlib.createInflateRaw(),
        zlib.createUnzip(),
    ]) {
        await new Promise<void>(resolve => closable.close(resolve));
        strictEqual(closable.destroyed, true);
    }
});

Deno.test('zlib upstream: callback validates options synchronously and fires asynchronously', async () => {
    throws(() => zlib.gzip('x', { level: 100 }, () => {}), RangeError);
    let synchronous = true;
    await new Promise<void>((resolve, reject) => {
        zlib.gzip('x', (error) => {
            if (error) return reject(error);
            strictEqual(synchronous, false);
            resolve();
        });
        synchronous = false;
    });
});

Deno.test('zlib upstream: advanced options apply or fail explicitly', () => {
    const payload = Buffer.from('strategy-check '.repeat(100));
    const filtered = zlib.deflateSync(payload, {
        level: 4,
        strategy: zlib.constants.Z_FILTERED,
        memLevel: 4,
    });
    strictEqual(zlib.inflateSync(filtered).toString(), payload.toString());
    throws(() => zlib.deflateSync(payload, { dictionary: Buffer.from('dict') }), /not supported/);
    throws(() => zlib.createInflate({ windowBits: 12 }), /windowBits/);
});

Deno.test('zlib upstream: Brotli validates operations and passes large-window params', () => {
    if (!brotliNativeAvailable()) return;
    throws(() => zlib.createBrotliCompress({ flush: zlib.constants.Z_FULL_FLUSH }), RangeError);
    throws(() => zlib.brotliCompressSync('x', { finishFlush: 9 }), RangeError);

    const compressed = zlib.brotliCompressSync('large-window', {
        params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
            [zlib.constants.BROTLI_PARAM_LGWIN]: 25,
            [zlib.constants.BROTLI_PARAM_LARGE_WINDOW]: 1,
        },
    });
    const decompressed = zlib.brotliDecompressSync(compressed, {
        params: { [zlib.constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 },
    });
    strictEqual(decompressed.toString(), 'large-window');
});

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
