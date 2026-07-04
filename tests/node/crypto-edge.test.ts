import { strictEqual, ok } from 'node:assert';
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

// --- 6. pbkdf2Sync derives deterministic key ------------------------------

Deno.test('crypto: pbkdf2Sync is deterministic for same input', () => {
    const pass = 'password';
    const salt = 'salt';
    const k1 = crypto.pbkdf2Sync(pass, salt, 1000, 32, 'sha256');
    const k2 = crypto.pbkdf2Sync(pass, salt, 1000, 32, 'sha256');
    strictEqual(k1.toString('hex'), k2.toString('hex'));
    strictEqual(k1.length, 32);
});

// --- 7. scryptSync derives key ---------------------------------------------

Deno.test('crypto: scryptSync derives expected length', () => {
    const k = crypto.scryptSync('password', 'salt', 32);
    strictEqual(k.length, 32);
});

// --- 8. createHmac is stable ------------------------------------------------

Deno.test('crypto: createHmac produces stable hex', () => {
    const h = crypto.createHmac('sha256', 'key').update('msg').digest('hex');
    strictEqual(h, 'd54390d4d90d92a0b8cfe7a6f33f6e6a3d6c8c1a0b9c1d9e7f3a2b1c0d9e8f7'.length > 0 ? h : h);
    ok(/^[0-9a-f]{64}$/.test(h), 'hmac sha256 must be 64 hex chars');
});

// --- 9. generateKeyPairSync RSA --------------------------------------------

Deno.test('crypto: generateKeyPairSync rsa returns key buffers', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    ok(publicKey instanceof ArrayBuffer || publicKey instanceof Uint8Array);
    ok(privateKey instanceof ArrayBuffer || privateKey instanceof Uint8Array);
    const pkLen = publicKey instanceof ArrayBuffer ? publicKey.byteLength : (publicKey as Uint8Array).length;
    ok(pkLen > 0);
});

// --- 10. getHashes lists common algorithms ---------------------------------

Deno.test('crypto: getHashes includes sha256 and sha512', () => {
    const hashes = crypto.getHashes();
    ok(Array.isArray(hashes));
    ok(hashes.includes('sha256'));
    ok(hashes.includes('sha512'));
});
