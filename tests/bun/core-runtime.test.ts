import { rejects, strictEqual, throws } from 'node:assert';
import Bun, { fetch as bunFetch, isMainThread, serve } from 'bun';

Deno.test({ name: 'bun: fetch and isMainThread share the main runtime namespace', timeout: 5000 }, async () => {
    strictEqual(Bun, globalThis.Bun);
    strictEqual(isMainThread, true);
    strictEqual(isMainThread, Bun.isMainThread);
    strictEqual(bunFetch, Bun.fetch);
    strictEqual(bunFetch === globalThis.fetch, false);
    strictEqual(bunFetch.name, 'fetch');
    strictEqual(bunFetch.length, 1);
    strictEqual(Object.hasOwn(bunFetch, 'prototype'), false);
    throws(() => Reflect.construct(bunFetch as never, []), TypeError);
    await rejects(
        bunFetch('http://127.0.0.1/', { timeout: 1 } as BunFetchRequestInit),
        /unsupported Bun-specific option "timeout"/,
    );

    const fetchDescriptor = Object.getOwnPropertyDescriptor(Bun, 'fetch');
    const mainThreadDescriptor = Object.getOwnPropertyDescriptor(Bun, 'isMainThread');
    strictEqual(fetchDescriptor?.writable, false);
    strictEqual(fetchDescriptor?.configurable, false);
    strictEqual(mainThreadDescriptor?.writable, false);
    strictEqual(mainThreadDescriptor?.configurable, false);

    const server = serve({ port: 0, fetch: request => new Response(new URL(request.url).pathname) });
    try {
        for (const init of [undefined, false, 1, 'ignored', 1n, Symbol('ignored')]) {
            const response = await bunFetch(new URL('/bun-fetch', server.url), init as never);
            strictEqual(await response.text(), '/bun-fetch');
        }

        const getterError = new Error('proxy getter failed');
        const init = Object.defineProperty({}, 'proxy', {
            get() {
                throw getterError;
            },
        });
        await rejects(bunFetch(server.url, init), error => error === getterError);
    } finally {
        await server.stop();
    }
});
