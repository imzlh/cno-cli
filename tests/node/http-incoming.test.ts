import { strictEqual, ok } from 'node:assert';
import * as http from 'node:http';
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import * as net from 'node:net';

function listen(server: http.Server, port = 0, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
        server.listen(port, host, () => resolve());
        server.once('error', reject);
    });
}
function close(server: http.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

function sendRawHttpRequest(port: number, lines: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.end(lines.join('\r\n'));
        });
        let body = '';
        sock.setEncoding('utf8');
        sock.on('data', (chunk) => { body += chunk; });
        sock.once('error', reject);
        sock.once('close', () => resolve(body));
    });
}

// --- 1. rawHeaders preserves original casing and order -----------------------

Deno.test({ name: 'http: rawHeaders preserves original casing and order', timeout: 10000 }, async () => {
    const server = http.createServer((req, res) => {
        ok(Array.isArray(req.rawHeaders));
        const customIdx = req.rawHeaders.indexOf('X-Custom-Header');
        const secondIdx = req.rawHeaders.indexOf('x-second-header');
        ok(customIdx !== -1 && customIdx % 2 === 0, 'X-Custom-Header must appear as a key in rawHeaders');
        ok(secondIdx !== -1 && secondIdx % 2 === 0, 'x-second-header must appear as a key in rawHeaders');
        ok(customIdx < secondIdx, 'rawHeaders must preserve original header order');
        strictEqual(req.rawHeaders[customIdx + 1], 'value');
        strictEqual(req.rawHeaders[secondIdx + 1], 'two');
        res.end('ok');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        await sendRawHttpRequest(addr.port, [
            'GET / HTTP/1.1',
            'Host: 127.0.0.1',
            'X-Custom-Header: value',
            'x-second-header: two',
            'Connection: close',
            '',
            '',
        ]);
    } finally {
        await close(server);
    }
});

// --- 2. httpVersionMajor / httpVersionMinor split correctly ------------------

Deno.test({ name: 'http: httpVersionMajor and httpVersionMinor reflect request version', timeout: 10000 }, async () => {
    const server = http.createServer((req, res) => {
        ok(req.httpVersion === '1.0' || req.httpVersion === '1.1');
        strictEqual(req.httpVersionMajor, 1);
        ok(req.httpVersionMinor === 0 || req.httpVersionMinor === 1);
        res.end('ok');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        await new Promise<void>((resolve, reject) => {
            const req = http.request(`http://127.0.0.1:${addr.port}/`, (res) => {
                res.on('data', () => {}); res.on('end', () => resolve());
            });
            req.once('error', reject);
            req.end();
        });
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'http: requestTimeout zero disables first request timeout', timeout: 10000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.end('ok');
    });
    server.requestTimeout = 0;
    server.setTimeout(0);
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const body = await new Promise<string>((resolve, reject) => {
            let out = '';
            const req = http.request(`http://127.0.0.1:${addr.port}/`, (res) => {
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => { out += chunk; });
                res.on('end', () => resolve(out));
            });
            req.once('error', reject);
            req.end();
        });
        strictEqual(body, 'ok');
    } finally {
        await close(server);
    }
});

// --- 3. duplicate request headers collected into headersDistinct array ------

