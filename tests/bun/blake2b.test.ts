import { ok, strictEqual, throws } from 'node:assert';
import { createHash } from 'node:crypto';
import { CryptoHasher } from '../../cno/src/bun/crypto';
import { blake2b } from '../../cno/src/bun/crypto/blake2b';

// RFC 7693 appendix vectors for the unkeyed digest.
const ABC_512 = 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1'
    + '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923';
const ABC_256 = 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319';
// RFC 7693 keyed test: 64-byte key 00..3f, empty message, 64-byte digest.
const KEYED_512 = '10ebb67700b1868efb4417987acf4690ae9d972fb7a590c2f02871799aaa4786'
    + 'b5e996e8f0f4eb981fc214b005f42d2ff4233499391653df7aefcbc13fc51568';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const ascii = (text: string): Uint8Array => Buffer.from(text, 'utf8');
const pattern = (length: number): Uint8Array =>
    Uint8Array.from({ length }, (_, i) => (i * 7 + 13) % 251);

Deno.test('blake2b matches the RFC 7693 appendix vectors', () => {
    strictEqual(hex(blake2b(64, ascii('abc'))), ABC_512);
    strictEqual(hex(blake2b(32, ascii('abc'))), ABC_256);
    strictEqual(hex(blake2b(64, new Uint8Array(0))), createHash('blake2b512').digest('hex'));
});

Deno.test('blake2b matches node blake2b512 across block-boundary lengths', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 255, 300]) {
        const data = pattern(length);
        strictEqual(
            hex(blake2b(64, data)),
            createHash('blake2b512').update(data).digest('hex'),
            `length ${length}`,
        );
    }
});

Deno.test('keyed blake2b matches the RFC 7693 keyed vector', () => {
    const key = Uint8Array.from({ length: 64 }, (_, i) => i);
    strictEqual(hex(blake2b(64, new Uint8Array(0), key)), KEYED_512);
    // Oracle values from python hashlib.blake2b (reference implementation).
    strictEqual(hex(blake2b(32, new Uint8Array(0), key)),
        '2fa9fbd9be36437de204e139e97d402bce68c828f43391608c891b5faed8a98a');
    strictEqual(hex(blake2b(64, ascii('abc'), key)),
        '06bbc3dedf13a31139498655251b7588ccd3bb5aaa071b2d44d8e0a04095579ed'
        + '590fbfdcf941f4370ce5ce623624e7a76d33e7a8109dcda9b57d72f8f8efa51');
    strictEqual(hex(blake2b(32, ascii('abc'), ascii('key'))),
        '0330531d097355a3f72e80d55c1245ccf79f1704431c6e3887938320442c23c0');
    // Keyed and unkeyed must not collide.
    ok(hex(blake2b(64, new Uint8Array(0), key)) !== hex(blake2b(64, new Uint8Array(0))));
});

Deno.test('CryptoHasher exposes blake2b256 with Bun keyed-hash semantics', () => {
    ok(CryptoHasher.algorithms.includes('blake2b256'));

    const hasher = new CryptoHasher('blake2b256');
    strictEqual(hasher.algorithm, 'blake2b256');
    strictEqual(hasher.byteLength, 32);
    strictEqual(hasher.update('abc').digest('hex'), ABC_256);

    // Chunked updates match the one-shot digest.
    strictEqual(new CryptoHasher('blake2b256').update('a').update('bc').digest('hex'), ABC_256);
    strictEqual(new CryptoHasher('BLAKE2B256').update('abc').digest('hex'), ABC_256);
    strictEqual(CryptoHasher.hash('blake2b256', 'abc', 'hex'), ABC_256);

    // A CryptoHasher key is BLAKE2b keying, not HMAC — for both widths.
    const key = Uint8Array.from({ length: 64 }, (_, i) => i);
    strictEqual(new CryptoHasher('blake2b256', key).digest('hex'), hex(blake2b(32, new Uint8Array(0), key)));
    strictEqual(new CryptoHasher('blake2b256', 'key').update('abc').digest('hex'), hex(blake2b(32, ascii('abc'), ascii('key'))));
    strictEqual(new CryptoHasher('blake2b512', key).digest('hex'), KEYED_512);
    strictEqual(new CryptoHasher('blake2b512', 'key').update('abc').digest('hex'), hex(blake2b(64, ascii('abc'), ascii('key'))));

    // copy() preserves the buffered input.
    const original = new CryptoHasher('blake2b256').update('a');
    const cloned = original.copy();
    original.update('b');
    cloned.update('c');
    strictEqual(original.digest('hex'), hex(blake2b(32, ascii('ab'))));
    strictEqual(cloned.digest('hex'), hex(blake2b(32, ascii('ac'))));
});

Deno.test('blake2b rejects out-of-range digest lengths and keys', () => {
    throws(() => blake2b(0, new Uint8Array(0)), RangeError);
    throws(() => blake2b(65, new Uint8Array(0)), RangeError);
    throws(() => blake2b(1.5, new Uint8Array(0)), RangeError);
    throws(() => blake2b(32, new Uint8Array(0), new Uint8Array(65)), RangeError);
});

Deno.test('blake2b digest respects the requested length', () => {
    for (const length of [1, 16, 20, 32, 48, 64]) {
        const digest = blake2b(length, ascii('abc'));
        strictEqual(digest.byteLength, length);
        ok(digest.buffer instanceof ArrayBuffer);
    }
    // An explicitly empty key must hash exactly like no key (RFC 7693 kk=0).
    strictEqual(hex(blake2b(32, ascii('abc'), new Uint8Array(0))), ABC_256);
});
