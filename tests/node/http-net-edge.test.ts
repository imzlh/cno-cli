import { strictEqual, ok, throws } from 'node:assert';
import * as http from 'node:http';
import * as net from 'node:net';

// --- helpers ---------------------------------------------------------------

function listen(server: http.Server, port = 0, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
        server.listen(port, host, () => resolve());
        server.once('error', reject);
    });
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((err?: Error) => err ? reject(err) : resolve());
    });
}

function tcpListen(server: net.Server, port = 0, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
        server.listen(port, host, () => resolve());
        server.once('error', reject);
    });
}

function tcpClose(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

function httpGet(url: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => (body += c));
            res.on('end', () => {
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(res.headers)) {
                    if (typeof v === 'string') headers[k] = v;
                }
                resolve({ status: res.statusCode ?? 0, body, headers });
            });
        }).once('error', reject);
    });
}

// --- http: writeHead rejects further header mutation once sent --------------

Deno.test({ name: 'http: setHeader after writeHead throws headers-sent error', timeout: 10000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'x-first': '1' });
        let threw = false;
        try {
            res.setHeader('x-second', '2');
        } catch (e: any) {
            threw = true;
            ok(/header/i.test(e.message), `error message should mention headers, got: ${e.message}`);
        }
        ok(threw, 'setHeader after writeHead must throw');
        res.end();
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        await httpGet(`http://127.0.0.1:${addr.port}/`);
    } finally {
        await close(server);
    }
});

// --- http: writeHead with array-of-pairs headers ----------------------------

Deno.test({ name: 'http: writeHead accepts flat [k, v, k, v] header array', timeout: 10000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, ['x-a', '1', 'x-b', '2']);
        res.end('ok');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const r = await httpGet(`http://127.0.0.1:${addr.port}/`);
        strictEqual(r.body, 'ok');
        strictEqual(r.headers['x-a'], '1');
        strictEqual(r.headers['x-b'], '2');
    } finally {
        await close(server);
    }
});

// --- http: writeHead is idempotent on status; second call throws ------------

Deno.test({ name: 'http: second writeHead throws', timeout: 10000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.writeHead(200);
        let threw = false;
        try {
            res.writeHead(500);
        } catch {
            threw = true;
        }
        ok(threw, 'second writeHead must throw');
        res.end('still-200');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const r = await httpGet(`http://127.0.0.1:${addr.port}/`);
        strictEqual(r.status, 200);
        strictEqual(r.body, 'still-200');
    } finally {
        await close(server);
    }
});

// --- http: response.write after end throws ---------------------------------

