import { strictEqual, ok } from 'node:assert';
import * as http from 'node:http';

function listen(server: http.Server, port = 0, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
        server.listen(port, host, () => resolve());
        server.once('error', reject);
    });
}
function close(server: http.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}
function get(url: string): Promise<{ status: number; statusMessage: string; body: string }> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, statusMessage: res.statusMessage ?? '', body }));
        }).once('error', reject);
    });
}

// --- 1. res.end(cb): callback fires on finish --------------------------------

Deno.test({ name: 'http: res.end(callback) invokes callback once', timeout: 10000 }, async () => {
    let calls = 0;
    const server = http.createServer((_req, res) => {
        res.end(() => { calls++; });
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        await get(`http://127.0.0.1:${addr.port}/`);
        await new Promise((r) => setTimeout(r, 50));
        strictEqual(calls, 1, 'end callback must fire exactly once');
    } finally {
        await close(server);
    }
});

// --- 2. res.end(data, cb): both data and callback delivered ----------------

Deno.test({ name: 'http: res.end(data, cb) delivers body and fires callback', timeout: 10000 }, async () => {
    let calls = 0;
    const server = http.createServer((_req, res) => {
        res.end('payload', () => { calls++; });
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const r = await get(`http://127.0.0.1:${addr.port}/`);
        strictEqual(r.body, 'payload');
        await new Promise((r) => setTimeout(r, 50));
        strictEqual(calls, 1);
    } finally {
        await close(server);
    }
});

// --- 3. writeHead(statusCode, statusMessage) preserves custom message ------

Deno.test({ name: 'http: writeHead(statusCode, statusMessage) preserves custom statusMessage', timeout: 10000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, 'Custom OK');
        res.end();
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const r = await get(`http://127.0.0.1:${addr.port}/`);
        strictEqual(r.status, 200);
        strictEqual(r.statusMessage, 'Custom OK');
    } finally {
        await close(server);
    }
});

// --- 4. flushHeaders() sends headers early; body still follows -------------

Deno.test({ name: 'http: flushHeaders() sends headers before body', timeout: 10000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.setHeader('x-early', '1');
        res.flushHeaders();
        res.end('after-flush');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const r = await get(`http://127.0.0.1:${addr.port}/`);
        strictEqual(r.body, 'after-flush');
    } finally {
        await close(server);
    }
});

// --- 5. writeEarlyHints callback fires (no-op path) ------------------------

Deno.test({ name: 'http: writeEarlyHints invokes callback', timeout: 10000 }, async () => {
    let fired = false;
    const server = http.createServer((_req, res) => {
        res.writeEarlyHints({ link: '</style.css>; rel=preload' }, () => { fired = true; });
        res.end('x');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        await get(`http://127.0.0.1:${addr.port}/`);
        await new Promise((r) => setTimeout(r, 50));
        ok(fired, 'writeEarlyHints callback must fire');
    } finally {
        await close(server);
    }
});

// --- 6. res.end after end: callback fires, no double-finish -----------------

Deno.test({ name: 'http: second res.end only invokes its own callback, no crash', timeout: 10000 }, async () => {
    let first = 0;
    let second = 0;
    const server = http.createServer((_req, res) => {
        res.end('a', () => { first++; });
        res.end('b', () => { second++; });
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        await get(`http://127.0.0.1:${addr.port}/`);
        await new Promise((r) => setTimeout(r, 50));
        strictEqual(first, 1, 'first end callback fires once');
        strictEqual(second, 1, 'second end callback fires once (no-op path)');
    } finally {
        await close(server);
    }
});

// --- 7. HEAD response has no body but headers are sent ----------------------

Deno.test({ name: 'http: HEAD request returns headers with empty body', timeout: 10000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.setHeader('content-type', 'text/plain');
        res.setHeader('x-custom', 'yes');
        res.end('should-not-appear-in-head');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const result = await new Promise<{ ct: string | undefined; body: string }>((resolve, reject) => {
            const req = http.request(`http://127.0.0.1:${addr.port}/`, { method: 'HEAD' }, (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => resolve({ ct: res.headers['content-type'] as string, body }));
            });
            req.once('error', reject);
            req.end();
        });
        strictEqual(result.ct, 'text/plain');
        strictEqual(result.body, '', 'HEAD response body must be empty');
    } finally {
        await close(server);
    }
});

