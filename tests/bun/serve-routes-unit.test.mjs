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
    let shutdowns = 0;
    Object.defineProperty(globalThis, 'Deno', {
        configurable: true,
        value: {
            serve(options, handler) {
                bindings.push({ options, handler });
                return {
                    addr: { transport: 'tcp', port: 43111 },
                    async shutdown() { shutdowns++; },
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
        get shutdowns() { return shutdowns; },
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

function pendingStatic(t) {
    let controller;
    const source = new Response(new ReadableStream({ start(value) { controller = value; } }));
    const clone = source.clone.bind(source);
    let snapshot;
    let cancellations = 0;
    source.clone = () => {
        snapshot = clone();
        const getReader = snapshot.body.getReader.bind(snapshot.body);
        snapshot.body.getReader = (...args) => {
            const reader = getReader(...args);
            const cancel = reader.cancel.bind(reader);
            reader.cancel = reason => { cancellations++; return cancel(reason); };
            return reader;
        };
        return snapshot;
    };
    t.after(() => {
        try { controller.close(); } catch { /* The test may already have closed the stream. */ }
    });
    return {
        source,
        get snapshot() { return snapshot; },
        get cancellations() { return cancellations; },
        finish(text) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); },
    };
}

test('serve routes: exact paths, query exclusion, receivers, and routes-only 404', async t => {
    const mock = host(t);
    const server = serve({
        port: 0,
        routes: {
            '/Case': function (request, current) {
                assert.equal(this, server);
                assert.equal(current, server);
                return new Response(request.method);
            },
            '/encoded%2Fvalue': () => new Response('encoded'),
            '/raw%20space': () => new Response('space'),
            '/%E9%9B%AA': () => new Response('unicode'),
            '/disabled': false,
        },
    });
    assert.equal(await (await mock.request('/Case?query=1')).text(), 'GET');
    assert.equal(await (await mock.request('/encoded%2Fvalue')).text(), 'encoded');
    assert.equal(await (await mock.request('/raw%20space')).text(), 'space');
    assert.equal(await (await mock.request('/%E9%9B%AA')).text(), 'unicode');
    for (const path of ['/case', '/Case/', '/encoded/value', '/missing', '/disabled']) {
        assert.equal((await mock.request(path)).status, 404, path);
    }
    await server.stop();
    await server.stop();
    assert.equal(mock.bindings.length, 1);
    assert.equal(mock.shutdowns, 1);
});

test('serve routes: method maps, HEAD selection, and fetch fallthrough', async t => {
    const mock = host(t);
    const methods = Object.fromEntries(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].map(method => [
        method, async request => new Response(null, { headers: { selected: `${method}:${request.method}` } }),
    ]));
    const server = serve({
        routes: {
            '/methods': methods,
            '/head': { GET: () => new Response('get'), HEAD: () => new Response(null, { status: 202 }) },
            '/get': { GET: () => new Response('get') },
            '/disabled': false,
        },
        fetch(request, current) {
            assert.equal(this, server);
            assert.equal(current, server);
            return new Response('fallback', { status: 418 });
        },
    });
    for (const method of Object.keys(methods)) {
        assert.equal((await mock.request('/methods', method)).headers.get('selected'), `${method}:${method}`);
    }
    assert.equal((await mock.request('/methods', 'HEAD')).headers.get('selected'), 'GET:HEAD');
    assert.equal((await mock.request('/head', 'HEAD')).status, 202);
    for (const [path, method] of [['/methods', 'PROPFIND'], ['/get', 'POST'], ['/disabled', 'GET'], ['/missing', 'GET']]) {
        assert.equal((await mock.request(path, method)).status, 418);
    }
});

test('serve routes: registration snapshots tables and reload replaces them', async t => {
    const mock = host(t);
    const methods = { GET: () => new Response('original') };
    const routes = { '/original': methods };
    const server = serve({ routes });
    methods.GET = () => new Response('mutated');
    routes['/added'] = () => new Response('added');
    delete routes['/original'];
    assert.equal(await (await mock.request('/original')).text(), 'original');
    assert.equal((await mock.request('/added')).status, 404);
    assert.equal(server.reload({}), server);
    server.reload({ routes: undefined });
    assert.equal(await (await mock.request('/original')).text(), 'original');
    server.reload({ routes: { '/next': () => new Response('next') } });
    assert.equal((await mock.request('/original')).status, 404);
    assert.equal(await (await mock.request('/next')).text(), 'next');
    server.reload({ routes: {} });
    assert.equal((await mock.request('/next')).status, 404);
    assert.equal(mock.bindings.length, 1);
});

test('serve routes: static bodies and headers are reusable snapshots', async t => {
    const mock = host(t);
    const source = new Response('cached body', { status: 201, statusText: 'Created', headers: { marker: 'original' } });
    const clone = source.clone.bind(source);
    let clones = 0;
    let captured;
    source.clone = () => { clones++; return captured = clone(); };
    serve({ routes: { '/static': source, '/empty': new Response(null, { status: 204 }) } });
    assert.equal(clones, 1);
    assert.equal(captured.bodyUsed, true, 'snapshot reading starts before the first request');
    source.headers.set('marker', 'mutated');
    assert.equal(await source.text(), 'cached body');
    const responses = await Promise.all([mock.request('/static'), mock.request('/static')]);
    assert.notEqual(responses[0], responses[1]);
    for (const response of responses) {
        assert.equal(response.status, 201);
        assert.equal(response.statusText, 'Created');
        assert.equal(response.headers.get('marker'), 'original');
        assert.equal(await response.text(), 'cached body');
    }
    responses[0].headers.set('marker', 'changed response');
    assert.equal(responses[1].headers.get('marker'), 'original');
    assert.equal(await (await mock.request('/static')).text(), 'cached body');
    assert.equal(clones, 1);
    assert.equal(captured.bodyUsed, true);
    assert.equal((await mock.request('/empty')).status, 204);
});

test('serve routes: static response chunks are isolated with bounded copies', async t => {
    const mock = host(t);
    const payload = new Uint8Array(128 * 1024).fill(0x5a);
    const server = serve({ routes: { '/static': new Response(payload) } });
    try {
        const first = await mock.request('/static');
        const reader = first.body.getReader();
        const initial = await reader.read();
        assert.equal(initial.done, false);
        assert.ok(initial.value.byteLength <= 64 * 1024);
        initial.value[0] = 0;
        await reader.cancel();

        const second = await mock.request('/static');
        const bytes = await second.bytes();
        assert.equal(bytes[0], 0x5a);
        assert.equal(bytes.byteLength, payload.byteLength);
    } finally {
        await server.stop();
    }
});

test('serve routes: invalid configuration neither binds nor consumes static responses', async t => {
    const mock = host(t);
    const source = new Response('untouched');
    const used = new Response('used');
    await used.text();
    const locked = new Response('locked');
    const reader = locked.body.getReader();
    t.after(() => reader.releaseLock());
    let clones = 0;
    source.clone = () => { clones++; throw new Error('must validate first'); };
    const invalidRoutes = [
        null, [], 42, new Map(), new Date(),
        { '/good': source, relative: () => new Response() },
        ...[
            '/a?b', '/a#b', '/:id', '/any*', '/raw space', '/\u96EA',
            '/a/./b', '/a/../b', '/a/%2e/b', '/a/%2E%2E/b', '/a\\b',
            '/%', '/%2', '/%G0', '/%zz',
            '/a\nb', '/a\rb', '/a\tb', '/a\u0000b', '/a\u007Fb',
        ].map(path => ({ '/good': source, [path]: () => new Response() })),
        ...[true, null, 42, used, locked, new Map(), new Date(), { get() {} }, { TRACE() {} }, { GET: false }, { POST: 42 }]
            .map(value => ({ '/good': source, '/bad': value })),
    ];
    for (const routes of invalidRoutes) assert.throws(() => serve({ routes }), TypeError);
    assert.throws(() => serve({ routes: { '/good': source }, port: -1 }), RangeError);
    assert.throws(() => serve({ routes: { '/good': source }, hostname: '%' }), TypeError);
    assert.throws(() => serve({ routes: { '/good': source }, error: 42 }), TypeError);
    assert.equal(clones, 0);
    assert.equal(source.bodyUsed, false);
    assert.equal(mock.bindings.length, 0);
});

test('serve routes: invalid reload preserves routes, fetch, and error handlers', async t => {
    const mock = host(t);
    const server = serve({
        routes: { '/old': () => { throw new Error('old route'); } },
        fetch() { throw new Error('old fetch'); },
        error(error) { return new Response(error.message, { status: 409 }); },
    });
    const source = new Response('unused');
    let clones = 0;
    source.clone = () => { clones++; throw new Error('must validate first'); };
    const replacement = () => new Response('replacement');
    for (const invalid of [
        { routes: { '/new': source, '/bad': 42 }, fetch: replacement, error: replacement },
        { routes: { '/new': source }, fetch: replacement, error: 42 },
        { routes: { '/new': source }, fetch: replacement, port: -1 },
    ]) assert.throws(() => server.reload(invalid));
    assert.equal(clones, 0);
    for (const [path, text] of [['/old', 'old route'], ['/new', 'old fetch']]) {
        const response = await mock.request(path);
        assert.equal(response.status, 409);
        assert.equal(await response.text(), text);
    }
    assert.equal(mock.bindings.length, 1);
});

test('serve routes: stream failures and byte/read limits are cached without more pulls', { timeout: 10000 }, async t => {
    const mock = host(t);
    let fail;
    const broken = new Response(new ReadableStream({ start(controller) { fail = controller; } }));
    const chunk = new Uint8Array(64 * 1024);
    let chunks = 0;
    const oversized = new Response(new ReadableStream({
        pull(controller) {
            controller.enqueue(chunk);
            chunks++;
        },
    }, { highWaterMark: 0 }));
    const emptyChunk = new Uint8Array(0);
    let emptyChunks = 0;
    const empty = new Response(new ReadableStream({
        pull(controller) { controller.enqueue(emptyChunk); emptyChunks++; },
    }, { highWaterMark: 0 }));
    t.after(() => {
        void oversized.body.cancel().catch(() => {});
        void empty.body.cancel().catch(() => {});
    });
    let errors = 0;
    serve({
        routes: { '/broken': broken, '/large': oversized, '/empty': empty },
        error(error) { errors++; return new Response(error.message, { status: 503 }); },
    });
    const pending = Promise.all([mock.request('/broken'), mock.request('/broken')]);
    fail.error(new Error('broken static body'));
    for (const response of await pending) {
        assert.equal(response.status, 503);
        assert.match(await response.text(), /broken static body/);
    }
    for (const [path, pattern, pulls] of [
        ['/large', /16\s*MiB/, () => chunks],
        ['/empty', /16,?384/, () => emptyChunks],
    ]) {
        const response = await mock.request(path);
        assert.equal(response.status, 503);
        assert.match(await response.text(), pattern);
        await new Promise(resolve => setImmediate(resolve));
        const stoppedAt = pulls();
        const repeated = await mock.request(path);
        assert.equal(repeated.status, 503);
        assert.match(await repeated.text(), pattern);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(pulls(), stoppedAt, 'cached failures must not restart reading');
    }
    assert.ok(chunks >= 257);
    assert.ok(emptyChunks >= 16385 && emptyChunks < 16400, `unexpected empty chunk reads: ${emptyChunks}`);
    assert.equal(errors, 6);
});

test('serve routes: replacement, stop, and startup failure cancel unused snapshots', { timeout: 5000 }, async t => {
    const mock = host(t);
    for (const action of ['replace', 'stop', 'bind-failure', 'clone-failure']) {
        const pending = pendingStatic(t);
        if (action === 'clone-failure') {
            const failing = new Response('unused');
            failing.clone = () => { throw new Error('clone failure'); };
            assert.throws(() => serve({ routes: { '/pending': pending.source, '/bad': failing } }), /clone failure/);
        } else if (action === 'bind-failure') {
            const bind = globalThis.Deno.serve;
            globalThis.Deno.serve = () => { throw new Error('bind failure'); };
            try {
                assert.throws(() => serve({ routes: { '/pending': pending.source } }), /bind failure/);
            } finally {
                globalThis.Deno.serve = bind;
            }
        } else {
            const server = serve({ routes: { '/pending': pending.source } });
            if (action === 'replace') server.reload({ routes: {} });
            else await server.stop();
            await server.stop();
        }
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(pending.cancellations, 1, action);
        assert.equal(pending.snapshot.body.locked, false, action);
    }
    assert.equal(mock.shutdowns, 2);
});

test('serve routes: replacement preserves a snapshot already used by an inflight request', { timeout: 5000 }, async t => {
    const mock = host(t);
    const pending = pendingStatic(t);
    const server = serve({ routes: { '/pending': pending.source } });
    const response = mock.request('/pending');
    server.reload({ routes: {} });
    assert.equal(pending.cancellations, 0);
    assert.equal((await mock.request('/pending')).status, 404);
    pending.finish('old request completed');
    assert.equal(await (await response).text(), 'old request completed');
    assert.equal(pending.cancellations, 0);
    await server.stop();
});

test('serve routes: option getters run once and stopped servers reject new routes before cloning', async t => {
    const mock = host(t);
    let reads = 0;
    const server = serve({ get routes() { reads++; return {}; } });
    assert.equal(reads, 1);
    server.reload({ get routes() { reads++; return { '/old': () => new Response('old') }; } });
    assert.equal(reads, 2);
    assert.equal(await (await mock.request('/old')).text(), 'old');
    const stopped = server.stop();
    await stopped;
    assert.equal(server.reload({}), server);
    assert.equal(server.reload({ get routes() { reads++; return undefined; } }), server);
    assert.equal(reads, 3);
    const source = new Response('unused');
    let clones = 0;
    source.clone = () => { clones++; throw new Error('must reject before cloning'); };
    assert.throws(() => server.reload({ get routes() { reads++; return { '/new': source }; } }), /stopp/i);
    assert.equal(reads, 4);
    assert.equal(clones, 0);
    assert.equal(source.bodyUsed, false);
    assert.equal(server.stop(), stopped);
    assert.equal(mock.shutdowns, 1);
});
