import { deepStrictEqual, rejects, strictEqual, ok, throws } from 'node:assert';

// ============================================================================
// Cache API — Cache + CacheStorage
// ============================================================================
//
// Cache keys must be ABSOLUTE URLs in a server-side runtime.
//
// The Fetch spec parses the `Request` constructor's string `input` "with
// baseURL as base", where baseURL is the *entry settings object's API base
// URL*. In a browser that is the document URL, so `new Request('/a')` resolves
// against it. Neither cno, Node, nor Deno has a document, so there is no base
// URL and a scheme-relative path cannot be parsed. Per the Cache API spec,
// `Cache.put`/`match`/`delete`/`keys` funnel a string key through that same
// `Request` constructor, so the requirement propagates to every cache key.
//
// OBSERVED 2026-08-02:
//   node -e "new Request('/a')"
//     -> TypeError: Failed to parse URL from /a
//   deno: new Request('/a')
//     -> TypeError: Invalid URL: '/a'
//   deno: (await caches.open(n)).put('/a', new Response('body-a'))
//     -> TypeError: Invalid URL: '/a'
//
// cno's `parseRequestUrl` (cno/src/webapi/fetch/request.ts) now throws the
// byte-identical Node message, so these tests were converted from relative to
// absolute keys. They previously asserted pre-fix behaviour, where `this.url`
// was assigned the raw input unparsed.
const BASE = 'https://cache-test.example';

// --- 1. caches global exists ----------------------------------------------

Deno.test('caches: global exists', () => {
    ok(caches && typeof caches === 'object');
    ok(typeof caches.open === 'function');
});

// --- 2. caches.open creates / returns a Cache -----------------------------

Deno.test('caches.open: returns a Cache', async () => {
    const c = await caches.open('test-cache-1');
    ok(c && typeof c === 'object');
    ok(typeof c.put === 'function');
    ok(typeof c.match === 'function');
});

// --- 3. Cache put + match round-trip --------------------------------------

Deno.test('Cache: put then match returns the Response', async () => {
    const c = await caches.open('test-cache-2');
    await c.put(`${BASE}/a`, new Response('body-a'));
    const r = await c.match(`${BASE}/a`);
    ok(r, 'match must return a Response');
    strictEqual(r!.status, 200);
    strictEqual(await r!.text(), 'body-a');
});

// --- 4. Cache match on missing returns undefined --------------------------

Deno.test('Cache: match on missing returns undefined', async () => {
    const c = await caches.open('test-cache-3');
    const r = await c.match(`${BASE}/missing`);
    strictEqual(r, undefined);
});

// --- 5. Cache put overwrites previous -------------------------------------

Deno.test('Cache: put overwrites previous entry', async () => {
    const c = await caches.open('test-cache-4');
    await c.put(`${BASE}/x`, new Response('v1'));
    await c.put(`${BASE}/x`, new Response('v2'));
    const r = await c.match(`${BASE}/x`);
    strictEqual(await r!.text(), 'v2');
});

// --- 6. Cache delete ------------------------------------------------------

Deno.test('Cache: delete removes entry', async () => {
    const c = await caches.open('test-cache-5');
    await c.put(`${BASE}/d`, new Response('data'));
    ok(await c.delete(`${BASE}/d`), 'delete must return true');
    strictEqual(await c.match(`${BASE}/d`), undefined);
    ok(!(await c.delete(`${BASE}/d`)), 'delete on missing returns false');
});

// --- 7. Cache matchAll returns all ----------------------------------------

Deno.test('Cache: matchAll returns all entries', async () => {
    const c = await caches.open('test-cache-6');
    await c.put(`${BASE}/1`, new Response('one'));
    await c.put(`${BASE}/2`, new Response('two'));
    const all = await c.matchAll();
    ok(all.length >= 2);
});

// --- 8. Cache keys returns Request keys -----------------------------------

Deno.test('Cache: keys returns Request objects', async () => {
    const c = await caches.open('test-cache-7');
    await c.put(`${BASE}/k`, new Response('kv'));
    const keys = await c.keys();
    ok(keys.length >= 1);
    ok(keys[0] instanceof Request);
    ok(keys.some((k) => k.url.includes('/k')));
});

// --- 9. Cache put with Request object -------------------------------------

Deno.test('Cache: put accepts a Request', async () => {
    const c = await caches.open('test-cache-8');
    const req = new Request(`${BASE}/req-path`);
    await c.put(req, new Response('req-body'));
    const r = await c.match(`${BASE}/req-path`);
    strictEqual(await r!.text(), 'req-body');
});

// --- 10. CacheStorage has / delete / keys ---------------------------------

