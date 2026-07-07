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

Deno.test({ name: 'http upstream: Agent keepAlive reuses sockets and tracks free pool', timeout: 10000 }, async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    const server = http.createServer((_req, res) => {
        res.end('ok');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const name = `127.0.0.1:${addr.port}:`;
        const makeRequest = (path: string) => new Promise<boolean>((resolve, reject) => {
            const req = http.get({
                host: '127.0.0.1',
                port: addr.port,
                path,
                agent,
            }, (res) => {
                const reusedSocket = req.reusedSocket;
                res.resume();
                res.on('end', () => resolve(reusedSocket));
            });
            req.on('error', reject);
        });
        const waitForFreeSocket = () => new Promise((resolve) => setTimeout(resolve, 10));

        strictEqual(await makeRequest('/first'), false);
        await waitForFreeSocket();
        strictEqual(agent.freeSockets[name]?.length, 1);

        strictEqual(await makeRequest('/second'), true);
        await waitForFreeSocket();
        strictEqual(agent.freeSockets[name]?.length, 1);

        strictEqual(await makeRequest('/third'), true);
    } finally {
        agent.destroy();
        await close(server);
    }
});

Deno.test({ name: 'http upstream: Agent keepAlive stale idle sockets do not fail next request', timeout: 10000 }, async () => {
    let requestCount = 0;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const server = net.createServer((socket) => {
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => socket.destroy(), 50);
        };

        socket.on('data', () => {
            requestCount++;
            const body = `request ${requestCount}`;
            socket.write([
                'HTTP/1.1 200 OK',
                `Content-Length: ${body.length}`,
                'Connection: keep-alive',
                '',
                body,
            ].join('\r\n'));
            resetIdle();
        });
        socket.on('close', () => {
            if (idleTimer) clearTimeout(idleTimer);
        });
    });

    await tcpListen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const makeRequest = (path: string) => new Promise<string>((resolve, reject) => {
            const req = http.get({
                host: '127.0.0.1',
                port: addr.port,
                path,
                agent,
            }, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    body += chunk;
                });
                res.on('end', () => resolve(body));
            });
            req.on('error', reject);
        });

        strictEqual(await makeRequest('/first'), 'request 1');
        await new Promise((resolve) => setTimeout(resolve, 150));
        strictEqual(await makeRequest('/second'), 'request 2');
        strictEqual(await makeRequest('/third'), 'request 3');
    } finally {
        agent.destroy();
        await tcpClose(server);
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

Deno.test({ name: 'http: client parser preserves split response header fields and values', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => {
        socket.once('data', () => {
            socket.write('HTTP/1.1 200 OK\r\nX-Cus');
            setTimeout(() => {
                socket.write('tom-Header: value-');
                setTimeout(() => {
                    socket.end('one\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
                }, 10);
            }, 10);
        });
    });
    await tcpListen(server);

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const result = await new Promise<{ body: string; header: unknown; rawHeaders: string[] }>((resolve, reject) => {
            http.get(`http://127.0.0.1:${addr.port}/`, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    body += chunk;
                });
                res.on('end', () => {
                    resolve({
                        body,
                        header: res.headers['x-custom-header'],
                        rawHeaders: res.rawHeaders,
                    });
                });
            }).once('error', reject);
        });

        strictEqual(result.body, 'ok');
        strictEqual(result.header, 'value-one');
        const headerIndex = result.rawHeaders.indexOf('X-Custom-Header');
        ok(headerIndex !== -1 && headerIndex % 2 === 0, 'rawHeaders must keep original split response header name');
        strictEqual(result.rawHeaders[headerIndex + 1], 'value-one');
    } finally {
        await tcpClose(server);
    }
});

Deno.test({ name: 'http: client accepts close-delimited response body', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => {
        socket.once('data', () => {
            socket.write('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nclose-body', () => socket.destroy());
        });
    });
    await tcpListen(server);

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const result = await httpGet(`http://127.0.0.1:${addr.port}/`);
        strictEqual(result.status, 200);
        strictEqual(result.body, 'close-body');
    } finally {
        await tcpClose(server);
    }
});

