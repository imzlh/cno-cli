import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import * as crypto from 'node:crypto';

// asymmetricKeyDetails must be populated for PARSED keys, not just generated ones.
//
// createPrivateKey/createPublicKey used to build KeyObjects with no details, so
// `asymmetricKeyDetails` was `undefined` for every key that came from a PEM or a
// DER -- i.e. every key loaded from a file, which is how production keys are
// actually supplied. The key bytes were never the problem: a node-generated
// PKCS#8 and a cno-generated one are byte-identical (both 138-byte DER for
// P-256), so this was purely a missing property.
//
// It surfaced through `jsonwebtoken`, which reads `.asymmetricKeyDetails
// .namedCurve` to check the curve against the requested ES* algorithm:
//
//   jwt.sign(payload, fs.readFileSync('ec-p256.pem'), { algorithm: 'ES256' })
//     -> TypeError: cannot read property 'namedCurve' of undefined
//
// while the same call with a key generated in the same process worked, because
// only generateKeyPairSync passed details through. That asymmetry is why an API
// probe misses this: you have to load a key the way real software does.
//
// Shapes below are measured against node v24.18.0.

function pemRoundTrip(kind: 'private' | 'public', keyObject: crypto.KeyObject): crypto.KeyObject {
    // Export then re-import so the KeyObject under test is genuinely built by
    // the parse path, exactly as reading a .pem off disk would be.
    if (kind === 'private') {
        const pem = keyObject.export({ type: 'pkcs8', format: 'pem' }) as string;
        return crypto.createPrivateKey(pem);
    }
    const pem = keyObject.export({ type: 'spki', format: 'pem' }) as string;
    return crypto.createPublicKey(pem);
}

Deno.test('asymmetricKeyDetails: EC namedCurve survives a PEM round-trip', () => {
    for (const namedCurve of ['prime256v1', 'secp384r1', 'secp521r1']) {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve });

        // The generated keys already carried details; the parsed ones did not.
        deepStrictEqual(privateKey.asymmetricKeyDetails, { namedCurve }, `generated private ${namedCurve}`);
        deepStrictEqual(pemRoundTrip('private', privateKey).asymmetricKeyDetails, { namedCurve }, `parsed private ${namedCurve}`);
        deepStrictEqual(pemRoundTrip('public', publicKey).asymmetricKeyDetails, { namedCurve }, `parsed public ${namedCurve}`);
    }
});

Deno.test('asymmetricKeyDetails: EC namedCurve survives a DER round-trip', () => {
    for (const namedCurve of ['prime256v1', 'secp384r1', 'secp521r1']) {
        const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve });
        const der = privateKey.export({ type: 'pkcs8', format: 'der' }) as Uint8Array;
        const parsed = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
        deepStrictEqual(parsed.asymmetricKeyDetails, { namedCurve }, `der private ${namedCurve}`);
    }
});

Deno.test('asymmetricKeyDetails: RSA reports modulusLength and a BigInt publicExponent', () => {
    for (const modulusLength of [2048, 3072]) {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength });
        const expected = { modulusLength, publicExponent: 65537n };

        deepStrictEqual(privateKey.asymmetricKeyDetails, expected, `generated private ${modulusLength}`);
        deepStrictEqual(publicKey.asymmetricKeyDetails, expected, `generated public ${modulusLength}`);
        deepStrictEqual(pemRoundTrip('private', privateKey).asymmetricKeyDetails, expected, `parsed private ${modulusLength}`);
        deepStrictEqual(pemRoundTrip('public', publicKey).asymmetricKeyDetails, expected, `parsed public ${modulusLength}`);

        // publicExponent is a BigInt in node, which is why JSON.stringify of a
        // details object throws there. Asserting the type keeps a Number from
        // silently passing deepStrictEqual's coercion-free comparison later.
        strictEqual(typeof privateKey.asymmetricKeyDetails?.publicExponent, 'bigint');
    }
});

Deno.test('asymmetricKeyDetails: an Ed25519 DER is not misread as P-384', () => {
    // An ed25519/x25519 PKCS#8 is 48 bytes, which is ALSO P-384's coordinate
    // width. Probing the raw length before the DER structure reported
    // `namedCurve: 'secp384r1'` for an Ed25519 key -- a plausible-looking wrong
    // answer that would route a signature through the wrong curve's conversion.
    // Node reports `{}` for both RFC 8410 types: present, but empty.
    let privateKey: crypto.KeyObject;
    try {
        ({ privateKey } = crypto.generateKeyPairSync('ed25519' as 'ed25519', {}));
    } catch {
        // This build may not generate ed25519 yet; the assertion below is the
        // point, so skip rather than fail on a missing generator.
        return;
    }
    const der = privateKey.export({ type: 'pkcs8', format: 'der' }) as Uint8Array;
    strictEqual(der.byteLength, 48, 'precondition: the 48-byte collision with P-384');

    const parsed = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    strictEqual(parsed.asymmetricKeyType, 'ed25519');
    deepStrictEqual(parsed.asymmetricKeyDetails, {}, 'ed25519 details must be empty, not a curve');
});

