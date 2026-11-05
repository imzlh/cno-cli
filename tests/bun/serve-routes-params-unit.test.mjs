// @cno-host: false
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundled = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['cno/src/bun/serve.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    write: false,
});
const { serve } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

function host(t) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
    const bindings = [];
    Object.defineProperty(globalThis, 'Deno', {
        configurable: true,
        value: {
            serve(options, handler) {
                bindings.push({ options, handler });
                return {
                    addr: { transport: 'tcp', port: 43113 },
                    async shutdown() {},
                };
            },
        },
    });
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, 'Deno', previous);
        else delete globalThis.Deno;
    });
    return {
        bindings,
        async request(path, method = 'GET') {
            const { handler, options } = bindings.at(-1);
            try {
                return await handler(new Request(`http://localhost${path}`, { method }));
            } catch (error) {
                return await options.onError(error) ?? new Response(null, { status: 500 });
            }
        },
    };
}

/** A minimal stand-in for a real BunFile via the serve-target protocol. */
function fakeBunFile(body, { exists = true, contentType = 'text/plain' } = {}) {
    return {
        [Symbol.for('cno.bun-file.serve-target')]() {
            return { path: '/fake', exists, contentType, stream: () => body.body };
        },
    };
}

test('serve params: captures one segment per ":name" and decodes it', async t => {
    const mock = host(t);
    const seen = [];
    const server = serve({
        routes: {
            '/users/:id': request => {
                seen.push(request.params);
                return new Response(request.params.id);
            },
            '/posts/:postId/comments/:commentId': request =>
                new Response(`${request.params.postId}|${request.params.commentId}`),
            '/files/*': request => new Response(`wildcard:${new URL(request.url).pathname}`),
        },
    });
    assert.equal(await (await mock.request('/users/42')).text(), '42');
    assert.equal(await (await mock.request('/users/a%20b')).text(), 'a b');
    assert.equal(await (await mock.request('/users/%E9%9B%AA')).text(), '雪');
    // Malformed escapes stay raw instead of failing the match.
    assert.equal(await (await mock.request('/users/%zz')).text(), '%zz');
    assert.equal(await (await mock.request('/posts/7/comments/9')).text(), '7|9');
    // One parameter never swallows more than its own segment.
    for (const path of ['/users', '/users/', '/users/a/b', '/users//x', '/posts/7/comments']) {
        assert.equal((await mock.request(path)).status, 404, path);
    }
    assert.equal(await (await mock.request('/files/')).text(), 'wildcard:/files/');
    assert.equal(await (await mock.request('/files/a/b/c.txt')).text(), 'wildcard:/files/a/b/c.txt');
    // '/files/*' matches under the prefix, not the bare prefix or siblings.
    for (const path of ['/files', '/filesx', '/filesless/a']) {
        assert.equal((await mock.request(path)).status, 404, path);
    }
    assert.equal(await (await mock.request('/files')).status, 404);
    await server.stop();

    assert.ok(seen.length >= 4);
    for (const params of seen) {
        assert.equal(Object.getPrototypeOf(params), Object.prototype, 'params stays a plain object');
    }
    // Every request gets its own params object.
    assert.notEqual(seen[0], seen[1]);
});

test('serve params: request.params is a read-only non-enumerable own property', async t => {
    const mock = host(t);
    const observed = [];
    const server = serve({
        routes: {
            '/exact': request => {
                observed.push(Object.getOwnPropertyDescriptor(request, 'params'));
                return new Response('ok');
            },
            '/users/:id': request => {
                observed.push(Object.getOwnPropertyDescriptor(request, 'params'));
                return new Response('ok');
            },
            '/*': request => {
                observed.push(Object.getOwnPropertyDescriptor(request, 'params'));
                return new Response('ok');
            },
        },
    });
    for (const path of ['/exact', '/users/5', '/anything/else']) {
        assert.equal(await (await mock.request(path)).text(), 'ok', path);
    }
    assert.equal(observed.length, 3);
    const expectedValues = [{}, { id: '5' }, {}];
    for (const [index, descriptor] of observed.entries()) {
        assert.equal(descriptor.enumerable, false, index);
        assert.equal(descriptor.writable, false, index);
        assert.equal(descriptor.configurable, true, index);
        // Wildcard and exact routes expose empty params; only ":name" segments
        // capture values, matching Bun's BunRequest types.
        assert.deepEqual(descriptor.value, expectedValues[index]);
    }
    await server.stop();
});

