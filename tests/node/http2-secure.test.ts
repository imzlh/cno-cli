/**
 * HTTP/2 over TLS (ALPN h2): createSecureServer + connect(https).
 */
import { strictEqual, ok } from 'node:assert';
import * as http2 from 'node:http2';
import { h2Available, __forceH2Unavailable } from '@cnojs/http/h2-native';

const ssl = import.meta.use('ssl');

function once<T extends unknown[]>(
    emitter: { once(event: string, fn: (...args: T) => void): void },
    event: string,
): Promise<T> {
    return new Promise(resolve => {
        emitter.once(event, (...args: T) => resolve(args));
    });
}

Deno.test({
    name: 'http2: createSecureServer TLS+ALPN h2 GET round-trip',
    ignore: !h2Available(),
    timeout: 20000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = http2.createSecureServer({ cert, key, ALPNProtocols: ['h2'] });

    const got = once<[
        {
            on(e: string, fn: (...a: unknown[]) => void): void;
            respond(h: Record<string, unknown>, o?: { endStream?: boolean }): void;
            end(d?: string): void;
        },
        Record<string, string | string[]>,
    ]>(server, 'stream');

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.on('error', reject);
    });

    const addr = server.address();
    ok(addr && typeof addr === 'object' && 'port' in addr, 'server has port');
    const port = (addr as { port: number }).port;

    const streamPromise = got.then(([stream, headers]) => {
        strictEqual(headers[':method'], 'GET');
        const path = headers[':path'];
        ok(path === '/secure-h2' || (Array.isArray(path) && path[0] === '/secure-h2'), String(path));
        stream.respond({ ':status': 200, 'content-type': 'text/plain' });
        stream.end('tls-h2-pong');
    });

    const session = http2.connect(`https://127.0.0.1:${port}`, {
        rejectUnauthorized: false,
        ALPNProtocols: ['h2'],
    });
    await once(session, 'connect');

    const req = session.request({
        ':method': 'GET',
        ':path': '/secure-h2',
        ':scheme': 'https',
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
        req.on('close', () => resolve());
    });

    await streamPromise;

    strictEqual(String(responseHeaders[':status']), '200');
    strictEqual(Buffer.concat(chunks).toString(), 'tls-h2-pong');

    session.close();
    await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
    });
});

Deno.test({
    name: 'http2: createSecureServer without key/cert fails closed',
    ignore: !h2Available(),
}, () => {
    try {
        http2.createSecureServer({ key: 'only-key' });
        ok(false, 'expected throw');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ok(/key and cert/i.test(msg), msg);
    }
});

Deno.test({
    name: 'http2: createSecureServer fails closed when H2 gate forced missing',
}, () => {
    __forceH2Unavailable(true);
    try {
        ok(h2Available() === false);
        try {
            http2.createSecureServer({ key: 'k', cert: 'c' });
            ok(false, 'expected createSecureServer to throw without H2');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ok(/HTTP\/2|CNO_EMBED_EXT_H2|not available/i.test(msg), msg);
        }
        try {
            http2.connect('https://127.0.0.1:1', { rejectUnauthorized: false });
            ok(false, 'expected https connect to throw without H2');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ok(/HTTP\/2|CNO_EMBED_EXT_H2|not available/i.test(msg), msg);
        }
    } finally {
        __forceH2Unavailable(false);
    }
});
