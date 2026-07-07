import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';
import * as crypto from 'node:crypto';

// --- 1. AES-256-CBC cipher/decipher round-trip -----------------------------

Deno.test('crypto: AES-256-CBC encrypt then decrypt round-trips', () => {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const plaintext = 'the quick brown fox jumps over the lazy dog';

    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    strictEqual(decrypted, plaintext);
});

// --- 2. AES-256-GCM round-trip with auth tag -------------------------------

Deno.test('crypto: AES-256-GCM round-trips with auth tag', () => {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const plaintext = 'authenticated encryption';
    const aad = Buffer.from('additional-data');

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    decipher.setAAD(aad);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    strictEqual(decrypted, plaintext);
});

// --- 3. GCM auth-tag mismatch must fail decryption -------------------------

Deno.test('crypto: AES-256-GCM with wrong auth tag throws on final', () => {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    let encrypted = cipher.update('data', 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(crypto.randomBytes(16)); // wrong tag
    decipher.update(encrypted, 'hex', 'utf8');
    let threw = false;
    try { decipher.final('utf8'); } catch { threw = true; }
    ok(threw, 'final with wrong auth tag must throw');
});

Deno.test('crypto upstream: AES-GCM multiple updates and invalid inputs match Node', () => {
    const gcm = crypto.createCipheriv('aes-128-gcm', Buffer.alloc(16), Buffer.alloc(12));
    strictEqual(gcm.update('hello', 'utf8', 'hex'), '6bedb6a20f');
    strictEqual(gcm.update('world', 'utf8', 'hex'), 'c1cce09f4c');
    strictEqual(gcm.final('hex'), '');
    strictEqual(gcm.getAuthTag().toString('hex'), 'bf6d20a38e0c828bea3de63b7ff1dfbd');

    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        Buffer.from('eYLEiLFQnpjYksWTiKpwv2sKhw+WJb5Fo/aY2YqXswc=', 'base64'),
        Buffer.from('k5oP3kb8tTbZaL3PxbFWN8ToOb8vfv2b1EuPz1LbmYU=', 'base64'),
    );
    strictEqual(
        decipher.update('s0/KBsFec29XLrGbAnLiNA==', 'base64', 'utf8'),
        'this is a secret',
    );
    throws(() => decipher.final(), /authenticate|bad decrypt|Unsupported state/i);

    throws(() => crypto.createCipheriv('aes-128-gcm', Buffer.alloc(15), Buffer.alloc(12)), /Invalid key length/);
    throws(() => crypto.createCipheriv('aes-256-gcm', Buffer.alloc(31), Buffer.alloc(12)), /Invalid key length/);
});

Deno.test('crypto upstream: RSA publicEncrypt/privateDecrypt round-trips KeyObjects', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const plaintext = Buffer.from('rsa-public-encrypt');

    const encrypted = crypto.publicEncrypt(publicKey, plaintext);
    ok(Buffer.isBuffer(encrypted));
    const decrypted = crypto.privateDecrypt(privateKey, encrypted);
    deepStrictEqual(decrypted, plaintext);
});

Deno.test('crypto upstream: AES-CBC chunk vectors and final padding match Node', () => {
    const cipher = crypto.createCipheriv(
        'aes-128-cbc',
        new Uint8Array(16),
        new Uint8Array(16),
    );

    strictEqual(
        cipher.update(new Uint8Array(16), undefined, 'hex'),
        '66e94bd4ef8a2c3b884cfa59ca342b2e',
    );
    strictEqual(
        cipher.update(new Uint8Array(19), undefined, 'hex'),
        'f795bd4a52e29ed713d313fa20e98dbc',
    );
    strictEqual(
        cipher.update(new Uint8Array(55), undefined, 'hex'),
        'a10cf66d0fddf3405370b4bf8df5bfb347c78395e0d8ae2194da0a90abc9888a94ee48f6c78fcd518a941c3896102cb1',
    );
    strictEqual(cipher.final('hex'), 'e11901dde4a2f99fe4efc707e48c6aed');
});

