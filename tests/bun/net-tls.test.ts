import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { connect } from 'bun';

const ssl = import.meta.use('ssl');
const engine = import.meta.use('engine');

Deno.test({ name: 'bun.net TLS: handshake callback, ALPN, and graceful close', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const listener = Deno.listenTls({
        hostname: '127.0.0.1',
        port: 0,
        cert,
        key,
        alpnProtocols: ['http/1.1'],
    });
    let serverConn: Deno.TlsConn | undefined;
    const events: string[] = [];
    const received: string[] = [];
    const closed = Promise.withResolvers<void>();

    try {
        const accepted = listener.accept();
        const serverReady = (async () => {
            serverConn = await accepted;
            await serverConn.handshake();
            await serverConn.write(engine.encodeString('secure'));
            await serverConn.close();
        })();
        const socket = await connect({
            hostname: 'localhost',
            port: (listener.addr as Deno.NetAddr).port,
            tls: { ca: cert, ALPNProtocols: '\x08http/1.1' },
            socket: {
                handshake(current, success, error) {
                    events.push(`handshake:${success}`);
                    strictEqual(current.authorized, success);
                    strictEqual(error, success ? null : current.getAuthorizationError());
                },
                data(current, data) {
                    received.push(engine.decodeString(data as Uint8Array));
                    current.end();
                },
                close() {
                    events.push('close');
                    closed.resolve();
                },
            },
        });

        events.unshift('resolved');
        strictEqual(socket.authorized, false);
        await closed.promise;
        await serverReady;
        deepStrictEqual(received, ['secure']);
        strictEqual(socket.alpnProtocol, 'http/1.1');
        strictEqual(socket.getAuthorizationError(), null);
        ok(events.indexOf('resolved') < events.indexOf('handshake:true'));
        strictEqual(events.at(-1), 'close');
    } finally {
        try { await serverConn?.close(); } catch {}
        listener.close();
    }
});

Deno.test({ name: 'bun.net TLS: serverName mismatches fail before opening a socket', timeout: 5000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const listener = Deno.listenTls({ hostname: '127.0.0.1', port: 0, cert, key });
    try {
        let connectErrors = 0;
        await connect({
            hostname: 'localhost',
            port: (listener.addr as Deno.NetAddr).port,
            tls: { ca: cert, serverName: 'otherhost' },
            socket: { connectError() { connectErrors++; } },
        }).then(() => { throw new Error('TLS connection unexpectedly succeeded'); }, () => {});
        strictEqual(connectErrors, 0);
    } finally {
        listener.close();
    }
});