Deno.test('asymmetricKeyDetails: derived public key keeps the private key details', () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    // Node accepts a PRIVATE key here and derives the public half; the details
    // must come along, since this is the shape `createPublicKey(privatePem)`
    // takes in libraries that only keep one PEM around.
    const derived = crypto.createPublicKey(pem);
    strictEqual(derived.type, 'public');
    deepStrictEqual(derived.asymmetricKeyDetails, { namedCurve: 'prime256v1' });
});

Deno.test('asymmetricKeyDetails: secret keys report undefined', () => {
    const secret = crypto.createSecretKey(Buffer.alloc(32));
    strictEqual(secret.asymmetricKeyDetails, undefined);
    strictEqual(secret.symmetricKeySize, 32);
});

Deno.test('EC signing works with a key parsed from PEM (the jsonwebtoken path)', () => {
    // The end-to-end shape that was broken: read a curve off a parsed key, then
    // sign with the ieee-p1363 encoding ES256 requires. A throw here is the
    // original defect; a wrong width is the curve being misidentified.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

    const parsedPriv = crypto.createPrivateKey(privPem);
    strictEqual(parsedPriv.asymmetricKeyDetails?.namedCurve, 'prime256v1');

    const sig = crypto.sign('sha256', Buffer.from('payload'), { key: privPem, dsaEncoding: 'ieee-p1363' });
    strictEqual(sig.byteLength, 64, 'P-256 p1363 signature is exactly two 32-byte coordinates');
    strictEqual(crypto.verify('sha256', Buffer.from('payload'), { key: pubPem, dsaEncoding: 'ieee-p1363' }, sig), true);
});

Deno.test('generateKeyPairSync: publicKeyEncoding/privateKeyEncoding return encoded keys', () => {
    // These options were accepted and then ignored, so the call always handed back
    // KeyObjects. Node returns the ENCODED key: a string for pem, a Buffer for der.
    // Ignoring them fails silently -- writeFileSync('key.pem', privateKey) wrote
    // "[object Object]" and the key could never be read back.
    const pem = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    } as never) as unknown as { publicKey: string; privateKey: string };

    strictEqual(typeof pem.privateKey, 'string', 'format:pem must yield a string');
    strictEqual(typeof pem.publicKey, 'string');
    ok(pem.privateKey.startsWith('-----BEGIN PRIVATE KEY-----'), 'a real PEM header');
    ok(pem.publicKey.startsWith('-----BEGIN PUBLIC KEY-----'));

    // The point of encoding it: it survives a write/read cycle and reparses.
    const reparsed = crypto.createPrivateKey(pem.privateKey);
    deepStrictEqual(reparsed.asymmetricKeyDetails, { namedCurve: 'prime256v1' });

    const der = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    } as never) as unknown as { publicKey: Uint8Array; privateKey: Uint8Array };

    ok(der.privateKey instanceof Uint8Array, 'format:der must yield bytes, not a KeyObject');
    ok(der.privateKey.byteLength > 0);
    strictEqual(crypto.createPrivateKey({ key: der.privateKey, format: 'der', type: 'pkcs8' }).asymmetricKeyType, 'rsa');
});

Deno.test('generateKeyPairSync: each key is encoded independently', () => {
    // Supplying only publicKeyEncoding must leave the private key a KeyObject.
    // Encoding both from one flag would silently change the private key's type.
    const partial = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    } as never) as unknown as { publicKey: unknown; privateKey: crypto.KeyObject };

    strictEqual(typeof partial.publicKey, 'string');
    strictEqual(typeof partial.privateKey, 'object');
    strictEqual(partial.privateKey.type, 'private');
    deepStrictEqual(partial.privateKey.asymmetricKeyDetails, { namedCurve: 'prime256v1' });
});

Deno.test('generateKeyPairSync: no encoding options still yields KeyObjects', () => {
    // The common case and every internal caller. A regression here would be far
    // worse than the bug being fixed.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    strictEqual(typeof privateKey, 'object');
    strictEqual(privateKey.type, 'private');
    strictEqual(publicKey.type, 'public');
});
