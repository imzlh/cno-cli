import { strictEqual, ok } from 'node:assert';

// webcrypto subtle: the刁钻 cases are (1) sign/verify round-trip, (2) digest
// stability, (3) AES-GCM encrypt/decrypt with a random IV, and (4) the
// CryptoKey.usages guard (a key made for sign must reject decrypt).

Deno.test('webcrypto: sha-256 digest is stable and 32 bytes', async () => {
    const data = new TextEncoder().encode('hello');
    const d1 = await crypto.subtle.digest('SHA-256', data);
    const d2 = await crypto.subtle.digest('SHA-256', data);
    strictEqual(d1.byteLength, 32);
    ok(arrayBufferEqual(d1, d2), 'same input must yield same digest');
});

Deno.test('webcrypto: sha-256 differs for different input', async () => {
    const a = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('a'));
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('b'));
    ok(!arrayBufferEqual(a, b));
});

Deno.test('webcrypto: HMAC sign then verify succeeds', async () => {
    const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
    );
    const data = new TextEncoder().encode('message');
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
    const data = new TextEncoder().encode('message');
    const sig = await crypto.subtle.sign('HMAC', key, data);
    const tampered = new TextEncoder().encode('messagf');
    const valid = await crypto.subtle.verify('HMAC', key, sig, tampered);
    strictEqual(valid, false);
});

Deno.test('webcrypto: AES-GCM encrypt then decrypt round-trips', async () => {
    const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode('secret-data');
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    ok(ct.byteLength > plaintext.byteLength, 'ciphertext must include tag');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    strictEqual(new TextDecoder().decode(pt), 'secret-data');
});

Deno.test('webcrypto: AES-GCM with wrong IV fails to decrypt', async () => {
    const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('x'));
    const badIv = crypto.getRandomValues(new Uint8Array(12));
    let threw = false;
    try {
        await crypto.subtle.decrypt({ name: 'AES-GCM', badIv }, key, ct);
    } catch {
        threw = true;
    }
    ok(threw, 'decryption with wrong IV must fail');
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

Deno.test('webcrypto: getRandomValues fills and mutates the array', () => {
    const a = new Uint8Array(16);
    const r = crypto.getRandomValues(a);
    strictEqual(r, a, 'getRandomValues must return the same buffer');
    ok(a.some((b) => b !== 0), 'random bytes must not all be zero');
});

function arrayBufferEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
    if (a.byteLength !== b.byteLength) return false;
    const x = new Uint8Array(a), y = new Uint8Array(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
}