test('serve params: exact routes beat parameter routes beat wildcards', async t => {
    const mock = host(t);
    const server = serve({
        routes: {
            '/api/users': () => new Response('exact'),
            '/api/users/:id': () => new Response('param'),
            '/api/*': () => new Response('api-wildcard'),
            '/*': () => new Response('catchall'),
            '/deep/a/:b/c': () => new Response('deep-param'),
            '/deep/:x/y/c': () => new Response('one-static'),
            '/deep/*': () => new Response('deep-wildcard'),
        },
        fetch: () => new Response('fallback', { status: 410 }),
    });
    assert.equal(await (await mock.request('/api/users')).text(), 'exact');
    assert.equal(await (await mock.request('/api/users/9')).text(), 'param');
    assert.equal(await (await mock.request('/api/other')).text(), 'api-wildcard');
    // '/api/users/9/extra' still starts with '/api/', so the API wildcard wins
    // over the global catch-all.
    assert.equal(await (await mock.request('/api/users/9/extra')).text(), 'api-wildcard');
    assert.equal(await (await mock.request('/anything')).text(), 'catchall');
    assert.equal(await (await mock.request('/')).text(), 'catchall');
    // More static segments win within the same tier.
    assert.equal(await (await mock.request('/deep/a/x/c')).text(), 'deep-param');
    assert.equal(await (await mock.request('/deep/x/y/c')).text(), 'one-static');
    assert.equal(await (await mock.request('/deep/a/b/c/d')).text(), 'deep-wildcard');
    await server.stop();
});

test('serve params: disabled routes fall through to fetch and shadow later patterns', async t => {
    const mock = host(t);
    const server = serve({
        routes: {
            '/users/:id': false,
            '/users/*': () => new Response('wildcard-ran'),
            '/disabled': false,
        },
        fetch: () => new Response('fallback', { status: 409 }),
    });
    // A false route disables the whole path: the wildcard never runs.
    assert.equal((await mock.request('/users/5')).status, 409);
    assert.equal(await (await mock.request('/users/5/extra')).text(), 'wildcard-ran');
    assert.equal((await mock.request('/disabled')).status, 409);
    await server.stop();
});

test('serve params: dynamic method maps dispatch methods and implicit HEAD', async t => {
    const mock = host(t);
    const server = serve({
        routes: {
            '/users/:id': {
                GET: request => new Response(`get:${request.params.id}`),
                POST: async request => new Response(`post:${request.params.id}:${await request.text()}`),
            },
            '/both/:id': {
                GET: () => new Response('get'),
                HEAD: () => new Response(null, { status: 202 }),
            },
        },
        fetch: () => new Response('fallback', { status: 418 }),
    });
    assert.equal(await (await mock.request('/users/1')).text(), 'get:1');
    assert.equal(await (await mock.request('/users/1', 'POST')).text(), 'post:1:');
    assert.equal((await mock.request('/users/1', 'DELETE')).status, 418);
    // Implicit HEAD runs the GET handler; the mock bypasses the HTTP layer
    // that would discard the body, so only the status is asserted here.
    const head = await mock.request('/users/1', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal((await mock.request('/both/1', 'HEAD')).status, 202);
    await server.stop();
});

test('serve params: pattern grammar accepts root params and mixed prefix wildcards', async t => {
    const mock = host(t);
    const server = serve({
        routes: {
            '/:lang': request => new Response(request.params.lang),
            '/users/:id/*': request => new Response(`rest:${request.params.id}:${new URL(request.url).pathname}`),
        },
    });
    assert.equal(await (await mock.request('/en')).text(), 'en');
    assert.equal((await mock.request('/')).status, 404);
    assert.equal(await (await mock.request('/users/7/a/b')).text(), 'rest:7:/users/7/a/b');
    assert.equal(await (await mock.request('/users/7/')).text(), 'rest:7:/users/7/');
    assert.equal((await mock.request('/users/7')).status, 404);
    await server.stop();
});

test('serve params: dynamic pattern count stays bounded', async t => {
    const mock = host(t);
    const many = Object.fromEntries(
        Array.from({ length: 1024 }, (_, index) => [`/p${index}/*`, () => new Response('ok')]),
    );
    const bounded = serve({ routes: many });
    assert.equal(await (await mock.request('/p1023/x')).text(), 'ok');
    await bounded.stop();
    const over = Object.fromEntries(
        Array.from({ length: 1025 }, (_, index) => [`/q${index}/*`, () => new Response('ok')]),
    );
    assert.throws(() => serve({ routes: over }), error => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, /1024 parameter and wildcard routes/);
        return true;
    });
    // The oversized table is rejected before the listener binds.
    assert.equal(mock.bindings.length, 1);
});

