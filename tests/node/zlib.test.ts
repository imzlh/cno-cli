import { strictEqual, ok, throws } from 'node:assert';
import { Readable, pipeline } from 'node:stream';
import * as zlib from 'node:zlib';
import { decodeUtf8, encodeUtf8 } from '../_helpers/bytes.ts';

// zlib: tricky cases are (1) sync round-trip for gzip/deflate/raw,
// (2) brotli round-trip if present, (3) empty-buffer edge, (4) large buffer.

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

Deno.test('zlib: brotli compress then decompress round-trips', () => {
    if (typeof zlib.brotliCompressSync !== 'function' || typeof zlib.brotliDecompressSync !== 'function') {
        return;
    }
    const s = 'brotli payload';
    let c: Uint8Array;
    try {
        c = zlib.brotliCompressSync(encodeUtf8(s));
    } catch (e: any) {
        if (/not supported/i.test(String(e?.message ?? e))) return;
        throw e;
    }
    const back = zlib.brotliDecompressSync(c);
    strictEqual(decodeUtf8(back), s);
});

Deno.test('zlib upstream: BrotliCompress and BrotliDecompress classes stream data', async () => {
    try {
        zlib.brotliCompressSync(Buffer.from('probe'));
    } catch (e: any) {
        if (/not supported/i.test(String(e?.message ?? e))) return;
        throw e;
    }

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

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