Deno.test({ name: 'http: client marks response complete before end event', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => {
        socket.once('data', (data) => {
            const request = data.toString();
            const isHead = request.startsWith('HEAD ');
            const isNoContent = request.includes(' /empty ');
            if (isNoContent) {
                socket.end('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            } else if (isHead) {
                socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n');
            } else {
                socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
            }
        });
    });
    await tcpListen(server);

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const check = (method: string, path = '/'): Promise<boolean> => new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port: addr.port,
                method,
                path,
            }, (res) => {
                res.resume();
                res.on('end', () => resolve(res.complete));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.end();
        });

        strictEqual(await check('GET'), true);
        strictEqual(await check('HEAD'), true);
        strictEqual(await check('GET', '/empty'), true);
    } finally {
        await tcpClose(server);
    }
});

Deno.test({ name: 'http: client reports truncated content-length response', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => {
        socket.once('data', () => {
            socket.write('HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabc', () => socket.destroy());
        });
    });
    await tcpListen(server);

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${addr.port}/`, (res) => {
                res.resume();
                res.once('error', (err: NodeJS.ErrnoException) => resolve(err));
                res.once('end', () => reject(new Error('truncated response must not end normally')));
            });
            req.once('error', (err: NodeJS.ErrnoException) => resolve(err));
            setTimeout(() => reject(new Error('truncated response did not fail')), 3000);
        });

        strictEqual(error.code, 'ECONNRESET');
        ok(/HTTP parse error/i.test(error.message), `expected parse error, got: ${error.message}`);
        ok(/EOF|invalid|content/i.test(error.message), `expected EOF/detail in error, got: ${error.message}`);
    } finally {
        await tcpClose(server);
    }
});

Deno.test({ name: 'http: client treats 1xx as information before final response', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => {
        socket.once('data', () => {
            socket.write(
                'HTTP/1.1 100 Continue\r\nX-Info: yes\r\n\r\n' +
                'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok',
                () => socket.destroy(),
            );
        });
    });
    await tcpListen(server);

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const result = await new Promise<{ body: string; info: any[]; continued: number; statuses: number[] }>((resolve, reject) => {
            const info: any[] = [];
            const statuses: number[] = [];
            let continued = 0;
            const req = http.get(`http://127.0.0.1:${addr.port}/`, (res) => {
                statuses.push(res.statusCode ?? 0);
                if (res.statusCode !== 200) {
                    reject(new Error(`unexpected final response status: ${res.statusCode}`));
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    body += chunk;
                });
                res.on('end', () => resolve({ body, info, continued, statuses }));
                res.on('error', reject);
            });
            req.on('information', (item) => info.push(item));
            req.on('continue', () => {
                continued++;
            });
            req.on('error', reject);
        });

        strictEqual(result.body, 'ok');
        strictEqual(result.continued, 1);
        strictEqual(result.statuses.length, 1);
        strictEqual(result.statuses[0], 200);
        strictEqual(result.info.length, 1);
        strictEqual(result.info[0].statusCode, 100);
        strictEqual(result.info[0].headers['x-info'], 'yes');
    } finally {
        await tcpClose(server);
    }
});