Deno.test('caches: has/delete/keys manage cache names', async () => {
    await caches.open('my-cache');
    ok(await caches.has('my-cache'));
    ok(await caches.delete('my-cache'));
    ok(!(await caches.has('my-cache')));
    const keys = await caches.keys();
    ok(Array.isArray(keys));
});

// --- 11. caches.match (global) delegates ----------------------------------

Deno.test('caches.match: global match across caches', async () => {
    const c = await caches.open('test-cache-9');
    await c.put(`${BASE}/global`, new Response('global-body'));
    // Oracle: Deno 2.9.3 returns the stored Response with its body intact
    // (`deno eval` on this same sequence prints "Response body=gb"), so a
    // global match MUST hit. The previous `r === undefined || r instanceof
    // Response` accepted a total miss and could never fail.
    const r = await caches.match(`${BASE}/global`);
    ok(r instanceof Response, 'caches.match must find a response put into an open cache');
    strictEqual(await r.text(), 'global-body');
});

// --- 12. Cache put with Vary header ---------------------------------------

Deno.test('Cache: put with Vary header distinguishes by request header', async () => {
    const c = await caches.open('test-cache-10');
    const res = new Response('vary-body');
    res.headers.set('Vary', 'Accept');
    await c.put(new Request(`${BASE}/vary`, { headers: { Accept: 'text/html' } }), res);
    // Different Accept should not match
    const miss = await c.match(new Request(`${BASE}/vary`, { headers: { Accept: 'application/json' } }));
    strictEqual(miss, undefined, 'different Vary header must not match');
});

// --- 13. relative keys are rejected, matching Node and Deno ----------------
//
// Pins the contract the tests above were converted for. A server-side runtime
// has no API base URL, so a scheme-relative key cannot be resolved.
// OBSERVED: Node v24.18.0 throws `TypeError: Failed to parse URL from /a`;
// Deno 2.9.3 throws `TypeError: Invalid URL: '/a'` from both `new Request` and
// `Cache.put`. cno matches Node's message byte-for-byte.

Deno.test('Cache: relative keys are rejected because there is no base URL', async () => {
    throws(() => new Request('/a'), TypeError);
    throws(() => new Request('/a'), /Failed to parse URL from \/a/);

    const cacheName = `test-cache-relative-${Deno.pid}-${Date.now()}`;
    const c = await caches.open(cacheName);
    try {
        await rejects(c.put('/a', new Response('body-a')), TypeError);
        await rejects(c.match('/a') as Promise<unknown>, TypeError);
        await rejects(c.delete('/a') as Promise<unknown>, TypeError);
    } finally {
        await caches.delete(cacheName);
    }
});

Deno.test('Cache upstream: Cache is an illegal constructor', () => {
    throws(() => new (Cache as unknown as { new(): Cache })(), TypeError);
    throws(() => new (Cache as unknown as { new(name: string): Cache })('x'), TypeError);
});

Deno.test('Cache upstream: string URL and Request keys round-trip independently', async () => {
    const cacheName = `test-cache-upstream-keys-${Deno.pid}-${Date.now()}`;
    const c = await caches.open(cacheName);
    try {
        await c.put('https://example.com/string', new Response('string-key'));
        strictEqual(await (await c.match('https://example.com/string'))?.text(), 'string-key');
        ok(await c.delete('https://example.com/string'));

        await c.put(new URL('https://example.com/url'), new Response('url-key'));
        strictEqual(await (await c.match('https://example.com/url'))?.text(), 'url-key');
        ok(await c.delete('https://example.com/url'));

        const request = new Request('https://example.com/request');
        await c.put(request, new Response('request-key'));
        strictEqual(await (await c.match('https://example.com/request'))?.text(), 'request-key');
        ok(await c.delete(request));
    } finally {
        await caches.delete(cacheName);
    }
});

Deno.test('Cache upstream: Vary star is rejected and Vary headers select matching requests', async () => {
    const cacheName = `test-cache-upstream-vary-${Deno.pid}-${Date.now()}`;
    const c = await caches.open(cacheName);
    try {
        await rejects(
            c.put('https://example.com/star', new Response('bad', { headers: { Vary: '*' } })),
            TypeError,
        );

        await c.put(
            new Request('https://example.com/vary', { headers: { Accept: 'application/json' } }),
            Response.json({ msg: 'hello world' }, {
                headers: {
                    'Content-Type': 'application/json',
                    Vary: 'Accept',
                },
            }),
        );

        strictEqual(await c.match('https://example.com/vary'), undefined);
        strictEqual(await c.match(new Request('https://example.com/vary', {
            headers: { Accept: 'text/html' },
        })), undefined);
        deepStrictEqual(await (await c.match(new Request('https://example.com/vary', {
            headers: { Accept: 'application/json' },
        })))?.json(), { msg: 'hello world' });
    } finally {
        await caches.delete(cacheName);
    }
});

