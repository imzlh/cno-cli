import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { runInNewContext } from 'node:vm';
import { CryptoHasher } from '../../cno/src/bun/crypto/index.ts';
import { Blob } from '../../cno/src/webapi/formdata.ts';

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

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
    throws(
        () => new CryptoHasher(''),
        (error: unknown) => error instanceof TypeError && error.message === 'Invalid algorithm name' && code('ERR_INVALID_ARG_TYPE')(error),
    );
    for (const algorithm of ['', 'unknown']) {
        throws(
            () => new CryptoHasher(algorithm, 5 as never),
            (error: unknown) => error instanceof TypeError && error.message === 'hmacKey must be a string, ArrayBuffer or ArrayBufferView' && code('ERR_INVALID_ARG_TYPE')(error),
        );
    }
    throws(
        () => new CryptoHasher('unknown', 'key'),
        (error: unknown) => error instanceof TypeError
            && error.message === "algorithm must be one of 'blake2b256', 'blake2b512', 'blake2s256', 'md4', 'md5', 'ripemd160', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-224', 'sha512-256', 'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512', 'shake128' or 'shake256'"
            && code('ERR_INVALID_ARG_TYPE')(error),
    );
    strictEqual(new CryptoHasher('SHA512-256').algorithm, 'sha512-256');
    throws(
        () => new CryptoHasher('shake128', 'key'),
        (error: unknown) => {
            const name = Object.getOwnPropertyDescriptor(error as object, 'name');
            return error instanceof Error
                && error.constructor === Error
                && error.name === 'TODOError'
                && error.message === 'HMAC is not supported for this algorithm yet'
                && (error as { code?: unknown }).code === undefined
                && name?.enumerable === true;
        },
    );
    throws(
        () => new CryptoHasher('shake128', 5 as never),
        (error: unknown) => error instanceof TypeError && error.message === 'hmacKey must be a string, ArrayBuffer or ArrayBufferView' && code('ERR_INVALID_ARG_TYPE')(error),
    );
    const h = new CryptoHasher('sha256').update('abc');
    throws(() => h.digest(new Uint8Array(32)), TypeError);
    throws(() => h.digest('invalid'), TypeError);
    throws(() => h.digest(''), TypeError);
    throws(() => h.digest('utf-16le'), TypeError);
    strictEqual(h.digest('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

Deno.test('bun: CryptoHasher static hash has its own coercion and output contract', () => {
    const output = new Uint8Array(40).fill(42);
    strictEqual(CryptoHasher.hash('sha256', 'abc', output), output);
    strictEqual(Buffer.from(output.subarray(0, 32)).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    deepStrictEqual(Array.from(output.subarray(32)), Array(8).fill(42));
    throws(
        () => CryptoHasher.hash('sha256', 'abc', new Uint8Array(31)),
        (error: unknown) => error instanceof TypeError && error.message === 'TypedArray must be at least 32 bytes' && code('ERR_INVALID_ARG_TYPE')(error),
    );
    throws(
        () => (CryptoHasher.hash as Function)('sha256', 'abc', null),
        (error: unknown) => error instanceof TypeError && error.message === 'output must be of type string or ArrayBuffer or ArrayBufferView' && code('ERR_INVALID_ARG_TYPE')(error),
    );
    throws(
        () => (CryptoHasher.hash as Function)(new String('sha256'), 'abc', 'hex'),
        (error: unknown) => error instanceof TypeError && error.message === 'algorithm must be a string' && code('ERR_INVALID_ARG_TYPE')(error),
    );
    throws(
        () => (CryptoHasher.hash as Function)('unknown', Symbol('input'), 'nope'),
        (error: unknown) => error instanceof TypeError && error.message === 'input must be a string, ArrayBuffer, ArrayBufferView or Blob' && code('ERR_INVALID_ARG_TYPE')(error),
    );
    for (const output of [null, 5, {}]) {
        throws(
            () => (CryptoHasher.hash as Function)('unknown', 'abc', output),
            (error: unknown) => error instanceof TypeError && error.message === 'output must be of type string or ArrayBuffer or ArrayBufferView' && code('ERR_INVALID_ARG_TYPE')(error),
        );
    }
    for (const output of [undefined, 'nope', new Uint8Array(1)]) {
        throws(
            () => (CryptoHasher.hash as Function)('unknown', 'abc', output),
            (error: unknown) => error instanceof TypeError && error.message === 'Unsupported algorithm "unknown"' && code('ERR_INVALID_ARG_TYPE')(error),
        );
    }
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

Deno.test('bun: CryptoHasher shape and receiver checks match Bun', () => {
    const Hash = CryptoHasher as unknown as {
        new (algorithm: string): CryptoHasher;
        (...args: unknown[]): unknown;
        length: number;
        hash: Function;
        prototype: CryptoHasher;
    };
    const hasher = new Hash('sha256');
    strictEqual(Hash.length, 0);
    strictEqual(Hash.hash.length, 2);
    strictEqual(Hash.prototype.update.length, 2);
    strictEqual(Hash.prototype.digest.length, 0);
    strictEqual(Hash.prototype.copy.length, 0);
    strictEqual(Object.prototype.toString.call(hasher), '[object CryptoHasher]');
    deepStrictEqual(Reflect.ownKeys(hasher), []);
    deepStrictEqual(
        Reflect.ownKeys(Hash.prototype).map(String).sort(),
        ['Symbol(Symbol.toStringTag)', 'algorithm', 'byteLength', 'constructor', 'copy', 'digest', 'update'],
    );
    throws(() => Hash('sha256'), (error: unknown) => error instanceof TypeError && code('ERR_ILLEGAL_CONSTRUCTOR')(error));
    for (const method of [Hash.prototype.update, Hash.prototype.digest, Hash.prototype.copy]) {
        throws(
            () => Reflect.apply(method as Function, {}, ['abc']),
            (error: unknown) => error instanceof TypeError && code('ERR_INVALID_THIS')(error),
        );
    }
    const algorithm = Object.getOwnPropertyDescriptor(Hash.prototype, 'algorithm')!.get!;
    throws(() => algorithm.call(Object.create(Hash.prototype)), /only be used on instances of CryptoHasher/);
    strictEqual(Reflect.apply(Hash.hash, null, ['sha256', 'abc', 'hex']), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

Deno.test('bun: CryptoHasher accepts cross-realm buffers and preserves view windows', () => {
    const foreign = runInNewContext(`(() => {
        const inputBacking = new Uint8Array([9, 97, 98, 99, 9]);
        const outputBacking = new Uint8Array(80).fill(42);
        return {
            buffer: inputBacking.buffer,
            typed: inputBacking.subarray(1, 4),
            data: new DataView(inputBacking.buffer, 1, 3),
            outputBacking,
            output: outputBacking.subarray(8, 72),
        };
    })()`);
    strictEqual(CryptoHasher.hash('sha256', foreign.buffer, 'hex'), CryptoHasher.hash('sha256', new Uint8Array([9, 97, 98, 99, 9]), 'hex'));
    strictEqual(CryptoHasher.hash('sha256', foreign.typed, 'hex'), CryptoHasher.hash('sha256', 'abc', 'hex'));
    strictEqual(CryptoHasher.hash('sha256', foreign.data, foreign.output), foreign.output);
    strictEqual(Buffer.from(foreign.outputBacking.subarray(8, 40)).toString('hex'), CryptoHasher.hash('sha256', 'abc', 'hex'));
    deepStrictEqual(Array.from(foreign.outputBacking.subarray(0, 8)), Array(8).fill(42));
    deepStrictEqual(Array.from(foreign.outputBacking.subarray(72)), Array(8).fill(42));
});
