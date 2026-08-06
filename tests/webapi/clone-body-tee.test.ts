// Response.clone() / Request.clone() must not consume the ORIGINAL's body.
//
// The defect these cover: `trackBodyStream` installs a wrapping `getReader` as an
// own property of the body stream to mark the body used. `clone()` then called
// `tee()` on that already-patched stream, and cno's tee acquires its single source
// reader through the public `getReader` (cno/src/webapi/streams.ts:604). So every
// pull the CLONE made ran the ORIGINAL's markUsed, and the original threw
// "Already read" with its bytes still intact.
//
// Order-dependent, which is why it hid: reading the original first was fine.
// Reading the clone first destroyed the original -- exactly what a service-worker
// style `cache.put(req, res.clone()); return res;` does.
//
// Every expectation below was measured against node v24.18.0.

import { strictEqual } from 'node:assert';

/** A stream body, so the clone path cannot short-circuit through a buffer. */
function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
        start(c) {
            for (const p of parts) c.enqueue(enc.encode(p));
            c.close();
        },
    });
}

Deno.test({ name: 'Response.clone: reading the clone leaves the original readable', timeout: 10000 }, async () => {
    const r = new Response('PAYLOAD');
    const c = r.clone();
    strictEqual(await c.text(), 'PAYLOAD');
    // The regression: this was TRUE, and the next line threw "Already read".
    strictEqual(r.bodyUsed, false);
    strictEqual(await r.text(), 'PAYLOAD');
});

Deno.test({ name: 'Response.clone: reading the original leaves the clone readable', timeout: 10000 }, async () => {
    const r = new Response('PAYLOAD');
    const c = r.clone();
    strictEqual(await r.text(), 'PAYLOAD');
    strictEqual(await c.text(), 'PAYLOAD');
});

Deno.test({ name: 'Response.clone: service-worker cache pattern serves the original', timeout: 10000 }, async () => {
    const res = new Response('CACHED-VALUE', { headers: { 'x-h': '1' } });
    const forCache = res.clone();
    const stored = await forCache.arrayBuffer();
    strictEqual(stored.byteLength, 12);
    // `return res` after caching the clone.
    strictEqual(await res.text(), 'CACHED-VALUE');
});

Deno.test({ name: 'Response.clone: two clones and the original are all independently readable', timeout: 10000 }, async () => {
    const r = new Response('PAYLOAD');
    const c1 = r.clone();
    const c2 = r.clone();
    strictEqual(await c1.text(), 'PAYLOAD');
    strictEqual(await c2.text(), 'PAYLOAD');
    strictEqual(await r.text(), 'PAYLOAD');
});

Deno.test({ name: 'Response.clone: a clone can itself be cloned', timeout: 10000 }, async () => {
    const r = new Response('PAYLOAD');
    const c = r.clone();
    const cc = c.clone();
    strictEqual(await cc.text(), 'PAYLOAD');
    strictEqual(await c.text(), 'PAYLOAD');
    strictEqual(await r.text(), 'PAYLOAD');
});

Deno.test({ name: 'Response.clone: headers and status survive the clone', timeout: 10000 }, async () => {
    const r = new Response('PAYLOAD', { status: 201, statusText: 'Made', headers: { 'x-h': 'v' } });
    const c = r.clone();
    strictEqual(c.status, 201);
    strictEqual(c.statusText, 'Made');
    strictEqual(c.headers.get('x-h'), 'v');
    strictEqual(await c.text(), 'PAYLOAD');
    strictEqual(await r.text(), 'PAYLOAD');
});

Deno.test({ name: 'Response.clone: a stream body clone does not disturb the original', timeout: 10000 }, async () => {
    const r = new Response(streamOf('PAY', 'LOAD'));
    const c = r.clone();
    strictEqual(await c.text(), 'PAYLOAD');
    strictEqual(r.bodyUsed, false);
    strictEqual(await r.text(), 'PAYLOAD');
});

