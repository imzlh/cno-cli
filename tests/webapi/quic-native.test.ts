/**
 * QUIC native gate + public surface (WebTransport / Deno.QuicEndpoint).
 * Fail-closed runs via __forceQuicUnavailable (same requireQuic path as embed OFF).
 */
import { ok, strictEqual, throws } from 'node:assert';
import {
    quicAvailable,
    requireQuic,
    tryLoadQuic,
    __forceQuicUnavailable,
} from '../../cno/src/quic-native.ts';

Deno.test({
    name: 'quic: tryLoadQuic returns module when embedded',
    ignore: !quicAvailable(),
}, () => {
    const mod = tryLoadQuic();
    ok(mod !== null);
    ok(typeof mod!.Socket === 'function');
    ok(mod!.constants !== null && typeof mod!.constants === 'object');
    const again = requireQuic();
    strictEqual(again, mod);
});

Deno.test({
    name: 'quic: WebTransport is registered when polyfill loads',
}, () => {
    ok(typeof (globalThis as { WebTransport?: unknown }).WebTransport === 'function');
});

Deno.test({
    name: 'quic: Deno.QuicEndpoint is registered',
}, () => {
    ok(typeof Deno.QuicEndpoint === 'function');
    ok(typeof Deno.connectQuic === 'function');
});

Deno.test({
    name: 'quic: requireQuic fails closed when gate forced missing',
}, () => {
    __forceQuicUnavailable(true);
    try {
        try {
            requireQuic();
            ok(false, 'expected requireQuic to throw');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ok(/QUIC|CNO_EMBED_EXT_QUIC|not available/i.test(msg), msg);
        }
        ok(tryLoadQuic() === null);
        ok(quicAvailable() === false);
    } finally {
        __forceQuicUnavailable(false);
    }
});

Deno.test({
    name: 'quic: WebTransport fails closed without native',
}, () => {
    __forceQuicUnavailable(true);
    try {
        try {
            new (globalThis as { WebTransport: new (u: string) => unknown }).WebTransport(
                'https://127.0.0.1:4433/',
            );
            ok(false, 'expected WebTransport ctor to throw without QUIC');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ok(/QUIC|CNO_EMBED_EXT_QUIC|not available/i.test(msg), msg);
        }
    } finally {
        __forceQuicUnavailable(false);
    }
});

Deno.test({
    name: 'quic: Deno.QuicEndpoint.listen fails closed without native',
}, () => {
    __forceQuicUnavailable(true);
    try {
        const ep = new Deno.QuicEndpoint({ hostname: '127.0.0.1', port: 0 });
        try {
            ep.listen({
                cert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
                key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n',
                alpnProtocols: ['cno-quic'],
            });
            ok(false, 'expected listen to throw without QUIC');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ok(/QUIC|CNO_EMBED_EXT_QUIC|not available/i.test(msg), msg);
        }
    } finally {
        __forceQuicUnavailable(false);
    }
});

Deno.test({
    name: 'quic: Socket can be constructed when available (client, no connect)',
    ignore: !quicAvailable(),
}, () => {
    const { Socket } = requireQuic();
    const sock = new Socket({ host: '127.0.0.1', port: 0, isServer: false });
    ok(sock !== null);
    try {
        sock.close();
    } catch {
        // best-effort
    }
});

Deno.test({
    name: 'quic: native options preserve getter errors and reject invalid transport values',
    ignore: !quicAvailable(),
}, () => {
    const { Socket } = requireQuic();
    const marker = new Error('host getter marker');
    const options: CModuleExternalQuic.SocketOptions = {};
    Object.defineProperty(options, 'host', {
        get() {
            throw marker;
        },
    });

    let getterError: unknown;
    try {
        new Socket(options);
    } catch (error) {
        getterError = error;
    }
    strictEqual(getterError, marker);
    throws(() => Reflect.construct(Socket, [null]), /options must be an object/i);
    throws(
        () => Reflect.construct(Socket, [{ transport: 1 }]),
        /transport must be an object/i,
    );
    throws(
        () => Reflect.construct(Socket, [{ transport: { cc: 'bbr' } }]),
        /unknown congestion control algorithm/i,
    );
});

Deno.test({
    name: 'quic: connect coercion can close its socket without use-after-free',
    ignore: !quicAvailable(),
}, () => {
    const { Socket } = requireQuic();
    const sock = new Socket({ host: '127.0.0.1', port: 0 });
    const closingPort = {
        valueOf() {
            sock.close();
            return 4433;
        },
    };

    throws(
        () => Reflect.apply(sock.connect, sock, ['127.0.0.1', closingPort]),
        /socket.*closed|closed.*socket/i,
    );
    strictEqual(sock.close(), undefined);
    throws(() => Reflect.apply(sock.close, {}, []), TypeError);
});

Deno.test({
    name: 'quic: Socket.close leaves Connection methods safe (no UAF)',
    ignore: !quicAvailable(),
    timeout: 15000,
}, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'cno-quic-' });
    let server: CModuleExternalQuic.Socket | undefined;
    let client: CModuleExternalQuic.Socket | undefined;
    let peer: CModuleExternalQuic.Connection | null = null;
    let conn: CModuleExternalQuic.Connection | undefined;
    try {
        const keyPath = `${dir}/key.pem`;
        const certPath = `${dir}/cert.pem`;
        const cmd = new Deno.Command('openssl', {
            args: [
                'req', '-x509', '-newkey', 'rsa:2048',
                '-keyout', keyPath, '-out', certPath,
                '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
                '-addext', 'subjectAltName=IP:127.0.0.1',
            ],
            stdout: 'piped',
            stderr: 'piped',
        });
        const { code } = await cmd.output();
        ok(code === 0, 'openssl for UAF test');
        const cert = await Deno.readTextFile(certPath);
        const key = await Deno.readTextFile(keyPath);
        const { Socket } = requireQuic();
        const port = 19600 + (Math.floor(Math.random() * 100) | 0);
        server = new Socket({
            isServer: true, host: '127.0.0.1', port, cert, key, alpn: 'cno-quic',
        });
        server.onconnection = (connection) => { peer = connection; };
        client = new Socket({ host: '127.0.0.1', port, alpn: 'cno-quic' });
        conn = client.connect('127.0.0.1', port);
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('hs timeout')), 8000);
            conn!.onconnected = () => { clearTimeout(t); resolve(); };
            conn!.onerror = (message) => { clearTimeout(t); reject(new Error(String(message))); };
        });
        // Close sockets while Connection JS objects still live.
        client.close();
        server.close();
        // Methods must not crash (opaque cleared / qconn gone).
        try { conn.openStream(true); } catch { /* may throw or no-op */ }
        try { conn.close(); } catch { /* */ }
        try { peer?.close(); } catch { /* */ }
        ok(true);
    } finally {
        try { conn?.close(); } catch { /* already closed */ }
        try { peer?.close(); } catch { /* already closed */ }
        try { client?.close(); } catch { /* already closed */ }
        try { server?.close(); } catch { /* already closed */ }
        await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    }
});
