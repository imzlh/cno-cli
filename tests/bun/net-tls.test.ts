import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { connect, listen } from 'bun';

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

Deno.test({ name: 'bun.net TLS: listener handshake, trusted duplex traffic, and graceful stop', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const events: string[] = [];
    const serverClosed = Promise.withResolvers<void>();
    const clientClosed = Promise.withResolvers<void>();
    const received: string[] = [];
    const listener = listen({
        hostname: '127.0.0.1',
        port: 0,
        data: { side: 'server' },
        tls: { cert, key, ALPNProtocols: '\x08http/1.1' },
        socket: {
            binaryType: 'uint8array',
            open(socket) {
                events.push('open');
                strictEqual(Object.prototype.toString.call(socket), '[object TLSSocket]');
                strictEqual(socket.authorized, false);
                strictEqual(socket.alpnProtocol, false);
            },
            handshake(socket, success, error) {
                events.push('handshake');
                strictEqual(success, true);
                strictEqual(socket.authorized, false);
                strictEqual(error, null);
                strictEqual(socket.getAuthorizationError(), null);
                strictEqual(socket.alpnProtocol, 'http/1.1');
                strictEqual(socket.data.side, 'server');
                strictEqual(socket.listener, listener);
                listener.stop();
            },
            data(socket, data) {
                events.push('data');
                socket.end(data);
            },
            close() { serverClosed.resolve(); },
            error(_socket, error) { serverClosed.reject(error); },
        },
    });
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    try {
        client = await connect({
            hostname: 'localhost',
            port: listener.port,
            tls: { ca: cert, ALPNProtocols: '\x08http/1.1' },
            socket: {
                handshake(socket, success, error) {
                    strictEqual(success, true);
                    strictEqual(error, null);
                    strictEqual(socket.authorized, true);
                    strictEqual(socket.alpnProtocol, 'http/1.1');
                    socket.write('trusted duplex');
                },
                data(socket, data) {
                    received.push(engine.decodeString(data as Uint8Array));
                    socket.end();
                },
                close() { clientClosed.resolve(); },
                error(_socket, error) { clientClosed.reject(error); },
            },
        });
        await Promise.all([clientClosed.promise, serverClosed.promise]);
        deepStrictEqual(events, ['open', 'handshake', 'data']);
        strictEqual(received.join(''), 'trusted duplex');
        strictEqual(client.readyState, -1);
    } finally {
        client?.terminate();
        listener.stop(true);
    }
});

Deno.test({ name: 'bun.net TLS: failed handshakes stay local, reload and force-stop remain usable', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const failed = Promise.withResolvers<void>();
    const failedClosed = Promise.withResolvers<void>();
    const validReady = Promise.withResolvers<void>();
    const serverClosed = Promise.withResolvers<void>();
    const clientClosed = Promise.withResolvers<void>();
    let failures = 0;
    const listener = listen({
        hostname: '127.0.0.1',
        port: 0,
        tls: { cert, key },
        socket: {
            handshake(socket, success, error) {
                failures++;
                strictEqual(success, false);
                ok(error instanceof Error);
                strictEqual(socket.authorized, false);
                strictEqual(socket.getAuthorizationError(), error);
                failed.resolve();
            },
            close() { failedClosed.resolve(); },
            error(_socket, error) { failed.reject(error); },
        },
    });
    let raw: Deno.TcpConn | undefined;
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    try {
        raw = await Deno.connect({ hostname: '127.0.0.1', port: listener.port });
        await raw.write(engine.encodeString('not a TLS record\r\n'));
        await Promise.all([failed.promise, failedClosed.promise]);
        strictEqual(failures, 1);
        raw.close();
        raw = undefined;

        listener.reload({
            socket: {
                open(socket) {
                    strictEqual(socket.authorized, false);
                    strictEqual(socket.getAuthorizationError(), null);
                    socket.write('ready');
                },
                close() { serverClosed.resolve(); },
                error(_socket, error) { serverClosed.reject(error); },
            },
        });
        client = await connect({
            hostname: 'localhost',
            port: listener.port,
            tls: { ca: cert },
            socket: {
                data(_socket, data) {
                    strictEqual(engine.decodeString(data as Uint8Array), 'ready');
                    validReady.resolve();
                },
                close() { clientClosed.resolve(); },
                error(_socket, error) { validReady.reject(error); },
            },
        });
        await validReady.promise;
        listener.stop(true);
        await Promise.all([serverClosed.promise, clientClosed.promise]);
        strictEqual(client.readyState, -1);

        for (const tls of [{ cert, key, ca: cert }, { cert, key, requestCert: true }]) {
            throws(() => listen({ hostname: '127.0.0.1', port: 0, tls, socket: {} }), /not supported/);
        }
        throws(() => listen({ unix: 'unused-tls-socket', tls: { cert, key }, socket: {} }), /TLS over Unix/);
    } finally {
        raw?.close();
        client?.terminate();
        listener.stop(true);
    }
});
