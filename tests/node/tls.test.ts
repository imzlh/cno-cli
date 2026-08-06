import { strictEqual, ok, throws } from 'node:assert';
import * as tls from 'node:tls';
import * as net from 'node:net';
import { Buffer } from 'node:buffer';
import { Duplex } from 'node:stream';

const ssl = import.meta.use('ssl');

// --- 1. createSecureContext returns a SecureContext -------------------------

Deno.test({ name: 'tls: createSecureContext returns SecureContext', timeout: 10000 }, () => {
    const ctx = tls.createSecureContext({});
    ok(ctx instanceof tls.SecureContext);
    ok(typeof (ctx as tls.SecureContext & { context?: unknown }).context === 'object');
});

// --- 2. SecureContext constructor accepts options ---------------------------

Deno.test({ name: 'tls: SecureContext constructor accepts empty options object', timeout: 10000 }, () => {
    ok(new tls.SecureContext({}));
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

Deno.test({ name: 'tls upstream: setDefaultCACertificates validates and accepts PEM arrays', timeout: 10000 }, () => {
    const api = tls as typeof tls & { setDefaultCACertificates(certs: string[]): void };
    strictEqual(typeof api.setDefaultCACertificates, 'function');
    throws(() => api.setDefaultCACertificates('not an array' as unknown as string[]), /must be an array/);
    throws(() => api.setDefaultCACertificates([123 as unknown as string]), /must be a string/);

    const { cert } = ssl.createSelfSignedCert({ commonName: 'cno-default-ca', days: 1 });
    api.setDefaultCACertificates([cert]);
    ok(tls.createSecureContext({}) instanceof tls.SecureContext);
    api.setDefaultCACertificates([]);
});

// --- 7. defaultMinVersion / defaultMaxVersion ------------------------------

Deno.test({ name: 'tls: DEFAULT_MIN_VERSION and DEFAULT_MAX_VERSION match Node defaults', timeout: 10000 }, () => {
    strictEqual(tls.DEFAULT_MIN_VERSION, 'TLSv1.2');
    strictEqual(tls.DEFAULT_MAX_VERSION, 'TLSv1.3');
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

Deno.test({ name: 'tls: getCiphers returns common cipher names', timeout: 10000 }, () => {
    const ciphers = tls.getCiphers();
    ok(Array.isArray(ciphers));
    ok(ciphers.includes('aes128-gcm-sha256'));
});

Deno.test({ name: 'tls: createServer completes a real TLS round-trip', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = tls.createServer({ cert, key }, (socket) => {
        strictEqual(typeof socket.remotePort, 'number');
        socket.end('secure-ok');
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const body = await new Promise<string>((resolve, reject) => {
            const socket = tls.connect({ port: addr.port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
                socket.setEncoding('utf8');
            });
            let data = '';
            socket.on('data', (chunk: string) => {
                data += chunk;
            });
            socket.on('end', () => resolve(data));
            socket.on('error', reject);
        });

        strictEqual(body, 'secure-ok');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'tls: TLSSocket resumes a paused socket with buffered handshake bytes', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = net.createServer((socket) => {
        let buffered = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.length < 4) return;

            socket.off('data', onData);
            socket.pause();
            const tail = buffered.subarray(4);
            if (tail.length > 0) socket.unshift(tail);

            const tlsSocket = new tls.TLSSocket(socket, { isServer: true, cert, key });
            tlsSocket.once('secureConnect', () => tlsSocket.end('secure-ok'));
            tlsSocket.once('secure', () => tlsSocket.end('secure-ok'));
            tlsSocket.on('error', () => {});
        };
        socket.on('data', onData);
        socket.resume();
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const body = await new Promise<string>((resolve, reject) => {
            const tcp = net.connect({ port: addr.port, host: '127.0.0.1' });
            tcp.once('connect', () => {
                tcp.write(Buffer.alloc(4));
                const socket = tls.connect({ socket: tcp, rejectUnauthorized: false }, () => {
                    socket.setEncoding('utf8');
                });
                let data = '';
                socket.on('data', (chunk: string) => {
                    data += chunk;
                });
                socket.on('end', () => resolve(data));
                socket.on('error', reject);
            });
            tcp.once('error', reject);
        });

        strictEqual(body, 'secure-ok');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'tls: TLSSocket starts after unshifted ClientHello bytes', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = net.createServer((socket) => {
        const onData = (chunk: Buffer) => {
            socket.off('data', onData);
            socket.pause();
            socket.unshift(Buffer.from(chunk));

            const tlsSocket = new tls.TLSSocket(socket, { isServer: true, cert, key, start: true });
            let ended = false;
            const endSecure = () => {
                if (ended) return;
                ended = true;
                tlsSocket.end('secure-ok');
            };
            tlsSocket.once('secureConnect', endSecure);
            tlsSocket.once('secure', endSecure);
            tlsSocket.on('error', () => {});
        };
        socket.on('data', onData);
        socket.resume();
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const body = await new Promise<string>((resolve, reject) => {
            const socket = tls.connect({ port: addr.port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
                socket.setEncoding('utf8');
            });
            let data = '';
            socket.on('data', (chunk: string) => {
                data += chunk;
            });
            socket.on('end', () => resolve(data));
            socket.on('error', reject);
        });

        strictEqual(body, 'secure-ok');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'tls: TLSSocket starts after a framed prefix with tail bytes', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const frameBody = Buffer.from(JSON.stringify({ ok: true }));
    const frame = Buffer.alloc(9 + frameBody.length);
    frame[0] = 1;
    frame.writeInt32BE(0, 1);
    frame.writeUInt32BE(frameBody.length, 5);
    frameBody.copy(frame, 9);

    const server = net.createServer((socket) => {
        let buffered = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.length < 9) return;
            const length = buffered.readUInt32BE(5);
            if (buffered.length < 9 + length) return;

            socket.off('data', onData);
            socket.pause();
            const tail = buffered.subarray(9 + length);
            if (tail.length > 0) socket.unshift(tail);

            const tlsSocket = new tls.TLSSocket(socket, { isServer: true, cert, key, start: true });
            let ended = false;
            const endSecure = () => {
                if (ended) return;
                ended = true;
                tlsSocket.end('secure-ok');
            };
            tlsSocket.once('secureConnect', endSecure);
            tlsSocket.once('secure', endSecure);
            tlsSocket.on('error', () => {});
        };
        socket.on('data', onData);
        socket.resume();
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const body = await new Promise<string>((resolve, reject) => {
            const tcp = net.connect({ port: addr.port, host: '127.0.0.1' });
            tcp.once('connect', () => {
                tcp.write(frame);
                const socket = tls.connect({ socket: tcp, rejectUnauthorized: false }, () => {
                    socket.setEncoding('utf8');
                });
                let data = '';
                socket.on('data', (chunk: string) => {
                    data += chunk;
                });
                socket.on('end', () => resolve(data));
                socket.on('error', reject);
            });
            tcp.once('error', reject);
        });

        strictEqual(body, 'secure-ok');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'tls: TLSSocket continues after a partial framed ClientHello tail', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const frameBody = Buffer.from(JSON.stringify({ ok: true }));
    const frame = Buffer.alloc(9 + frameBody.length);
    frame[0] = 1;
    frame.writeInt32BE(0, 1);
    frame.writeUInt32BE(frameBody.length, 5);
    frameBody.copy(frame, 9);

    const target = net.createServer((socket) => {
        let buffered = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.length < 9) return;
            const length = buffered.readUInt32BE(5);
            if (buffered.length < 9 + length) return;

            socket.off('data', onData);
            socket.pause();
            const tail = buffered.subarray(9 + length);
            if (tail.length > 0) socket.unshift(tail);

            const tlsSocket = new tls.TLSSocket(socket, { isServer: true, cert, key, start: true });
            let ended = false;
            const endSecure = () => {
                if (ended) return;
                ended = true;
                tlsSocket.end('secure-ok');
            };
            tlsSocket.once('secureConnect', endSecure);
            tlsSocket.once('secure', endSecure);
            tlsSocket.on('error', () => {});
        };
        socket.on('data', onData);
        socket.resume();
    });

    await new Promise<void>((resolve, reject) => {
        target.listen(0, '127.0.0.1', () => resolve());
        target.once('error', reject);
    });

    const targetAddr = target.address();
    if (!targetAddr || typeof targetAddr === 'string') throw new Error('no target port');

    const proxy = net.createServer((client) => {
        const upstream = net.connect({ port: targetAddr.port, host: '127.0.0.1' });
        upstream.on('data', (chunk: Buffer) => client.write(chunk));
        upstream.on('end', () => client.end());
        upstream.on('error', (err) => client.destroy(err));
        client.on('end', () => upstream.end());
        client.on('error', (err) => upstream.destroy(err));

        let first = true;
        client.on('data', (chunk: Buffer) => {
            if (!first) {
                upstream.write(chunk);
                return;
            }
            first = false;
            const split = Math.min(64, chunk.length);
            upstream.write(Buffer.concat([frame, chunk.subarray(0, split)]));
            setTimeout(() => {
                if (chunk.length > split) upstream.write(chunk.subarray(split));
            }, 20);
        });
    });

    await new Promise<void>((resolve, reject) => {
        proxy.listen(0, '127.0.0.1', () => resolve());
        proxy.once('error', reject);
    });

    try {
        const proxyAddr = proxy.address();
        if (!proxyAddr || typeof proxyAddr === 'string') throw new Error('no proxy port');

        const body = await new Promise<string>((resolve, reject) => {
            const socket = tls.connect({ port: proxyAddr.port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
                socket.setEncoding('utf8');
            });
            let data = '';
            socket.on('data', (chunk: string) => {
                data += chunk;
            });
            socket.on('end', () => resolve(data));
            socket.on('error', reject);
        });

        strictEqual(body, 'secure-ok');
    } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await new Promise<void>((resolve) => target.close(() => resolve()));
    }
});

Deno.test({ name: 'tls: TLSSocket starts over a generic Duplex', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });

    class MemorySocket extends Duplex {
        peer?: MemorySocket;

        _read(): void {}

        _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
            this.peer?.push(Buffer.from(chunk));
            callback();
        }

        _final(callback: (error?: Error | null) => void): void {
            this.peer?.push(null);
            callback();
        }
    }

    const clientRaw = new MemorySocket();
    const serverRaw = new MemorySocket();
    clientRaw.peer = serverRaw;
    serverRaw.peer = clientRaw;

    const server = new tls.TLSSocket(serverRaw, { isServer: true, cert, key, start: true });
    const client = new tls.TLSSocket(clientRaw, { rejectUnauthorized: false, start: true });

    try {
        server.once('secureConnect', () => server.end('secure-ok'));
        server.once('secure', () => server.end('secure-ok'));

        const body = await new Promise<string>((resolve, reject) => {
            let data = '';
            client.setEncoding('utf8');
            client.on('data', (chunk: string) => {
                data += chunk;
            });
            client.on('end', () => resolve(data));
            client.on('error', reject);
            server.on('error', reject);
        });

        strictEqual(body, 'secure-ok');
    } finally {
        client.destroy();
        server.destroy();
    }
});

Deno.test({ name: 'tls: TLSSocket over generic Duplex is passive by default', timeout: 10000 }, async () => {
    const raw = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
            callback();
        },
    });
    const socket = new tls.TLSSocket(raw);
    let errored = false;
    socket.on('error', () => {
        errored = true;
    });
    raw.push(Buffer.from('not tls'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.destroy();
    strictEqual(errored, false);
});

// --- certificate verification --------------------------------------------
//
// Every case below is a regression guard: each one previously reported success
// (or reported `authorized: true`) against a certificate that must not have been
// trusted. Verified against real Node v24 behaviour.

type TlsListenResult = { server: tls.Server; port: number };

async function listenTls(options: Parameters<typeof tls.createServer>[0], onSecure?: (s: tls.TLSSocket) => void): Promise<TlsListenResult> {
    const server = tls.createServer(options ?? {}, (socket) => {
        try { onSecure?.(socket); } catch { /* assertions run on the client side */ }
        try { socket.write('payload'); } catch { /* peer already gone */ }
    });
    // A refused handshake surfaces here; the client side is what we assert on.
    server.on('tlsClientError', () => {});
    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    return { server, port: addr.port };
}

type ConnectOutcome = {
    connected: boolean;
    authorized: boolean | null;
    authErrorMessage: string | null;
    authErrorCode: string | null;
    errorMessage: string | null;
    errorCode: string | null;
    // Node attaches the attempted host to ERR_TLS_CERT_ALTNAME_INVALID. It was
    // absent here, so a caller could not tell which name failed.
    errorHost: string | null;
};

function connectTls(port: number, options: Record<string, unknown>): Promise<ConnectOutcome> {
    return new Promise((resolve) => {
        const outcome: ConnectOutcome = {
            connected: false, authorized: null, authErrorMessage: null,
            authErrorCode: null, errorMessage: null, errorCode: null, errorHost: null,
        };
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.destroy(); } catch { /* already destroyed */ }
            resolve(outcome);
        };
        const timer = setTimeout(finish, 6000);
        const socket = tls.connect({ port, host: '127.0.0.1', ...options } as Parameters<typeof tls.connect>[0]);
        socket.on('secureConnect', () => {
            outcome.connected = true;
            outcome.authorized = socket.authorized;
            const authError = socket.authorizationError as (Error & { code?: string }) | null;
            outcome.authErrorMessage = authError ? String(authError.message) : null;
            outcome.authErrorCode = authError?.code ?? null;
            finish();
        });
        socket.on('error', (err: Error & { code?: string; host?: string }) => {
            outcome.errorMessage = String(err.message);
            outcome.errorCode = err.code ?? null;
            outcome.errorHost = err.host ?? null;
            finish();
        });
    });
}