// --- 8. removeHeader before writeHead drops the header ---------------------

Deno.test({ name: 'http: removeHeader before writeHead drops the header', timeout: 10000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.setHeader('x-drop', '1');
        res.removeHeader('x-drop');
        res.end('ok');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const result = await new Promise<string | undefined>((resolve, reject) => {
            http.get(`http://127.0.0.1:${addr.port}/`, (res) => {
                res.on('data', () => {});
                res.on('end', () => resolve(res.headers['x-drop'] as string | undefined));
            }).once('error', reject);
        });
        strictEqual(result, undefined, 'removed header must not be sent');
    } finally {
        await close(server);
    }
});

// --- 9. client abort mid-body: no server 'error', no unhandled rejection ---

Deno.test({
    name: 'http: client abort mid-response does not emit server error',
    timeout: 10000,
}, async () => {
    const serverErrors: unknown[] = [];
    let writeStarted: () => void;
    const writeGate = new Promise<void>((r) => { writeStarted = r; });

    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' });
        // Keep writing until the peer leaves (Vite HMR style streaming).
        const tick = () => {
            if (res.writableEnded) return;
            res.write('x'.repeat(16 * 1024), (err) => {
                if (err) return;
                writeStarted();
                setTimeout(tick, 0);
            });
        };
        tick();
    });
    server.on('error', (err) => { serverErrors.push(err); });

    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        await new Promise<void>((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${addr.port}/`, (res) => {
                res.once('data', () => {
                    // Drop the client as soon as the first chunk arrives.
                    req.destroy();
                    resolve();
                });
            });
            req.once('error', () => resolve());
            setTimeout(() => reject(new Error('client abort timeout')), 5000);
        });

        // Let the server drain the EPIPE / close path.
        await writeGate;
        await new Promise((r) => setTimeout(r, 100));

        strictEqual(serverErrors.length, 0, `server must not emit disconnect as error: ${serverErrors}`);
    } finally {
        await close(server);
    }
});

// --- 10. req.socket is HTTP-owned: address ok, write rejected, no dual I/O ---

Deno.test({
    name: 'http: req.socket is facade with address and no dual-write',
    timeout: 10000,
}, async () => {
    let socketLocalPort = 0;
    let writeCode: string | undefined;
    let writeDone: () => void;
    const writeGate = new Promise<void>((r) => { writeDone = r; });

    const server = http.createServer((req, res) => {
        const sock = req.socket;
        ok(sock, 'req.socket must exist');
        const addr = sock.address();
        if (addr && typeof addr === 'object' && 'port' in addr) {
            socketLocalPort = addr.port;
        }
        // Absorb socket 'error' so the dual-write fault is not unhandled.
        sock.once('error', () => {});
        // Core owns the wire — app write must fail with a structured code.
        sock.write('hijack', (err) => {
            writeCode = err && typeof err === 'object' && 'code' in err
                ? String(Reflect.get(err, 'code'))
                : undefined;
            writeDone();
        });
        res.end('ok');
    });

    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const result = await get(`http://127.0.0.1:${addr.port}/`);
        strictEqual(result.status, 200);
        strictEqual(result.body, 'ok');
        await writeGate;
        ok(socketLocalPort > 0, 'facade address() must report local port');
        strictEqual(writeCode, 'ERR_SOCKET_HTTP_SERVER');
    } finally {
        await close(server);
    }
});

// --- 11. closeAllConnections tears down active clients ---

