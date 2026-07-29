/**
 * Deno.serve TLS path negotiates h2 when ext-h2 is linked.
 * Client: node:http2 over https with ALPN h2.
 */
import { strictEqual, ok } from 'node:assert';
import * as http2 from 'node:http2';
import { h2Available } from '@cnojs/http/h2-native';

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
    name: 'Deno.serve: TLS ALPN h2 handler round-trip',
    ignore: !h2Available(),
    timeout: 20000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });

    const server = Deno.serve({
        hostname: '127.0.0.1',
        port: 0,
        cert,
        key,
        onListen: () => {},
    }, (req) => {
        strictEqual(req.method, 'GET');
        ok(req.url.includes('/deno-h2'), req.url);
        return new Response('serve-h2-ok', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
        });
    });

    const port = server.addr.transport === 'tcp' ? server.addr.port : 0;
    ok(port > 0, `bound port ${port}`);

    try {
        const session = http2.connect(`https://127.0.0.1:${port}`, {
            rejectUnauthorized: false,
            ALPNProtocols: ['h2'],
        });
        await once(session, 'connect');

        const req = session.request({
            ':method': 'GET',
            ':path': '/deno-h2',
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

        strictEqual(String(responseHeaders[':status']), '200');
        strictEqual(responseHeaders['transfer-encoding'], undefined);
        strictEqual(Buffer.concat(chunks).toString(), 'serve-h2-ok');

        session.close();
    } finally {
        await server.shutdown();
    }
});

Deno.test({
    name: 'Deno.serve: cleartext stays HTTP/1 (no h2c by default)',
    timeout: 10000,
}, async () => {
    const server = Deno.serve({
        hostname: '127.0.0.1',
        port: 0,
        onListen: () => {},
    }, () => new Response('h1-only'));

    const port = server.addr.transport === 'tcp' ? server.addr.port : 0;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        strictEqual(res.status, 200);
        strictEqual(await res.text(), 'h1-only');
    } finally {
        await server.shutdown();
    }
});
