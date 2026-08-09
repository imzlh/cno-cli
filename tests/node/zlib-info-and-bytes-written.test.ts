import { ok, strictEqual } from 'node:assert';
import * as zlib from 'node:zlib';

// Three parity gaps found by differential audit against node v24.18.0, all in
// cno/src/node/zlib/mod.ts:
//
//  1. `{ info: true }` was declared in the options interface but never implemented,
//     so every one-shot returned a bare Buffer. Node returns `{ buffer, engine }`
//     where `engine` is an instance of the matching stream class carrying
//     `bytesWritten` (the INPUT byte count). A declared-but-ignored option is worse
//     than an absent one: a caller reads `r.buffer` and gets `undefined`.
//  2. zlib streams had no `bytesWritten` at all (node exposes a running total of
//     bytes handed to the stream: uncompressed in, compressed for decompressors).
//  3. `maxOutputLength` was enforced on streams. Node applies it only to the
//     convenience methods — `createGunzip({maxOutputLength:1})` decompresses a
//     100000-byte payload without complaint in v24.18.0.
//
// Every expectation below was captured from node v24.18.0 on the same machine.

const IN = Buffer.from('hello hello hello hello hello hello'); // 35 bytes
strictEqual(IN.length, 35);

type Info = { buffer: Buffer; engine: { bytesWritten: number; _handle: unknown } };

// ---------------------------------------------------------------- info: true

Deno.test('zlib: info:true returns {buffer, engine} from every one-shot', () => {
    const cases: Array<[string, Buffer, string, number]> = [
        ['gzipSync', IN, 'Gzip', 35],
        ['deflateSync', IN, 'Deflate', 35],
        ['deflateRawSync', IN, 'DeflateRaw', 35],
        ['gunzipSync', zlib.gzipSync(IN), 'Gunzip', zlib.gzipSync(IN).length],
        ['inflateSync', zlib.deflateSync(IN), 'Inflate', zlib.deflateSync(IN).length],
        ['inflateRawSync', zlib.deflateRawSync(IN), 'InflateRaw', zlib.deflateRawSync(IN).length],
        ['unzipSync', zlib.gzipSync(IN), 'Unzip', zlib.gzipSync(IN).length],
    ];
    for (const [fn, input, engineName, expectWritten] of cases) {
        const r = (zlib as unknown as Record<string, (b: Buffer, o: object) => Info>)[fn](input, { info: true });
        ok(!Buffer.isBuffer(r), `${fn}: info:true must not return a bare Buffer`);
        strictEqual(Object.keys(r).sort().join(','), 'buffer,engine', `${fn}: result keys`);
        ok(Buffer.isBuffer(r.buffer), `${fn}: .buffer must be a Buffer`);
        strictEqual(r.engine.constructor.name, engineName, `${fn}: engine class`);
        // bytesWritten is the INPUT length, not the output length.
        strictEqual(r.engine.bytesWritten, expectWritten, `${fn}: engine.bytesWritten`);
        // Node releases the native handle on the returned engine.
        strictEqual(r.engine._handle, null, `${fn}: engine._handle must be null`);
    }
});

Deno.test('zlib: info:true round-trips and reports the real byte counts', () => {
    const c = zlib.gzipSync(IN, { info: true } as never) as unknown as Info;
    // The compressed payload must be shorter than the input and must decode back.
    ok(c.buffer.length > 0 && c.buffer.length < IN.length, `compressed ${c.buffer.length}`);
    strictEqual(c.engine.bytesWritten, IN.length);
    const d = zlib.gunzipSync(c.buffer, { info: true } as never) as unknown as Info;
    strictEqual(d.buffer.length, IN.length);
    strictEqual(d.buffer.toString(), IN.toString());
    // The decompressor was fed the compressed bytes.
    strictEqual(d.engine.bytesWritten, c.buffer.length);
});

Deno.test('zlib: info absent or false still returns a bare Buffer', () => {
    ok(Buffer.isBuffer(zlib.gzipSync(IN)));
    ok(Buffer.isBuffer(zlib.gzipSync(IN, {})));
    ok(Buffer.isBuffer(zlib.gzipSync(IN, { info: false })));
    ok(Buffer.isBuffer(zlib.gunzipSync(zlib.gzipSync(IN), { info: false })));
});

