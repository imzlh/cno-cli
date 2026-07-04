import { strictEqual, ok } from 'node:assert';
import * as zlib from 'node:zlib';

// zlib: the刁che cases are (1) sync round-trip for gzip/deflate/raw,
// (2) brotli round-trip if present, (3) empty-buffer edge, (4) large buffer.

Deno.test('zlib: gzipSync then gunzipSync round-trips', () => {
    const s = 'the quick brown fox jumps over the lazy dog';
    const gz = zlib.gzipSync(new TextEncoder().encode(s));
    ok(gz.length > 0);
    const back = zlib.gunzipSync(gz);
    strictEqual(new TextDecoder().decode(back), s);
});

Deno.test('zlib: deflateSync then inflateSync round-trips', () => {
    const s = 'deflate me';
    const d = zlib.deflateSync(new TextEncoder().encode(s));
    const back = zlib.inflateSync(d);
    strictEqual(new TextDecoder().decode(back), s);
});

Deno.test('zlib: deflateRawSync then inflateRawSync round-trips', () => {
    const s = 'raw deflate payload';
    const d = zlib.deflateRawSync(new TextEncoder().encode(s));
    const back = zlib.inflateRawSync(d);
    strictEqual(new TextDecoder().decode(back), s);
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
        c = zlib.brotliCompressSync(new TextEncoder().encode(s));
    } catch (e: any) {
        if (/not supported/i.test(String(e?.message ?? e))) return;
        throw e;
    }
    const back = zlib.brotliDecompressSync(c);
    strictEqual(new TextDecoder().decode(back), s);
});

Deno.test('zlib: gzip is byte-different from deflate (header/footer)', () => {
    const data = new TextEncoder().encode('sample data for header check');
    const gz = zlib.gzipSync(data);
    const df = zlib.deflateSync(data);
    ok(gz[0] === 0x1f && gz[1] === 0x8b, 'gzip must start with magic 1f 8b');
    ok(!(df[0] === 0x1f && df[1] === 0x8b), 'deflate must NOT have gzip magic');
});

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