Deno.test({ name: 'tls: rejectUnauthorized rejects a self-signed certificate with a Node error code', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        const outcome = await connectTls(port, { rejectUnauthorized: true, servername: 'localhost' });
        strictEqual(outcome.connected, false, 'a self-signed certificate must not be accepted');
        // Node reports DEPTH_ZERO_SELF_SIGNED_CERT; a bare OpenSSL string with no
        // code left every failure indistinguishable to the caller.
        strictEqual(outcome.errorCode, 'DEPTH_ZERO_SELF_SIGNED_CERT');
    } finally { server.close(); }
});

Deno.test({ name: 'tls: rejectUnauthorized:false connects but reports authorized:false', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        const outcome = await connectTls(port, { rejectUnauthorized: false, servername: 'localhost' });
        ok(outcome.connected, 'rejectUnauthorized:false must still connect');
        strictEqual(outcome.authorized, false);
        ok(outcome.authErrorMessage, 'authorizationError must explain why');
    } finally { server.close(); }
});

Deno.test({ name: 'tls: an explicit ca makes an otherwise untrusted chain verify', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        const trusted = await connectTls(port, { ca: cert, servername: 'localhost' });
        ok(trusted.connected, 'passing the peer certificate as ca must verify');
        strictEqual(trusted.authorized, true);
        strictEqual(trusted.authErrorMessage, null);
    } finally { server.close(); }
});

