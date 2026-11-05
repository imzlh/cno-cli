import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import Bun, { serve } from 'bun';

const start = (options: Parameters<typeof serve>[0]): ReturnType<typeof serve> => serve(options);

Deno.test({ name: 'bun: exact static routes preserve responses across repeated HTTP requests', timeout: 15000 }, async () => {
    strictEqual(Bun.serve, serve);
    const source = new Response('static-payload', {
        status: 203,
        headers: { 'content-type': 'text/plain', 'x-snapshot': 'original' },
    });
    const server = start({
        hostname: '127.0.0.1',
        port: 0,
        routes: {
            '/asset': source,
            '/a%2Fb': new Response('encoded-path'),
            '/empty': new Response(null, { status: 204 }),
        },
    });

    try {
        source.headers.set('x-snapshot', 'changed');
        for (const path of ['/asset', '/asset?version=2', '/asset']) {
            const response = await fetch(new URL(path, server.url));
            strictEqual(response.status, 203);
            strictEqual(response.headers.get('x-snapshot'), 'original');
            strictEqual(await response.text(), 'static-payload');
        }
        strictEqual(await source.text(), 'static-payload');
        strictEqual(await (await fetch(new URL('/a%2Fb', server.url))).text(), 'encoded-path');
        for (const path of ['/Asset', '/asset/', '/a/b', '/missing']) {
            const response = await fetch(new URL(path, server.url));
            strictEqual(response.status, 404, path);
            await response.text();
        }
        const empty = await fetch(new URL('/empty', server.url));
        strictEqual(empty.status, 204);
        strictEqual(await empty.text(), '');
    } finally {
        await server.stop();
    }
});

Deno.test({ name: 'bun: method routes dispatch HTTP bodies and support explicit or implicit HEAD', timeout: 15000 }, async () => {
    const seen: string[] = [];
    const server = start({
        hostname: '127.0.0.1',
        port: 0,
        routes: {
            '/method': {
                GET(request) {
                    seen.push(request.method);
                    return new Response('get-body', { status: 201, headers: { 'x-method': request.method } });
                },
                async POST(request) {
                    return new Response(`post:${await request.text()}`, { status: 202 });
                },
                PUT: new Response('put-body', { status: 203 }),
                DELETE: () => new Response(null, { status: 204 }),
                OPTIONS: () => new Response(null, { headers: { allow: 'GET, HEAD, POST, PUT, DELETE, OPTIONS' } }),
            },
            '/head': {
                GET: () => new Response('unused', { headers: { 'x-handler': 'get' } }),
                HEAD: () => new Response(null, { status: 204, headers: { 'x-handler': 'head' } }),
            },
        },
        fetch(request) {
            return new Response(`fallback:${request.method}`, { status: 409 });
        },
    });

    try {
        const url = new URL('/method', server.url);
        let response = await fetch(url);
        strictEqual(response.status, 201);
        strictEqual(await response.text(), 'get-body');
        response = await fetch(url, { method: 'HEAD' });
        strictEqual(response.status, 201);
        strictEqual(response.headers.get('x-method'), 'HEAD');
        strictEqual(await response.text(), '');
        deepStrictEqual(seen, ['GET', 'HEAD']);

        response = await fetch(url, { method: 'POST', body: 'request-body' });
        strictEqual(response.status, 202);
        strictEqual(await response.text(), 'post:request-body');
        response = await fetch(url, { method: 'PUT' });
        strictEqual(response.status, 203);
        strictEqual(await response.text(), 'put-body');
        response = await fetch(url, { method: 'DELETE' });
        strictEqual(response.status, 204);
        strictEqual(await response.text(), '');
        response = await fetch(url, { method: 'OPTIONS' });
        strictEqual(response.headers.get('allow'), 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
        await response.text();
        response = await fetch(url, { method: 'PATCH' });
        strictEqual(response.status, 409);
        strictEqual(await response.text(), 'fallback:PATCH');
        response = await fetch(new URL('/head', server.url), { method: 'HEAD' });
        strictEqual(response.status, 204);
        strictEqual(response.headers.get('x-handler'), 'head');
        strictEqual(await response.text(), '');
    } finally {
        await server.stop();
    }
});

Deno.test({ name: 'bun: route handlers retain server context, streaming and error handling', timeout: 15000 }, async () => {
    let routeThis: unknown;
    let routeServer: unknown;
    let errorThis: unknown;
    const errors: string[] = [];
    const server = start({
        hostname: '127.0.0.1',
        port: 0,
        routes: {
            '/stream': function (this: unknown, _request, currentServer) {
                routeThis = this;
                routeServer = currentServer;
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('route-stream'));
                        controller.close();
                    },
                }));
            },
            '/sync-error': () => { throw new Error('sync-route'); },
            '/async-error': async () => { throw new Error('async-route'); },
            '/disabled': false,
        },
        fetch(request) {
            return new Response(`fallback:${new URL(request.url).pathname}`, { status: 410 });
        },
        error(error) {
            errorThis = this;
            errors.push((error as Error).message);
            return new Response((error as Error).message, { status: 418 });
        },
    });

    try {
        strictEqual(await (await fetch(new URL('/stream', server.url))).text(), 'route-stream');
        strictEqual(routeThis, server);
        strictEqual(routeServer, server);
        for (const [path, message] of [['/sync-error', 'sync-route'], ['/async-error', 'async-route']]) {
            const response = await fetch(new URL(path, server.url));
            strictEqual(response.status, 418);
            strictEqual(await response.text(), message);
        }
        strictEqual(errorThis, server);
        deepStrictEqual(errors, ['sync-route', 'async-route']);
        for (const path of ['/disabled', '/unmatched']) {
            const response = await fetch(new URL(path, server.url));
            strictEqual(response.status, 410);
            strictEqual(await response.text(), `fallback:${path}`);
        }
        strictEqual(await (await fetch(new URL('/stream', server.url))).text(), 'route-stream');
    } finally {
        await server.stop();
    }
});

