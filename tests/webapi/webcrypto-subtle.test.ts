import { deepStrictEqual, strictEqual, ok, rejects, throws } from 'node:assert';
import { decodeUtf8, encodeUtf8 } from '../_helpers/bytes.ts';

// webcrypto subtle: tricky cases are (1) sign/verify round-trip, (2) digest
// stability, (3) AES-GCM encrypt/decrypt with a random IV, and (4) the
// CryptoKey.usages guard (a key made for sign must reject decrypt).

Deno.test('webcrypto: sha-256 digest is stable and 32 bytes', async () => {
    const data = encodeUtf8('hello');
    const d1 = await crypto.subtle.digest('SHA-256', data);
    const d2 = await crypto.subtle.digest('SHA-256', data);
    strictEqual(d1.byteLength, 32);
    ok(arrayBufferEqual(d1, d2), 'same input must yield same digest');
});

Deno.test('webcrypto: sha-256 differs for different input', async () => {
    const a = await crypto.subtle.digest('SHA-256', encodeUtf8('a'));
    const b = await crypto.subtle.digest('SHA-256', encodeUtf8('b'));
    ok(!arrayBufferEqual(a, b));
});

Deno.test('webcrypto upstream: digest consumes only the supplied BufferSource view range', async () => {
    const source = encodeUtf8('xxhelloyy');
    const view = new Uint8Array(source.buffer, source.byteOffset + 2, 5);
    const sliced = await crypto.subtle.digest({ name: 'SHA-256' }, view);
    const plain = await crypto.subtle.digest('SHA-256', encodeUtf8('hello'));
    const full = await crypto.subtle.digest('SHA-256', source);

    ok(arrayBufferEqual(sliced, plain));
    ok(!arrayBufferEqual(sliced, full));
});

Deno.test('webcrypto upstream: unsupported digest algorithms reject', async () => {
    await rejects(
        () => crypto.subtle.digest('SHA-999', new Uint8Array()),
        /Unsupported hash algorithm/,
    );
});

Deno.test('webcrypto: HMAC sign then verify succeeds', async () => {
    const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
    );
    const data = encodeUtf8('message');
    const sig = await crypto.subtle.sign('HMAC', key, data);
    ok(sig.byteLength > 0, 'signature must be non-empty');
    const valid = await crypto.subtle.verify('HMAC', key, sig, data);
    strictEqual(valid, true);
});

Deno.test('webcrypto: HMAC verify fails on tampered data', async () => {
    const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
    );
    const data = encodeUtf8('message');
    const sig = await crypto.subtle.sign('HMAC', key, data);
    const tampered = encodeUtf8('messagf');
    const valid = await crypto.subtle.verify('HMAC', key, sig, tampered);
    strictEqual(valid, false);
});

Deno.test('webcrypto upstream: RSA-PSS and RSASSA sign verify round-trips', async () => {
    const data = encodeUtf8('rsa message');
    for (const algorithm of ['RSA-PSS', 'RSASSA-PKCS1-v1_5'] as const) {
        const keyPair = await crypto.subtle.generateKey(
            {
                name: algorithm,
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: 'SHA-256',
            },
            true,
            ['sign', 'verify'],
        );
        ok(keyPair.privateKey.usages.includes('sign'));
        ok(keyPair.publicKey.usages.includes('verify'));

        const signAlgorithm = algorithm === 'RSA-PSS'
            ? { name: algorithm, saltLength: 32 }
            : { name: algorithm };
        const signature = await crypto.subtle.sign(signAlgorithm, keyPair.privateKey, data);
        ok(signature instanceof ArrayBuffer);
        ok(signature.byteLength > 0);
        strictEqual(await crypto.subtle.verify(signAlgorithm, keyPair.publicKey, signature, data), true);
        strictEqual(await crypto.subtle.verify(signAlgorithm, keyPair.publicKey, signature, encodeUtf8('tampered')), false);
    }
});

Deno.test('webcrypto upstream: ECDSA sign verify and key direction errors', async () => {
    const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-384' },
        true,
        ['sign', 'verify'],
    );
    const algorithm = { name: 'ECDSA', hash: 'SHA-384' };
    const data = encodeUtf8('ecdsa message');
    const signature = await crypto.subtle.sign(algorithm, keyPair.privateKey, data);
    ok(signature instanceof ArrayBuffer);
    strictEqual(await crypto.subtle.verify(algorithm, keyPair.publicKey, signature, data), true);
    strictEqual(await crypto.subtle.verify(algorithm, keyPair.publicKey, signature, encodeUtf8('tampered')), false);

    await rejects(() => crypto.subtle.sign(algorithm, keyPair.publicKey, data), DOMException);
    await rejects(() => crypto.subtle.verify(algorithm, keyPair.privateKey, signature, data), DOMException);
});