Deno.test({ name: 'tls: a certificate for another host is rejected on name mismatch', timeout: 15000 }, async () => {
    // Trusted chain (the certificate is its own ca) but the wrong name.
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'other.example', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        const outcome = await connectTls(port, { ca: cert, servername: 'localhost' });
        strictEqual(outcome.connected, false, 'a name mismatch must not be accepted');
    } finally { server.close(); }
});

Deno.test({ name: 'tls: a name mismatch reports authorized:false under rejectUnauthorized:false', timeout: 15000 }, async () => {
    // The hostname check lives in the C layer behind verifyHostname, which
    // tracks rejectUnauthorized — so with verification off the name was never
    // checked and `authorized` came back true for a certificate issued to
    // another host. Callers use that flag to decide whether to trust the peer.
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'other.example', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        const outcome = await connectTls(port, { ca: cert, servername: 'localhost', rejectUnauthorized: false });
        ok(outcome.connected, 'rejectUnauthorized:false must still connect');
        strictEqual(outcome.authorized, false, 'a name mismatch must not report authorized:true');
    } finally { server.close(); }
});

Deno.test({ name: 'tls: checkServerIdentity is called and its rejection is honoured', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        let calls = 0;
        let sawHost: string | null = null;
        // Previously accepted as an option and never invoked, so a pinning or
        // custom-identity check silently enforced nothing.
        const outcome = await connectTls(port, {
            ca: cert, servername: 'localhost',
            checkServerIdentity: (host: string) => {
                calls++; sawHost = host;
                return new Error('identity refused by test');
            },
        });
        strictEqual(calls, 1, 'checkServerIdentity must be called exactly once');
        strictEqual(sawHost, 'localhost');
        strictEqual(outcome.connected, false, 'a checkServerIdentity error must reject the connection');
        ok(/identity refused by test/.test(String(outcome.errorMessage)));
    } finally { server.close(); }
});

