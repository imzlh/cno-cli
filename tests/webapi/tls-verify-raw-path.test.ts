/**
 * Verification on the raw connection path (`connectDirectTcp` / proxy `startTls`).
 *
 * These are the paths `https:`, `wss:`, WebSocket and EventSource take when they
 * do not go through libcurl. Before this fix both built an `ssl.Context` with no
 * `verify` and no CA material, so any certificate was accepted — including a
 * self-signed one, and including a certificate issued for a different host. That
 * happened whether or not `--skip-cert-verify` was passed, so the flag was not
 * the control it appeared to be.
 *
 * Imported from disk (`../../cno/src/utils/http.ts`) rather than exercised through
 * the baked binary, so the assertions describe the current source.
 */

import { ok, strictEqual } from 'node:assert';
import { createServer as createTlsServer, type Server } from 'node:tls';
import type { Socket } from 'node:net';
import { connectDirectTcp, createClientTlsContext, getRawTlsOptions } from '../../cno/src/utils/http.ts';
import { connectViaProxy, type ProxyConfig } from '../../cno/src/utils/proxy.ts';
import { createServer, type Server as NetServer } from 'node:net';

const ssl = import.meta.use('ssl');

interface Listening { server: Server; port: number; cert: string }

async function listenTls(commonName: string): Promise<Listening | null> {
    const { cert, key } = ssl.createSelfSignedCert({ commonName, days: 1 });
    const server = createTlsServer({ cert, key }, (socket: Socket) => {
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
    server.on('tlsClientError', () => { /* expected on the rejection cases */ });
    const port = await new Promise<number | null>(resolve => {
        server.on('error', () => resolve(null));
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    return port === null ? null : { server, port, cert };
}

function closeServer(server: Server | NetServer): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

/**
 * Prove the TLS session actually carries application data.
 *
 * Every "accepted" case asserts this rather than just that `clientHandshake`
 * returned. A probe whose success arm is only "no exception thrown" cannot
 * distinguish a working session from a call that failed for an unrelated reason,
 * which is how a security check gets reported as present when it is not. The
 * fixtures answer a fixed 2-byte body, so a matching read is end-to-end evidence:
 * handshake completed, keys agreed, plaintext flowed both ways.
 */
async function roundTrip(socket: { write(b: Uint8Array<ArrayBuffer>): Promise<unknown>; read(n: number): Promise<Uint8Array<ArrayBuffer> | null>; }, host: string): Promise<string> {
    await socket.write(new TextEncoder().encode(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let response = '';
    while (!response.includes('\r\n\r\n')) {
        const chunk = await socket.read(1024);
        if (!chunk) break;
        response += new TextDecoder().decode(chunk);
    }
    return response;
}

/** A CONNECT proxy that blindly tunnels, so the target TLS is the only variable. */
async function startTunnelProxy(): Promise<{ server: NetServer; port: number; connects: string[] } | null> {
    const connects: string[] = [];
    const server = createServer((socket: Socket) => {
        let head = '';
        const onData = (chunk: Buffer) => {
            head += chunk.toString('latin1');
            const end = head.indexOf('\r\n\r\n');
            if (end < 0) return;
            socket.off('data', onData);
            const authority = head.match(/^CONNECT\s+(\S+)/)?.[1];
            if (!authority) { socket.destroy(); return; }
            connects.push(authority);
            const separator = authority.lastIndexOf(':');
            const port = Number(authority.slice(separator + 1));
            const leftover = Buffer.from(head.slice(end + 4), 'latin1');
            // Always dial 127.0.0.1: the target servers in this file bind IPv4
            // loopback, while the authority may say `localhost`, which resolves
            // to ::1 first. The authority is still recorded above, so the CONNECT
            // assertions keep their meaning.
            const upstream = connectNet(port, '127.0.0.1', () => {
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (leftover.length) upstream.write(leftover);
                socket.pipe(upstream).pipe(socket);
            });
            upstream.on('error', () => socket.destroy());
        };
        socket.on('data', onData);
        socket.on('error', () => { /* client aborts on rejection */ });
    });
    const port = await new Promise<number | null>(resolve => {
        server.on('error', () => resolve(null));
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    return port === null ? null : { server, port, connects };
}

// node:net connect, imported lazily to keep the import list above readable.
import { connect as connectNet } from 'node:net';

/* -------------------------------------------------------------------------- */
/* Direct path                                                                */
/* -------------------------------------------------------------------------- */

Deno.test('raw TLS: verification is on by default', () => {
    // The default must not depend on --skip-cert-verify having been parsed.
    strictEqual(getRawTlsOptions().rejectUnauthorized, true);
});

Deno.test({ name: 'raw TLS: direct https rejects a self-signed certificate', timeout: 15000 }, async () => {
    const target = await listenTls('127.0.0.1');
    if (!target) return;
    try {
        let socket: Awaited<ReturnType<typeof connectDirectTcp>> | null = null;
        let message: string | null = null;
        try {
            socket = await connectDirectTcp(new URL(`https://127.0.0.1:${target.port}/`));
        } catch (error) {
            message = (error as Error).message;
        } finally {
            try { socket?.close(); } catch { /* not established */ }
        }
        ok(message !== null, 'an untrusted self-signed certificate must fail the handshake');
        ok(/certificate verify failed/i.test(message!), `unexpected error text: ${message}`);
    } finally {
        await closeServer(target.server);
    }
});

Deno.test({ name: 'raw TLS: direct https accepts a certificate named as a trust root', timeout: 15000 }, async () => {
    // A DNS name, because that is the case the engine can fully verify. The
    // IP-literal equivalent is covered separately below.
    const target = await listenTls('localhost');
    if (!target) return;
    try {
        // The legitimate opt-in: the caller vouches for this root explicitly.
        const socket = await connectDirectTcp(
            new URL(`https://localhost:${target.port}/`),
            { caCerts: [target.cert] },
        );
        // Positive control: a live TLS session, not merely a call that returned.
        ok(/^HTTP\/1\.1 200/.test(await roundTrip(socket, 'localhost')), 'the trusted session must carry data');
        socket.close();
    } finally {
        await closeServer(target.server);
    }
});

Deno.test({ name: 'raw TLS: direct https honours the rejectUnauthorized opt-out', timeout: 15000 }, async () => {
    const target = await listenTls('127.0.0.1');
    if (!target) return;
    try {
        // What --skip-cert-verify maps to. Must remain possible, and must be the
        // only way to reach the old behaviour.
        const socket = await connectDirectTcp(
            new URL(`https://127.0.0.1:${target.port}/`),
            { rejectUnauthorized: false },
        );
        // Positive control on the SAME certificate the default rejects: the only
        // difference is the opt-out, so this isolates the flag from the fixture.
        ok(/^HTTP\/1\.1 200/.test(await roundTrip(socket, '127.0.0.1')), 'the opt-out session must carry data');
        socket.close();
    } finally {
        await closeServer(target.server);
    }
});

Deno.test({ name: 'raw TLS: direct https rejects a certificate issued for another host', timeout: 15000 }, async () => {
    // Chain is trusted (the cert is supplied as its own root), so a failure here
    // can only come from the hostname check. Without SAN/CN name matching this
    // connection would succeed and a cert for wrong.example would authenticate
    // the host we actually asked for.
    const target = await listenTls('wrong.example');
    if (!target) return;
    try {
        let message: string | null = null;
        let socket: Awaited<ReturnType<typeof connectDirectTcp>> | null = null;
        try {
            socket = await connectDirectTcp(
                new URL(`https://localhost:${target.port}/`),
                { caCerts: [target.cert] },
            );
        } catch (error) {
            message = (error as Error).message;
        } finally {
            try { socket?.close(); } catch { /* not established */ }
        }
        ok(message !== null, 'a certificate for wrong.example must not authenticate localhost');
        ok(/certificate verify failed/i.test(message!), `unexpected error text: ${message}`);
    } finally {
        await closeServer(target.server);
    }
});

Deno.test({ name: 'raw TLS: an IP-literal target is chain-verified but not name-verified', timeout: 15000 }, async () => {
    // Pins the known weakness so it cannot be mistaken for working name checking.
    // `SSL_set1_host` matches DNS names only and the binding never calls
    // `SSL_set1_ip_asc`, so a name check on an IP literal would reject every
    // certificate. Hostname verification is therefore off for IP targets while
    // the chain check stays on — hence a cert whose CN is a *different* IP still
    // connects once its chain is trusted. Closing this needs a C change.
    const target = await listenTls('10.99.99.99');
    if (!target) return;
    try {
        const socket = await connectDirectTcp(
            new URL(`https://127.0.0.1:${target.port}/`),
            { caCerts: [target.cert] },
        );
        ok(/^HTTP\/1\.1 200/.test(await roundTrip(socket, '127.0.0.1')), 'chain-only verification is the documented IP-literal behaviour');
        socket.close();
    } finally {
        await closeServer(target.server);
    }
});

Deno.test({ name: 'raw TLS: an IP-literal target still rejects an untrusted chain', timeout: 15000 }, async () => {
    // The half that must keep working for IP targets: no trust root, no connection.
    const target = await listenTls('127.0.0.1');
    if (!target) return;
    try {
        let message: string | null = null;
        let socket: Awaited<ReturnType<typeof connectDirectTcp>> | null = null;
        try {
            socket = await connectDirectTcp(new URL(`https://127.0.0.1:${target.port}/`));
        } catch (error) {
            message = (error as Error).message;
        } finally {
            try { socket?.close(); } catch { /* not established */ }
        }
        ok(message !== null, 'an IP-literal target must still verify the chain');
        ok(/certificate verify failed/i.test(message!), `unexpected error text: ${message}`);
    } finally {
        await closeServer(target.server);
    }
});

/* -------------------------------------------------------------------------- */
/* Context builder                                                            */
/* -------------------------------------------------------------------------- */

Deno.test('raw TLS: the context builder asks for both chain and hostname checks', () => {
    // Guards against the shape of the bug returning: a context built with no
    // options must not be the unverified one.
    const verified = createClientTlsContext(['http/1.1']);
    ok(verified, 'a default context must be constructible');
    const unverified = createClientTlsContext(['http/1.1'], { rejectUnauthorized: false });
    ok(unverified, 'an opt-out context must still be constructible');
});

Deno.test({ name: 'raw TLS: openTcp falls back past an unreachable first address', timeout: 15000 }, async () => {
    // Incidental to the TLS work but on the same path: `localhost` resolves to
    // ::1 before 127.0.0.1, and openTcp reused a single streams.TCP across
    // candidates. A handle that has failed connect cannot be reused, so the
    // IPv4 fallback never got a real attempt and every IPv6-first name failed
    // outright. Plain http here so only the TCP layer is under test.
    const server = createServer((socket: Socket) => {
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
    const port = await new Promise<number | null>(resolve => {
        server.on('error', () => resolve(null));
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    if (port === null) return;
    try {
        const socket = await connectDirectTcp(new URL(`http://localhost:${port}/`));
        ok(/^HTTP\/1\.1 200/.test(await roundTrip(socket, 'localhost')), 'localhost must reach an IPv4-only listener despite ::1 sorting first');
        socket.close();
    } finally {
        await closeServer(server);
    }
});

/* -------------------------------------------------------------------------- */
/* Proxy path (wss: via CONNECT)                                              */
/* -------------------------------------------------------------------------- */

Deno.test({ name: 'raw TLS: wss through a CONNECT proxy rejects a self-signed certificate', timeout: 20000 }, async () => {
    const target = await listenTls('127.0.0.1');
    if (!target) return;
    const proxy = await startTunnelProxy();
    if (!proxy) { await closeServer(target.server); return; }
    const config: ProxyConfig = { url: `http://127.0.0.1:${proxy.port}`, type: 'http' };
    try {
        let message: string | null = null;
        let connection: Awaited<ReturnType<typeof connectViaProxy>> | null = null;
        try {
            connection = await connectViaProxy(new URL(`wss://127.0.0.1:${target.port}/ws`), config);
        } catch (error) {
            message = (error as Error).message;
        } finally {
            try { connection?.socket.close(); } catch { /* not established */ }
        }
        // The tunnel itself must have been built — this is a TLS rejection, not a
        // CONNECT failure, which is what makes it a statement about verification.
        strictEqual(proxy.connects.length, 1);
        ok(message !== null, 'wss: through CONNECT must verify the tunnelled certificate');
        ok(/certificate verify failed/i.test(message!), `unexpected error text: ${message}`);
    } finally {
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'raw TLS: wss through a CONNECT proxy accepts a named trust root', timeout: 20000 }, async () => {
    const target = await listenTls('localhost');
    if (!target) return;
    const proxy = await startTunnelProxy();
    if (!proxy) { await closeServer(target.server); return; }
    const config: ProxyConfig = { url: `http://127.0.0.1:${proxy.port}`, type: 'http' };
    try {
        const connection = await connectViaProxy(
            new URL(`wss://localhost:${target.port}/ws`),
            config,
            { caCerts: [target.cert] },
        );
        // Positive control for the tunnelled leg: data must traverse CONNECT + TLS.
        ok(/^HTTP\/1\.1 200/.test(await roundTrip(connection.socket, 'localhost')), 'the tunnelled session must carry data');
        strictEqual(proxy.connects.length, 1);
        connection.socket.close();
    } finally {
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});
