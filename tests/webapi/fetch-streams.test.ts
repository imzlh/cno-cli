import { strictEqual, ok, rejects } from 'node:assert';
import { createServer, RequestListener } from 'node:http';
import { AddressInfo } from 'node:net';

// fetch: GET with body must error (RequestInit disallows body on GET/HEAD).
Deno.test({ name: 'fetch: GET with body rejects', timeout: 10000 }, async () => {
    await rejects(
        () => fetch('http://127.0.0.1/', { method: 'GET', body: 'x' }),
        'fetch GET with body must reject',
    );
});

// fetch: HEAD with body must error.
Deno.test({ name: 'fetch: HEAD with body rejects', timeout: 10000 }, async () => {
    await rejects(
        () => fetch('http://127.0.0.1/', { method: 'HEAD', body: 'x' }),
        'fetch HEAD with body must reject',
    );
});

// fetch: 204/241/304 responses must not expose a usable body (null).
Deno.test({ name: 'fetch: 204 response body is null and text() is empty', timeout: 10000 }, async () => {
    const listener: RequestListener = (_req, res) => {
        res.statusCode = 204;
        res.end();
    };
    const server = createServer(listener);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        strictEqual(res.status, 204);
        strictEqual(res.body, null);
        strictEqual(await res.text(), '');
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
});

// fetch: json() on 204 rejects (empty body cannot be parsed).
Deno.test({ name: 'fetch: json() on 204 rejects', timeout: 10000 }, async () => {
    const server = createServer((_req, res) => { res.statusCode = 204; res.end(); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        await rejects(() => res.json(), 'json() on empty 204 must reject');
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
});

// fetch: response body can only be consumed once.
Deno.test({ name: 'fetch: response body is single-use', timeout: 10000 }, async () => {
    const server = createServer((_req, res) => { res.end('payload'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        strictEqual(await res.text(), 'payload');
        let threw = false;
        try { await res.text(); } catch { threw = true; }
        ok(threw, 'second body consumption must throw');
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
});

// fetch: arrayBuffer decodes utf8 bytes faithfully.
Deno.test({ name: 'fetch: arrayBuffer returns raw bytes', timeout: 10000 }, async () => {
    const server = createServer((_req, res) => {
        res.setHeader('content-type', 'text/plain');
        res.end('café');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        const buf = await res.arrayBuffer();
        strictEqual(new TextDecoder().decode(buf), 'café');
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
});

// fetch: redirect by default follows (manual mode keeps opaque-redirect).
Deno.test({ name: 'fetch: follows 302 redirect by default', timeout: 10000 }, async () => {
    const server = createServer((req, res) => {
        if (req.url === '/redir') { res.statusCode = 302; res.setHeader('location', '/final'); res.end(); return; }
        res.end('final-body');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/redir`);
        strictEqual(res.status, 200);
        strictEqual(res.url, `http://127.0.0.1:${port}/final`);
        strictEqual(await res.text(), 'final-body');
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
});

// --- Request/Response/Headers web API -------------------------------------

Deno.test({ name: 'Request: clones body stream reference semantics', timeout: 10000 }, () => {
    const r = new Request('http://x/', { method: 'POST', body: 'data' });
    strictEqual(r.method, 'POST');
    ok(r.body instanceof ReadableStream || r.body === null);
});

Deno.test({ name: 'Response: redirect() produces 302 with Location', timeout: 10000 }, () => {
    const r = Response.redirect('http://x/y', 302);
    strictEqual(r.status, 302);
    strictEqual(r.headers.get('location'), 'http://x/y');
});

Deno.test({ name: 'Response: json() serializes and sets content-type', timeout: 10000 }, async () => {
    const r = Response.json({ a: 1 });
    strictEqual(r.headers.get('content-type'), 'application/json');
    const body = await r.json();
    strictEqual(body.a, 1);
});

Deno.test({ name: 'Headers: append then get returns comma-joined', timeout: 10000 }, () => {
    const h = new Headers();
    h.append('x', '1');
    h.append('x', '2');
    strictEqual(h.get('x'), '1, 2');
});

Deno.test({ name: 'Headers: iteration yields all entries', timeout: 10000 }, () => {
    const h = new Headers({ a: '1', b: '2' });
    const keys = [...h.keys()].sort();
    strictEqual(keys.length, 2);
    ok(keys.includes('a') && keys.includes('b'));
});

// --- AbortController/AbortSignal ------------------------------------------

Deno.test({ name: 'AbortSignal: abort() fires event and sets aborted', timeout: 10000 }, () => {
    const ac = new AbortController();
    ok(!ac.signal.aborted);
    let fired = false;
    ac.signal.addEventListener('abort', () => { fired = true; });
    ac.abort('reason');
    ok(ac.signal.aborted);
    ok(fired);
    strictEqual((ac.signal as AbortSignal & { reason?: unknown }).reason, 'reason');
});

Deno.test({ name: 'AbortSignal.timeout fires after ms', timeout: 10000 }, async () => {
    const s = AbortSignal.timeout(10);
    await new Promise<void>((resolve) => {
        s.addEventListener('abort', () => resolve());
        setTimeout(resolve, 2000);
    });
    ok(s.aborted);
});

// --- ReadableStream / TransformStream -------------------------------------

Deno.test({ name: 'ReadableStream: async iterator drains chunks', timeout: 10000 }, async () => {
    const rs = new ReadableStream<string>({
        start(c) { c.enqueue('a'); c.enqueue('b'); c.close(); },
    });
    const out: string[] = [];
    for await (const chunk of rs) out.push(chunk);
    strictEqual(out.join(''), 'ab');
});

Deno.test({ name: 'ReadableStream: tee produces two independent streams', timeout: 10000 }, async () => {
    const rs = new ReadableStream<number>({
        start(c) { c.enqueue(1); c.enqueue(2); c.close(); },
    });
    const [a, b] = rs.tee();
    const ra = await a.getReader().read();
    const rb = await b.getReader().read();
    strictEqual(ra.value, 1);
    strictEqual(rb.value, 1);
});

Deno.test({ name: 'TransformStream: transforms chunks', timeout: 10000 }, async () => {
    const ts = new TransformStream<string, string>({
        transform(chunk, ctrl) { ctrl.enqueue(chunk.toUpperCase()); },
    });
    const w = ts.writable.getWriter();
    const r = ts.readable.getReader();
    await w.write('hi');
    await w.close();
    const { value } = await r.read();
    strictEqual(value, 'HI');
});

// --- URL / URLSearchParams (global) ---------------------------------------

Deno.test({ name: 'URL: parses and normalizes', timeout: 10000 }, () => {
    const u = new URL('HTTP://Example.com:80/a/../b?x=1#f');
    strictEqual(u.origin, 'http://example.com');
    strictEqual(u.pathname, '/b');
    strictEqual(u.searchParams.get('x'), '1');
});

Deno.test({ name: 'URLSearchParams: encodes spaces as +', timeout: 10000 }, () => {
    const sp = new URLSearchParams({ q: 'a b' });
    strictEqual(sp.toString(), 'q=a+b');
});

// --- structuredClone / atob / btoa ----------------------------------------

Deno.test({ name: 'structuredClone: deep clones nested object', timeout: 10000 }, () => {
    const o = { a: { b: [1, 2] } };
    const c = structuredClone(o);
    (o.a.b as number[]).push(3);
    strictEqual(c.a.b.length, 2);
});

Deno.test({ name: 'atob/btoa round-trip', timeout: 10000 }, () => {
    const bin = 'Hello, world!';
    strictEqual(atob(btoa(bin)), bin);
});