Deno.test({ name: 'http: write after end invokes callback with error', timeout: 10000 }, async () => {
    const server = http.createServer(async (_req, res) => {
        const sawError = new Promise<void>((resolve, reject) => {
            res.once('error', (err: any) => {
                try {
                    strictEqual(err?.code, 'ERR_STREAM_WRITE_AFTER_END');
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
        res.end('done');
        const ok2 = res.write('more', (err?: Error | null) => {
            ok(err, 'write-after-end callback must receive an error');
            strictEqual((err as any)?.code, 'ERR_STREAM_WRITE_AFTER_END');
        });
        strictEqual(ok2, false, 'write after end returns false');
        await sawError;
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const r = await httpGet(`http://127.0.0.1:${addr.port}/`);
        strictEqual(r.body, 'done');
    } finally {
        await close(server);
    }
});

// --- http: socket identity + address fields --------------------------------

Deno.test({ name: 'http: req.socket === res.socket and carries address info', timeout: 10000 }, async () => {
    const server = http.createServer((req, res) => {
        strictEqual(req.socket, res.socket);
        const s = req.socket!;
        ok(typeof s.remoteAddress === 'string' && s.remoteAddress.length > 0);
        ok(typeof s.remotePort === 'number' && s.remotePort > 0);
        ok(typeof s.localAddress === 'string' && s.localAddress.length > 0);
        ok(typeof s.localPort === 'number' && s.localPort > 0);
        res.end('ok');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        strictEqual((await httpGet(`http://127.0.0.1:${addr.port}/`)).body, 'ok');
    } finally {
        await close(server);
    }
});

// --- http: chunked transfer for multiple writes -----------------------------

Deno.test({ name: 'http: multiple res.write yields chunked body', timeout: 10000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.write('hello');
        res.write(' ');
        res.write('world');
        res.end();
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const r = await httpGet(`http://127.0.0.1:${addr.port}/`);
        strictEqual(r.body, 'hello world');
    } finally {
        await close(server);
    }
});

// --- http: server 'close' fires only once, no request handler after close ---

Deno.test({ name: 'http: server.close callback fires and stops accepting', timeout: 10000 }, async () => {
    const server = http.createServer((_req, res) => res.end('x'));
    await listen(server);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const port = addr.port;

    let closed = false;
    await new Promise<void>((resolve) => server.close(() => { closed = true; resolve(); }));
    ok(closed, 'close callback fired');

    let refused = false;
    try {
        await httpGet(`http://127.0.0.1:${port}/`);
    } catch {
        refused = true;
    }
    ok(refused, 'connection must be refused after server closes');
});

// --- net: repeated resume() must not throw EALREADY -------------------------

Deno.test({ name: 'net: double resume() on a connected socket is idempotent', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => {
        socket.resume();
        socket.resume(); // must not throw
        socket.pipe(socket);
    });
    await tcpListen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const result = await new Promise<boolean>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1', () => {
                sock.resume();
                sock.resume();
                sock.write('ping');
            });
            let buf = '';
            sock.on('data', (d) => {
                buf += d.toString();
                if (buf === 'ping') {
                    sock.end();
                    resolve(true);
                }
            });
            sock.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });
        ok(result);
    } finally {
        await tcpClose(server);
    }
});

// --- net: server + client echo over TCP ------------------------------------

Deno.test({ name: 'net: TCP echo round-trip', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => socket.pipe(socket));
    await tcpListen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const echoed = await new Promise<string>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1');
            let buf = '';
            sock.on('data', (d) => {
                buf += d.toString();
                sock.end();
            });
            sock.on('close', () => resolve(buf));
            sock.on('error', reject);
            sock.write('hello-tcp');
        });
        strictEqual(echoed, 'hello-tcp');
    } finally {
        await tcpClose(server);
    }
});

// --- net: socket.setTimeout fires 'timeout' when idle ----------------------

Deno.test({ name: 'net: socket timeout fires on inactivity', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => {
        // deliberately never write; client has a timeout
    });
    await tcpListen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const timedOut = await new Promise<boolean>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1');
            sock.setTimeout(200, () => {
                sock.destroy();
                resolve(true);
            });
            sock.on('error', () => {}); // ignore ECONNRESET from destroy
            sock.on('close', () => resolve(false));
            setTimeout(() => reject(new Error('timeout did not fire')), 3000);
        });
        ok(timedOut, 'timeout event should fire');
    } finally {
        await tcpClose(server);
    }
});

// --- net: socket.address() returns bound info ------------------------------

Deno.test({ name: 'net: socket.address() reports local port after connect', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => socket.end());
    await tcpListen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const localPort = await new Promise<number>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1', () => {
                const a = sock.address();
                if (a && typeof a === 'object' && 'port' in a) resolve(a.port);
                else reject(new Error('no address'));
            });
            sock.on('error', reject);
        });
        ok(localPort > 0);
    } finally {
        await tcpClose(server);
    }
});

// --- STATUS_CODES + METHODS constants --------------------------------------

Deno.test({ name: 'http: STATUS_CODES and METHODS are populated', timeout: 10000 }, () => {
    ok(http.STATUS_CODES[200] === 'OK');
    ok(http.STATUS_CODES[404] === 'Not Found');
    ok(http.STATUS_CODES[500] === 'Internal Server Error');
    ok(Array.isArray(http.METHODS));
    ok(http.METHODS.includes('GET'));
    ok(http.METHODS.includes('POST'));
});
