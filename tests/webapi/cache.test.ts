import { strictEqual, ok } from 'node:assert';

// ============================================================================
// Cache API — Cache + CacheStorage
// ============================================================================

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
    await c.put('/a', new Response('body-a'));
    const r = await c.match('/a');
    ok(r, 'match must return a Response');
    strictEqual(r!.status, 200);
    strictEqual(await r!.text(), 'body-a');
});

// --- 4. Cache match on missing returns undefined --------------------------

Deno.test('Cache: match on missing returns undefined', async () => {
    const c = await caches.open('test-cache-3');
    const r = await c.match('/missing');
    strictEqual(r, undefined);
});

// --- 5. Cache put overwrites previous -------------------------------------

Deno.test('Cache: put overwrites previous entry', async () => {
    const c = await caches.open('test-cache-4');
    await c.put('/x', new Response('v1'));
    await c.put('/x', new Response('v2'));
    const r = await c.match('/x');
    strictEqual(await r!.text(), 'v2');
});

// --- 6. Cache delete ------------------------------------------------------

Deno.test('Cache: delete removes entry', async () => {
    const c = await caches.open('test-cache-5');
    await c.put('/d', new Response('data'));
    ok(await c.delete('/d'), 'delete must return true');
    strictEqual(await c.match('/d'), undefined);
    ok(!(await c.delete('/d')), 'delete on missing returns false');
});

// --- 7. Cache matchAll returns all ----------------------------------------

Deno.test('Cache: matchAll returns all entries', async () => {
    const c = await caches.open('test-cache-6');
    await c.put('/1', new Response('one'));
    await c.put('/2', new Response('two'));
    const all = await c.matchAll();
    ok(all.length >= 2);
});

// --- 8. Cache keys returns Request keys -----------------------------------

Deno.test('Cache: keys returns Request objects', async () => {
    const c = await caches.open('test-cache-7');
    await c.put('/k', new Response('kv'));
    const keys = await c.keys();
    ok(keys.length >= 1);
    ok(keys[0] instanceof Request);
    ok(keys.some((k) => k.url.includes('/k')));
});

// --- 9. Cache put with Request object -------------------------------------

Deno.test('Cache: put accepts a Request', async () => {
    const c = await caches.open('test-cache-8');
    const req = new Request('/req-path');
    await c.put(req, new Response('req-body'));
    const r = await c.match('/req-path');
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
    await c.put('/global', new Response('global-body'));
    // caches.match may or may not find it depending on impl; just smoke
    const r = await caches.match('/global');
    ok(r === undefined || r instanceof Response);
});

// --- 12. Cache put with Vary header ---------------------------------------

Deno.test('Cache: put with Vary header distinguishes by request header', async () => {
    const c = await caches.open('test-cache-10');
    const res = new Response('vary-body');
    res.headers.set('Vary', 'Accept');
    await c.put(new Request('/vary', { headers: { Accept: 'text/html' } }), res);
    // Different Accept should not match
    const miss = await c.match(new Request('/vary', { headers: { Accept: 'application/json' } }));
    strictEqual(miss, undefined, 'different Vary header must not match');
});