Deno.test('zlib: info:true propagates through the async callback form', async () => {
    const r = await new Promise<Info>((resolve, reject) => {
        zlib.gzip(IN, { info: true } as never, (e: Error | null, v: unknown) => (e ? reject(e) : resolve(v as Info)));
    });
    ok(!Buffer.isBuffer(r), 'async info:true must not yield a bare Buffer');
    strictEqual(Object.keys(r).sort().join(','), 'buffer,engine');
    strictEqual(r.engine.bytesWritten, 35);
    strictEqual(zlib.gunzipSync(r.buffer).toString(), IN.toString());
});

// ------------------------------------------------------- stream bytesWritten

type Counted = zlib.Gzip & { bytesWritten: number };

function runStream(z: Counted, chunks: Buffer[]): Promise<{ out: Buffer; written: number }> {
    return new Promise((resolve, reject) => {
        const got: Buffer[] = [];
        z.on('data', (c: Buffer) => got.push(c));
        z.on('error', reject);
        z.on('end', () => resolve({ out: Buffer.concat(got), written: z.bytesWritten }));
        for (const c of chunks.slice(0, -1)) z.write(c);
        z.end(chunks[chunks.length - 1]);
    });
}

Deno.test('zlib: stream bytesWritten counts input bytes and starts at 0', async () => {
    const gz = zlib.createGzip() as Counted;
    strictEqual(gz.bytesWritten, 0, 'fresh stream must report 0, not undefined');
    // 10 + 20 + 5 = 35 bytes in, across three writes.
    const r = await runStream(gz, [Buffer.alloc(10), Buffer.alloc(20), Buffer.alloc(5)]);
    strictEqual(r.written, 35, 'compressor counts UNcompressed input');
    strictEqual(zlib.gunzipSync(r.out).length, 35);
});

Deno.test('zlib: decompressor bytesWritten counts compressed input bytes', async () => {
    const packed = zlib.gzipSync(IN);
    const gun = zlib.createGunzip() as unknown as Counted;
    strictEqual(gun.bytesWritten, 0);
    // Split across a chunk boundary so the counter has to accumulate.
    const r = await runStream(gun, [packed.subarray(0, 10), packed.subarray(10)]);
    strictEqual(r.out.toString(), IN.toString());
    strictEqual(r.written, packed.length, 'decompressor counts COMPRESSED input');
});

Deno.test('zlib: streams expose _level and _strategy like node', () => {
    const a = zlib.createGzip() as unknown as { _level: number; _strategy: number };
    strictEqual(a._level, -1, 'default _level is Z_DEFAULT_COMPRESSION');
    strictEqual(a._strategy, 0, 'default _strategy is Z_DEFAULT_STRATEGY');
    const b = zlib.createGzip({ level: 9, strategy: 2 }) as unknown as { _level: number; _strategy: number };
    strictEqual(b._level, 9);
    strictEqual(b._strategy, 2);
});

// -------------------------------------------------------- maxOutputLength

const BIG = zlib.gzipSync(Buffer.alloc(100000, 0x61));

Deno.test('zlib: maxOutputLength applies to convenience methods', () => {
    // Under the limit: fine.
    strictEqual(zlib.gunzipSync(BIG, { maxOutputLength: 100000 }).length, 100000);
    strictEqual(zlib.gunzipSync(BIG, { maxOutputLength: 100001 }).length, 100000);
    // Over the limit: RangeError with node's code and message.
    for (const max of [1, 100, 99999]) {
        let caught: (Error & { code?: string }) | undefined;
        try { zlib.gunzipSync(BIG, { maxOutputLength: max }); } catch (e) { caught = e as Error & { code?: string }; }
        ok(caught, `maxOutputLength=${max} must throw`);
        strictEqual(caught.constructor.name, 'RangeError', `maxOutputLength=${max} error type`);
        strictEqual(caught.code, 'ERR_BUFFER_TOO_LARGE', `maxOutputLength=${max} err.code`);
        strictEqual(caught.message, `Cannot create a Buffer larger than ${max} bytes`);
    }
});

Deno.test('zlib: maxOutputLength is IGNORED on streams, as node does', async () => {
    // node v24.18.0: createGunzip({maxOutputLength:1}) emits all 100000 bytes and
    // never errors. cno previously destroyed the stream with a RangeError that also
    // carried no `code`, so a package passing one option bag to both the one-shot
    // and the stream form broke only on the stream.
    for (const max of [1, 1000]) {
        const z = zlib.createGunzip({ maxOutputLength: max }) as unknown as Counted;
        const r = await runStream(z, [BIG]);
        strictEqual(r.out.length, 100000, `stream maxOutputLength=${max} must not truncate`);
    }
});