Deno.test('crypto upstream: decipher auto padding controls last chunk semantics', () => {
    const key = Buffer.from(
        '84dcdd964968734fdf0de4a2cba471c2e0a753930b841c014b1e77f456b5797b',
        'hex',
    );
    const encrypted = Buffer.from(
        'feabbdf66e2c71cc780d0cd2765dcce283e8ae7e58fcc1a9acafc678581e0e06',
        'hex',
    );
    const iv = Buffer.alloc(16);

    const noPadding = crypto.createDecipheriv('aes-256-cbc', key, iv);
    noPadding.setAutoPadding(false);
    strictEqual(
        noPadding.update(encrypted, undefined, 'hex'),
        'ed2c908f26571bf8e50d60b77fb9c25f95b933b59111543c6fac41ad6b47e681',
    );
    strictEqual(noPadding.final('hex'), '');

    const withPadding = crypto.createDecipheriv('aes-256-cbc', key, iv);
    strictEqual(
        withPadding.update(encrypted, undefined, 'hex'),
        'ed2c908f26571bf8e50d60b77fb9c25f',
    );
    throws(() => withPadding.final());
});

Deno.test('crypto upstream: cipher and decipher validate algorithm key and iv', () => {
    throws(
        () => crypto.createCipheriv('missing-cipher', new Uint8Array(16), new Uint8Array(16)),
        /Unknown cipher/,
    );
    throws(
        () => crypto.createDecipheriv('missing-cipher', new Uint8Array(16), new Uint8Array(16)),
        /Unknown cipher/,
    );
    throws(
        () => crypto.createCipheriv('aes-256-cbc', new Uint8Array(31), new Uint8Array(16)),
        /Invalid key length/,
    );
    throws(
        () => crypto.createDecipheriv('aes-256-cbc', new Uint8Array(32), new Uint8Array(15)),
        /Invalid initialization vector/,
    );
});

// --- 4. createSign / createVerify round-trip -------------------------------

Deno.test('crypto: SHA256 sign then verify round-trips', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const data = Buffer.from('signed-message');

    const signer = crypto.createSign('SHA256');
    signer.update(data);
    const signature = signer.sign(privateKey);

    const verifier = crypto.createVerify('SHA256');
    verifier.update(data);
    ok(verifier.verify(publicKey, signature), 'valid signature must verify');
});

// --- 5. verify with tampered data fails ------------------------------------

Deno.test('crypto: verify rejects tampered data', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const data = Buffer.from('original');

    const signer = crypto.createSign('SHA256');
    signer.update(data);
    const signature = signer.sign(privateKey);

    const verifier = crypto.createVerify('SHA256');
    verifier.update(Buffer.from('tampered'));
    ok(!verifier.verify(publicKey, signature), 'tampered data must not verify');
});

// --- 6. crypto.sign / crypto.verify static API -----------------------------

Deno.test('crypto: static sign/verify round-trips raw EC keys', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const data = Buffer.from('chunk-a chunk-b');
    const signature = crypto.sign('sha256', data, privateKey);
    ok(crypto.verify('sha256', data, publicKey, signature));
});

Deno.test('crypto: verify rejects signature from a different EC keypair', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { publicKey: otherPublicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const data = Buffer.from('mismatched-keypair');
    const signature = crypto.sign('sha256', data, privateKey);
    ok(!crypto.verify('sha256', data, otherPublicKey, signature));
    ok(crypto.verify('sha256', data, publicKey, signature));
});

Deno.test('crypto: createSecretKey produces HMAC-compatible KeyObject', () => {
    const key = crypto.createSecretKey(Buffer.from('secret'));
    strictEqual(key.type, 'secret');
    strictEqual(key.asymmetricKeyType, undefined);
    strictEqual(key.symmetricKeySize, 6);
    const digest = crypto.createHmac('sha256', key).update('abc').digest('hex');
    strictEqual(digest, '9946dad4e00e913fc8be8e5d3f7e110a4a9e832f83fb09c345285d78638d8a0e');
});

Deno.test('crypto upstream: secret KeyObject export supports raw and JWK formats', () => {
    const empty = crypto.createSecretKey(Buffer.alloc(0));
    strictEqual(empty.type, 'secret');
    strictEqual(empty.asymmetricKeyType, undefined);
    strictEqual(empty.symmetricKeySize, 0);

    const material = Buffer.from('secret');
    const key = crypto.createSecretKey(material);
    deepStrictEqual(Buffer.from(key.export()), material);
    deepStrictEqual(key.export({ format: 'jwk' }), { kty: 'oct', k: 'c2VjcmV0' });
});

