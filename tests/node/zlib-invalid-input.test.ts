import { ok, strictEqual, throws } from 'node:assert';
import * as zlib from 'node:zlib';

const gzip = zlib.gzipSync(Buffer.from('gzip checksum payload'));
const badGzipChecksum = Buffer.from(gzip);
badGzipChecksum[badGzipChecksum.length - 8] ^= 1;

const deflate = zlib.deflateSync(Buffer.from('deflate checksum payload'));
const badDeflateChecksum = Buffer.from(deflate);
badDeflateChecksum[badDeflateChecksum.length - 1] ^= 1;

const cases = [
    { name: 'gunzip invalid header', input: Buffer.from([1, 2, 3]), sync: zlib.gunzipSync, async: zlib.gunzip },
    { name: 'gunzip invalid CRC', input: badGzipChecksum, sync: zlib.gunzipSync, async: zlib.gunzip },
    { name: 'gunzip invalid second member', input: Buffer.concat([gzip, badGzipChecksum]), sync: zlib.gunzipSync, async: zlib.gunzip },
    { name: 'inflate invalid header', input: Buffer.from([1, 2, 3]), sync: zlib.inflateSync, async: zlib.inflate },
    { name: 'inflate invalid checksum', input: badDeflateChecksum, sync: zlib.inflateSync, async: zlib.inflate },
    { name: 'unzip invalid gzip CRC', input: badGzipChecksum, sync: zlib.unzipSync, async: zlib.unzip },
    { name: 'unzip invalid deflate checksum', input: badDeflateChecksum, sync: zlib.unzipSync, async: zlib.unzip },
];

for (const entry of cases) {
    Deno.test(`zlib: ${entry.name} throws Z_DATA_ERROR synchronously`, () => {
        throws(() => entry.sync(entry.input), { code: 'Z_DATA_ERROR' });
        // Allowing a missing trailer must not permit invalid compressed data.
        throws(() => entry.sync(entry.input, { finishFlush: zlib.constants.Z_SYNC_FLUSH }), { code: 'Z_DATA_ERROR' });
    });

    Deno.test(`zlib: ${entry.name} reports Z_DATA_ERROR to its callback`, async () => {
        const result = await new Promise<{ error: Error | null; output: unknown }>((resolve) => {
            entry.async(entry.input, (error, output) => resolve({ error, output }));
        });
        ok(result.error);
        strictEqual((result.error as Error & { code?: string }).code, 'Z_DATA_ERROR');
        strictEqual(result.output, undefined);
    });
}
