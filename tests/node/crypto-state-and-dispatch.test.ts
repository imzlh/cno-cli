import { strictEqual, throws } from 'node:assert';
import * as crypto from 'node:crypto';

Deno.test('crypto: every native hash keeps copied digest branches independent', () => {
    for (const algorithm of [
        'md5', 'ripemd160', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512',
        'sha512-224', 'sha512-256', 'sha3-224', 'sha3-256', 'sha3-384',
        'sha3-512', 'blake2b512', 'blake2s256',
    ]) {
        const input = Buffer.from('prefix:');
        const base = crypto.createHash(algorithm).update(input);
        const left = base.copy();
        const right = base.copy();
        input.fill(0);
        strictEqual(left.update('left').digest('hex'), crypto.hash(algorithm, 'prefix:left'), algorithm);
        strictEqual(base.update('base').digest('hex'), crypto.hash(algorithm, 'prefix:base'), algorithm);
        strictEqual(right.update('right').digest('hex'), crypto.hash(algorithm, 'prefix:right'), algorithm);
        for (const state of [base, left, right]) {
            throws(() => state.update('after'), { code: 'ERR_CRYPTO_HASH_FINALIZED' });
            throws(() => state.digest(), { code: 'ERR_CRYPTO_HASH_FINALIZED' });
            throws(() => state.copy(), { code: 'ERR_CRYPTO_HASH_FINALIZED' });
        }
    }
});

Deno.test('crypto: native and buffered HMACs consume input and finalize consistently', () => {
    // Expected values from Node.js cover native, generic, and empty-key paths.
    const vectors = [
        ['sha1', '', 'a2202c38c0d2dfd588dbf2ed5c2b1d10f0c507b3'],
        ['sha1', 'secret', 'f30180e52866544e40705d7fffc5e9ede64c8dba'],
        ['sha256', '', '34e44df4878f1f905d4517ab9ac31a47589f6f0b418788f696d1add75a96efb7'],
        ['sha256', 'secret', 'dcb07fa23f63c43de16e0f362193b1c6cef4bd4bd8413846768892a1c1b36f8a'],
        ['sha512', '', 'a3d71c67d9238711c6df8aa1975d70fbea5fb8a01cea0629475ed9061deb7771d20b3c040eaaceefaf3de9d4486d679f0cae72d2f4130e90ec40d0a781623b38'],
        ['sha512', 'secret', '99e5871089af8652ab74fa732ed9b80fe45e853f9c3f0c6a2b7afb957ad0151a9e08789517476b42ed428be68f0affa724912ee4d6963497d587a844615f7b29'],
        ['sha512-224', '', '0a83212c75bac8a508c4acf18cc5a27af0cfab4d99347ec5219482e4'],
        ['sha512-224', 'secret', 'cacd95c11439bffc56c448f1157c92ce643a8e712af4fa204fe1be2b'],
    ];
    for (const [algorithm, key, expected] of vectors) {
        const input = Buffer.from('prefix:');
        const state = crypto.createHmac(algorithm, key).update(input);
        input.fill(0);
        state.update('payload');
        strictEqual(state.digest('hex'), expected, `${algorithm}/${key}`);
        strictEqual(state.digest('hex'), '');
        strictEqual(state.digest().byteLength, 0);
        throws(() => state.update('after'), { code: 'ERR_CRYPTO_HASH_FINALIZED' });
    }
});

Deno.test('crypto: RSA digest aliases agree between one-shot and streaming signatures', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    const data = Buffer.from('signature dispatch');
    for (const algorithm of ['sha224', 'sha256', 'sha384', 'sha512']) {
        const alias = `RSA-${algorithm.toUpperCase()}`;
        const signature = crypto.sign(algorithm, data, privateKey);
        const streamed = crypto.createSign(alias).update('signature ').update('dispatch').sign(privateKey);
        strictEqual(streamed.toString('hex'), signature.toString('hex'), algorithm);
        strictEqual(crypto.verify(alias, data, publicKey, streamed), true, algorithm);
        strictEqual(crypto.createVerify(algorithm.toUpperCase()).update(data).verify(publicKey, signature), true, algorithm);
        strictEqual(crypto.verify(alias, Buffer.from('tampered'), publicKey, signature), false, algorithm);
        const altered = Buffer.from(signature);
        altered[0] ^= 1;
        strictEqual(crypto.createVerify(alias).update(data).verify(publicKey, altered), false, algorithm);
    }

    for (const algorithm of ['not-a-digest', 'toString', '__proto__']) {
        throws(() => crypto.sign(algorithm, data, privateKey));
        throws(() => crypto.verify(algorithm, data, publicKey, Buffer.alloc(128)));
        throws(() => crypto.createSign(algorithm).update(data).sign(privateKey));
        throws(() => crypto.createVerify(algorithm).update(data).verify(publicKey, Buffer.alloc(128)));
    }
});
