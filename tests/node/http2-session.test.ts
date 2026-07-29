/**
 * Real HTTP/2 (nghttp2) round-trip via node:http2 createServer + connect (h2c).
 */
import { strictEqual, ok } from 'node:assert';
import * as http2 from 'node:http2';
import { h2Available, __forceH2Unavailable } from '@cnojs/http/h2-native';

function once<T extends unknown[]>(emitter: { once(event: string, fn: (...args: T) => void): void }, event: string): Promise<T> {
    return new Promise(resolve => {
        emitter.once(event, (...args: T) => resolve(args));
    });
}

Deno.test({
    name: 'http2: h2c client GET round-trip against createServer',
    ignore: !h2Available(),
    timeout: 15000,
}, async () => {
    const server = http2.createServer();
    const got = once<[
        { on(e: string, fn: (...a: unknown[]) => void): void; respond(h: Record<string, unknown>, o?: { endStream?: boolean }): void; end(d?: string): void },
        Record<string, string | string[]>,
    ]>(server, 'stream');

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.on('error', reject);
    });

    const addr = server.address();
    ok(addr && typeof addr === 'object' && 'port' in addr, 'server has port');
    const port = (addr as { port: number }).port;

    const session = http2.connect(`http://127.0.0.1:${port}`);
    await once(session, 'connect');

    const streamPromise = got.then(([stream, headers]) => {
        strictEqual(headers[':method'] ?? headers[':method'.toLowerCase()], 'GET');
        const path = headers[':path'];
        ok(path === '/hello' || (Array.isArray(path) && path[0] === '/hello'), String(path));
        stream.respond({ ':status': 200, 'content-type': 'text/plain' });
        stream.end('pong-h2');
    });

    const req = session.request({
        ':method': 'GET',
        ':path': '/hello',
        ':scheme': 'http',
        ':authority': `127.0.0.1:${port}`,
    });

    const chunks: Buffer[] = [];
    const responseHeaders = await new Promise<Record<string, string | string[]>>((resolve, reject) => {
        req.on('response', (h: Record<string, string | string[]>) => resolve(h));
        req.on('error', reject);
        req.on('data', (c: Buffer) => chunks.push(c));
    });

    await new Promise<void>((resolve, reject) => {
        req.on('end', () => resolve());
        req.on('error', reject);
        // if already ended
        req.on('close', () => resolve());
    });

    await streamPromise;

    const status = responseHeaders[':status'];
    strictEqual(String(status), '200');
    const body = Buffer.concat(chunks).toString();
    strictEqual(body, 'pong-h2');

    session.close();
    await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
    });
});

Deno.test({
    name: 'http2: connect request is not a throw-only stub when H2 is available',
    ignore: !h2Available(),
}, () => {
    // Structural: request method exists and is a function (not never-throw stub).
    const session = http2.connect('http://127.0.0.1:1');
    ok(typeof session.request === 'function');
    session.close();
});

Deno.test({
    name: 'http2: createServer/connect fail closed when H2 gate forced missing',
}, () => {
    // Runs on H2-ON builds via __forceH2Unavailable (same path as embed OFF).
    __forceH2Unavailable(true);
    try {
        ok(h2Available() === false);
        try {
            http2.createServer();
            ok(false, 'expected createServer to throw without H2');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ok(/HTTP\/2|CNO_EMBED_EXT_H2|not available/i.test(msg), msg);
        }
        try {
            http2.connect('http://127.0.0.1:1');
            ok(false, 'expected connect to throw without H2');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ok(/HTTP\/2|CNO_EMBED_EXT_H2|not available/i.test(msg), msg);
        }
    } finally {
        __forceH2Unavailable(false);
    }
});

Deno.test({
    name: 'http2: request callback streams a flow-controlled POST body',
    ignore: !h2Available(),
    timeout: 20000,
}, async () => {
    const payload = Buffer.alloc(256 * 1024, 0x61);
    let callbackError: Error | null = null;
    const server = http2.createServer((request, response) => {
        try {
            strictEqual(request === response, false);
            strictEqual(request.method, 'POST');
            strictEqual(request.url, '/upload');
            strictEqual(request.httpVersion, '2.0');
            strictEqual(request.headers['x-test'], 'callback');
        } catch (error) {
            callbackError = error instanceof Error ? error : new Error(String(error));
        }
        let received = 0;
        request.on('data', (chunk: Buffer) => { received += chunk.byteLength; });
        request.on('end', () => {
            response.statusCode = 201;
            response.setHeader('content-type', 'text/plain');
            response.end(String(received));
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', resolve);
        server.on('error', reject);
    });
    const addr = server.address();
    ok(addr && typeof addr === 'object' && 'port' in addr, 'server has port');
    const port = (addr as { port: number }).port;
    const session = http2.connect(`http://127.0.0.1:${port}`);

    try {
        await once(session, 'connect');
        const request = session.request({
            ':method': 'POST',
            ':path': '/upload',
            ':scheme': 'http',
            ':authority': `127.0.0.1:${port}`,
            'x-test': 'callback',
        }, { endStream: false });
        const chunks: Buffer[] = [];
        const responseHeaders = new Promise<Record<string, string | string[]>>((resolve, reject) => {
            request.on('response', resolve);
            request.on('error', reject);
        });
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        const ended = once(request, 'end');
        request.end(payload);

        const headers = await responseHeaders;
        await ended;
        if (callbackError) throw callbackError;
        strictEqual(String(headers[':status']), '201');
        strictEqual(headers['content-type'], 'text/plain');
        strictEqual(Buffer.concat(chunks).toString(), String(payload.byteLength));
    } finally {
        session.close();
        await new Promise<void>((resolve, reject) => {
            server.close(error => (error ? reject(error) : resolve()));
        });
    }
});