test('serve params: BunFile routes snapshot bodies eagerly with HEAD and 404 handling', async t => {
    const mock = host(t);
    const source = new Response('file-payload', { headers: { 'x-unused': 'yes' } });
    const server = serve({
        routes: {
            '/logo.png': fakeBunFile(source, { contentType: 'image/png' }),
            '/empty.bin': fakeBunFile(new Response(''), { contentType: 'application/octet-stream' }),
            '/missing.txt': fakeBunFile(new Response('unused'), { exists: false }),
            '/no-type': fakeBunFile(new Response('bytes'), { contentType: '' }),
        },
    });
    // Eager snapshot: the source body is consumed at registration.
    assert.equal(source.bodyUsed, true);
    const first = await mock.request('/logo.png');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/png');
    assert.equal(await first.text(), 'file-payload');
    // Repeated requests reuse the snapshot; mutating one body does not leak.
    const second = await mock.request('/logo.png');
    const reader = second.body.getReader();
    const chunk = await reader.read();
    assert.ok(chunk.value.byteLength > 0);
    chunk.value[0] = 0x21;
    await reader.cancel();
    const third = await mock.request('/logo.png');
    assert.equal(await third.text(), 'file-payload');
    const head = await mock.request('/logo.png', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'image/png');
    assert.equal(await head.text(), '');
    const empty = await mock.request('/empty.bin');
    assert.equal(empty.status, 200);
    assert.equal(await empty.text(), '');
    assert.equal((await mock.request('/missing.txt')).status, 404);
    const untyped = await mock.request('/no-type');
    assert.equal(untyped.headers.get('content-type'), null);
    assert.equal(await untyped.text(), 'bytes');
    await server.stop();
});

test('serve params: replacement and stop release BunFile snapshot state', { timeout: 5000 }, async t => {
    const mock = host(t);
    for (const action of ['reload', 'stop']) {
        let controller;
        // The cancel hook makes the trailing assertion real: the pending
        // response must drain to completion, not get force-cancelled.
        const stream = new ReadableStream({
            start(c) { controller = c; },
            cancel() { cancelled = true; },
        });
        const source = new Response('unused');
        let cancelled = false;
        const file = {
            [Symbol.for('cno.bun-file.serve-target')]() {
                return {
                    path: '/pending',
                    exists: true,
                    contentType: 'text/plain',
                    stream: () => stream,
                };
            },
        };
        const server = serve({ routes: { '/pending': file, '/origin': source } });
        const pending = mock.request('/pending');
        if (action === 'reload') server.reload({ routes: {} });
        else await server.stop();
        await new Promise(resolve => setImmediate(resolve));
        // The snapshot reader is cancelled once the table is replaced or stopped.
        await controller.close();
        const response = await pending;
        assert.equal(await response.text(), '', action);
        assert.equal(await source.text(), 'unused', action);
        assert.equal(cancelled, false);
    }
    assert.equal(mock.bindings.length, 2);
});

test('serve params: descriptor objects without the protocol stay invalid', async t => {
    const mock = host(t);
    const bogus = [
        { path: '/x', exists: true, contentType: 'text/plain', stream: () => new Response('x').body },
        { [Symbol.for('cno.bun-file.serve-target')]: 42 },
        { [Symbol.for('cno.bun-file.serve-target')]() { return null; } },
        'string-value',
    ];
    for (const value of bogus) {
        assert.throws(() => serve({ routes: { '/bad': value } }), TypeError, String(value));
    }
    assert.equal(mock.bindings.length, 0);
});
