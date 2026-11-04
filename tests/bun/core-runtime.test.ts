import { strictEqual, throws } from 'node:assert';
import Bun, { fetch as bunFetch, isMainThread, serve } from 'bun';

Deno.test({ name: 'bun: fetch and isMainThread share the main runtime namespace', timeout: 5000 }, async () => {
    strictEqual(Bun, globalThis.Bun);
    strictEqual(isMainThread, true);
    strictEqual(isMainThread, Bun.isMainThread);
    strictEqual(bunFetch, Bun.fetch);
    strictEqual(bunFetch === globalThis.fetch, false);
    strictEqual(bunFetch.name, 'fetch');
    strictEqual(bunFetch.length, 1);
    throws(
        () => bunFetch('http://127.0.0.1/', { proxy: false } as BunFetchRequestInit),
        /unsupported Bun-specific option "proxy"/,
    );

    const fetchDescriptor = Object.getOwnPropertyDescriptor(Bun, 'fetch');
    const mainThreadDescriptor = Object.getOwnPropertyDescriptor(Bun, 'isMainThread');
    strictEqual(fetchDescriptor?.writable, false);
    strictEqual(fetchDescriptor?.configurable, false);
    strictEqual(mainThreadDescriptor?.writable, false);
    strictEqual(mainThreadDescriptor?.configurable, false);

    const server = serve({ port: 0, fetch: request => new Response(new URL(request.url).pathname) });
    try {
        const response = await bunFetch(new URL('/bun-fetch', server.url));
        strictEqual(await response.text(), '/bun-fetch');
    } finally {
        await server.stop();
    }
});