Deno.test('webcrypto: AES-GCM encrypt then decrypt round-trips', async () => {
    const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encodeUtf8('secret-data');
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    ok(ct.byteLength > plaintext.byteLength, 'ciphertext must include tag');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    strictEqual(decodeUtf8(pt), 'secret-data');
});

Deno.test('webcrypto upstream: RSA-OAEP encrypt decrypt and oversized plaintext reject', async () => {
    const keyPair = await crypto.subtle.generateKey(
        {
            name: 'RSA-OAEP',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256',
        },
        true,
        ['encrypt', 'decrypt'],
    );
    const plaintext = encodeUtf8('rsa oaep secret');
    const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, keyPair.publicKey, plaintext);
    ok(encrypted instanceof ArrayBuffer);
    strictEqual(encrypted.byteLength, 256);

    const decrypted = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, keyPair.privateKey, encrypted);
    deepStrictEqual(new Uint8Array(decrypted), plaintext);

    await rejects(
        () => crypto.subtle.encrypt({ name: 'RSA-OAEP' }, keyPair.publicKey, new Uint8Array(191)),
        DOMException,
    );
});

Deno.test('webcrypto: AES-GCM with wrong IV fails to decrypt', async () => {
    const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encodeUtf8('x'));
    const badIv = crypto.getRandomValues(new Uint8Array(12));
    let threw = false;
    try {
        await crypto.subtle.decrypt({ name: 'AES-GCM', badIv }, key, ct);
    } catch {
        threw = true;
    }
    ok(threw, 'decryption with wrong IV must fail');
});

Deno.test('webcrypto upstream: AES-GCM tagLength is measured in bits', async () => {
    const key = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(32),
        'AES-GCM',
        false,
        ['encrypt', 'decrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = crypto.getRandomValues(new Uint8Array(32));

    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 96 }, key, plaintext);
    strictEqual(encrypted.byteLength, plaintext.byteLength + 12);

    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 96 }, key, encrypted);
    deepStrictEqual(new Uint8Array(decrypted), plaintext);

    await rejects(
        () => crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, encrypted),
        DOMException,
    );
    await rejects(
        () => crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 24 }, key, plaintext),
        DOMException,
    );
});

Deno.test('webcrypto: key usages guard rejects off-label use', async () => {
    const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    ok(!key.usages.includes('verify'), 'sign-only key must not list verify');
    let threw = false;
    try {
        await crypto.subtle.verify('HMAC', key, new Uint8Array(32), new Uint8Array(2));
    } catch {
        threw = true;
    }
    ok(threw, 'verify with a sign-only key must throw');
});

Deno.test('webcrypto upstream: HMAC raw and JWK import export match known vector', async () => {
    const rawKey = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8,
        9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    const jwk: JsonWebKey = {
        kty: 'oct',
        k: 'AQIDBAUGBwgJCgsMDQ4PEA',
        alg: 'HS256',
        ext: true,
        key_ops: ['sign'],
    };
    const expected = new Uint8Array([
        59, 170, 255, 216, 51, 141, 51, 194,
        213, 48, 41, 191, 184, 40, 216, 47,
        130, 165, 203, 26, 163, 43, 38, 71,
        23, 122, 222, 1, 146, 46, 182, 87,
    ]);
    const raw = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, true, ['sign']);
    const fromJwk = await crypto.subtle.importKey('jwk', jwk, { name: 'HMAC', hash: 'SHA-256' }, true, ['sign']);

    deepStrictEqual(new Uint8Array(await crypto.subtle.sign('HMAC', raw, new Uint8Array([1, 2, 3, 4]))), expected);
    deepStrictEqual(new Uint8Array(await crypto.subtle.sign('HMAC', fromJwk, new Uint8Array([1, 2, 3, 4]))), expected);
    deepStrictEqual(new Uint8Array(await crypto.subtle.exportKey('raw', raw)), rawKey);
    deepStrictEqual(await crypto.subtle.exportKey('jwk', fromJwk), jwk);
});