Deno.test({ name: 'bun: route reload replaces tables atomically without changing the listener', timeout: 15000 }, async () => {
    const server = start({
        hostname: '127.0.0.1',
        port: 0,
        routes: {
            '/route': new Response('old-route'),
            '/gone': () => new Response('old-gone'),
            '/error': () => { throw new Error('old-error'); },
        },
        fetch: () => new Response('old-fallback'),
        error: () => new Response('old-error-handler', { status: 418 }),
    });
    const port = server.port;
    const url = server.url.href;
    const reload = (options: unknown) => server.reload(options as Parameters<typeof server.reload>[0]);
    const textAt = async (path: string) => (await fetch(new URL(path, server.url))).text();

    try {
        // Fifth pass supports ':param' and trailing '/*' patterns; mid-path
        // wildcards remain rejected.
        throws(() => reload({
            routes: { '/unsupported/*/x': () => new Response('wrong') },
            fetch: () => new Response('wrong-fallback'),
            error: () => new Response('wrong-error-handler'),
        }), TypeError);
        strictEqual(await textAt('/route'), 'old-route');
        strictEqual(await textAt('/missing'), 'old-fallback');
        strictEqual(await textAt('/error'), 'old-error-handler');

        const routes = { '/route': () => new Response('new-route'), '/added': new Response('new-added') };
        strictEqual(reload({ routes }), server);
        routes['/route'] = () => new Response('mutated-route');
        strictEqual(server.port, port);
        strictEqual(server.url.href, url);
        strictEqual(await textAt('/route'), 'new-route');
        strictEqual(await textAt('/added'), 'new-added');
        strictEqual(await textAt('/gone'), 'old-fallback');
        strictEqual(reload({ routes: undefined }), server);
        strictEqual(await textAt('/route'), 'new-route');
        strictEqual(reload({ routes: {} }), server);
        strictEqual(await textAt('/route'), 'old-fallback');
        strictEqual(await textAt('/added'), 'old-fallback');
    } finally {
        await server.stop();
    }
});

Deno.test({ name: 'bun: route reload leaves an in-flight handler intact', timeout: 15000 }, async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = start({
        hostname: '127.0.0.1',
        port: 0,
        routes: {
            '/hold': async () => {
                started.resolve();
                await release.promise;
                return new Response('old-in-flight');
            },
        },
    });

    try {
        const pending = fetch(new URL('/hold', server.url));
        await started.promise;
        server.reload({ routes: { '/hold': () => new Response('new-handler') } });
        release.resolve();
        strictEqual(await (await pending).text(), 'old-in-flight');
        strictEqual(await (await fetch(new URL('/hold', server.url))).text(), 'new-handler');
    } finally {
        release.resolve();
        await server.stop();
    }
});
