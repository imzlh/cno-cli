import { deepStrictEqual, strictEqual } from 'node:assert';
import { serve } from 'bun';
import { withTempDir } from '../_helpers/temp.ts';
import { join } from 'node:path';

Deno.test({ name: 'bun: parameter and wildcard routes match real HTTP requests', timeout: 15000 }, async () => {
    const server = serve({
        hostname: '127.0.0.1',
        port: 0,
        routes: {
            '/users/:id': request => new Response(`user:${request.params.id}`),
            '/posts/:postId/comments/:commentId': request =>
                new Response(`${request.params.postId}:${request.params.commentId}`),
            '/files/*': request => new Response(`wildcard:${new URL(request.url).pathname}`),
            '/api/users': () => new Response('exact'),
            '/api/users/:id': request => new Response(`param:${request.params.id}`),
            '/api/*': () => new Response('api-catchall'),
            '/legacy': false,
        },
        fetch: request => new Response(`fallback:${new URL(request.url).pathname}`, { status: 409 }),
    });

    try {
        const textAt = async (path: string) => (await fetch(new URL(path, server.url))).text();
        strictEqual(await textAt('/users/42'), 'user:42');
        strictEqual(await textAt('/users/a%20b'), 'user:a b');
        strictEqual(await textAt('/users/%E9%9B%AA'), 'user:雪');
        strictEqual(await textAt('/posts/7/comments/9'), '7:9');
        strictEqual(await textAt('/files/'), 'wildcard:/files/');
        strictEqual(await textAt('/files/deep/asset.bin'), 'wildcard:/files/deep/asset.bin');
        strictEqual(await textAt('/api/users'), 'exact');
        strictEqual(await textAt('/api/users/5'), 'param:5');
        strictEqual(await textAt('/api/other'), 'api-catchall');

        const responses = await Promise.all([
            fetch(new URL('/users', server.url)),
            fetch(new URL('/users/', server.url)),
            fetch(new URL('/users/a/b', server.url)),
            fetch(new URL('/files', server.url)),
            fetch(new URL('/filesx/a', server.url)),
            fetch(new URL('/legacy', server.url)),
        ]);
        for (const [index, response] of responses.entries()) {
            strictEqual(response.status, 409, String(index));
            await response.text();
        }
        // Params stay request-scoped: two concurrent requests each see their own id.
        const concurrent = await Promise.all([
            fetch(new URL('/users/1', server.url)),
            fetch(new URL('/users/2', server.url)),
        ]);
        deepStrictEqual(await Promise.all(concurrent.map(response => response.text())), ['user:1', 'user:2']);
    } finally {
        await server.stop();
    }
});

Deno.test({ name: 'bun: BunFile routes serve static file snapshots with HEAD and 404 parity', timeout: 15000 }, async () => {
    await withTempDir('bun-serve-bunfile', async root => {
        await Bun.write(join(root, 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
        await Bun.write(join(root, 'page.html'), '<h1>page</h1>');
        const server = serve({
            hostname: '127.0.0.1',
            port: 0,
            routes: {
                '/logo.png': Bun.file(join(root, 'logo.png')),
                '/page': Bun.file(join(root, 'page.html')),
                '/absent.txt': Bun.file(join(root, 'absent.txt')),
            },
            fetch: () => new Response('fallback', { status: 409 }),
        });

        try {
            const logo = await fetch(new URL('/logo.png', server.url));
            strictEqual(logo.status, 200);
            strictEqual(logo.headers.get('content-type'), 'image/png');
            const bytes = new Uint8Array(await logo.arrayBuffer());
            deepStrictEqual([...bytes], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
            // Snapshots are reusable.
            const repeat = new Uint8Array(await (await fetch(new URL('/logo.png', server.url))).arrayBuffer());
            deepStrictEqual([...repeat], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

            const head = await fetch(new URL('/logo.png', server.url), { method: 'HEAD' });
            strictEqual(head.status, 200);
            strictEqual(head.headers.get('content-type'), 'image/png');
            strictEqual(await head.text(), '');

            const page = await fetch(new URL('/page', server.url));
            strictEqual(page.status, 200);
            strictEqual(page.headers.get('content-type'), 'text/html;charset=utf-8');
            strictEqual(await page.text(), '<h1>page</h1>');

            strictEqual((await fetch(new URL('/absent.txt', server.url))).status, 404);
        } finally {
            await server.stop();
        }
    });
});

Deno.test({ name: 'bun: dynamic routes reload atomically like exact routes', timeout: 15000 }, async () => {
    const server = serve({
        hostname: '127.0.0.1',
        port: 0,
        routes: { '/users/:id': request => new Response(`old:${request.params.id}`) },
        fetch: () => new Response('old-fallback', { status: 410 }),
    });
    try {
        strictEqual(await (await fetch(new URL('/users/1', server.url))).text(), 'old:1');
        strictEqual(server.reload({ routes: { '/users/:id': request => new Response(`new:${request.params.id}`) } }), server);
        strictEqual(await (await fetch(new URL('/users/1', server.url))).text(), 'new:1');
        strictEqual(server.reload({ routes: {} }), server);
        strictEqual((await fetch(new URL('/users/1', server.url))).status, 410);
    } finally {
        await server.stop();
    }
});
