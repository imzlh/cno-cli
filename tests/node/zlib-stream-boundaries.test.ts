import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import * as zlib from 'node:zlib';

type Decoder = ReturnType<typeof zlib.createGunzip>;

function decode(stream: Decoder, chunks: Uint8Array[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const output: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => output.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(output)));
        for (const chunk of chunks) stream.write(chunk);
        stream.end();
    });
}

const payload = Buffer.from('compressed data split across header, body and trailer');
const codecs = [
    { name: 'gzip', pack: zlib.gzipSync, create: zlib.createGunzip },
    { name: 'deflate', pack: zlib.deflateSync, create: zlib.createInflate },
    { name: 'raw deflate', pack: zlib.deflateRawSync, create: zlib.createInflateRaw },
    { name: 'unzip gzip', pack: zlib.gzipSync, create: zlib.createUnzip },
    { name: 'unzip deflate', pack: zlib.deflateSync, create: zlib.createUnzip },
];

for (const codec of codecs) {
    Deno.test(`zlib: ${codec.name} decodes one byte per write`, async () => {
        const packed = codec.pack(payload);
        const chunks = Array.from(packed, (byte) => Buffer.from([byte]));
        deepStrictEqual(await decode(codec.create(), chunks), payload);
    });

    Deno.test(`zlib: ${codec.name} validates completion and honors finishFlush`, async () => {
        const packed = codec.pack(payload);
        const partial = packed.subarray(0, packed.length - 1);
        await rejects(decode(codec.create(), [partial]), { code: 'Z_BUF_ERROR' });
        const allowed = await decode(codec.create({ finishFlush: zlib.constants.Z_SYNC_FLUSH }), [partial]);
        deepStrictEqual(allowed, payload);
    });
}

for (const [name, create] of [['gunzip', zlib.createGunzip], ['unzip', zlib.createUnzip]] as const) {
    Deno.test(`zlib: ${name} walks concatenated members at every byte boundary`, async () => {
        const first = zlib.gzipSync('AAA');
        const second = zlib.gzipSync('BBB');
        const packed = Buffer.concat([first, second]);
        strictEqual((await decode(create(), [packed])).toString(), 'AAABBB');
        const chunks = Array.from(packed, (byte) => Buffer.from([byte]));
        strictEqual((await decode(create(), chunks)).toString(), 'AAABBB');
        strictEqual((await decode(create(), [first, Buffer.from([0]), second])).toString(), 'AAA');
        await rejects(decode(create(), [Buffer.from([0]), first]), { code: 'Z_DATA_ERROR' });
        await rejects(decode(create(), [first, second.subarray(0, 1)]), { code: 'Z_BUF_ERROR' });
    });
}

Deno.test('zlib: corrupt gzip checksum emits Z_DATA_ERROR after earlier output', async () => {
    const packed = zlib.gzipSync(payload);
    packed[packed.length - 8] ^= 1;
    await rejects(decode(zlib.createGunzip(), [packed.subarray(0, -8), packed.subarray(-8)]), { code: 'Z_DATA_ERROR' });
});