// ---------------------------------------------------------------- unchanged rows
// These already matched node before the fix. They are here so that a future change
// to teeUntracked cannot quietly relax them.

Deno.test({ name: 'Response.clone: cloning a consumed body still rejects', timeout: 10000 }, async () => {
    const r = new Response('PAYLOAD');
    const reader = r.body!.getReader();
    while (true) {
        const { done } = await reader.read();
        if (done) break;
    }
    reader.releaseLock();
    strictEqual(r.bodyUsed, true);
    let threw = '';
    try { r.clone(); } catch (e) { threw = (e as Error).constructor.name; }
    strictEqual(threw, 'TypeError');
});

Deno.test({ name: 'Response.clone: cloning after text() rejects', timeout: 10000 }, async () => {
    const r = new Response('PAYLOAD');
    strictEqual(await r.text(), 'PAYLOAD');
    let threw = '';
    try { r.clone(); } catch (e) { threw = (e as Error).constructor.name; }
    strictEqual(threw, 'TypeError');
});

Deno.test({ name: 'Response.clone: a null body clones to a null body', timeout: 10000 }, async () => {
    const r = new Response(null);
    const c = r.clone();
    strictEqual(c.body, null);
    strictEqual(r.body, null);
    strictEqual(await c.text(), '');
    strictEqual(await r.text(), '');
});

Deno.test({ name: 'Response.body: a direct tee still marks the body used', timeout: 10000 }, async () => {
    // Load-bearing: consumption tracking must stay visible to a caller who tees the
    // body themselves. Only clone()'s internal tee bypasses it.
    const r = new Response('PAYLOAD');
    const [a, b] = r.body!.tee();
    strictEqual(r.bodyUsed, false);
    const rd = b.getReader();
    while (true) {
        const { done } = await rd.read();
        if (done) break;
    }
    strictEqual(r.bodyUsed, true);
    void a;
});

// ------------------------------------------------------------------------ Request
// Request.clone() was reported as already correct. It is -- but only for a
// serialisable body, which request.ts buffers at construction so clone() never
// tees. With a ReadableStream body it had the identical defect.

Deno.test({ name: 'Request.clone: a stream body clone does not consume the original', timeout: 10000 }, async () => {
    const q = new Request('http://x/', { method: 'POST', body: streamOf('REQ', 'BODY'), duplex: 'half' } as RequestInit);
    const c = q.clone();
    strictEqual(await c.text(), 'REQBODY');
    strictEqual(q.bodyUsed, false);
    strictEqual(await q.text(), 'REQBODY');
});

Deno.test({ name: 'Request.clone: a string body clone works in either order', timeout: 10000 }, async () => {
    const a = new Request('http://x/', { method: 'POST', body: 'REQBODY' });
    const ac = a.clone();
    strictEqual(await ac.text(), 'REQBODY');
    strictEqual(await a.text(), 'REQBODY');

    const b = new Request('http://x/', { method: 'POST', body: 'REQBODY' });
    const bc = b.clone();
    strictEqual(await b.text(), 'REQBODY');
    strictEqual(await bc.text(), 'REQBODY');
});

Deno.test({ name: 'Request.clone: cloning a consumed body rejects', timeout: 10000 }, async () => {
    const q = new Request('http://x/', { method: 'POST', body: 'REQBODY' });
    strictEqual(await q.text(), 'REQBODY');
    let threw = '';
    try { q.clone(); } catch (e) { threw = (e as Error).constructor.name; }
    strictEqual(threw, 'TypeError');
});

Deno.test({ name: 'Request.clone: method, url and headers survive', timeout: 10000 }, async () => {
    const q = new Request('http://x/p', { method: 'POST', body: 'REQBODY', headers: { 'x-h': 'v' } });
    const c = q.clone();
    strictEqual(c.method, 'POST');
    strictEqual(c.url, 'http://x/p');
    strictEqual(c.headers.get('x-h'), 'v');
    strictEqual(await c.text(), 'REQBODY');
    strictEqual(await q.text(), 'REQBODY');
});
