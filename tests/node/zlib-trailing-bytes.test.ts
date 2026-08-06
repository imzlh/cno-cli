import { strictEqual } from 'node:assert';
import * as zlib from 'node:zlib';

// Trailing bytes after a complete gzip member. Node's member walk stops as soon as
// the first byte after a finished member is NUL (`node_zlib.cc`: `next_in[0] != 0x00`)
// and discards the whole remainder regardless of what it holds. cno previously
// required *every* trailing byte to be zero, so NUL-padded gzip payloads that Node
// decodes fine failed with `Z_DATA_ERROR: incorrect header check`.

const A = zlib.gzipSync(Buffer.from('AAA'));
const B = zlib.gzipSync(Buffer.from('BBB'));

// Feeds discrete writes into a gunzip stream, stopping as soon as it ends or errors.
function gunzipWrites(writes: Buffer[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const z = zlib.createGunzip();
        const chunks: Buffer[] = [];
        let done = false;
        z.on('data', (c: Buffer) => chunks.push(c));
        z.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString()); } });
        z.on('error', (e: Error) => { if (!done) { done = true; reject(e); } });
        (async () => {
            for (const w of writes) {
                if (done) return;
                z.write(w);
                await new Promise((r) => setTimeout(r, 5));
            }
            if (!done) z.end();
        })();
    });
}

async function gunzipErrorCode(writes: Buffer[]): Promise<string> {
    try {
        await gunzipWrites(writes);
        return 'no-error';
    } catch (e) {
        return (e as { code?: string }).code ?? 'no-code';
    }
}

Deno.test('zlib: gunzipSync ignores non-zero trailing bytes after a NUL', () => {
    // [0, 1, 2, 3]: first byte NUL, rest non-zero. Node yields 'AAA'.
    strictEqual(zlib.gunzipSync(Buffer.concat([A, Buffer.from([0, 1, 2, 3])])).toString(), 'AAA');
    strictEqual(zlib.unzipSync(Buffer.concat([A, Buffer.from([0, 1, 2, 3])])).toString(), 'AAA');
});

Deno.test('zlib: a NUL after a member discards even a valid following member', () => {
    // The NUL terminates the walk, so B is dropped rather than decoded.
    strictEqual(zlib.gunzipSync(Buffer.concat([A, Buffer.from([0]), B])).toString(), 'AAA');
    strictEqual(zlib.gunzipSync(Buffer.concat([A, Buffer.alloc(4), B])).toString(), 'AAA');
});

Deno.test('zlib: adjacent gzip members still both decode', () => {
    // No NUL separator, so the walk continues into B.
    strictEqual(zlib.gunzipSync(Buffer.concat([A, B])).toString(), 'AAABBB');
    strictEqual(zlib.unzipSync(Buffer.concat([A, B])).toString(), 'AAABBB');
});

Deno.test('zlib: non-zero trailing bytes are still an error', () => {
    // First trailing byte non-zero: Node treats it as a new member and fails.
    let code = 'no-error';
    try { zlib.gunzipSync(Buffer.concat([A, Buffer.from([1, 2, 3])])); }
    catch (e) { code = (e as { code?: string }).code ?? 'no-code'; }
    strictEqual(code, 'Z_DATA_ERROR');
});

Deno.test('zlib: gunzip stream ignores trailing bytes after a NUL', async () => {
    strictEqual(await gunzipWrites([A, Buffer.from([0, 1, 2, 3])]), 'AAA');
    strictEqual(await gunzipWrites([Buffer.concat([A, Buffer.from([0]), B])]), 'AAA');
});

Deno.test('zlib: gunzip stream drops later chunks once a NUL closed the stream', async () => {
    // The discard spans write boundaries: B arrives in its own chunk and is dropped.
    strictEqual(await gunzipWrites([A, Buffer.from([0]), B]), 'AAA');
    strictEqual(await gunzipWrites([A, Buffer.alloc(4), Buffer.alloc(4)]), 'AAA');
});

Deno.test('zlib: gunzip stream still decodes adjacent members across writes', async () => {
    strictEqual(await gunzipWrites([A, B]), 'AAABBB');
});

Deno.test('zlib: gunzip stream still rejects non-zero trailing bytes', async () => {
    strictEqual(await gunzipErrorCode([A, Buffer.from([1, 2, 3])]), 'Z_DATA_ERROR');
});

Deno.test('zlib: truncated input is still reported, not treated as padding', async () => {
    // Guards the fix against over-accepting: these must all stay errors.
    let code = 'no-error';
    try { zlib.gunzipSync(A.subarray(0, A.length - 3)); }
    catch (e) { code = (e as { code?: string }).code ?? 'no-code'; }
    strictEqual(code, 'Z_BUF_ERROR');
    strictEqual(await gunzipErrorCode([A.subarray(0, A.length - 3)]), 'Z_BUF_ERROR');
    // A truncated second member after a NUL is discarded, matching Node.
    strictEqual(zlib.gunzipSync(Buffer.concat([A, Buffer.alloc(2), B.subarray(0, 8)])).toString(), 'AAA');
    // A truncated second member with no NUL separator is an error.
    strictEqual(await gunzipErrorCode([A, B.subarray(0, 8)]), 'Z_BUF_ERROR');
});

Deno.test('zlib: a leading NUL is not padding and must still fail', async () => {
    // trailingIsPadding must only apply *after* a finished member.
    strictEqual(await gunzipErrorCode([Buffer.from([0]), A]), 'Z_DATA_ERROR');
    let code = 'no-error';
    try { zlib.gunzipSync(Buffer.alloc(16)); }
    catch (e) { code = (e as { code?: string }).code ?? 'no-code'; }
    strictEqual(code, 'Z_DATA_ERROR');
});