Deno.test({
    name: 'http: closeAllConnections aborts active keep-alive client',
    timeout: 10000,
}, async () => {
    let server: http.Server;
    const gotRequest = new Promise<void>((resolve) => {
        server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'keep-alive' });
            res.end('alive');
            resolve();
        });
    });

    await listen(server!);
    try {
        const addr = server!.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const net = await import('node:net');
        const sock = net.connect(addr.port, '127.0.0.1');
        const closed = new Promise<void>((resolve) => {
            sock.once('close', () => resolve());
            sock.once('error', () => resolve());
        });
        await new Promise<void>((resolve, reject) => {
            sock.once('connect', () => {
                sock.write('GET / HTTP/1.1\r\nHost: h\r\nConnection: keep-alive\r\n\r\n');
                resolve();
            });
            sock.once('error', reject);
        });
        await gotRequest;
        // Drain one response so the connection is tracked and idle keep-alive.
        await new Promise<void>((resolve) => {
            sock.once('data', () => resolve());
        });

        server!.closeAllConnections();
        await Promise.race([
            closed,
            new Promise((_, reject) => setTimeout(() => reject(new Error('closeAllConnections timeout')), 3000)),
        ]);
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'http: short-lived core connections release Node socket facades', timeout: 30000 }, async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        for (let i = 0; i < 250; i++) {
            await new Promise<void>((resolve, reject) => {
                const req = http.get({
                    host: '127.0.0.1',
                    port: addr.port,
                    path: `/?i=${i}`,
                    agent: false,
                    headers: { connection: 'close' },
                }, (res) => {
                    res.resume();
                    res.once('end', resolve);
                });
                req.once('error', reject);
            });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        const tracked = Reflect.get(server, '_httpConnections') as Set<unknown>;
        strictEqual(tracked.size, 0, 'all short-lived HTTP socket facades must be released');
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'http: keep-alive reuses one facade and releases it at terminal close', timeout: 15000 }, async () => {
    const sockets = new Set<unknown>();
    const server = http.createServer((req, res) => {
        sockets.add(req.socket);
        res.end('ok');
    });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const request = () => new Promise<void>((resolve, reject) => {
            const req = http.get({ host: '127.0.0.1', port: addr.port, agent }, (res) => {
                res.resume();
                res.once('end', resolve);
            });
            req.once('error', reject);
        });
        await request();
        await request();
        strictEqual(sockets.size, 1, 'keep-alive requests must share one Node facade');
        strictEqual((Reflect.get(server, '_httpConnections') as Set<unknown>).size, 1);
        agent.destroy();
        await new Promise((resolve) => setTimeout(resolve, 100));
        strictEqual((Reflect.get(server, '_httpConnections') as Set<unknown>).size, 0);
    } finally {
        agent.destroy();
        await close(server);
    }
});

// --- 12. client closes mid-request-body: coded EOF, no server 'error' ---

Deno.test({
    name: 'http: client abort mid-request-body does not emit server error',
    timeout: 10000,
}, async () => {
    const serverErrors: unknown[] = [];
    let bodyError: unknown;
    let bodyDone: () => void;
    const bodyGate = new Promise<void>((r) => { bodyDone = r; });

    const server = http.createServer(async (req, res) => {
        try {
            for await (const _ of req) { /* drain until peer leaves */ }
        } catch (err) {
            bodyError = err;
        } finally {
            bodyDone();
        }
        if (!res.headersSent) res.writeHead(200);
        res.end('ok');
    });
    server.on('error', (err) => { serverErrors.push(err); });

    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        // Open a raw TCP client: partial Content-Length body, then RST/FIN.
        const net = await import('node:net');
        await new Promise<void>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1', () => {
                sock.write(
                    'POST /upload HTTP/1.1\r\n' +
                    'Host: 127.0.0.1\r\n' +
                    'Content-Length: 100\r\n' +
                    '\r\n' +
                    'partial',
                );
                // Peer gone before the rest of the body arrives.
                setTimeout(() => {
                    sock.destroy();
                    resolve();
                }, 30);
            });
            sock.once('error', () => resolve());
            setTimeout(() => reject(new Error('mid-body abort timeout')), 5000);
        });

        await bodyGate;
        await new Promise((r) => setTimeout(r, 50));

        strictEqual(serverErrors.length, 0, `server must not emit body-EOF as error: ${serverErrors}`);
        // Peer left mid-body: stream ends quietly (aborted/complete). A throw is ok
        // only when it carries a structured disconnect code — never a bare message.
        if (bodyError !== undefined) {
            const code = bodyError instanceof Error
                ? Reflect.get(bodyError, 'code')
                : undefined;
            ok(
                code === 'EOF' || code === 'ECONNRESET' || code === 'EPIPE' ||
                code === 'ECONNABORTED' || typeof code === 'number',
                `body error must carry structured code, got ${String(bodyError)} code=${String(code)}`,
            );
        }
    } finally {
        await close(server);
    }
});
