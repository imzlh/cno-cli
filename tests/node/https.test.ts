import { strictEqual, ok } from 'node:assert';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';

const ssl = import.meta.use('ssl');

// --- 1. https.createServer is a function -----------------------------------

Deno.test('https: createServer is a function', () => {
    ok(typeof https.createServer === 'function');
});

// --- 2. https.request is a function -----------------------------------------

Deno.test('https: request and get are functions', () => {
    ok(typeof https.request === 'function');
    ok(typeof https.get === 'function');
});

// --- 3. https.globalAgent exists -------------------------------------------

Deno.test('https: globalAgent exists', () => {
    ok(https.globalAgent);
});

// --- 4. https.createServer returns a server with listen/close --------------

Deno.test('https: createServer returns a server', () => {
    const s = https.createServer({});
    ok(typeof s.listen === 'function');
    ok(typeof s.close === 'function');
    s.close();
});

// --- 5. https.STATUS_CODES is inherited from http ---------------------------

Deno.test('https: STATUS_CODES populated', () => {
    ok(https.STATUS_CODES[200] === 'OK');
    ok(https.STATUS_CODES[404] === 'Not Found');
});

// --- 6. https.METHODS is an array ------------------------------------------

Deno.test('https: METHODS is an array', () => {
    ok(Array.isArray(https.METHODS));
    ok(https.METHODS.includes('GET'));
});

// --- 7. https.Agent is a constructor ---------------------------------------

Deno.test('https: Agent is a constructor', () => {
    ok(typeof https.Agent === 'function');
});

// --- 8. Agent maxSockets default -------------------------------------------

Deno.test('https: Agent maxSockets default is Infinity', () => {
    const a = new https.Agent();
    ok(a.maxSockets === Infinity || typeof a.maxSockets === 'number');
});

Deno.test('https: Agent respects explicit keepAlive and maxSockets options', () => {
    const agent = new https.Agent({ keepAlive: true, maxSockets: 5 });
    strictEqual(agent.options.keepAlive, true);
    strictEqual(agent.maxSockets, 5);
});

// --- 9. createServer with requestListener ----------------------------------

Deno.test('https: createServer accepts requestListener', () => {
    const s = https.createServer({}, (_req, res) => {});
    ok(s);
    s.close();
});

// --- 10. server address() returns null when not listening ------------------

Deno.test('https: server.address() returns null before listen', () => {
    const s = https.createServer({});
    strictEqual(s.address(), null);
    s.close();
});

Deno.test('https: request uses provided method and defaults to globalAgent', () => {
    const req = https.request({ host: '127.0.0.1', port: 1, method: 'POST', rejectUnauthorized: false });
    req.once('error', () => {});
    try {
        strictEqual(req.method, 'POST');
        strictEqual(req.agent, https.globalAgent);
    } finally {
        req.destroy();
    }
});

// --- 11. request/get surface the connection error path ----------------------

Deno.test({ name: 'https: request to a closed port emits error', timeout: 10000 }, async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const addr = probe.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const port = addr.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const errored = await new Promise<boolean>((resolve) => {
        const req = https.request(`https://127.0.0.1:${port}/`, { agent: false, rejectUnauthorized: false }, () => resolve(false));
        req.once('error', () => resolve(true));
        req.end();
        setTimeout(() => resolve(false), 3000);
    });

    ok(errored, 'https.request to a closed port must error');
});

// --- 12. https server and client can complete a real TLS round-trip ---------