Deno.test({ name: 'http: client parser preserves response trailers', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => {
        socket.once('data', () => {
            socket.write(
                'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n' +
                '2\r\nok\r\n0\r\nX-Trail',
            );
            setTimeout(() => {
                socket.write('er: tail-');
                setTimeout(() => {
                    socket.write('value\r\n\r\n', () => socket.destroy());
                }, 10);
            }, 10);
        });
    });
    await tcpListen(server);

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const result = await new Promise<{ body: string; trailer: unknown; rawTrailers: string[]; distinct: unknown }>((resolve, reject) => {
            http.get(`http://127.0.0.1:${addr.port}/`, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    body += chunk;
                });
                res.on('end', () => resolve({
                    body,
                    trailer: res.trailers['x-trailer'],
                    rawTrailers: res.rawTrailers,
                    distinct: res.trailersDistinct?.['x-trailer'],
                }));
                res.on('error', reject);
            }).once('error', reject);
        });

        strictEqual(result.body, 'ok');
        strictEqual(result.trailer, 'tail-value');
        const trailerIndex = result.rawTrailers.indexOf('X-Trailer');
        ok(trailerIndex !== -1 && trailerIndex % 2 === 0, 'rawTrailers must keep original split trailer name');
        strictEqual(result.rawTrailers[trailerIndex + 1], 'tail-value');
        ok(Array.isArray(result.distinct), 'trailersDistinct must collect trailer values');
        strictEqual((result.distinct as string[])[0], 'tail-value');
    } finally {
        await tcpClose(server);
    }
});

// --- http: client 101 upgrade keeps socket + leftover head -----------------

Deno.test({ name: 'http: client emits upgrade for 101 response with head', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => {
        socket.once('data', () => {
            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\n' +
                'Connection: Upgrade\r\n' +
                'Upgrade: websocket\r\n' +
                '\r\n' +
                'HELLO',
            );
            socket.once('data', (data) => {
                socket.end(`echo:${data.toString()}`);
            });
        });
    });
    await tcpListen(server);

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const result = await new Promise<{ status: number; upgradeHeader: unknown; head: string; echo: string }>((resolve, reject) => {
            let upgraded = false;
            let status = 0;
            let upgradeHeader: unknown;
            let headText = '';
            let echo = '';
            const timeoutId = setTimeout(() => {
                reject(new Error(upgraded ? 'upgraded socket timed out' : 'upgrade response timed out'));
            }, 3000);
            const req = http.request({
                host: '127.0.0.1',
                port: addr.port,
                path: '/',
                headers: {
                    Connection: 'Upgrade',
                    Upgrade: 'websocket',
                },
            });
            req.on('response', () => {
                clearTimeout(timeoutId);
                reject(new Error('101 upgrade must not emit response'));
            });
            req.on('upgrade', (res, socket, head) => {
                upgraded = true;
                status = res.statusCode ?? 0;
                upgradeHeader = res.headers.upgrade;
                ok(Buffer.isBuffer(head), 'upgrade head must be a Buffer');
                headText = Buffer.from(head).toString();
                socket.on('data', (chunk: Uint8Array) => {
                    echo += Buffer.from(chunk).toString();
                });
                socket.on('close', () => {
                    clearTimeout(timeoutId);
                    resolve({ status, upgradeHeader, head: headText, echo });
                });
                socket.on('error', reject);
                socket.write('ping');
            });
            req.on('error', (err) => {
                clearTimeout(timeoutId);
                reject(err);
            });
            req.end();
        });

        strictEqual(result.status, 101);
        strictEqual(result.upgradeHeader, 'websocket');
        strictEqual(result.head, 'HELLO');
        strictEqual(result.echo, 'echo:ping');
    } finally {
        await tcpClose(server);
    }
});

// --- http: client CONNECT keeps socket + leftover head ---------------------