Deno.test({ name: 'tls: checkServerIdentity may accept a name the built-in check would refuse', timeout: 15000 }, async () => {
    // Node's contract: a caller-supplied checkServerIdentity replaces the
    // built-in name check.
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'other.example', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        let calls = 0;
        const outcome = await connectTls(port, {
            ca: cert, servername: 'localhost',
            checkServerIdentity: () => { calls++; return undefined; },
        });
        strictEqual(calls, 1);
        ok(outcome.connected, 'an accepting checkServerIdentity must allow the connection');
        strictEqual(outcome.authorized, true);
    } finally { server.close(); }
});

Deno.test({ name: 'tls: requestCert with rejectUnauthorized refuses a client that sends no certificate', timeout: 15000 }, async () => {
    // The server context ran with SSL_VERIFY_NONE, so no CertificateRequest was
    // ever sent: an anonymous client was served and the server reported
    // authorized:true. mTLS was decorative.
    //
    // Under TLS 1.3 the client's own handshake completes before the server's
    // rejection arrives, so (matching Node) the check is that the connection is
    // never handed to the application: no secureConnection, and tlsClientError
    // instead.
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    let handlerRan = false;
    const server = tls.createServer({ cert, key, ca: cert, requestCert: true, rejectUnauthorized: true }, () => {
        handlerRan = true;
    });
    const clientErrors: string[] = [];
    server.on('tlsClientError', (err: Error) => clientErrors.push(String(err.message)));
    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    try {
        await connectTls(addr.port, { ca: cert, servername: 'localhost' });
        // Let the server side settle before asserting on it.
        await new Promise((resolve) => setTimeout(resolve, 400));
        strictEqual(handlerRan, false, 'no secureConnection for a client with no certificate');
        ok(clientErrors.length > 0, 'the server must report a tlsClientError');
        ok(
            clientErrors.some((message) => /did not return a certificate/i.test(message)),
            `expected a missing-certificate fault, got: ${clientErrors.join('; ')}`,
        );
    } finally { server.close(); }
});