Deno.test('Cache upstream: put marks the source response consumed while storing', async () => {
    const cacheName = `test-cache-upstream-consumed-${Deno.pid}-${Date.now()}`;
    const c = await caches.open(cacheName);
    try {
        const response = new Response('consumed');
        const put = c.put(new Request('https://example.com/consumed'), response);
        await rejects(response.arrayBuffer(), TypeError);
        await put;
        strictEqual(await (await c.match('https://example.com/consumed'))?.text(), 'consumed');
    } finally {
        await caches.delete(cacheName);
    }
});

Deno.test('Cache upstream: failed response bodies are not cached', async () => {
    const cacheName = `test-cache-upstream-failed-${Deno.pid}-${Date.now()}`;
    const c = await caches.open(cacheName);
    try {
        const request = new Request('https://example.com/failed-body');
        const stream = new ReadableStream({
            start(controller) {
                controller.error(new Error('corrupt'));
            },
        });

        await rejects(c.put(request, new Response(stream)), /corrupt/);
        strictEqual(await c.match(request), undefined);
    } finally {
        await caches.delete(cacheName);
    }
});

Deno.test('Cache upstream: put stores a response backed by a file resource', async () => {
    const cacheName = `test-cache-upstream-resource-${Deno.pid}-${Date.now()}`;
    const tempFile = await Deno.makeTempFile({ prefix: 'cno-cache-resource-', suffix: '.txt' });
    const payload = 'Contents'.repeat(1024);
    const c = await caches.open(cacheName);
    let file: Deno.FsFile | undefined;
    try {
        await Deno.writeTextFile(tempFile, payload);
        file = await Deno.open(tempFile);
        const request = new Request('https://example.com/file-resource');
        await c.put(request, new Response(file.readable));
        strictEqual(await (await c.match(request))?.text(), payload);
    } finally {
        try {
            file?.close();
        } catch {}
        await caches.delete(cacheName);
        await Deno.remove(tempFile).catch(() => {});
    }
});

Deno.test('Cache upstream: put rejects non-GET before consuming the response', async () => {
    const cacheName = `test-cache-upstream-put-method-${Deno.pid}-${Date.now()}`;
    const c = await caches.open(cacheName);
    try {
        const response = new Response('post-body');
        await rejects(
            c.put(new Request('https://example.com/post', { method: 'POST', body: 'request-body' }), response),
            TypeError,
        );
        strictEqual(response.bodyUsed, false);
        strictEqual(await c.match('https://example.com/post'), undefined);
    } finally {
        await caches.delete(cacheName);
    }
});

Deno.test('Cache upstream: add fetches GET responses without consuming caller request', async () => {
    const originalFetch = globalThis.fetch;
    const cacheName = `test-cache-upstream-add-${Deno.pid}-${Date.now()}`;
    const c = await caches.open(cacheName);
    const seen: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        seen.push(`${request.method} ${request.url} ${request.headers.get('x-token')}`);
        return new Response(`fetched:${new URL(request.url).pathname}`);
    };

    try {
        const request = new Request('https://example.com/add', { headers: { 'x-token': 'yes' } });
        await c.add(request);
        strictEqual(request.bodyUsed, false);
        strictEqual(await (await c.match(request))?.text(), 'fetched:/add');
        deepStrictEqual(seen, ['GET https://example.com/add yes']);
    } finally {
        globalThis.fetch = originalFetch;
        await caches.delete(cacheName);
    }
});

Deno.test('Cache upstream: add and addAll reject non-GET and failed fetches without storing', async () => {
    const originalFetch = globalThis.fetch;
    const cacheName = `test-cache-upstream-addall-${Deno.pid}-${Date.now()}`;
    const c = await caches.open(cacheName);
    let fetchCalls = 0;
    globalThis.fetch = async (input: RequestInfo | URL) => {
        fetchCalls++;
        const request = input instanceof Request ? input : new Request(input);
        const path = new URL(request.url).pathname;
        if (path === '/bad') return new Response('bad', { status: 500 });
        return new Response(`ok:${path}`);
    };

    try {
        await rejects(
            c.add(new Request('https://example.com/post', { method: 'POST', body: 'request-body' })),
            TypeError,
        );
        strictEqual(fetchCalls, 0);

        await rejects(c.add('https://example.com/bad'), TypeError);
        strictEqual(await c.match('https://example.com/bad'), undefined);

        await rejects(c.addAll([
            'https://example.com/one',
            'https://example.com/bad',
        ]), TypeError);
        strictEqual(await c.match('https://example.com/one'), undefined);

        await c.addAll([
            'https://example.com/one',
            new Request('https://example.com/two'),
        ]);
        strictEqual(await (await c.match('https://example.com/one'))?.text(), 'ok:/one');
        strictEqual(await (await c.match('https://example.com/two'))?.text(), 'ok:/two');
    } finally {
        globalThis.fetch = originalFetch;
        await caches.delete(cacheName);
    }
});