Deno.test('crypto: createSign/createVerify support hex signature encoding', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const signer = crypto.createSign('sha256');
    signer.update('chunk-a ');
    signer.update('chunk-b');
    const signatureHex = signer.sign(privateKey, 'hex');
    ok(typeof signatureHex === 'string');
    ok(signatureHex.length > 0 && signatureHex.length % 2 === 0);

    const verifier = crypto.createVerify('sha256');
    verifier.update('chunk-a chunk-b');
    ok(verifier.verify(publicKey, signatureHex, 'hex'));
});

Deno.test('crypto upstream: sign and verify support RSA SHA224 and SHA384 aliases', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const data = Buffer.from('some data to sign');

    for (const [shortName, rsaName] of [['sha224', 'RSA-SHA224'], ['sha384', 'RSA-SHA384']] as const) {
        const signer = crypto.createSign(shortName);
        signer.update(data);
        const signatureHex = signer.sign(privateKey, 'hex');
        ok(typeof signatureHex === 'string');
        ok(signatureHex.length > 0 && signatureHex.length % 2 === 0);

        const verifier = crypto.createVerify(rsaName);
        verifier.update(data);
        ok(verifier.verify(publicKey, signatureHex, 'hex'), `${rsaName} signature must verify`);

        const staticSignature = crypto.sign(rsaName, data, privateKey);
        ok(Buffer.isBuffer(staticSignature));
        ok(crypto.verify(shortName, data, publicKey, staticSignature), `${shortName} static signature must verify`);
        ok(!crypto.verify('sha256', data, publicKey, staticSignature), `${shortName} signature must not verify as sha256`);
    }
});

// --- 9. pbkdf2Sync derives deterministic key ------------------------------

Deno.test('crypto: pbkdf2Sync is deterministic for same input', () => {
    const pass = 'password';
    const salt = 'salt';
    const k1 = crypto.pbkdf2Sync(pass, salt, 1000, 32, 'sha256');
    const k2 = crypto.pbkdf2Sync(pass, salt, 1000, 32, 'sha256');
    strictEqual(k1.toString('hex'), k2.toString('hex'));
    strictEqual(k1.length, 32);
});

Deno.test('crypto upstream: pbkdf2 sha1 matches RFC vector in sync and async forms', async () => {
    const expected = '0c60c80f961f0e71f3a9b524af6012062fe037a6e0f0eb94fe8fc46bdc637164';
    strictEqual(crypto.pbkdf2Sync('password', 'salt', 1, 32, 'sha1').toString('hex'), expected);

    const asyncKey = await new Promise<Uint8Array>((resolve, reject) => {
        crypto.pbkdf2('password', 'salt', 1, 32, 'sha1', (err, key) => {
            if (err) reject(err);
            else resolve(key);
        });
    });
    strictEqual(Buffer.from(asyncKey).toString('hex'), expected);
});

Deno.test('crypto upstream: pbkdf2 supports official digest vectors and typed-array bytes', async () => {
    const expected: Record<string, string> = {
        md5: 'f31afb6d931392daa5e3130f47f9a9b6e8e72029d8350b9fb27a9e0e00b9d991',
        sha224: '3c198cbdb9464b7857966bd05b7bc92bc1cc4e6e63155d4e490557fd85989497',
        sha384: 'c0e14f06e49e32d73f9f52ddf1d0c5c7191609233631dadd76a567db42b78676',
        ripemd160: 'b725258b125e0bacb0e2307e34feb16a4d0d6aed6cb4b0eee458fc1829020428',
    };

    for (const [digest, hex] of Object.entries(expected)) {
        strictEqual(crypto.pbkdf2Sync('password', 'salt', 1, 32, digest).toString('hex'), hex);
        const asyncKey = await new Promise<Buffer>((resolve, reject) => {
            crypto.pbkdf2('password', 'salt', 1, 32, digest, (err, key) => {
                if (err) reject(err);
                else resolve(key);
            });
        });
        strictEqual(asyncKey.toString('hex'), hex);
    }

    strictEqual(
        crypto.pbkdf2Sync(new Int32Array([112, 97, 115, 115, 119, 111, 114, 100]), 'salt', 1, 32, 'sha256').toString('hex'),
        '9b4608f5eeab348f0b9d85a918b140706b24f275acf6829382dfee491015f9eb',
    );
    strictEqual(
        crypto.pbkdf2Sync('password', new Float64Array([115, 97, 108, 116]), 1, 32, 'sha512').toString('hex'),
        'b10c2ea742de7dd0525988761ee1733564c91380eeaa1b199f4fafcbf7144b0c',
    );
});

