import { ok, rejects, strictEqual, throws } from 'node:assert';

const ssl = import.meta.use('ssl');

async function withTimeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function isSandboxSocketError(error: unknown): boolean {
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase();
    return message.includes('EPERM') || message.includes('operation not permitted');
}

function createTlsMaterial() {
    return ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
}

Deno.test({ name: 'deno tls: listenTls and connectTls negotiate ALPN and exchange bytes', timeout: 10000 }, async () => {
    const { cert, key } = createTlsMaterial();
    let listener: Deno.TlsListener | undefined;
    let serverConn: Deno.TlsConn | undefined;
    let clientConn: Deno.TlsConn | undefined;

    try {
        listener = Deno.listenTls({
            hostname: '127.0.0.1',
            port: 0,
            cert,
            key,
            alpnProtocols: ['deno', 'rocks'],
        });
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    }

    try {
        const addr = listener.addr;
        strictEqual(addr.transport, 'tcp');
        strictEqual(addr.hostname, '127.0.0.1');
        ok(addr.port > 0);

        const accepted = listener.accept();
        clientConn = await Deno.connectTls({
            hostname: '127.0.0.1',
            port: addr.port,
            caCerts: [cert],
            unsafelyDisableHostnameVerification: true,
            alpnProtocols: ['rocks', 'rises'],
        });
        serverConn = await withTimeout(accepted);

        const [serverHandshake, clientHandshake] = await withTimeout(Promise.all([
            serverConn.handshake(),
            clientConn.handshake(),
        ]));
        strictEqual(serverHandshake.alpnProtocol, 'rocks');
        strictEqual(clientHandshake.alpnProtocol, 'rocks');

        strictEqual(await serverConn.write(new TextEncoder().encode('secure')), 6);
        const buf = new Uint8Array(6);
        strictEqual(await withTimeout(clientConn.read(buf)), 6);
        strictEqual(new TextDecoder().decode(buf), 'secure');
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    } finally {
        try { serverConn?.close(); } catch {}
        try { clientConn?.close(); } catch {}
        try { listener?.close(); } catch {}
    }
});

Deno.test({ name: 'deno tls: startTls upgrades and consumes a TCP connection', timeout: 10000 }, async () => {
    const { cert, key } = createTlsMaterial();
    let listener: Deno.TlsListener | undefined;
    let serverConn: Deno.TlsConn | undefined;
    let tcpConn: Deno.TcpConn | undefined;
    let tlsConn: Deno.TlsConn | undefined;

    try {
        listener = Deno.listenTls({
            hostname: '127.0.0.1',
            port: 0,
            cert,
            key,
            alpnProtocols: ['deno', 'rocks'],
        });
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    }

    try {
        const addr = listener.addr;
        const accepted = listener.accept();
        tcpConn = await Deno.connect({ hostname: '127.0.0.1', port: addr.port });
        tlsConn = await Deno.startTls(tcpConn, {
            hostname: '127.0.0.1',
            caCerts: [cert],
            unsafelyDisableHostnameVerification: true,
            alpnProtocols: ['rocks'],
        });
        throws(() => tcpConn!.write(new Uint8Array([1])), Deno.errors.BadResource);

        serverConn = await withTimeout(accepted);
        const [serverHandshake, clientHandshake] = await withTimeout(Promise.all([
            serverConn.handshake(),
            tlsConn.handshake(),
        ]));
        strictEqual(serverHandshake.alpnProtocol, 'rocks');
        strictEqual(clientHandshake.alpnProtocol, 'rocks');

        strictEqual(await tlsConn.write(new TextEncoder().encode('upgrade')), 7);
        const buf = new Uint8Array(7);
        strictEqual(await withTimeout(serverConn.read(buf)), 7);
        strictEqual(new TextDecoder().decode(buf), 'upgrade');
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    } finally {
        try { serverConn?.close(); } catch {}
        try { tlsConn?.close(); } catch {}
        try { tcpConn?.close(); } catch {}
        try { listener?.close(); } catch {}
    }
});

Deno.test({ name: 'deno tls: startTls rejects while the TCP connection has a pending read', timeout: 10000 }, async () => {
    let listener: Deno.TcpListener | undefined;
    let serverConn: Deno.TcpConn | undefined;
    let clientConn: Deno.TcpConn | undefined;

    try {
        listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    }

    try {
        const addr = listener.addr;
        const accepted = listener.accept();
        clientConn = await Deno.connect({ hostname: '127.0.0.1', port: addr.port });
        serverConn = await withTimeout(accepted);

        const pendingRead = clientConn.read(new Uint8Array(16));
        await rejects(
            () => Deno.startTls(clientConn!, { hostname: '127.0.0.1' }),
            Deno.errors.Busy,
        );

        serverConn.close();
        strictEqual(await withTimeout(pendingRead), null);
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    } finally {
        try { serverConn?.close(); } catch {}
        try { clientConn?.close(); } catch {}
        try { listener?.close(); } catch {}
    }
});