Deno.test('Cache upstream: match honors ignoreSearch and method filtering', async () => {
    const cacheName = `test-cache-upstream-query-options-${Deno.pid}-${Date.now()}`;
    const c = await caches.open(cacheName);
    try {
        await c.put('https://example.com/item?version=1', new Response('v1'));

        strictEqual(await c.match('https://example.com/item?version=2'), undefined);
        strictEqual(await (await c.match('https://example.com/item?version=2', { ignoreSearch: true }))?.text(), 'v1');

        const post = new Request('https://example.com/item?version=1', { method: 'POST', body: 'post-body' });
        strictEqual(await c.match(post), undefined);
        strictEqual(await (await c.match(post, { ignoreMethod: true }))?.text(), 'v1');
    } finally {
        await caches.delete(cacheName);
    }
});

Deno.test('Cache upstream: ignoreVary bypasses stored Vary header checks', async () => {
    const cacheName = `test-cache-upstream-ignore-vary-${Deno.pid}-${Date.now()}`;
    const c = await caches.open(cacheName);
    try {
        await c.put(
            new Request('https://example.com/vary-options', { headers: { Accept: 'text/plain' } }),
            new Response('plain', { headers: { Vary: 'Accept' } }),
        );

        const htmlRequest = new Request('https://example.com/vary-options', { headers: { Accept: 'text/html' } });
        strictEqual(await c.match(htmlRequest), undefined);
        strictEqual(await (await c.match(htmlRequest, { ignoreVary: true }))?.text(), 'plain');
    } finally {
        await caches.delete(cacheName);
    }
});

Deno.test('Cache upstream: matchAll delete and keys share query option semantics', async () => {
    const cacheName = `test-cache-upstream-shared-options-${Deno.pid}-${Date.now()}`;
    const c = await caches.open(cacheName);
    try {
        await c.put('https://example.com/list?one', new Response('one'));
        await c.put('https://example.com/list?two', new Response('two'));

        strictEqual((await c.matchAll('https://example.com/list?missing')).length, 0);
        strictEqual((await c.matchAll('https://example.com/list?missing', { ignoreSearch: true })).length, 2);
        strictEqual((await c.keys('https://example.com/list?missing', { ignoreSearch: true })).length, 2);

        ok(await c.delete('https://example.com/list?missing', { ignoreSearch: true }));
        strictEqual((await c.matchAll()).length, 0);
    } finally {
        await caches.delete(cacheName);
    }
});

Deno.test('Cache upstream: keys returns request copies instead of internal cache keys', async () => {
    const cacheName = `test-cache-upstream-key-copies-${Deno.pid}-${Date.now()}`;
    const c = await caches.open(cacheName);
    try {
        const url = 'https://example.com/key-copy';
        const storedRequest = new Request(url, { headers: { Accept: 'application/json' } });
        await c.put(storedRequest, new Response('json', { headers: { Vary: 'Accept' } }));

        const [allKey] = await c.keys();
        const [filteredKey] = await c.keys(new Request(url, { headers: { Accept: 'application/json' } }));
        ok(allKey);
        ok(filteredKey);
        allKey.headers.set('accept', 'text/html');
        filteredKey.headers.set('accept', 'text/html');

        strictEqual(
            await (await c.match(new Request(url, { headers: { Accept: 'application/json' } })))?.text(),
            'json',
        );
        strictEqual(await c.match(new Request(url, { headers: { Accept: 'text/html' } })), undefined);
    } finally {
        await caches.delete(cacheName);
    }
});

Deno.test('CacheStorage upstream: match respects cacheName and query options', async () => {
    const firstName = `test-cache-upstream-storage-a-${Deno.pid}-${Date.now()}`;
    const secondName = `test-cache-upstream-storage-b-${Deno.pid}-${Date.now()}`;
    const first = await caches.open(firstName);
    const second = await caches.open(secondName);
    try {
        await first.put('https://example.com/shared?first', new Response('first'));
        await second.put('https://example.com/shared?second', new Response('second'));

        strictEqual(
            await (await caches.match('https://example.com/shared?miss', {
                cacheName: secondName,
                ignoreSearch: true,
            }))?.text(),
            'second',
        );
        strictEqual(await caches.match('https://example.com/shared?miss', { cacheName: 'missing', ignoreSearch: true }), undefined);
    } finally {
        await caches.delete(firstName);
        await caches.delete(secondName);
    }
});