Deno.test({ name: 'http: client emits connect for CONNECT response with head', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => {
        socket.once('data', () => {
            socket.write('HTTP/1.1 200 Connection');
            setTimeout(() => {
                socket.write(' Established\r\nProxy-Agent: cno\r\n\r');
                setTimeout(() => {
                    socket.write('\nTUNNEL');
                    socket.once('data', (data) => {
                        socket.end(`echo:${data.toString()}`);
                    });
                }, 10);
            }, 10);
        });
    });
    await tcpListen(server);

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const result = await new Promise<{ status: number; proxyAgent: unknown; head: string; echo: string }>((resolve, reject) => {
            let connected = false;
            let status = 0;
            let proxyAgent: unknown;
            let headText = '';
            let echo = '';
            const timeoutId = setTimeout(() => {
                reject(new Error(connected ? 'connected socket timed out' : 'connect response timed out'));
            }, 3000);
            const req = http.request({
                host: '127.0.0.1',
                port: addr.port,
                method: 'CONNECT',
                path: 'example.com:443',
            });
            req.on('response', () => {
                clearTimeout(timeoutId);
                reject(new Error('CONNECT response must not emit response'));
            });
            req.on('connect', (res, socket, head) => {
                connected = true;
                status = res.statusCode ?? 0;
                proxyAgent = res.headers['proxy-agent'];
                ok(Buffer.isBuffer(head), 'connect head must be a Buffer');
                headText = Buffer.from(head).toString();
                socket.on('data', (chunk: Uint8Array) => {
                    echo += Buffer.from(chunk).toString();
                });
                socket.on('close', () => {
                    clearTimeout(timeoutId);
                    resolve({ status, proxyAgent, head: headText, echo });
                });
                socket.on('error', reject);
                socket.write('ping');
            });
            req.on('error', (err) => {
                clearTimeout(timeoutId);
                reject(err);
            });
            req.end();
        });

        strictEqual(result.status, 200);
        strictEqual(result.proxyAgent, 'cno');
        strictEqual(result.head, 'TUNNEL');
        strictEqual(result.echo, 'echo:ping');
    } finally {
        await tcpClose(server);
    }
});

Deno.test({ name: 'http: client CONNECT treats first 1xx response as tunnel head boundary', timeout: 10000 }, async () => {
    const server = net.createServer((socket) => {
        socket.once('data', () => {
            socket.write(
                'HTTP/1.1 100 Continue\r\nX-Info: yes\r\n\r\n' +
                'HTTP/1.1 200 Connection Established\r\nProxy-Agent: cno\r\n\r\nTUNNEL',
            );
            socket.once('data', (data) => {
                socket.end(`echo:${data.toString()}`);
            });
        });
    });
    await tcpListen(server);

    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const result = await new Promise<{ status: number; head: string; echo: string; infoCount: number }>((resolve, reject) => {
            let connected = false;
            let status = 0;
            let headText = '';
            let echo = '';
            let infoCount = 0;
            const timeoutId = setTimeout(() => {
                reject(new Error(connected ? 'connected socket timed out' : 'connect response timed out'));
            }, 3000);
            const req = http.request({
                host: '127.0.0.1',
                port: addr.port,
                method: 'CONNECT',
                path: 'example.com:443',
            });
            req.on('information', () => {
                infoCount++;
            });
            req.on('response', () => {
                clearTimeout(timeoutId);
                reject(new Error('CONNECT response must not emit response'));
            });
            req.on('connect', (res, socket, head) => {
                connected = true;
                status = res.statusCode ?? 0;
                ok(Buffer.isBuffer(head), 'connect head must be a Buffer');
                headText = Buffer.from(head).toString();
                socket.on('data', (chunk: Uint8Array) => {
                    echo += Buffer.from(chunk).toString();
                });
                socket.on('close', () => {
                    clearTimeout(timeoutId);
                    resolve({ status, head: headText, echo, infoCount });
                });
                socket.on('error', reject);
                socket.write('ping');
            });
            req.on('error', (err) => {
                clearTimeout(timeoutId);
                reject(err);
            });
            req.end();
        });

        strictEqual(result.status, 100);
        strictEqual(result.infoCount, 0);
        ok(result.head.startsWith('HTTP/1.1 200 Connection Established'), 'final response must remain in tunnel head');
        ok(result.head.endsWith('TUNNEL'), 'tunnel bytes must remain in head');
        strictEqual(result.echo, 'echo:ping');
    } finally {
        await tcpClose(server);
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

    const refused = await new Promise<boolean>((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => {
            socket.destroy();
            resolve(false);
        });
        socket.once('error', () => resolve(true));
    });
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
