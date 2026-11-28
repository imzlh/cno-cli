import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { createServer, type TLSSocket } from 'node:tls';
import { fetch as bunFetch } from 'bun';

const ssl = import.meta.use('ssl');
const engine = import.meta.use('engine');

Deno.test({ name: 'bun.fetch: explicit proxy, NO_PROXY, redirects and streaming bodies share one request lifetime', timeout: 15000 }, async () => {
    const savedNoProxy = Deno.env.get('NO_PROXY');
    const savedLowerNoProxy = Deno.env.get('no_proxy');
    const hits: string[] = [];
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const origin = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, () => new Response('origin'));
    const target = `http://127.0.0.1:${(origin.addr as Deno.NetAddr).port}`;
    const proxy = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
        const path = new URL(request.url).pathname;
        hits.push(`${request.method}:${path}`);
        if (path === '/redirect') return new Response(null, { status: 302, headers: { location: `${target}/stream` } });
        if (path === '/stream') {
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    stream = controller;
                    controller.enqueue(new Uint8Array(engine.encodeString('first-')));
                },
            }));
        }
        return Response.json({
            from: 'proxy', method: request.method, body: await request.text(),
            header: request.headers.get('x-input'), authorization: request.headers.get('proxy-authorization'),
        });
    });
    const proxyUrl = `http://127.0.0.1:${(proxy.addr as Deno.NetAddr).port}`;
    try {
        Deno.env.set('NO_PROXY', '');
        Deno.env.set('no_proxy', '');
        const input = new Request(`${target}/post`, { method: 'POST', headers: { 'x-input': 'kept' }, body: 'payload' });
        deepStrictEqual(await (await bunFetch(input, Object.freeze({ proxy: new URL(proxyUrl), client: null }) as never)).json(), {
            from: 'proxy', method: 'POST', body: 'payload', header: 'kept', authorization: null,
        });
        const authenticated = new URL(proxyUrl);
        authenticated.username = 'proxy-user';
        authenticated.password = 'proxy-pass';
        const authenticatedResponse = await bunFetch(`${target}/authenticated`, { proxy: authenticated } as never);
        strictEqual((await authenticatedResponse.json()).authorization, `Basic ${btoa('proxy-user:proxy-pass')}`);

        const response = await bunFetch(`${target}/redirect`, { proxy: { url: proxyUrl, respectNoProxy: true } } as never);
        strictEqual(response.redirected, true);
        strictEqual(response.url, `${target}/stream`);
        const reader = response.body!.getReader();
        strictEqual(engine.decodeString((await reader.read()).value!), 'first-');
        stream.enqueue(new Uint8Array(engine.encodeString('last')));
        stream.close();
        strictEqual(engine.decodeString((await reader.read()).value!), 'last');
        strictEqual((await reader.read()).done, true);
        deepStrictEqual(hits, ['POST:/post', 'GET:/authenticated', 'GET:/redirect', 'GET:/stream']);

        Deno.env.set('NO_PROXY', '*');
        strictEqual(await (await bunFetch(`${target}/direct`, { proxy: proxyUrl } as never)).text(), 'origin');
        strictEqual(hits.length, 4);
        await rejects(bunFetch(target, { proxy: { url: proxyUrl, respectNoProxy: false } } as never), /respectNoProxy/);
        await rejects(bunFetch(target, { proxy: { url: proxyUrl, headers: { 'x-proxy': 'unsupported' } } } as never), /proxy headers/);
    } finally {
        if (savedNoProxy === undefined) Deno.env.delete('NO_PROXY');
        else Deno.env.set('NO_PROXY', savedNoProxy);
        if (savedLowerNoProxy === undefined) Deno.env.delete('no_proxy');
        else Deno.env.set('no_proxy', savedLowerNoProxy);
        await Promise.all([origin.shutdown(), proxy.shutdown()]);
    }
});

Deno.test({
    name: 'bun.fetch: custom TLS trust preserves streamed responses, aborts and certificate rejection',
    ignore: Deno.build.os === 'windows',
    timeout: 15000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, cert, key, onListen() {} }, request => {
        if (new URL(request.url).pathname === '/stream') {
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    stream = controller;
                    controller.enqueue(new Uint8Array(engine.encodeString('trusted')));
                },
            }));
        }
        return new Response('verified');
    });
    const url = `https://localhost:${(server.addr as Deno.NetAddr).port}`;
    try {
        strictEqual(await (await bunFetch(url, { tls: { ca: [cert] } } as never)).text(), 'verified');
        await rejects(bunFetch(url, { tls: {} } as never));
        const controller = new AbortController();
        const response = await bunFetch(`${url}/stream`, {
            tls: { ca: new Uint8Array(engine.encodeString(cert)) }, signal: controller.signal,
        } as never);
        const reader = response.body!.getReader();
        strictEqual(engine.decodeString((await reader.read()).value!), 'trusted');
        controller.abort(new Error('stop streamed transfer'));
        await rejects(reader.read());
        reader.releaseLock();
        try { stream.close(); } catch {}
        await rejects(bunFetch(url, { tls: { ca: cert, rejectUnauthorized: false } } as never), /rejectUnauthorized/);
        await rejects(bunFetch(url, { tls: { ca: cert, serverName: 'other-host' } } as never), /serverName/);
        await rejects(bunFetch(url, { tls: { ca: cert, cert } } as never), /cert and key/);
        const aborted = new AbortController();
        aborted.abort();
        await rejects(bunFetch(url, { tls: { ca: cert }, signal: aborted.signal } as never));
        ok(await (await bunFetch(url, { tls: { ca: cert } } as never)).text());
    } finally {
        try { stream?.close(); } catch {}
        await server.shutdown();
    }
});

Deno.test({
    name: 'bun.fetch: a client identity is presented to a server requiring mutual TLS',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const sockets = new Set<TLSSocket>();
    const server = createServer({ cert, key, ca: cert, requestCert: true, rejectUnauthorized: true }, socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => socket.destroy());
        let headers = '';
        socket.on('data', chunk => {
            headers += chunk.toString();
            if (headers.includes('\r\n\r\n')) {
                socket.end(`HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n${socket.authorized ? 'pass' : 'fail'}`);
            }
        });
    });
    server.on('tlsClientError', () => {});
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const url = `https://localhost:${(server.address() as { port: number }).port}`;
    try {
        await rejects(bunFetch(url, { tls: { ca: cert } } as never));
        const response = await bunFetch(url, { tls: { ca: cert, cert: [cert], key: [key] } } as never);
        strictEqual(await response.text(), 'pass');
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
