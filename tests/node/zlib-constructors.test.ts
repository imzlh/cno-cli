import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { Transform } from 'node:stream';
import * as zlib from 'node:zlib';

const codecs = [
    ['Deflate', zlib.Deflate, zlib.createDeflate],
    ['Inflate', zlib.Inflate, zlib.createInflate],
    ['Gzip', zlib.Gzip, zlib.createGzip],
    ['Gunzip', zlib.Gunzip, zlib.createGunzip],
    ['DeflateRaw', zlib.DeflateRaw, zlib.createDeflateRaw],
    ['InflateRaw', zlib.InflateRaw, zlib.createInflateRaw],
    ['Unzip', zlib.Unzip, zlib.createUnzip],
] as const;

Deno.test('zlib: every constructor supports new, calls, factories and subclasses', () => {
    for (const [name, Constructor, create] of codecs) {
        strictEqual(Constructor.name, name);
        strictEqual(Constructor.length, 1);
        strictEqual(Constructor.prototype.constructor, Constructor);
        const descriptor = Object.getOwnPropertyDescriptor(Constructor.prototype, 'constructor')!;
        deepStrictEqual([descriptor.writable, descriptor.enumerable, descriptor.configurable], [true, false, true]);

        class Derived extends Constructor {}
        const receiver = Object.create(Constructor.prototype);
        Reflect.apply(Constructor, receiver, []);
        const derived = new Derived();
        const streams = [new Constructor(), Reflect.apply(Constructor, undefined, []), create(), receiver, derived];
        try {
            for (const stream of streams) {
                ok(stream instanceof Constructor, name);
                ok(stream instanceof Transform, name);
                strictEqual(stream.bytesWritten, 0, name);
                strictEqual(stream.destroyed, false, name);
                strictEqual(typeof stream.flush, 'function');
                strictEqual(typeof stream.reset, 'function');
                strictEqual(typeof stream.close, 'function');
            }
            strictEqual(Object.getPrototypeOf(derived), Derived.prototype);
            strictEqual(derived.constructor, Derived);
        } finally {
            for (const stream of streams) stream.close();
        }
    }
});

Deno.test('zlib: every constructor validates options before initializing a receiver', () => {
    for (const [name, Constructor, create] of codecs) {
        const options = { level: 100 };
        throws(() => new Constructor(options), RangeError, name);
        throws(() => create(options), RangeError, name);
        const receiver = Object.create(Constructor.prototype);
        throws(() => Reflect.apply(Constructor, receiver, [options]), RangeError, name);
        strictEqual(Object.hasOwn(receiver, '_handle'), false, name);
        strictEqual(Object.hasOwn(receiver, '_readableState'), false, name);
    }
});

Deno.test('zlib: codec instances keep independent state and ignore stream output limits', async () => {
    for (const [name, Constructor] of codecs) {
        const compressor = name === 'Deflate' || name === 'Gzip' || name === 'DeflateRaw';
        const plain = Buffer.from('independent codec state '.repeat(100));
        const input = compressor ? plain
            : name === 'Inflate' ? zlib.deflateSync(plain)
            : name === 'InflateRaw' ? zlib.deflateRawSync(plain)
            : zlib.gzipSync(plain);
        const idle = new Constructor();
        const active = new Constructor({ maxOutputLength: 1 });
        try {
            const chunks: Buffer[] = [];
            const done = new Promise<void>((resolve, reject) => {
                active.on('data', chunk => chunks.push(Buffer.from(chunk)));
                active.on('error', reject);
                active.on('end', resolve);
            });
            active.write(input.subarray(0, 5));
            active.end(input.subarray(5));
            await done;
            strictEqual(active.bytesWritten, input.byteLength, name);
            strictEqual(idle.bytesWritten, 0, name);
            const output = Buffer.concat(chunks);
            const decoded = name === 'Deflate' ? zlib.inflateSync(output)
                : name === 'DeflateRaw' ? zlib.inflateRawSync(output)
                : name === 'Gzip' ? zlib.gunzipSync(output) : output;
            deepStrictEqual(decoded, plain, name);
        } finally {
            idle.close();
            active.close();
        }
    }
});
