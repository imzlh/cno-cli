import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { CryptoHasher } from '../../cno/src/bun/crypto/index.ts';
import { Blob } from '../../cno/src/webapi/formdata.ts';

Deno.test('bun: CryptoHasher hashes, copies, and resets', () => {
    const h = new CryptoHasher('SHA-256').update('a');
    const copy = h.copy();
    strictEqual(h.algorithm, 'sha256');
    strictEqual(h.byteLength, 32);
    strictEqual(h.update('bc').digest('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    strictEqual(copy.digest('hex'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
    strictEqual(h.digest('hex'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    strictEqual(CryptoHasher.hash('sha256', 'abc', 'hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

Deno.test('bun: CryptoHasher handles HMAC, input views, and output buffers', () => {
    const input = new Uint8Array([0, 97, 98, 99, 0]).subarray(1, 4);
    const h = new CryptoHasher('sha256', 'key').update(input);
    input.fill(0);
    const out = new Uint8Array(64);
    strictEqual(h.digest(out), out);
    strictEqual(Buffer.from(out.subarray(0, 32)).toString('hex'), '9c196e32dc0175f86f4b1cb89289d6619de6bee699e4c378e68309ed97a1a6ab');
    deepStrictEqual(Array.from(out.subarray(32)), Array(32).fill(0));
    strictEqual(new CryptoHasher('shake128').digest('hex'), '7f9c2ba4e88f827d616045507605853e');
});

Deno.test('bun: CryptoHasher validates algorithms and outputs', () => {
    throws(() => new CryptoHasher('unknown'), TypeError);
    throws(() => new CryptoHasher('shake128', 'key'), /HMAC is not supported/);
    const h = new CryptoHasher('sha256').update('abc');
    throws(() => h.digest(new Uint8Array(32)), TypeError);
    throws(() => h.digest('invalid'), TypeError);
    throws(() => h.digest(''), TypeError);
    throws(() => h.digest('utf-16le'), TypeError);
    strictEqual(h.digest('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

Deno.test('bun: CryptoHasher accepts views and preserves output offsets', () => {
    for (const output of [new ArrayBuffer(64), new DataView(new ArrayBuffer(64)), new Uint16Array(32), new Float64Array(8)]) {
        strictEqual(CryptoHasher.hash('SHA-256', 'abc', output), output);
        const bytes = output instanceof ArrayBuffer ? new Uint8Array(output) : new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
        strictEqual(Buffer.from(bytes.subarray(0, 32)).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    }
    const backing = new Uint8Array(80).fill(42);
    const output = backing.subarray(8, 72);
    strictEqual(new CryptoHasher('md5').update(new Blob(['abc'])).digest(output), output);
    strictEqual(Buffer.from(output.subarray(0, 16)).toString('hex'), '900150983cd24fb0d6963f7d28e17f72');
    deepStrictEqual(Array.from(backing.subarray(0, 8)), Array(8).fill(42));
    deepStrictEqual(Array.from(backing.subarray(72)), Array(8).fill(42));
    throws(() => new CryptoHasher('md5').digest(new Uint8Array(63)), /64 bytes/);
});

Deno.test('bun: CryptoHasher input encodings and HMAC lifetime', () => {
    strictEqual(new CryptoHasher('sha256').update('6162', 'HEX').digest('hex'), 'fb8e20fc2e4c3f248c60c39bd652f3c1347298bb977b8b4d5903b85055620603');
    strictEqual(new CryptoHasher('sha256').update('é', 'UTF16LE').digest('hex'), '63e3c807f93f669a2625f37ee673726c36ef3e99b6b7db02c910be25087e0f9c');
    const h = new CryptoHasher('sha256', 'key').update('abc');
    const copy = h.copy();
    strictEqual(h.digest('hex'), copy.digest('hex'));
    throws(() => h.update('abc'), /HMAC has been consumed/);
    throws(() => h.digest(), /HMAC has been consumed/);
    throws(() => h.copy(), /HMAC has been consumed/);
    throws(() => new CryptoHasher('blake2s256', 'key'), /HMAC is not supported/);
    throws(() => new CryptoHasher('SHA-512-256'), TypeError);
});

Deno.test('bun: CryptoHasher replaces lone surrogates before string encoding', () => {
    strictEqual(
        CryptoHasher.hash('sha256', '\ud800', 'hex'),
        CryptoHasher.hash('sha256', '\ufffd', 'hex'),
    );
    strictEqual(
        new CryptoHasher('sha256').update('a\ud800b').digest('hex'),
        new CryptoHasher('sha256').update('a\ufffdb').digest('hex'),
    );
});
