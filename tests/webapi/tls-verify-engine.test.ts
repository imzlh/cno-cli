/**
 * Engine-capability probe for TLS peer verification.
 *
 * Measures what `ssl.Context` actually enforces, independent of any JS wiring,
 * so a later "verification is on" claim can be checked against the engine
 * rather than against a flag being passed. Every case is loopback-only and
 * uses a locally generated certificate.
 *
 * The four cases together form the negative control the fix needs:
 *   1. verify off, self-signed         -> handshake SUCCEEDS  (the defect)
 *   2. verify on, no CA                -> handshake REJECTED  (chain)
 *   3. verify on, cert supplied as CA  -> handshake SUCCEEDS  (opt-in trust)
 *   4. verify on, CA ok, wrong name    -> handshake REJECTED  (hostname)
 */

import { ok, strictEqual } from 'node:assert';
import { createServer as createTlsServer, type Server } from 'node:tls';
import type { Socket } from 'node:net';
import { TcpSocket } from '@cnojs/http/socket';

const ssl = import.meta.use('ssl');
const streams = import.meta.use('streams');

interface Listening { server: Server; port: number }

/** A TLS server whose leaf certificate is issued for `commonName`. */
async function listenTls(commonName: string): Promise<Listening & { cert: string } | null> {
    const { cert, key } = ssl.createSelfSignedCert({ commonName, days: 1 });
    const server = createTlsServer({ cert, key }, (socket: Socket) => {
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
    server.on('tlsClientError', () => { /* expected for the rejection cases */ });
    const port = await new Promise<number | null>(resolve => {
        server.on('error', () => resolve(null));
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    return port === null ? null : { server, port, cert };
}

function closeServer(server: Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

/**
 * Drive one client handshake and report whether it completed.
 * Returns null on success, or the error message on rejection.
 */
async function handshake(port: number, servername: string, options: Record<string, unknown>): Promise<string | null> {
    const tcp = new streams.TCP();
    await tcp.connect({ ip: '127.0.0.1', port });
    const socket = new TcpSocket(tcp);
    try {
        const context = new ssl.Context({ alpn: ['http/1.1'], mode: 'client', ...options });
        await socket.clientHandshake(context, servername);
        return null;
    } catch (error) {
        return (error as Error).message ?? String(error);
    } finally {
        try { socket.close(); } catch { /* already closed */ }
    }
}

Deno.test({ name: 'engine: verify off accepts a self-signed certificate', timeout: 15000 }, async () => {
    const target = await listenTls('localhost');
    if (!target) return;
    try {
        // The pre-fix behaviour of connectDirectTcp / startTls, stated as a fact
        // about the engine: with no verify option nothing is enforced.
        strictEqual(await handshake(target.port, 'localhost', {}), null);
    } finally {
        await closeServer(target.server);
    }
});

Deno.test({ name: 'engine: verify on rejects a self-signed certificate', timeout: 15000 }, async () => {
    const target = await listenTls('localhost');
    if (!target) return;
    try {
        const error = await handshake(target.port, 'localhost', { verify: true });
        ok(error !== null, 'self-signed certificate must not be accepted when verify is on');
    } finally {
        await closeServer(target.server);
    }
});

Deno.test({ name: 'engine: verify on accepts the certificate supplied as a CA root', timeout: 15000 }, async () => {
    const target = await listenTls('localhost');
    if (!target) return;
    try {
        // Proves the opt-out path is a real trust decision, not a bypass: the
        // chain now validates because the caller named this cert as a root.
        strictEqual(await handshake(target.port, 'localhost', { verify: true, ca: target.cert }), null);
    } finally {
        await closeServer(target.server);
    }
});

Deno.test({ name: 'engine: verify on rejects a name that the certificate does not cover', timeout: 15000 }, async () => {
    // Chain is trusted (cert is its own root) so only the name can fail.
    const target = await listenTls('wrong.example');
    if (!target) return;
    try {
        const error = await handshake(target.port, 'localhost', { verify: true, ca: target.cert });
        ok(error !== null, 'a certificate issued for wrong.example must not satisfy localhost');
    } finally {
        await closeServer(target.server);
    }
});
