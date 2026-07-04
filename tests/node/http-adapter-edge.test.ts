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
