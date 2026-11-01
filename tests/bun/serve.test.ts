import { ok, strictEqual, throws } from 'node:assert';
import Bun, { serve } from 'bun';

const start = (options: Parameters<typeof serve>[0]): ReturnType<typeof serve> => serve(options);

Deno.test({ name: 'bun: serve exposes TCP metadata and passes its handle to fetch', timeout: 5000 }, async () => {
    strictEqual(Bun, globalThis.Bun);
    strictEqual(serve, Bun.serve);

    let receivedServer: ReturnType<typeof serve> | undefined;
    const server = start({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request, currentServer) {
            receivedServer = currentServer;
            return new Response(`${request.method}:${new URL(request.url).pathname}`);
        },
    });

    try {
        strictEqual(server.hostname, '127.0.0.1');
        ok(server.port > 0);
        strictEqual(server.url.protocol, 'http:');
        strictEqual(server.url.port, String(server.port));

        const response = await fetch(new URL('/hello', server.url));
        strictEqual(response.status, 200);
        strictEqual(await response.text(), 'GET:/hello');
        strictEqual(receivedServer, server);
    } finally {
        await server.stop();
    }
});

Deno.test({ name: 'bun: serve exposes localhost while binding its IPv4 loopback', timeout: 5000 }, async () => {
    let fetchThis: unknown;
    let errorThis: unknown;
    const server = start({
        port: 0,
        fetch() {
            fetchThis = this;
            throw new Error('receiver-probe');
        },
        error(error) {
            errorThis = this;
            return new Response((error as Error).message, { status: 503 });
        },
    });

    try {
        strictEqual(server.hostname, 'localhost');
        strictEqual(server.url.hostname, 'localhost');
        const response = await fetch(`http://127.0.0.1:${server.port}/`);
        strictEqual(response.status, 503);
        strictEqual(await response.text(), 'receiver-probe');
        strictEqual(fetchThis, server);
        strictEqual(errorThis, server);
    } finally {
        await server.stop();
    }
});

Deno.test({ name: 'bun: serve supports async handlers and streaming responses', timeout: 5000 }, async () => {
    const server = start({
        hostname: '127.0.0.1',
        port: 0,
        async fetch() {
            await Promise.resolve();
            const encoder = new TextEncoder();
            let sent = false;
            return new Response(new ReadableStream({
                pull(controller) {
                    if (sent) {
                        controller.close();
                        return;
                    }
                    sent = true;
                    controller.enqueue(encoder.encode('first-'));
                    controller.enqueue(encoder.encode('second'));
                },
            }));
        },
    });

    try {
        const response = await fetch(server.url);
        strictEqual(response.status, 200);
        strictEqual(await response.text(), 'first-second');
    } finally {
        await server.stop();
    }
});

Deno.test({ name: 'bun: serve routes handler errors through error and keeps serving', timeout: 5000 }, async () => {
    let errors = 0;
    const server = start({
        hostname: '127.0.0.1',
        port: 0,
        fetch() {
            throw new Error('bun-test-error');
        },
        error(error) {
            errors++;
            return new Response(`handled:${(error as Error).message}`, { status: 418 });
        },
    });

    try {
        const response = await fetch(server.url);
        strictEqual(response.status, 418);
        strictEqual(await response.text(), 'handled:bun-test-error');
        strictEqual(errors, 1);
    } finally {
        await server.stop();
    }
});

Deno.test('bun: serve rejects unsupported transport and routing options', () => {
    const fetch = () => new Response('unused');
    for (const option of ['websocket', 'tls', 'routes', 'development', 'reload']) {
        throws(
            () => serve({ fetch, [option]: {} } as Parameters<typeof serve>[0]),
            new RegExp(`unsupported option "${option}"`),
        );
    }
});

Deno.test({ name: 'bun: stop is graceful and does not claim force-close support', timeout: 5000 }, async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = start({
        hostname: '127.0.0.1',
        port: 0,
        async fetch() {
            started.resolve();
            await release.promise;
            return new Response('finished');
        },
    });

    try {
        const responsePromise = fetch(server.url);
        await started.promise;

        let stopped = false;
        const stopPromise = Promise.resolve(server.stop()).then(() => { stopped = true; });
        await Promise.resolve();
        strictEqual(stopped, false);
        throws(() => server.stop(true), /forceful stop is unsupported/);

        release.resolve();
        const response = await responsePromise;
        strictEqual(await response.text(), 'finished');
        await stopPromise;
        strictEqual(stopped, true);
    } finally {
        release.resolve();
        await Promise.resolve(server.stop());
    }
});