Deno.test({ name: 'tls: a server without requestCert still serves an anonymous client', timeout: 15000 }, async () => {
    // The guard above must not turn every plain TLS server into an mTLS server.
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    let handlerRan = false;
    const { server, port } = await listenTls({ cert, key }, () => { handlerRan = true; });
    try {
        const outcome = await connectTls(port, { ca: cert, servername: 'localhost' });
        ok(outcome.connected, 'a plain TLS server must accept a client with no certificate');
        strictEqual(outcome.authorized, true);
        await new Promise((resolve) => setTimeout(resolve, 400));
        ok(handlerRan, 'secureConnection must fire');
    } finally { server.close(); }
});

Deno.test({ name: 'tls: getPeerCertificate uses Node field names', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        const peer = await new Promise<tls.PeerCertificate>((resolve, reject) => {
            const socket = tls.connect({ port, host: '127.0.0.1', ca: cert, servername: 'localhost' }, () => {
                const value = socket.getPeerCertificate();
                socket.destroy();
                resolve(value);
            });
            socket.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 5000);
        });
        strictEqual(peer.subject?.CN, 'localhost');
        // Node's keys are valid_from / valid_to, not validFrom / validTo.
        ok(typeof peer.valid_from === 'string', 'valid_from must be present');
        ok(typeof peer.valid_to === 'string', 'valid_to must be present');
        // `fingerprint` is SHA-1 in Node. The C layer computes only SHA-256, so
        // the field must stay unset rather than carry the wrong digest under it.
        strictEqual(peer.fingerprint, undefined);
        ok(typeof peer.fingerprint256 === 'string');
    } finally { server.close(); }
});