// --- 10. scryptSync derives key --------------------------------------------

Deno.test('crypto: scryptSync derives expected length', () => {
    const k = crypto.scryptSync('password', 'salt', 32);
    strictEqual(k.length, 32);
    deepStrictEqual(k, Buffer.from([
        116, 87, 49, 175, 68, 132, 243, 35,
        150, 137, 105, 237, 162, 137, 174, 238,
        0, 91, 89, 3, 172, 86, 30, 100,
        165, 172, 161, 33, 121, 123, 247, 115,
    ]));
});

Deno.test('crypto: scryptSync accepts cost/blockSize/parallelization aliases', () => {
    const byPrimary = crypto.scryptSync('password', 'salt', 32, { N: 1024, r: 8, p: 1 });
    const byAlias = crypto.scryptSync('password', 'salt', 32, { cost: 1024, blockSize: 8, parallelization: 1 });
    strictEqual(byAlias.toString('hex'), byPrimary.toString('hex'));

    deepStrictEqual(crypto.scryptSync('password', 'salt', 32, { N: 512 }), Buffer.from([
        57, 134, 165, 72, 236, 9, 166, 182,
        42, 46, 138, 230, 251, 154, 25, 15,
        214, 209, 57, 208, 31, 163, 203, 87,
        251, 42, 144, 179, 98, 92, 193, 71,
    ]));
});

Deno.test('crypto: scrypt callback matches scryptSync output', async () => {
    const expected = Buffer.from(crypto.scryptSync('password', 'salt', 16, { N: 1024, r: 8, p: 1 })).toString('hex');
    const derived = await new Promise<Uint8Array>((resolve, reject) => {
        crypto.scrypt('password', 'salt', 16, { cost: 1024, blockSize: 8, parallelization: 1 }, (err, key) => {
            if (err) reject(err);
            else resolve(key);
        });
    });
    strictEqual(derived.length, 16);
    strictEqual(Buffer.from(derived).toString('hex'), expected);
});

Deno.test('crypto: scryptSync rejects non-power-of-two cost', () => {
    let caught: Error | null = null;
    try {
        crypto.scryptSync('password', 'salt', 16, { N: 1000 });
    } catch (error) {
        caught = error as Error;
    }
    ok(caught instanceof RangeError);
    ok(caught.message.includes('Invalid scrypt params'));
});

Deno.test('crypto: scrypt rejects invalid params before invoking callback', () => {
    let caught: Error | null = null;
    let callbackCalled = false;
    try {
        crypto.scrypt('password', 'salt', 16, { N: 1000 }, () => {
            callbackCalled = true;
        });
    } catch (error) {
        caught = error as Error;
    }
    ok(caught instanceof RangeError);
    ok(caught.message.includes('Invalid scrypt params'));
    strictEqual(callbackCalled, false);
});

// --- 11. createHmac is stable -----------------------------------------------

Deno.test('crypto: createHmac produces stable hex', () => {
    const h = crypto.createHmac('sha256', 'key').update('msg').digest('hex');
    strictEqual(h, '2d93cbc1be167bcb1637a4a23cbff01a7878f0c50ee833954ea5221bb1b8c628');
    ok(/^[0-9a-f]{64}$/.test(h), 'hmac sha256 must be 64 hex chars');
});

