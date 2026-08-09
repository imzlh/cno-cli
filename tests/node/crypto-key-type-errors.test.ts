import { ok } from 'node:assert';
import * as crypto from 'node:crypto';

// Diagnosis quality for keys whose algorithm this build does not classify.
//
// createPublicKey tries the public parse first, then retries as a private key
// because node accepts a private key here and derives the public half. The
// retry must not mask the first error: whichever attempt matched the input's
// actual structure is the one reporting "Unsupported key type", and that is the
// accurate diagnosis. Reporting the other attempt's failure names the wrong key
// kind AND the wrong operation -- a public key blamed on a private-key parse.
//
// These assertions are runtime-independent: node succeeds on both calls, and a
// success passes too, so the test stays correct once x25519 support lands. Only
// naming the OPPOSITE key kind is a failure.
//
// Throwaway test-only x25519 keys, generated solely for this file. They protect
// nothing and are safe to commit.
const X25519_PUBLIC_PEM = [
    '-----BEGIN PUBLIC KEY-----',
    'MCowBQYDK2VuAyEAny+9qTdj718070Tgc5uBP9r3G7L8ahR9KBqjWbCApnA=',
    '-----END PUBLIC KEY-----',
    '',
].join('\n');

const X25519_PRIVATE_PEM = [
    '-----BEGIN PRIVATE KEY-----',
    'MC4CAQAwBQYDK2VuBCIEIGgBdC77IAl8tgXPZIBJwNNWS1hxAFhaevy5mQaJ/dVg',
    '-----END PRIVATE KEY-----',
    '',
].join('\n');

// Returns the thrown message, or null when the call succeeded.
function publicKeyErrorMessage(pem: string): string | null {
    try {
        crypto.createPublicKey(pem);
        return null;
    } catch (err) {
        return (err as { message?: string }).message ?? '';
    }
}

Deno.test('crypto: createPublicKey error on a public key must not blame the private key', () => {
    const message = publicKeyErrorMessage(X25519_PUBLIC_PEM);
    ok(
        message === null || !message.toLowerCase().includes('private'),
        `createPublicKey(x25519 public key) named the wrong key kind: ${message}`,
    );
});

Deno.test('crypto: createPublicKey error on a private key must not blame the public key', () => {
    const message = publicKeyErrorMessage(X25519_PRIVATE_PEM);
    ok(
        message === null || !message.toLowerCase().includes('public'),
        `createPublicKey(x25519 private key) named the wrong key kind: ${message}`,
    );
});