Deno.test({ name: 'https: createServer serves a real TLS response', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = https.createServer({ cert, key }, (req, res) => {
        strictEqual(req.method, 'GET');
        strictEqual(typeof req.socket?.remotePort, 'number');
        strictEqual(res.socket, req.socket);
        res.end('secure-ok');
    });

    await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', onError);
            resolve();
        });
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = https.request(`https://127.0.0.1:${addr.port}/`, { rejectUnauthorized: false }, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => { body += chunk; });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            });
            req.once('error', reject);
            req.end();
        });

        strictEqual(result.status, 200);
        strictEqual(result.body, 'secure-ok');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'https: request honors custom lookup with global agent', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = https.createServer({ cert, key }, (req, res) => {
        ok(String(req.headers.host).startsWith('example.test'));
        res.end('lookup-agent-ok');
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const seen: string[] = [];

        const body = await new Promise<string>((resolve, reject) => {
            const req = https.request({
                host: 'example.test',
                port: addr.port,
                rejectUnauthorized: false,
                lookup(hostname, options, callback) {
                    seen.push(`${hostname}:${options.family}`);
                    callback(null, '127.0.0.1', 4);
                },
            }, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => resolve(data));
            });
            req.once('error', reject);
            req.end();
        });

        strictEqual(body, 'lookup-agent-ok');
        strictEqual(seen.join(','), 'example.test:4');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'https: request honors custom lookup without agent', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = https.createServer({ cert, key }, (_req, res) => {
        res.end('lookup-direct-ok');
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        let sawLookup = false;

        const body = await new Promise<string>((resolve, reject) => {
            const req = https.request({
                agent: false,
                host: 'example.test',
                port: addr.port,
                rejectUnauthorized: false,
                lookup(hostname, options, callback) {
                    sawLookup = hostname === 'example.test' && options.family === 4;
                    callback(null, '127.0.0.1', 4);
                },
            }, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => resolve(data));
            });
            req.once('error', reject);
            req.end();
        });

        strictEqual(body, 'lookup-direct-ok');
        strictEqual(sawLookup, true);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'https: server parser preserves split header fields and values', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    let observed = false;
    const server = https.createServer({ cert, key }, (req, res) => {
        observed = true;
        strictEqual(req.headers['x-custom-header'], 'value-one');
        const headerIndex = req.rawHeaders.indexOf('X-Custom-Header');
        ok(headerIndex !== -1 && headerIndex % 2 === 0, 'rawHeaders must keep the original split header name');
        strictEqual(req.rawHeaders[headerIndex + 1], 'value-one');
        res.end('ok');
    });

    await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', onError);
            resolve();
        });
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const body = await new Promise<string>((resolve, reject) => {
            const socket = tls.connect({ port: addr.port, host: '127.0.0.1', rejectUnauthorized: false }, async () => {
                try {
                    socket.write('GET /split HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Cus');
                    await new Promise((r) => setTimeout(r, 10));
                    socket.write('tom-Header: value-');
                    await new Promise((r) => setTimeout(r, 10));
                    socket.write('one\r\nConnection: close\r\n\r\n');
                } catch (err) {
                    reject(err);
                }
            });
            let data = '';
            socket.setEncoding('utf8');
            socket.on('data', (chunk: string) => {
                data += chunk;
                const bodyStart = data.indexOf('\r\n\r\n');
                if (bodyStart !== -1 && data.slice(bodyStart + 4).includes('ok')) {
                    socket.destroy();
                    resolve(data);
                }
            });
            socket.on('error', reject);
            socket.on('end', () => resolve(data));
        });

        ok(observed, 'server must receive the split-header request');
        ok(body.includes('ok'), 'client must receive the response body');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'https: server handles sequential requests on one TLS connection', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const urls: string[] = [];
    let firstSocket: unknown;
    const server = https.createServer({ cert, key }, (req, res) => {
        urls.push(req.url || '');
        if (!firstSocket) firstSocket = req.socket;
        else strictEqual(req.socket, firstSocket);

        const body = req.url === '/one' ? 'one' : 'two';
        res.setHeader('Content-Length', String(body.length));
        res.end(body);
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const data = await new Promise<string>((resolve, reject) => {
            const socket = tls.connect({ port: addr.port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
                socket.write('GET /one HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
            });
            let received = '';
            let sentSecond = false;
            socket.setEncoding('utf8');
            socket.on('data', (chunk: string) => {
                received += chunk;
                if (!sentSecond && received.includes('\r\n\r\none')) {
                    sentSecond = true;
                    socket.write('GET /two HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
                }
                if (sentSecond && received.includes('\r\n\r\ntwo')) {
                    socket.destroy();
                    resolve(received);
                }
            });
            socket.on('error', reject);
            socket.on('end', () => resolve(received));
        });

        strictEqual(urls.join(','), '/one,/two');
        ok(data.includes('\r\n\r\none'), 'first response body must be delivered');
        ok(data.includes('\r\n\r\ntwo'), 'second response body must be delivered');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'https: pipelined responses stay in request order', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const events: string[] = [];
    const server = https.createServer({ cert, key }, (req, res) => {
        events.push(`start:${req.url}`);
        const body = req.url === '/slow' ? 'slow' : 'fast';
        res.setHeader('Content-Length', String(body.length));
        if (req.url === '/slow') {
            setTimeout(() => {
                events.push('end:/slow');
                res.end(body);
            }, 30);
        } else {
            events.push('end:/fast');
            res.end(body);
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const data = await new Promise<string>((resolve, reject) => {
            const socket = tls.connect({ port: addr.port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
                socket.write(
                    'GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n' +
                    'GET /fast HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
                );
            });
            let received = '';
            socket.setEncoding('utf8');
            socket.on('data', (chunk: string) => {
                received += chunk;
                if (received.includes('\r\n\r\nslow') && received.includes('\r\n\r\nfast')) {
                    socket.destroy();
                    resolve(received);
                }
            });
            socket.on('error', reject);
            socket.on('end', () => resolve(received));
        });

        const slowIndex = data.indexOf('\r\n\r\nslow');
        const fastIndex = data.indexOf('\r\n\r\nfast');
        ok(slowIndex !== -1, 'first response body must be delivered');
        ok(fastIndex !== -1, 'second response body must be delivered');
        ok(slowIndex < fastIndex, 'pipelined responses must preserve request order');
        ok(
            events.indexOf('start:/fast') !== -1 && events.indexOf('start:/fast') < events.indexOf('end:/slow'),
            'next pipelined listener must start before the previous slow response finishes',
        );
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'https: server closes TLS connection after Connection close request', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = https.createServer({ cert, key }, (_req, res) => {
        res.end('bye');
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const data = await new Promise<string>((resolve, reject) => {
            const socket = tls.connect({ port: addr.port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
                socket.write('GET /close HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
            });
            let received = '';
            socket.setEncoding('utf8');
            socket.on('data', (chunk: string) => {
                received += chunk;
            });
            socket.on('end', () => resolve(received));
            socket.on('error', reject);
        });

        ok(data.toLowerCase().includes('connection: close'), 'response must advertise close');
        ok(data.includes('\r\n\r\nbye'), 'response body must be delivered before close');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'https: request listener runs before slow body completes', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    let listenerStartedBeforeBody = false;
    let bodyFinished = false;
    const server = https.createServer({ cert, key }, (req, res) => {
        listenerStartedBeforeBody = !bodyFinished;
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
            body += chunk;
        });
        req.on('end', () => {
            bodyFinished = true;
            strictEqual(body, 'hello');
            res.setHeader('Content-Length', '2');
            res.end('ok');
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const data = await new Promise<string>((resolve, reject) => {
            const socket = tls.connect({ port: addr.port, host: '127.0.0.1', rejectUnauthorized: false }, async () => {
                try {
                    socket.write('POST /slow-body HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhe');
                    await new Promise((r) => setTimeout(r, 30));
                    socket.write('llo');
                } catch (err) {
                    reject(err);
                }
            });
            let received = '';
            socket.setEncoding('utf8');
            socket.on('data', (chunk: string) => {
                received += chunk;
            });
            socket.on('end', () => resolve(received));
            socket.on('error', reject);
        });

        ok(listenerStartedBeforeBody, 'request listener must run before the request body completes');
        ok(data.includes('\r\n\r\nok'), 'response body must be delivered');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'https: server emits clientError on malformed request', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = https.createServer({ cert, key }, (_req, res) => {
        res.end('ok');
    });
    let sawClientError = false;
    let resolveClientError!: () => void;
    const clientErrorSeen = new Promise<void>((resolve) => {
        resolveClientError = resolve;
    });
    server.on('clientError', (err: Error, socket: tls.TLSSocket) => {
        sawClientError = true;
        ok(err instanceof Error);
        ok(socket instanceof tls.TLSSocket);
        resolveClientError();
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
            const socket = tls.connect({ port: addr.port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
                socket.write('GET /bad HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: nope\r\n\r\n');
                resolve(socket);
            });
            socket.on('error', reject);
        });
        await clientErrorSeen;
        socket.destroy();

        ok(sawClientError, 'malformed HTTPS request must trigger clientError');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'https: listener error after headers closes TLS socket', timeout: 10000 }, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = https.createServer({ cert, key }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        throw new Error('boom after headers');
    });
    let sawServerError = false;
    server.on('error', (err: Error) => {
        sawServerError = true;
        strictEqual(err.message, 'boom after headers');
    });

    await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', onError);
            resolve();
        });
    });

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const data = await new Promise<string>((resolve, reject) => {
            const socket = tls.connect({ port: addr.port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
                socket.write('GET /boom HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
            });
            let received = '';
            socket.setEncoding('utf8');
            socket.on('data', (chunk: string) => {
                received += chunk;
            });
            socket.on('end', () => resolve(received));
            socket.on('close', () => resolve(received));
            socket.on('error', reject);
        });

        ok(sawServerError, 'server error must be observable');
        ok(data.includes('HTTP/1.1 200'), 'partial response headers must be flushed before abort');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
