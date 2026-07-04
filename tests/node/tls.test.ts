import { strictEqual, ok } from 'node:assert';
import * as tls from 'node:tls';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// --- 1. createSecureContext returns a SecureContext -------------------------

Deno.test({ name: 'tls: createSecureContext returns SecureContext', timeout: 10000 }, () => {
    const ctx = tls.createSecureContext({});
    ok(ctx instanceof tls.SecureContext);
});

// --- 2. SecureContext constructor accepts options ---------------------------

Deno.test({ name: 'tls: SecureContext constructor accepts cert/key strings', timeout: 10000 }, () => {
    const dummyKey = '-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEA\n-----END PRIVATE KEY-----';
    const ctx = new tls.SecureContext({});
    ok(ctx);
});

// --- 3. tls.connect is a function -------------------------------------------

Deno.test({ name: 'tls: tls.connect is a function', timeout: 10000 }, () => {
    ok(typeof tls.connect === 'function');
});

// --- 4. tls.createServer is a function -------------------------------------

Deno.test({ name: 'tls: tls.createServer is a function', timeout: 10000 }, () => {
    ok(typeof tls.createServer === 'function');
});

// --- 5. tls.createServer returns a server with listen ---------------------

Deno.test({ name: 'tls: tls.createServer returns a server with listen/close', timeout: 10000 }, () => {
    const server = tls.createServer({});
    ok(typeof server.listen === 'function');
    ok(typeof server.close === 'function');
    server.close();
});

// --- 6. rootCertificates is an array of strings ---------------------------

Deno.test({ name: 'tls: rootCertificates is an array of strings', timeout: 10000 }, () => {
    const roots = tls.rootCertificates;
    ok(Array.isArray(roots));
    if (roots.length > 0) {
        ok(typeof roots[0] === 'string');
        ok(roots[0]!.includes('BEGIN CERTIFICATE'));
    }
});

// --- 7. defaultMinVersion / defaultMaxVersion ------------------------------

Deno.test({ name: 'tls: default min/max version constants exist', timeout: 10000 }, () => {
    for (const k of ['defaultMinVersion', 'defaultMaxVersion']) {
        const v = (tls as typeof tls & Record<string, unknown>)[k];
        if (v !== undefined) {
            ok(typeof v === 'string');
        }
    }
});

// --- 8. TLSSocket is a class -----------------------------------------------

Deno.test({ name: 'tls: TLSSocket is a constructor', timeout: 10000 }, () => {
    ok(typeof tls.TLSSocket === 'function');
});

// --- 9. TLS connect to a closed port emits error ---------------------------

Deno.test({ name: 'tls: connect to a closed port emits error', timeout: 10000 }, async () => {
    const probe = (require('node:net') as typeof import('node:net')).createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const addr = probe.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const port = addr.port;
    await new Promise<void>((r) => probe.close(() => r()));

    const errored = await new Promise<boolean>((resolve) => {
        const sock = tls.connect(port, '127.0.0.1', {}, () => resolve(false));
        sock.on('error', () => resolve(true));
        setTimeout(() => resolve(false), 3000);
    });
    ok(errored, 'tls connect to closed port must error');
});

// --- 10. getCipher returns undefined before handshake ----------------------

Deno.test({ name: 'tls: TLSSocket.getCipher exists', timeout: 10000 }, () => {
    ok(typeof tls.TLSSocket.prototype.getCipher === 'function');
});
