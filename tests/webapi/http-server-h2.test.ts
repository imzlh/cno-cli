/**
 * Shared @cnojs/http Server HTTP/2 accept + handler path.
 */
import { strictEqual, ok } from 'node:assert';
import { createServer } from '@cnojs/http/server';
import { HttpVersion } from '@cnojs/http/protocol';
import { h2Available } from '@cnojs/http/h2-native';
import * as http2 from 'node:http2';

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
    name: '@cnojs/http Server: TLS h2 handler GET',
    ignore: !h2Available(),
    timeout: 20000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = createServer(async (req, res) => {
        strictEqual(req.httpVersion, '2.0');
        strictEqual(req.method, 'GET');
        ok(req.url === '/core-h2' || req.url.startsWith('/core-h2'), req.url);
        await res.writeHead(200, 'OK', [['content-type', 'text/plain']]);
        await res.end('core-h2-ok');
    }, {
        hostname: '127.0.0.1',
        port: 0,
        cert,
        key,
        protocols: [HttpVersion.HTTP2, HttpVersion.HTTP11],
    });

    server.listen();
    await server.acceptLoop();
    const addr = server.address();
    ok(addr && 'port' in addr, 'has port');
    const port = (addr as { port: number }).port;

    try {
        const session = http2.connect(`https://127.0.0.1:${port}`, {
            rejectUnauthorized: false,
            ALPNProtocols: ['h2'],
        });
        await once(session, 'connect');

        const req = session.request({
            ':method': 'GET',
            ':path': '/core-h2',
            ':scheme': 'https',
            ':authority': `127.0.0.1:${port}`,
        });

        const chunks: Buffer[] = [];
        const headers = await new Promise<Record<string, string | string[]>>((resolve, reject) => {
            req.on('response', (h: Record<string, string | string[]>) => resolve(h));
            req.on('error', reject);
            req.on('data', (c: Buffer) => chunks.push(c));
        });
        await new Promise<void>((resolve, reject) => {
            req.on('end', () => resolve());
            req.on('error', reject);
            req.on('close', () => resolve());
        });

        strictEqual(String(headers[':status']), '200');
        strictEqual(Buffer.concat(chunks).toString(), 'core-h2-ok');
        session.close();
    } finally {
        await server.shutdown();
    }
});