Deno.test('crypto upstream: hash and HMAC encodings match Node fixtures', () => {
    const sha1Buffer = crypto.createHash('sha1').update('abc').update('def').digest();
    ok(Buffer.isBuffer(sha1Buffer));
    deepStrictEqual(
        Buffer.from(sha1Buffer),
        Buffer.from([
            0x1f, 0x8a, 0xc1, 0x0f, 0x23, 0xc5, 0xb5, 0xbc, 0x11, 0x67,
            0xbd, 0xa8, 0x4b, 0x83, 0x3e, 0x5c, 0x05, 0x7a, 0x77, 0xd2,
        ]),
    );
    strictEqual(crypto.createHash('sha1').update('abc').update('def').digest('base64url'), 'H4rBDyPFtbwRZ72oS4M-XAV6d9I');
    const hmacBuffer = crypto.createHmac('sha1', 'secret').update('hello').digest();
    ok(Buffer.isBuffer(hmacBuffer));
    strictEqual(hmacBuffer.toString('hex'), '5112055c05f944f85755efc5cd8970e194e9f45b');
    strictEqual(
        crypto.createHmac('sha512-224', 'secret').update('hello').digest('hex'),
        '27ade3215d20a0e939a1ff98f91052148e85f2ece87d926d6a2c1aad',
    );
    strictEqual(
        crypto.createHmac('sha512-256', 'secret').update('hello').digest('hex'),
        'e1a285d0317f7cce89acb5642fb6e82fc16d14ab588b0a5abcc7c20ea748594e',
    );
    strictEqual(
        crypto.createHmac('sha3-224', 'secret').update('hello').digest('hex'),
        'd078791e9bf080c2139f883ac65033d4b5b75bbdb4088c494d0b6a14',
    );
    strictEqual(
        crypto.createHmac('sha3-256', 'secret').update('hello').digest('hex'),
        '850ae61707b3e60d4e45548c4facfda415d301712641fd11535cf395d9e2d7fe',
    );
    strictEqual(
        crypto.createHmac('sha3-384', 'secret').update('hello').digest('hex'),
        'e24e0dc664132644a6740071af5a05622edffea8afacf0a4060111961bc9148f23c001b6f7d7e79a44b9896b1f00cd85',
    );
    strictEqual(
        crypto.createHmac('sha3-512', 'secret').update('hello').digest('hex'),
        'bc07c2dfc0295b420662bda474eb8db11b0389822e13da56cf9991f467f2f6c713c481aa8663900ecaee310bf2f226eaa5c2d1345dfebee990658bd529a9c504',
    );
    strictEqual(
        crypto.createHmac('blake2b512', 'secret').update('hello').digest('hex'),
        '59d8e60d8f7f54753ab7b823b11f20879c4db732e5b56a0da5559d10b2c2b7ac37d47474b668725b661178359ad71c189597108dd2d94ca051697fbc24b6d7ad',
    );
    strictEqual(
        crypto.createHmac('blake2s256', 'secret').update('hello').digest('hex'),
        '56f9d5d171c31a9481d1949743ddd370209f7c666ba8bb6872067ad70398d9ce',
    );
    throws(() => crypto.createHmac('unknown-algorithm', 'secret'), /Unsupported HMAC algorithm/);
});

Deno.test('crypto upstream: hash and HMAC finalized state matches Node', () => {
    const hash = crypto.createHash('sha256');
    strictEqual(hash.update('a'), hash);
    strictEqual(hash.digest('hex'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
    throws(() => hash.update('b'), /Digest already called/);
    throws(() => hash.digest('hex'), /Digest already called/);

    const oneshotHash = crypto.createHash('sha512-224');
    strictEqual(oneshotHash.update('a'), oneshotHash);
    strictEqual(oneshotHash.digest('hex'), 'd5cdb9ccc769a5121d4175f2bfdd13d6310e0d3d361ea75d82108327');
    throws(() => oneshotHash.update('b'), /Digest already called/);
    throws(() => oneshotHash.digest('hex'), /Digest already called/);

    const hmac = crypto.createHmac('sha256', 'k');
    strictEqual(hmac.update('a'), hmac);
    strictEqual(hmac.digest('hex'), '78da91511e675587f5b9df78bedebaf5560da2abb88162ee875dcdf744951d9e');
    strictEqual(hmac.digest('hex'), '');
    strictEqual((hmac.digest() as Buffer).length, 0);
    throws(() => hmac.update('b'), /Digest already called/);
});

Deno.test('crypto: latin1 string input encodes code units as bytes', () => {
    const textHash = crypto.createHash('sha256').update('AéĀ', 'latin1').digest('hex');
    const byteHash = crypto.createHash('sha256').update(new Uint8Array([65, 233, 0])).digest('hex');
    strictEqual(textHash, byteHash);
});

// --- 12. generateKeyPairSync RSA -------------------------------------------

Deno.test('crypto: generateKeyPairSync rsa returns KeyObjects by default', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    strictEqual(publicKey.type, 'public');
    strictEqual(privateKey.type, 'private');
    strictEqual(publicKey.asymmetricKeyType, 'rsa');
    strictEqual(privateKey.asymmetricKeyType, 'rsa');
    ok(typeof publicKey.export === 'function');
    ok(typeof privateKey.export === 'function');
});

Deno.test('crypto upstream: generateKeyPair callback returns KeyObjects and exportable public keys', async () => {
    const { publicKey, privateKey } = await new Promise<{
        publicKey: crypto.KeyObject;
        privateKey: crypto.KeyObject;
    }>((resolve, reject) => {
        crypto.generateKeyPair('rsa', { modulusLength: 2048 }, (err, pub, priv) => {
            if (err) reject(err);
            else resolve({ publicKey: pub!, privateKey: priv! });
        });
    });

    strictEqual(publicKey.type, 'public');
    strictEqual(privateKey.type, 'private');
    strictEqual(publicKey.asymmetricKeyType, 'rsa');
    strictEqual(privateKey.asymmetricKeyType, 'rsa');

    const spkiPem = publicKey.export({ format: 'pem', type: 'spki' });
    ok(typeof spkiPem === 'string');
    ok(spkiPem.startsWith('-----BEGIN PUBLIC KEY-----'));

    const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
    ok(Buffer.isBuffer(spkiDer));
    ok(spkiDer.length > 0);
});

// --- 13. getHashes lists common algorithms --------------------------------

Deno.test('crypto: getHashes includes sha256 and sha512', () => {
    const hashes = crypto.getHashes();
    ok(Array.isArray(hashes));
    ok(hashes.includes('sha256'));
    ok(hashes.includes('sha512'));
});

Deno.test('crypto: static sign/verify accept PEM key material', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const data = Buffer.from('pem-key-material');
    const signature = crypto.sign('sha256', data, privatePem);
    ok(crypto.verify('sha256', data, publicPem, signature));
});