Deno.test('webcrypto upstream: HMAC JWK accepts use sig and base64url key material', async () => {
    const key = await crypto.subtle.importKey(
        'jwk',
        {
            kty: 'oct',
            use: 'sig',
            alg: 'HS256',
            k: 'HnZXRyDKn-_G5Fx4JWR1YA',
        },
        { name: 'HMAC', hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
    );

    strictEqual(key instanceof CryptoKey, true);
    strictEqual((key.algorithm as HmacKeyAlgorithm).length, 128);
    const exported = await crypto.subtle.exportKey('jwk', key);
    strictEqual(exported.k, 'HnZXRyDKn-_G5Fx4JWR1YA');
    deepStrictEqual(exported.key_ops, ['sign', 'verify']);
});

Deno.test('webcrypto: wrapKey and unwrapKey round-trip JWK keys', async () => {
    const wrappingKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 128 },
        true,
        ['wrapKey', 'unwrapKey']
    );
    const key = await crypto.subtle.importKey(
        'jwk',
        {
            kty: 'oct',
            k: 'AQIDBAUGBwgJCgsMDQ4PEA',
            alg: 'HS256',
            ext: true,
            key_ops: ['sign'],
        },
        { name: 'HMAC', hash: 'SHA-256' },
        true,
        ['sign']
    );
    const iv = new Uint8Array(12);
    const wrapped = await crypto.subtle.wrapKey('jwk', key, wrappingKey, { name: 'AES-GCM', iv });
    const unwrapped = await crypto.subtle.unwrapKey(
        'jwk',
        wrapped,
        wrappingKey,
        { name: 'AES-GCM', iv },
        { name: 'HMAC', hash: 'SHA-256' },
        true,
        ['sign']
    );

    deepStrictEqual(
        new Uint8Array(await crypto.subtle.sign('HMAC', unwrapped, new Uint8Array([1, 2, 3, 4]))),
        new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array([1, 2, 3, 4])))
    );
});

Deno.test('webcrypto upstream: HMAC generation uses hash block-size defaults for JWK', async () => {
    const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-512' }, true, ['sign']);
    strictEqual(key.type, 'secret');
    strictEqual(key.extractable, true);
    deepStrictEqual(key.usages, ['sign']);
    strictEqual((key.algorithm as HmacKeyAlgorithm).length, 1024);

    const exported = await crypto.subtle.exportKey('jwk', key);
    strictEqual(exported.kty, 'oct');
    strictEqual(exported.alg, 'HS512');
    deepStrictEqual(exported.key_ops, ['sign']);
    strictEqual(exported.ext, true);
    strictEqual(typeof exported.k, 'string');
    strictEqual(exported.k!.length, 171);
});

Deno.test('webcrypto upstream: CryptoKey has native-like shape and is not directly constructable', async () => {
    throws(() => new (CryptoKey as unknown as { new(): CryptoKey })(), TypeError);

    const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    strictEqual(key instanceof CryptoKey, true);
    strictEqual(Object.prototype.toString.call(key), '[object CryptoKey]');
    strictEqual(key.type, 'secret');
    strictEqual(key.extractable, false);
    deepStrictEqual(key.usages, ['sign']);
    strictEqual(key.algorithm.name, 'HMAC');
});

Deno.test('webcrypto upstream: exportKey rejects non-extractable keys with DOMException', async () => {
    const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-512' }, false, ['sign', 'verify']);
    strictEqual(key.extractable, false);
    await rejects(() => crypto.subtle.exportKey('raw', key), DOMException);
});