Deno.test({ name: 'http: duplicate request headers collected into headersDistinct', timeout: 10000 }, async () => {
    const server = http.createServer((req, res) => {
        const distinct = (req as typeof req & { headersDistinct?: Record<string, string | string[]> }).headersDistinct;
        ok(distinct, 'headersDistinct must exist');
        const multi = distinct['x-multi'];
        ok(Array.isArray(multi), `x-multi must be an array, got ${JSON.stringify(multi)}`);
        strictEqual(multi.length, 2);
        strictEqual(multi[0], 'one');
        strictEqual(multi[1], 'two');
        res.end('ok');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        await sendRawHttpRequest(addr.port, [
            'GET / HTTP/1.1',
            'Host: 127.0.0.1',
            'X-Multi: one',
            'X-Multi: two',
            'Connection: close',
            '',
            '',
        ]);
    } finally {
        await close(server);
    }
});

// --- 4. req.method and req.url reflect the request line ----------------------

Deno.test({ name: 'http: req.method and req.url reflect request line', timeout: 10000 }, async () => {
    const server = http.createServer((req, res) => {
        strictEqual(req.method, 'POST');
        strictEqual(req.url, '/path?q=1');
        res.end('ok');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        await new Promise<void>((resolve, reject) => {
            const req = http.request(`http://127.0.0.1:${addr.port}/path?q=1`, { method: 'POST' }, (res) => {
                res.on('data', () => {}); res.on('end', () => resolve());
            });
            req.once('error', reject);
            req.end();
        });
    } finally {
        await close(server);
    }
});

// --- 5. server emits 'upgrade' for Connection: Upgrade -----------------------

Deno.test({ name: 'http: server emits upgrade event on Connection: Upgrade', timeout: 10000 }, async () => {
    const server = http.createServer();
    let upgraded = false;
    server.on('upgrade', (req, socket, head) => {
        upgraded = true;
        ok(typeof req.url === 'string');
        ok(socket);
        ok(head instanceof Uint8Array);
        socket.destroy();
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        await sendRawHttpRequest(addr.port, [
            'GET / HTTP/1.1',
            'Host: 127.0.0.1',
            'Connection: Upgrade',
            'Upgrade: websocket',
            '',
            '',
        ]);
        await new Promise((r) => setTimeout(r, 50));
        ok(upgraded, 'server must emit upgrade event');
    } finally {
        await close(server);
    }
});

// --- 5b. server emits 'connect' for CONNECT tunnel ---------------------------

Deno.test({ name: 'http: server emits connect event on CONNECT request', timeout: 10000 }, async () => {
    const server = http.createServer();
    let connected = false;
    server.on('connect', (req, socket, head) => {
        connected = true;
        strictEqual(req.method, 'CONNECT');
        strictEqual(req.url, '127.0.0.1:443');
        ok(socket);
        ok(head instanceof Uint8Array);
        socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const response = await sendRawHttpRequest(addr.port, [
            'CONNECT 127.0.0.1:443 HTTP/1.1',
            'Host: 127.0.0.1:443',
            '',
            '',
        ]);
        ok(response.includes('200 Connection Established'));
        ok(connected, 'server must emit connect event');
    } finally {
        await close(server);
    }
});

// --- 6. req.complete is true after body stream ends --------------------------

Deno.test({ name: 'http: req.complete is true after body ends', timeout: 10000 }, async () => {
    const server = http.createServer((req, res) => {
        req.on('end', () => {
            ok(req.complete, 'req.complete must be true after body ends');
            res.end('ok');
        });
        req.resume();
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        await new Promise<void>((resolve, reject) => {
            const req = http.request(`http://127.0.0.1:${addr.port}/`, { method: 'POST' }, (res) => {
                res.on('data', () => {}); res.on('end', () => resolve());
            });
            req.once('error', reject);
            req.write('body');
            req.end();
        });
    } finally {
        await close(server);
    }
});

// --- 7. POST body is readable via data/end events ----------------------------

Deno.test({ name: 'http: POST body is readable via data/end events', timeout: 10000 }, async () => {
    const server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            strictEqual(body, 'request-body');
            res.end('ok');
        });
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        await new Promise<void>((resolve, reject) => {
            const req = http.request(`http://127.0.0.1:${addr.port}/`, { method: 'POST' }, (res) => {
                res.on('data', () => {}); res.on('end', () => resolve());
            });
            req.once('error', reject);
            req.write('request-body');
            req.end();
        });
    } finally {
        await close(server);
    }
});

// --- 8. server 'clientError' emits on malformed request ---------------------

Deno.test({ name: 'http: server emits clientError on malformed request', timeout: 10000 }, async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    let sawClientError = false;
    server.on('clientError', () => {
        sawClientError = true;
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        await new Promise<void>((resolve) => {
            const sock = (require('node:net') as typeof import('node:net')).connect(addr.port, '127.0.0.1', () => {
                sock.write('THIS IS NOT HTTP\r\n\r\n');
            });
            sock.on('error', () => {});
            sock.on('close', () => resolve());
            setTimeout(() => { sock.destroy(); resolve(); }, 1500);
        });
        await new Promise((r) => setTimeout(r, 50));
        ok(sawClientError, 'malformed request must trigger clientError');
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'http upstream: ServerResponse can send wrapped Web Response bodies', timeout: 10000 }, async () => {
    const GlobalResponse = globalThis.Response;
    const responseCache = Symbol('responseCache');
    const getResponseCache = Symbol('getResponseCache');

    const buildOutgoingHttpHeaders = (headers: Headers | HeadersInit | null | undefined): OutgoingHttpHeaders => {
        const out: OutgoingHttpHeaders = {};
        const source = headers instanceof Headers ? headers : new Headers(headers ?? undefined);
        const cookies: string[] = [];
        for (const [key, value] of source) {
            if (key === 'set-cookie') cookies.push(value);
            else out[key] = value;
        }
        if (cookies.length) out['set-cookie'] = cookies;
        out['content-type'] ??= 'text/plain; charset=UTF-8';
        return out;
    };

    class WrappedResponse {
        #body?: BodyInit | null;
        #init?: ResponseInit;

        constructor(body?: BodyInit | null, init?: ResponseInit) {
            this.#body = body;
            this.#init = init instanceof WrappedResponse
                ? (init as WrappedResponse).#init
                : init;
        }

        [getResponseCache](): Response {
            const self = this as WrappedResponse & Record<PropertyKey, unknown>;
            let cached = self[responseCache] as Response | undefined;
            if (!cached) {
                cached = new GlobalResponse(this.#body, this.#init);
                self[responseCache] = cached;
            }
            return cached;
        }
    }

    for (const key of ['body', 'bodyUsed', 'headers', 'ok', 'redirected', 'status', 'statusText', 'type', 'url'] as const) {
        Object.defineProperty(WrappedResponse.prototype, key, {
            get(this: WrappedResponse) {
                return this[getResponseCache]()[key];
            },
        });
    }
    for (const key of ['arrayBuffer', 'blob', 'clone', 'formData', 'json', 'text'] as const) {
        Object.defineProperty(WrappedResponse.prototype, key, {
            value(this: WrappedResponse) {
                const fn = this[getResponseCache]()[key] as () => unknown;
                return fn.call(this[getResponseCache]());
            },
        });
    }
    Object.setPrototypeOf(WrappedResponse, GlobalResponse);
    Object.setPrototypeOf(WrappedResponse.prototype, GlobalResponse.prototype);

    const previousResponse = globalThis.Response;
    Object.defineProperty(globalThis, 'Response', { value: WrappedResponse, configurable: true });
    const server = http.createServer(async (_req, res: ServerResponse) => {
        const response = new Response('Hello, world!');
        const headers = buildOutgoingHttpHeaders(response.headers);
        const body = await response.arrayBuffer();
        headers['content-length'] = body.byteLength;
        res.writeHead(response.status, headers);
        res.end(new Uint8Array(body));
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const response = await fetch(`http://127.0.0.1:${addr.port}`);
        strictEqual(response.status, 200);
        strictEqual(response.headers.get('content-type'), 'text/plain; charset=UTF-8');
        strictEqual(await response.text(), 'Hello, world!');
    } finally {
        Object.defineProperty(globalThis, 'Response', { value: previousResponse, configurable: true });
        await close(server);
    }
});