Deno.test({ name: 'tls: getProtocol reports the negotiated version and alpnProtocol is false when unnegotiated', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        const info = await new Promise<{ protocol: string | null; alpn: unknown }>((resolve, reject) => {
            const socket = tls.connect({ port, host: '127.0.0.1', ca: cert, servername: 'localhost' }, () => {
                const value = { protocol: socket.getProtocol(), alpn: socket.alpnProtocol };
                socket.destroy();
                resolve(value);
            });
            socket.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 5000);
        });
        ok(/^TLSv1\.[23]$/.test(String(info.protocol)), `unexpected protocol ${info.protocol}`);
        // Node reports false, not null, when no ALPN was negotiated.
        strictEqual(info.alpn, false);
    } finally { server.close(); }
});

Deno.test({ name: 'tls: checkServerIdentity matches IP SANs against an IP peer, not the CN', timeout: 10000 }, () => {
    // The built-in check parsed only "DNS:"-prefixed entries out of a bare name
    // list, so the SAN filter matched nothing and it fell back to the CN — a
    // certificate whose SAN covered another host could pass on its CN alone.
    const mismatch = tls.checkServerIdentity('127.0.0.1', {
        subject: { CN: '127.0.0.1' },
        subjectaltname: 'DNS:example.com',
    });
    ok(mismatch instanceof Error, 'an IP peer must not match a DNS SAN or the CN');

    const match = tls.checkServerIdentity('127.0.0.1', {
        subject: { CN: 'unrelated' },
        subjectaltname: 'DNS:example.com, IP Address:127.0.0.1',
    });
    strictEqual(match, undefined, 'an IP peer must match an IP Address SAN');

    // With a dNSName SAN present the CN must be ignored entirely (RFC 6125).
    const cnIgnored = tls.checkServerIdentity('good.example', {
        subject: { CN: 'good.example' },
        subjectaltname: 'DNS:evil.example',
    });
    ok(cnIgnored instanceof Error, 'the CN must not be consulted when a DNS SAN exists');
});

// --- hostname verification (checkServerIdentity) ---------------------------
//
// The whole point of TLS PKI: a certificate valid for one name must not be
// accepted for another. Every case below is measured against real Node
// v24.18.0. Passing the self-signed cert as `ca` makes the chain verify, so a
// name mismatch is the ONLY reason a connection here can fail.

Deno.test({ name: 'tls: a certificate for another host is rejected with ERR_TLS_CERT_ALTNAME_INVALID', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'a.example', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        const outcome = await connectTls(port, { ca: cert, servername: 'b.example' });
        strictEqual(outcome.connected, false, 'a cert for a.example must not be accepted for b.example');
        strictEqual(outcome.errorCode, 'ERR_TLS_CERT_ALTNAME_INVALID');
        // Node names the host that failed; without it the caller cannot tell.
        strictEqual(outcome.errorHost, 'b.example');
    } finally { server.close(); }
});

Deno.test({ name: 'tls: the matching hostname is still accepted', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'a.example', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        const outcome = await connectTls(port, { ca: cert, servername: 'a.example' });
        strictEqual(outcome.connected, true, 'the matching name must connect');
        strictEqual(outcome.authorized, true);
    } finally { server.close(); }
});