Deno.test('crypto: createPublicKey derives verifying key from private PEM', () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const derivedPublicKey = crypto.createPublicKey(privatePem);
    const data = Buffer.from('derived-public-key');
    const signature = crypto.sign('sha256', data, privatePem);
    ok(crypto.verify('sha256', data, derivedPublicKey, signature));
});

Deno.test('crypto: createPrivateKey imports PKCS8 DER buffers', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    const importedPrivateKey = crypto.createPrivateKey({ key: privateDer, type: 'pkcs8', format: 'der' });
    strictEqual(importedPrivateKey.type, 'private');
    strictEqual(importedPrivateKey.asymmetricKeyType, 'ec');
    const data = Buffer.from('pkcs8-der-import');
    const signature = crypto.sign('sha256', data, importedPrivateKey);
    ok(crypto.verify('sha256', data, publicKey, signature));
});

Deno.test('crypto: createPublicKey imports SPKI DER buffers', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicDer = publicKey.export({ type: 'spki', format: 'der' });
    const importedPublicKey = crypto.createPublicKey({ key: publicDer, type: 'spki', format: 'der' });
    strictEqual(importedPublicKey.type, 'public');
    strictEqual(importedPublicKey.asymmetricKeyType, 'ec');
    const data = Buffer.from('spki-der-import');
    const signature = crypto.sign('sha256', data, privateKey);
    ok(crypto.verify('sha256', data, importedPublicKey, signature));
});

Deno.test('crypto: ieee-p1363 dsaEncoding round-trips for EC signatures', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const data = Buffer.from('p1363-signature');
    const signature = crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    strictEqual(signature.length, 64);
    ok(crypto.verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature));
});

Deno.test('crypto: EC curve aliases map to the same P-256 key family', () => {
    const aliasNames = ['prime256v1', 'secp256r1', 'P-256'] as const;
    for (const namedCurve of aliasNames) {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve });
        const data = Buffer.from(`curve-alias:${namedCurve}`);
        const signature = crypto.sign('sha256', data, privateKey);
        ok(crypto.verify('sha256', data, publicKey, signature), `${namedCurve} must round-trip sign/verify`);
    }
});

Deno.test('crypto upstream: EC explicit parameter encoding is rejected', () => {
    throws(
        () => crypto.generateKeyPairSync('ec', {
            namedCurve: 'P-256',
            paramEncoding: 'explicit',
        } as crypto.ECKeyPairOptions<'pem', 'pem'>),
        /explicit/i,
    );
});

Deno.test('crypto: randomBytes returns Buffer with encoding-aware toString', () => {
    const bytes = crypto.randomBytes(16);
    ok(Buffer.isBuffer(bytes));
    strictEqual(bytes.toString('base64').length, 24);
    ok(!bytes.toString('base64').includes(','));
});