Deno.test('webcrypto upstream: PBKDF2 deriveKey and deriveBits are deterministic', async () => {
    const baseKey = await crypto.subtle.importKey(
        'raw',
        encodeUtf8('password'),
        'PBKDF2',
        false,
        ['deriveKey', 'deriveBits'],
    );
    const salt = encodeUtf8('salt');
    const params = { name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-256' };
    const bits1 = await crypto.subtle.deriveBits(params, baseKey, 128);
    const bits2 = await crypto.subtle.deriveBits(params, baseKey, 128);
    strictEqual(bits1.byteLength, 16);
    ok(arrayBufferEqual(bits1, bits2));

    const derived = await crypto.subtle.deriveKey(
        params,
        baseKey,
        { name: 'HMAC', hash: 'SHA-256' },
        true,
        ['sign'],
    );
    ok(derived instanceof CryptoKey);
    strictEqual(derived.type, 'secret');
    strictEqual(derived.extractable, true);
    deepStrictEqual(derived.usages, ['sign']);
    strictEqual((derived.algorithm as HmacKeyAlgorithm).length, 512);
});

Deno.test('webcrypto upstream: PBKDF2 SHA-1 matches RFC 6070 vector', async () => {
    const baseKey = await crypto.subtle.importKey(
        'raw',
        encodeUtf8('password'),
        'PBKDF2',
        false,
        ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits({
        name: 'PBKDF2',
        salt: encodeUtf8('salt'),
        iterations: 1,
        hash: 'SHA-1',
    }, baseKey, 160);

    deepStrictEqual(new Uint8Array(bits), new Uint8Array([
        0x0c, 0x60, 0xc8, 0x0f, 0x96, 0x1f, 0x0e, 0x71, 0xf3, 0xa9,
        0xb5, 0x24, 0xaf, 0x60, 0x12, 0x06, 0x2f, 0xe0, 0x37, 0xa6,
    ]));
});

Deno.test('webcrypto upstream: HKDF and ECDH deriveBits length semantics', async () => {
    const hkdfKey = await crypto.subtle.importKey('raw', new Uint8Array([0, 1, 2, 3]), 'HKDF', false, ['deriveBits']);
    const hkdfBits = await crypto.subtle.deriveBits({
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array([4, 5, 6, 7]),
        info: new Uint8Array([8, 9]),
    }, hkdfKey, 128);
    strictEqual(hkdfBits.byteLength, 16);

    const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits', 'deriveKey'],
    );
    const full = await crypto.subtle.deriveBits({ name: 'ECDH', public: keyPair.publicKey }, keyPair.privateKey, null);
    strictEqual(full.byteLength, 32);
    const shorter = await crypto.subtle.deriveBits({ name: 'ECDH', public: keyPair.publicKey }, keyPair.privateKey, 128);
    strictEqual(shorter.byteLength, 16);
    await rejects(
        () => crypto.subtle.deriveBits({ name: 'ECDH', public: keyPair.publicKey }, keyPair.privateKey, 512),
        DOMException,
    );
});

Deno.test('webcrypto upstream: AES-CBC import encrypt decrypt round-trips', async () => {
    const key = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(16),
        { name: 'AES-CBC' },
        true,
        ['encrypt', 'decrypt'],
    );
    const iv = new Uint8Array(16);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, new Uint8Array([1, 2, 3, 4, 5, 6]));
    strictEqual(encrypted.byteLength, 16);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, encrypted);
    deepStrictEqual(new Uint8Array(decrypted), new Uint8Array([1, 2, 3, 4, 5, 6]));
});

Deno.test('webcrypto: getRandomValues fills and mutates the array', () => {
    const a = new Uint8Array(16);
    const r = crypto.getRandomValues(a);
    strictEqual(r, a, 'getRandomValues must return the same buffer');
    ok(a.some((b) => b !== 0), 'random bytes must not all be zero');
});

Deno.test('webcrypto upstream: getRandomValues supports integer typed arrays', () => {
    const views = [
        new Int8Array(32),
        new Uint8Array(32),
        new Uint8ClampedArray(32),
        new Int16Array(8),
        new Uint16Array(8),
        new Int32Array(8),
        new Uint32Array(8),
        new BigInt64Array(8),
        new BigUint64Array(8),
    ];

    for (const view of views) {
        strictEqual(crypto.getRandomValues(view), view);
        ok(valuesOf(view).some((value) => value !== 0 && value !== 0n), `${view.constructor.name} should be filled`);
    }
});

Deno.test('webcrypto upstream: getRandomValues rejects non-integer views and oversize input', () => {
    throws(() => crypto.getRandomValues(new Float32Array(2)), { name: 'TypeMismatchError' });
    throws(() => crypto.getRandomValues(new Float64Array(2)), { name: 'TypeMismatchError' });
    throws(() => crypto.getRandomValues(new DataView(new ArrayBuffer(8))), { name: 'TypeMismatchError' });
    throws(() => crypto.getRandomValues(new Uint8Array(65537)), { name: 'QuotaExceededError' });
});

Deno.test('webcrypto upstream: randomUUID returns RFC 4122 version 4 UUID strings', () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    ok(pattern.test(first));
    ok(pattern.test(second));
    strictEqual(first === second, false);
});

function arrayBufferEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
    if (a.byteLength !== b.byteLength) return false;
    const x = new Uint8Array(a), y = new Uint8Array(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
}

function valuesOf(view: ArrayBufferView): Array<number | bigint> {
    if (view instanceof BigInt64Array || view instanceof BigUint64Array) return Array.from(view);
    if (view instanceof Int8Array || view instanceof Uint8Array || view instanceof Uint8ClampedArray) return Array.from(view);
    if (view instanceof Int16Array || view instanceof Uint16Array) return Array.from(view);
    if (view instanceof Int32Array || view instanceof Uint32Array) return Array.from(view);
    return [];
}
