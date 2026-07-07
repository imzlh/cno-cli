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
