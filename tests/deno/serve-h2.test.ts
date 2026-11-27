/**
 * Deno.serve TLS path negotiates h2 when ext-h2 is linked.
 * Client: node:http2 over https with ALPN h2.
 */
import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import * as http2 from 'node:http2';
import { createServer } from '@cnojs/http/server';
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
    const peer = Promise.withResolvers<Deno.Addr>();

    let server: Deno.HttpServer | undefined;
    let session: http2.ClientHttp2Session | undefined;
    try {
        server = Deno.serve({
            hostname: '127.0.0.1',
            port: 0,
            cert,
            key,
            onListen: () => {},
        }, (req, info) => {
            peer.resolve(info.remoteAddr);
            strictEqual(req.method, 'GET');
            ok(req.url.includes('/deno-h2'), req.url);
            return new Response('serve-h2-ok', {
                status: 200,
                headers: { 'content-type': 'text/plain' },
            });
        });
        const port = server.addr.transport === 'tcp' ? server.addr.port : 0;
        ok(port > 0, `bound port ${port}`);

        const activeSession = http2.connect(`https://127.0.0.1:${port}`, {
            rejectUnauthorized: false,
            ALPNProtocols: ['h2'],
        });
        session = activeSession;
        await once(activeSession, 'connect');
        const clientPort = activeSession.socket?.localPort;
        ok(typeof clientPort === 'number' && clientPort > 0);

        const req = activeSession.request({
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
        const remote = await peer.promise;
        strictEqual(remote.transport, 'tcp');
        if (remote.transport !== 'tcp') throw new Error('expected TCP peer');
        strictEqual(remote.hostname, activeSession.socket?.localAddress);
        strictEqual(remote.port, clientPort);
        ok(remote.port !== port, 'client ephemeral port must differ from the listener');
    } finally {
        session?.destroy();
        await server?.shutdown();
    }
});

Deno.test({
    name: 'Deno.serve: TLS h2 multiplexes flow-controlled request and response bodies',
    ignore: !h2Available(),
    timeout: 20000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let arrivals = 0;
    const allArrived = Promise.withResolvers<void>();
    const arrivalDeadline = setTimeout(() => allArrived.resolve(), 2000);
    let server: Deno.HttpServer | undefined;
    let session: http2.ClientHttp2Session | undefined;
    try {
        server = Deno.serve({
            hostname: '127.0.0.1', port: 0, cert, key, onListen() {},
        }, async request => {
            activeRequests++;
            maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
            if (++arrivals === 3) {
                clearTimeout(arrivalDeadline);
                allArrived.resolve();
            }
            await allArrived.promise;
            activeRequests--;
            return new Response(await request.arrayBuffer());
        });
        const port = server.addr.transport === 'tcp' ? server.addr.port : 0;
        const activeSession = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
        session = activeSession;
        const failed = Promise.withResolvers<never>();
        activeSession.on('error', failed.reject);
        await Promise.race([once(activeSession, 'connect'), failed.promise]);
        strictEqual(activeSession.alpnProtocol, 'h2');
        const transfers = [0x41, 0x62, 0x39].map(async value => {
            const payload = Buffer.alloc(256 * 1024, value);
            const request = activeSession.request({ 'X-Stream': String(value), ':method': 'POST', ':path': `/echo/${value}` }, { endStream: false });
            const chunks: Buffer[] = [];
            const result = new Promise<void>((resolve, reject) => {
                request.on('data', (chunk: Buffer) => chunks.push(chunk));
                request.on('error', reject);
                request.on('end', resolve);
            });
            request.end(payload);
            await result;
            deepStrictEqual(Buffer.concat(chunks), payload);
        });
        await Promise.race([Promise.all(transfers), failed.promise]);
        strictEqual(maxActiveRequests, 3, `expected three concurrent handlers, got ${maxActiveRequests}`);
    } finally {
        clearTimeout(arrivalDeadline);
        session?.destroy();
        await server?.shutdown();
    }
});

Deno.test({
    name: 'Deno.serve: cleartext stays HTTP/1 (no h2c by default)',
    timeout: 10000,
}, async () => {
    let server: Deno.HttpServer | undefined;
    try {
        server = Deno.serve({
            hostname: '127.0.0.1',
            port: 0,
            onListen: () => {},
        }, () => new Response('h1-only'));
        const port = server.addr.transport === 'tcp' ? server.addr.port : 0;
        const res = await fetch(`http://127.0.0.1:${port}/`);
        strictEqual(res.status, 200);
        strictEqual(await res.text(), 'h1-only');
    } finally {
        await server?.shutdown();
    }
});

Deno.test({
    name: 'fetch: HttpClient negotiates HTTP/2 by default and honours http2 false',
    ignore: !h2Available(),
    timeout: 20000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const negotiated: string[] = [];
    const server = createServer(async (request, response) => {
        negotiated.push(request.httpVersion);
        await response.end('fetch-protocol');
    }, { hostname: '127.0.0.1', port: 0, cert, key });
    let client: Deno.HttpClient | undefined;
    let http1: Deno.HttpClient | undefined;
    try {
        server.listen();
        await server.acceptLoop();
        const address = server.address();
        ok(address && 'port' in address);
        client = Deno.createHttpClient({ caCerts: [cert] });
        http1 = Deno.createHttpClient({ caCerts: [cert], http2: false });
        const url = `https://localhost:${address.port}/`;
        for (const transport of [client, http1]) {
            const response = await fetch(url, { client: transport });
            strictEqual(await response.text(), 'fetch-protocol');
        }
        deepStrictEqual(negotiated, ['2.0', '1.1']);
    } finally {
        client?.close();
        http1?.close();
        server.close();
    }
});