Deno.test({ name: 'tls: an IP-address name mismatch also carries ERR_TLS_CERT_ALTNAME_INVALID', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'a.example', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        // No servername: the connect host 127.0.0.1 is used, which is an IP and
        // matches only an iPAddress SAN. X509 code 64 was unmapped, so this
        // error previously arrived with NO `code` at all.
        const outcome = await connectTls(port, { ca: cert });
        strictEqual(outcome.connected, false);
        strictEqual(outcome.errorCode, 'ERR_TLS_CERT_ALTNAME_INVALID');
    } finally { server.close(); }
});

Deno.test({ name: 'tls: rejectUnauthorized:false still reports a name mismatch as authorized:false', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'a.example', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        const outcome = await connectTls(port, { ca: cert, servername: 'b.example', rejectUnauthorized: false });
        strictEqual(outcome.connected, true, 'rejectUnauthorized:false must still connect');
        strictEqual(outcome.authorized, false, 'but the name mismatch must be reported');
        strictEqual(outcome.authErrorCode, 'ERR_TLS_CERT_ALTNAME_INVALID');
    } finally { server.close(); }
});

Deno.test({ name: 'tls: checkServerIdentity is actually called and receives the hostname and cert', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'a.example', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    let sawHost: string | null = null;
    let sawCn: string | undefined;
    try {
        const outcome = await connectTls(port, {
            ca: cert, servername: 'a.example',
            checkServerIdentity: (host: string, peer: tls.PeerCertificate) => {
                sawHost = host;
                sawCn = peer?.subject?.CN;
                return undefined;
            },
        });
        strictEqual(outcome.connected, true);
        // It was accepted as an option and never invoked.
        strictEqual(sawHost, 'a.example', 'checkServerIdentity must be called with the hostname');
        strictEqual(sawCn, 'a.example', 'and with the peer certificate');
    } finally { server.close(); }
});

Deno.test({ name: 'tls: a checkServerIdentity that returns an Error rejects the connection', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'a.example', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        const outcome = await connectTls(port, {
            ca: cert, servername: 'a.example',
            checkServerIdentity: () => {
                const err = new Error('vetoed-by-caller') as Error & { code?: string };
                err.code = 'MY_VETO';
                return err;
            },
        });
        strictEqual(outcome.connected, false, 'a vetoing checkServerIdentity must reject');
        // Node preserves the caller's own code rather than overwriting it.
        strictEqual(outcome.errorCode, 'MY_VETO');
        strictEqual(outcome.errorMessage, 'vetoed-by-caller');
    } finally { server.close(); }
});

Deno.test({ name: 'tls: a caller-supplied checkServerIdentity replaces the built-in name check', timeout: 15000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'a.example', days: 1 });
    const { server, port } = await listenTls({ cert, key });
    try {
        // Node's contract: the custom function REPLACES the default, so
        // returning undefined accepts a name the default would have rejected.
        const outcome = await connectTls(port, {
            ca: cert, servername: 'b.example',
            checkServerIdentity: () => undefined,
        });
        strictEqual(outcome.connected, true, 'a permissive custom check must override the default');
        strictEqual(outcome.authorized, true);
    } finally { server.close(); }
});

Deno.test({ name: 'tls: exported checkServerIdentity error carries code, reason and host', timeout: 10000 }, () => {
    const err = tls.checkServerIdentity('b.example', {
        subject: { CN: 'a.example' },
        subjectaltname: 'DNS:a.example',
    } as tls.PeerCertificate) as (Error & { code?: string; reason?: string; host?: string }) | undefined;
    ok(err instanceof Error, 'a mismatch must return an Error');
    // It returned a bare Error: callers branching on err.code saw undefined.
    strictEqual(err!.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    strictEqual(err!.host, 'b.example');
    strictEqual(err!.reason, "Host: b.example. is not in the cert's altnames: DNS:a.example");
    ok(err!.message.startsWith("Hostname/IP does not match certificate's altnames:"));
});