Deno.test('crypto upstream: randomBytes callback exceptions escape instead of becoming second callbacks', async () => {
    const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            const { randomBytes } = await import("node:crypto");
            await new Promise((resolve) => {
                randomBytes(0, (err) => {
                    if (!err) {
                        setTimeout(resolve, 0);
                        throw new Error("randomBytes-success-once");
                    }
                    resolve(undefined);
                });
            });
        `],
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    const stderr = new TextDecoder().decode(output.stderr);
    ok(stderr.includes('randomBytes-success-once'), stderr);
});

Deno.test('crypto upstream: randomBytes async pseudoRandomBytes randomUUID and randomInt basics', async () => {
    strictEqual(crypto.randomBytes(0).length, 0);
    strictEqual(crypto.randomBytes(300).length, 300);
    throws(() => crypto.randomBytes(-1), RangeError);
    strictEqual(crypto.pseudoRandomBytes(30).length, 30);

    const asyncBytes = await new Promise<Buffer>((resolve, reject) => {
        crypto.randomBytes(32, (err, bytes) => {
            if (err) reject(err);
            else resolve(bytes);
        });
    });
    ok(Buffer.isBuffer(asyncBytes));
    strictEqual(asyncBytes.length, 32);

    const uuid = crypto.randomUUID();
    strictEqual(uuid.length, globalThis.crypto.randomUUID().length);
    strictEqual(typeof uuid, 'string');

    const small = crypto.randomInt(55);
    ok(small >= 0 && small < 55);
    const ranged = crypto.randomInt(40, 120);
    ok(ranged >= 40 && ranged < 120);
    throws(() => crypto.randomInt(45, 34), RangeError);
    throws(() => crypto.randomInt(undefined as unknown as number), TypeError);
});

Deno.test('crypto upstream: randomInt callback overloads return values in range', async () => {
    const maxOnly = await new Promise<number>((resolve, reject) => {
        crypto.randomInt(3, (err, value) => {
            if (err) reject(err);
            else resolve(value);
        });
    });
    ok(maxOnly >= 0 && maxOnly < 3);

    const ranged = await new Promise<number>((resolve, reject) => {
        crypto.randomInt(3, 5, (err, value) => {
            if (err) reject(err);
            else resolve(value);
        });
    });
    ok(ranged >= 3 && ranged < 5);
});

Deno.test('crypto: randomFillSync fills typed arrays, ArrayBuffers and DataViews in range', () => {
    const bytes = Buffer.alloc(16);
    strictEqual(crypto.randomFillSync(bytes, 4, 8), bytes);
    deepStrictEqual([...bytes.subarray(0, 4)], [0, 0, 0, 0]);
    deepStrictEqual([...bytes.subarray(12)], [0, 0, 0, 0]);
    ok(bytes.subarray(4, 12).some((byte) => byte !== 0));

    const arrayBuffer = new ArrayBuffer(8);
    strictEqual(crypto.randomFillSync(arrayBuffer), arrayBuffer);
    ok(new Uint8Array(arrayBuffer).some((byte) => byte !== 0));

    const backing = new Uint8Array(12);
    const view = new DataView(backing.buffer, 2, 6);
    strictEqual(crypto.randomFillSync(view), view);
    deepStrictEqual([...backing.subarray(0, 2)], [0, 0]);
    deepStrictEqual([...backing.subarray(8)], [0, 0, 0, 0]);
    ok(backing.subarray(2, 8).some((byte) => byte !== 0));

    throws(() => crypto.randomFillSync(Buffer.alloc(10), 1, 10), RangeError);
});

Deno.test('crypto upstream: randomFill callback fills only the requested range', async () => {
    const bytes = Buffer.alloc(10);
    const filled = await new Promise<Buffer>((resolve, reject) => {
        crypto.randomFill(bytes, 5, 5, (err, out) => {
            if (err) reject(err);
            else resolve(out);
        });
    });

    strictEqual(filled, bytes);
    deepStrictEqual([...bytes.subarray(0, 5)], [0, 0, 0, 0, 0]);
    ok(bytes.subarray(5).some((byte) => byte !== 0));
});

Deno.test('crypto: timingSafeEqual accepts ArrayBuffer views and enforces lengths/types', () => {
    const left = Buffer.from([212, 213]);
    const right = Buffer.from([0, 0, 212, 213]).subarray(2);
    ok(crypto.timingSafeEqual(left, right));

    const digest = new Uint8Array(crypto.createHash('sha256').update('foo').digest() as ArrayBuffer);
    ok(crypto.timingSafeEqual(digest.buffer, digest));

    throws(() => crypto.timingSafeEqual(Buffer.from([1]), Buffer.from([1, 2])), RangeError);
    throws(() => crypto.timingSafeEqual('foo' as unknown as Uint8Array, Buffer.from('foo')), TypeError);
});

Deno.test('crypto: one-shot hash and cipher metadata expose supported algorithms', () => {
    strictEqual(crypto.hash('sha1', Buffer.from('Node.js')), '10b3493287f831e81a438811a1ffba01f8cec4b7');
    strictEqual(crypto.hash('sha256', 'hello', 'base64url'), 'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ');
    strictEqual(crypto.hash('sha512-224', 'hello'), 'fe8509ed1fb7dcefc27e6ac1a80eddbec4cb3d2c6fe565244374061c');
    strictEqual(crypto.hash('shake-128', 'Node.js', 'base64url'), 'Nkx9-EgHpFkeXY5OPsL0rg');
    strictEqual(crypto.hash('shake-256', 'Node.js', 'base64url'), 'JdelDxiwp92tkk9jYjEFPMlHD0gC8bMbYtHRCIM6TTQ');
    strictEqual(
        crypto.createHash('blake2s256').update('hello').digest('hex'),
        '19213bacc58dee6dbde3ceb9a47cbb330b3d86f8cca8997eb00be456f140ca25',
    );

    const ciphers = crypto.getCiphers();
    ok(ciphers.includes('aes-128-cbc'));
    ok(ciphers.includes('aes-256-gcm'));
    const hashes = crypto.getHashes();
    ok(hashes.includes('sha512-224'));
    ok(hashes.includes('sha3-512'));
    ok(hashes.includes('blake2b512'));
    ok(hashes.includes('shake-128'));
    ok(hashes.includes('shake-256'));

    const info = crypto.getCipherInfo('aes-128-cbc');
    deepStrictEqual(
        { name: info?.name, keyLength: info?.keyLength, ivLength: info?.ivLength, mode: info?.mode },
        { name: 'aes-128-cbc', keyLength: 16, ivLength: 16, mode: 'cbc' },
    );
    strictEqual(crypto.getCipherInfo('aes128')?.name, 'aes-128-cbc');
    strictEqual(crypto.getCipherInfo('missing-cipher'), undefined);
});

Deno.test('crypto upstream: hkdfSync uses ArrayBufferView bytes and enforces info limit', () => {
    const stringResult = crypto.hkdfSync('sha256', 'secret', 'salt', 'info', 10);
    strictEqual(Buffer.from(stringResult).toString('hex'), 'f6d2fcc47cb939deafe3');

    const uint16Result = crypto.hkdfSync(
        'sha256',
        'secret',
        new Uint16Array(Buffer.from('salt')),
        new Uint16Array(Buffer.from('info')),
        10,
    );
    strictEqual(Buffer.from(uint16Result).toString('hex'), 'db570fbe9a3a81e18bef');

    const salt = Buffer.from('salt');
    const info = Buffer.from('info');
    const dataViewResult = crypto.hkdfSync(
        'sha256',
        'secret',
        new DataView(salt.buffer, salt.byteOffset, salt.byteLength),
        new DataView(info.buffer, info.byteOffset, info.byteLength),
        10,
    );
    strictEqual(Buffer.from(dataViewResult).toString('hex'), 'f6d2fcc47cb939deafe3');

    throws(
        () => crypto.hkdfSync('sha256', 'secret', 'salt', new Uint8Array(1025), 10),
        /must not contain more than 1024 bytes/,
    );
});

Deno.test('crypto upstream: hkdf async callback matches hkdfSync', async () => {
    let callbackCalled = false;
    const asyncResult = await new Promise<ArrayBuffer>((resolve, reject) => {
        const ret = crypto.hkdf(
            'sha256',
            'secret',
            new Uint16Array(Buffer.from('salt')),
            new Uint16Array(Buffer.from('info')),
            10,
            (err, derivedKey) => {
                callbackCalled = true;
                if (err) reject(err);
                else resolve(derivedKey!);
            },
        );
        strictEqual(ret, undefined);
        strictEqual(callbackCalled, false);
    });

    const syncResult = crypto.hkdfSync(
        'sha256',
        'secret',
        new Uint16Array(Buffer.from('salt')),
        new Uint16Array(Buffer.from('info')),
        10,
    );
    strictEqual(Buffer.from(asyncResult).toString('hex'), Buffer.from(syncResult).toString('hex'));
    strictEqual(callbackCalled, true);
});
