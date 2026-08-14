// Parity assertions measured two-column against node v24.18.0 on the same machine.
// Every expectation below is node's OBSERVED behaviour, not a restatement of cno's.
//
// Tests marked `ignore: true` carry the node-correct expectation for a defect that is
// still OPEN. Each is preceded by a comment naming the defect, the exact measurement
// that established it, and the source location. They live in `cno/src/webapi/**`,
// which is **baked into the binary** (confirmed by string-literal greps on
// build/stage/cno.exe: `Cannot tee a locked stream`=1,
// `Cannot get a BYOB reader for a non-byte stream`=1, `Already read`=1,
// `----CNOFormBoundary`=1, while node's `Body is unusable: ...`=0 and a nonsense
// marker=0; and `find $CTS_CACHE_DIR -type d -name webapi`=0). They are therefore
// inert today and can only pass after the pending rebuild carries a fix.
// Whoever lands each fix must un-ignore the corresponding test.
//
// The un-ignored tests interleaved below guard the behaviour that must NOT regress
// while those defects are being fixed.
import { strictEqual, deepStrictEqual, ok, rejects, throws } from 'node:assert';
import { createHash } from 'node:crypto';
import http from 'node:http';

const sha = (b: Uint8Array | string): string =>
    createHash('sha256').update(b as never).digest('hex').slice(0, 16);
const hex = (b: Uint8Array): string =>
    Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ============================================================================
// F2 — Response/Request are plain mutable objects instead of prototype accessors
//
// Measured: for every one of `bodyUsed body status headers ok url statusText type
// redirected`, node reports `own=none proto=getter` while cno reports
// `own=data(w=true,e=true,c=true) proto=none`.
// Consequence measured end to end: `r.bodyUsed = false` succeeds in cno and a second
// `r.text()` then returns the FULL body again —
//   cno:  first="secret-payload" | assigned, now=false | second=GOT:"secret-payload"
//   node: assign throws TypeError (getter-only), second read still throws.
// Source: cno/src/webapi/fetch/response.ts:61, cno/src/webapi/fetch/request.ts:76
// ("public bodyUsed: boolean = false") and siblings.
// ============================================================================

Deno.test({
    name: 'node oracle: Response accessors live on the prototype, not the instance',
}, () => {
    const r = new Response('abc');
    for (const k of ['bodyUsed', 'body', 'status', 'headers', 'ok', 'url', 'statusText', 'type', 'redirected']) {
        strictEqual(Object.getOwnPropertyDescriptor(r, k), undefined,
            `Response.${k} must not be an own property`);
        const d = Object.getOwnPropertyDescriptor(Response.prototype, k);
        ok(d && typeof d.get === 'function', `Response.prototype.${k} must be a getter`);
    }
});

Deno.test({
    name: 'node oracle: forging bodyUsed=false cannot re-read a consumed body',
}, async () => {
    const r = new Response('secret-payload');
    strictEqual(await r.text(), 'secret-payload');
    // node: assigning to a getter-only accessor throws in strict mode (ESM is strict).
    throws(() => { (r as unknown as { bodyUsed: boolean }).bodyUsed = false; }, TypeError,
        'bodyUsed must not be assignable');
    await rejects(() => r.text(), TypeError, 'the body must stay unusable');
});

Deno.test({
    name: 'node oracle: Response status/ok/url are not forgeable',
}, () => {
    const r = new Response('body', { status: 404, statusText: 'Not Found' });
    throws(() => { (r as unknown as { status: number }).status = 200; }, TypeError);
    throws(() => { (r as unknown as { ok: boolean }).ok = true; }, TypeError);
    throws(() => { (r as unknown as { url: string }).url = 'https://evil.example/'; }, TypeError);
    strictEqual(r.status, 404, 'status must be unchanged');
    strictEqual(r.ok, false, 'ok must be unchanged');
});

Deno.test({
    name: 'node oracle: a Response exposes no enumerable own keys and stringifies to {}',
}, () => {
    const r = new Response('x', { status: 201 });
    // cno leaks `_bodyBuffer,body,bodyUsed,headers,ok,redirected,status,statusText,type,url`
    // here, so JSON.stringify(res) emits internals instead of node's `{}`.
    deepStrictEqual(Object.keys(r), []);
    strictEqual(JSON.stringify(r), '{}');
});

Deno.test({
    name: 'node oracle: Response and ReadableStream carry Symbol.toStringTag',
}, () => {
    // cno reports [object Object] for both; Headers and Blob are already correct.
    strictEqual(Object.prototype.toString.call(new Response('x')), '[object Response]');
    strictEqual(Object.prototype.toString.call(new ReadableStream()), '[object ReadableStream]');
});

// GUARD (not ignored): single-use enforcement must keep working on the ordinary path
// while F2 is fixed. cno already passes this; the defect is only the forged-flag path.
Deno.test('guard: an ordinary second body read still rejects with TypeError', async () => {
    for (const [first, second] of [
        ['text', 'arrayBuffer'], ['json', 'text'], ['arrayBuffer', 'blob'], ['bytes', 'text'],
    ] as const) {
        const r = new Response(first === 'json' ? '{"a":1}' : 'payload');
        await (r as unknown as Record<string, () => Promise<unknown>>)[first]!();
        strictEqual(r.bodyUsed, true, `${first} must set bodyUsed`);
        await rejects(() => (r as unknown as Record<string, () => Promise<unknown>>)[second]!(),
            TypeError, `${first} then ${second} must reject`);
    }
});

Deno.test('node oracle: Request body state and metadata are prototype accessors', async () => {
    const request = new Request('https://example.test/', { method: 'POST', body: 'secret' });
    strictEqual(typeof (Request.prototype as unknown as { markBodyUsed?: unknown }).markBodyUsed, 'undefined',
        'internal body-state mutation must not be exposed on Request.prototype');
    for (const key of ['bodyUsed', 'body', 'url', 'method', 'headers', 'signal', 'duplex']) {
        strictEqual(Object.getOwnPropertyDescriptor(request, key), undefined);
        ok(typeof Object.getOwnPropertyDescriptor(Request.prototype, key)?.get === 'function',
            `Request.prototype.${key} must be a getter`);
    }
    strictEqual(await request.text(), 'secret');
    throws(() => { (request as unknown as { bodyUsed: boolean }).bodyUsed = false; }, TypeError);
    await rejects(() => request.text(), TypeError);
    deepStrictEqual(Object.keys(request), []);
    strictEqual(Object.prototype.toString.call(request), '[object Request]');
});

// ============================================================================
// F5 — tee() leaks an unhandled rejection when the SOURCE errors
//
// cno/src/webapi/streams.ts:615 allocates
//   const cancelResult = Promise.withResolvers<void>();
// whose `.promise` is only ever returned from the branch cancel() sink (line 701).
// When the source errors instead, line 679 `rejectCancel(err)` rejects it with no
// handler attached. WHATWG ReadableStreamDefaultTee requires
// "Set cancelPromise.[[PromiseIsHandled]] to true".
//
// Measured with BOTH branch rejections handled: node prints `rej:errC,rej:errC`, no
// unhandledRejection, rc=0. cno prints the same stdout, then fires
// `unhandledRejection: errC`; with no handler installed it aborts at rc=1.
// Negative-controlled: 5 sibling error shapes (plain controller.error + handled read,
// reader.closed handled, error-never-read, cancel-rejects, writable-write-rejects) are
// byte-identical between runtimes — the tee path is the only leak.
// Candidate fix (unverified, baked): `cancelResult.promise.catch(() => {});` at the
// declaration — same promise object, so cancel()'s rejection still reaches real callers.
// ============================================================================

Deno.test({
    name: 'node oracle: a tee\'d source error with both branches handled raises no unhandledRejection',
}, async () => {
    const seen: unknown[] = [];
    const onRej = (r: unknown) => seen.push(r);
    process.on('unhandledRejection', onRej);
    try {
        let i = 0;
        const rs = new ReadableStream<Uint8Array>({
            pull(ctl) {
                if (i++ < 1) ctl.enqueue(new Uint8Array([1]));
                else ctl.error(new Error('tee-oracle-boom'));
            },
        });
        const [a, b] = rs.tee();
        const drainCaught = async (s: ReadableStream<Uint8Array>) => {
            const rd = s.getReader();
            try { for (;;) { const x = await rd.read(); if (x.done) return 'done'; } }
            catch { return 'rejected'; }
        };
        const out = await Promise.all([drainCaught(a), drainCaught(b)]);
        deepStrictEqual(out, ['rejected', 'rejected'], 'both branches must reject');
        // Let any stray rejection surface before asserting.
        await new Promise((r) => setTimeout(r, 60));
        deepStrictEqual(seen, [], 'a fully handled tee error must not reach unhandledRejection');
    } finally {
        process.off('unhandledRejection', onRej);
    }
});

// GUARD (not ignored): the tee error must still reach both branches while F5 is fixed.
Deno.test('guard: a tee\'d source error still rejects both branches', async () => {
    let i = 0;
    const rs = new ReadableStream<Uint8Array>({
        pull(ctl) {
            if (i++ < 2) ctl.enqueue(new Uint8Array([i]));
            else ctl.error(new Error('tee-guard-boom'));
        },
    });
    const [a, b] = rs.tee();
    const drain = async (s: ReadableStream<Uint8Array>) => {
        const rd = s.getReader();
        for (;;) { const x = await rd.read(); if (x.done) return; }
    };
    await rejects(() => drain(a), /tee-guard-boom/);
    await rejects(() => drain(b), /tee-guard-boom/);
});

// ============================================================================
// F6 — a ReadableStream request body is not streamed; it is drained to a temp file
//      in full before a single byte reaches the wire
//
// Measured with a source emitting 3 chunks 200 ms apart, server-side timestamps:
//   node: SOURCE enqueue0@212 | SERVER headers@215 te=chunked cl=none | data@215 +3
//         data@422 +3 | data@632 +3   -> headersAt=215 < lastEnqueueAt=631, STREAMED
//   cno:  enqueue0@212 | enqueue1@414 | enqueue2@617 | SOURCE close@621
//         SERVER headers@640 te=none cl=9 | data@641 +9 (ALL AT ONCE), NOT streamed
// The server sees nothing until 19 ms AFTER the source closed, and Content-Length
// replaces Transfer-Encoding: chunked — you cannot know cl=9 without having consumed
// the whole stream.
// Source: cno/src/webapi/fetch/helpers.ts:467 `await writeStreamToTempFile(...)` inside
// prepareRequestBody (line 459); writeStreamToTempFile at line 430 writes
// `${os.tmpDir}/fetch-body-*.tmp`; cno/src/webapi/fetch/perform.ts:266 then calls
// curl.setUploadFile(path). (The temp file IS unlinked — perform.ts:187-195 — so this
// is not a file leak.)
// Silent-wrong: the bytes and hash are CORRECT, so only timing and framing expose it.
// The fix is architectural (a curl read-callback upload), not a one-liner.
// ============================================================================

Deno.test({
    name: 'node oracle: a ReadableStream request body streams chunked instead of buffering',
    ignore: true,
    timeout: 30000,
}, async () => {
    let sawHeadersAt = -1;
    let framing = '';
    const server = http.createServer((req: { url?: string; headers: Record<string, string | string[] | undefined>; on: (e: string, f: (...a: never[]) => void) => void }, res: { writeHead: (s: number, h?: Record<string, string>) => void; end: (b?: string) => void }) => {
        sawHeadersAt = Date.now() - t0;
        framing = `te=${req.headers['transfer-encoding'] ?? 'none'} cl=${req.headers['content-length'] ?? 'none'}`;
        req.on('data', () => { /* drain */ });
        req.on('end', () => { res.writeHead(200); res.end('ack'); });
    });
    // Keepalive spanning the close: a microtask enqueued from a handle-close callback is
    // invisible to libuv's aliveness test, so the run can otherwise exit with nothing done.
    const keepalive = setInterval(() => { }, 50);
    let t0 = 0;
    try {
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as { port: number }).port;
        let lastEnqueueAt = -1;
        let i = 0;
        t0 = Date.now();
        const body = new ReadableStream<Uint8Array>({
            async pull(ctl) {
                if (i >= 3) { ctl.close(); return; }
                await new Promise((r) => setTimeout(r, 200));
                lastEnqueueAt = Date.now() - t0;
                ctl.enqueue(new TextEncoder().encode('c' + i + '-'));
                i++;
            },
        });
        const res = await fetch(`http://127.0.0.1:${port}/`, {
            method: 'POST', body, duplex: 'half',
        } as RequestInit);
        strictEqual(await res.text(), 'ack');
        ok(sawHeadersAt >= 0, 'server must have seen the request');
        ok(sawHeadersAt < lastEnqueueAt,
            `request headers must reach the server BEFORE the last chunk is produced `
            + `(headersAt=${sawHeadersAt} lastEnqueueAt=${lastEnqueueAt})`);
        strictEqual(framing, 'te=chunked cl=none',
            'a stream body must be sent chunked, not with a precomputed Content-Length');
    } finally {
        clearInterval(keepalive);
        server.close();
    }
});

// ============================================================================
// F7 — duplex:'half' is not required when sending a stream body (follows from F6)
// node: TypeError "RequestInit: duplex option is required when sending a body."
// cno:  SUCCEEDS, len=5 hash=d460f4c0d012fb8a
// ============================================================================

Deno.test({
    name: 'node oracle: a stream body without duplex:half is rejected',
    ignore: true,
    timeout: 30000,
}, async () => {
    const server = http.createServer((req: { url?: string; headers: Record<string, string | string[] | undefined>; on: (e: string, f: (...a: never[]) => void) => void }, res: { writeHead: (s: number, h?: Record<string, string>) => void; end: (b?: string) => void }) => {
        req.on('data', () => { });
        req.on('end', () => { res.writeHead(200); res.end('ok'); });
    });
    const keepalive = setInterval(() => { }, 50);
    try {
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as { port: number }).port;
        const body = new ReadableStream<Uint8Array>({
            start(ctl) { ctl.enqueue(new TextEncoder().encode('nodup')); ctl.close(); },
        });
        await rejects(
            () => fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body }),
            TypeError,
            'omitting duplex:half with a stream body must throw TypeError',
        );
    } finally {
        clearInterval(keepalive);
        server.close();
    }
});

// ============================================================================
// F8 — redirect:'manual' reports redirected=true and type='default'
// Measured on a 302 with redirect:'manual':
//   node: status=302 redirected=FALSE type=basic
//   cno:  status=302 redirected=TRUE  type=default
// Per spec `redirected` is true only if the response went through >=1 redirect; in
// manual mode none was followed, so code branching on res.redirected gets a false
// positive. `location` and the empty body already match.
// ============================================================================

Deno.test({
    name: 'node oracle: redirect:manual leaves redirected=false',
    timeout: 30000,
}, async () => {
    const server = http.createServer((req: { url?: string; headers: Record<string, string | string[] | undefined>; on: (e: string, f: (...a: never[]) => void) => void }, res: { writeHead: (s: number, h?: Record<string, string>) => void; end: (b?: string) => void }) => {
        if (req.url === '/redirect') { res.writeHead(302, { location: '/text' }); res.end(); }
        else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('plain-text-body'); }
    });
    const keepalive = setInterval(() => { }, 50);
    try {
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as { port: number }).port;
        const r = await fetch(`http://127.0.0.1:${port}/redirect`, { redirect: 'manual' });
        strictEqual(r.status, 302);
        strictEqual(r.headers.get('location'), '/text');
        strictEqual(r.redirected, false, 'no redirect was followed, so redirected must be false');
        strictEqual(r.type, 'basic');
    } finally {
        clearInterval(keepalive);
        server.close();
    }
});

// GUARD (not ignored): redirect:follow and redirect:error must keep working.
Deno.test({ name: 'guard: redirect follow and error modes still behave', timeout: 30000 }, async () => {
    const server = http.createServer((req: { url?: string; headers: Record<string, string | string[] | undefined>; on: (e: string, f: (...a: never[]) => void) => void }, res: { writeHead: (s: number, h?: Record<string, string>) => void; end: (b?: string) => void }) => {
        if (req.url === '/redirect') { res.writeHead(302, { location: '/text' }); res.end(); }
        else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('plain-text-body'); }
    });
    const keepalive = setInterval(() => { }, 50);
    try {
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as { port: number }).port;
        const followed = await fetch(`http://127.0.0.1:${port}/redirect`);
        strictEqual(followed.status, 200);
        strictEqual(followed.redirected, true, 'a followed redirect must set redirected');
        strictEqual(await followed.text(), 'plain-text-body');
        ok(followed.url.endsWith('/text'), 'url must be the final URL');
        await rejects(() => fetch(`http://127.0.0.1:${port}/redirect`, { redirect: 'error' }),
            TypeError, 'redirect:error must reject');
    } finally {
        clearInterval(keepalive);
        server.close();
    }
});

// ============================================================================
// F9 — type:'bytes' is accepted but silently degrades to a default stream
// Measured:                        node v24.18.0             | cno
//   controller ctor                ReadableByteStreamController | ReadableStreamController
//   'byobRequest' in ctl           true (value null)            | FALSE
//   getReader({mode:'byob'})       ReadableStreamBYOBReader     | throws TypeError
//                                  read(view) -> 4 bytes 09080706 | "Cannot get a BYOB
//                                                                 reader for a non-byte stream"
//   enqueue('a-string')            throws TypeError             | ACCEPTED, yields a string
//   autoAllocateChunkSize:16       got=5a                       | got=NONE (zero bytes)
// The last two are silent-wrong: a byte stream that yields a string breaks every
// consumer relying on `value instanceof Uint8Array`, and an autoAllocateChunkSize
// source produces ZERO bytes rather than data. BYOB read(view) with a non-zero
// byteOffset is unreachable in cno as a result.
// Globals `ReadableStreamBYOBReader`, `ReadableByteStreamController` and
// `TransformStreamDefaultController` are also undefined (node: function).
// ============================================================================

Deno.test({
    name: 'node oracle: type:bytes yields a real ReadableByteStreamController',
    ignore: true,
}, () => {
    let ctl: ReadableStreamController<Uint8Array> | undefined;
    new ReadableStream<Uint8Array>({
        type: 'bytes',
        start(c) { ctl = c; c.enqueue(new Uint8Array([1])); c.close(); },
    } as UnderlyingSource<Uint8Array>);
    strictEqual(ctl?.constructor?.name, 'ReadableByteStreamController');
    ok('byobRequest' in (ctl as object), 'a byte controller must expose byobRequest');
});

Deno.test({
    name: 'node oracle: a bytes stream rejects a non-ArrayBufferView chunk',
    ignore: true,
}, async () => {
    // cno accepts the string and read() hands back "a-string".
    const rs = new ReadableStream({
        type: 'bytes',
        start(c) { (c as ReadableStreamDefaultController).enqueue('a-string' as never); c.close(); },
    } as UnderlyingSource);
    await rejects(() => rs.getReader().read(), TypeError,
        'enqueueing a string on a byte stream must throw');
});

Deno.test({
    name: 'node oracle: BYOB read(view) fills a view at a non-zero byteOffset',
    ignore: true,
}, async () => {
    const rs = new ReadableStream<Uint8Array>({
        type: 'bytes',
        start(c) { c.enqueue(new Uint8Array([0xaa, 0xbb, 0xcc])); c.close(); },
    } as UnderlyingSource<Uint8Array>);
    const reader = (rs as ReadableStream<Uint8Array>).getReader({ mode: 'byob' } as never) as
        ReadableStreamBYOBReader;
    strictEqual(reader.constructor.name, 'ReadableStreamBYOBReader');
    const view = new Uint8Array(new ArrayBuffer(16), 5, 8);   // byteOffset 5
    const { value } = await reader.read(view);
    ok(value, 'BYOB read must yield a view');
    strictEqual(value!.byteOffset, 5, 'the returned view must keep the requested byteOffset');
    strictEqual(value!.byteLength, 3);
    strictEqual(hex(new Uint8Array(value!.buffer, value!.byteOffset, value!.byteLength)), 'aabbcc');
});

Deno.test({
    name: 'node oracle: autoAllocateChunkSize delivers bytes through byobRequest',
    ignore: true,
}, async () => {
    // cno's byobRequest is undefined, so such a source yields NO data at all.
    const rs = new ReadableStream<Uint8Array>({
        type: 'bytes',
        autoAllocateChunkSize: 16,
        pull(c) {
            const req = (c as ReadableByteStreamController).byobRequest;
            ok(req, 'byobRequest must be present with autoAllocateChunkSize');
            (req!.view as Uint8Array)[0] = 0x5a;
            req!.respond(1);
            c.close();
        },
    } as UnderlyingSource<Uint8Array>);
    const { value } = await rs.getReader().read();
    strictEqual(hex(value!), '5a');
});

Deno.test({
    name: 'node oracle: byte-stream and transform globals are exposed',
    ignore: true,
}, () => {
    for (const n of ['ReadableStreamBYOBReader', 'ReadableByteStreamController', 'TransformStreamDefaultController']) {
        strictEqual(typeof (globalThis as Record<string, unknown>)[n], 'function',
            `${n} must be a global constructor`);
    }
});

Deno.test({
    name: 'node oracle: ReadableStream.prototype exposes no internal slots',
    ignore: true,
}, () => {
    // cno additionally exposes `_controller` and `_releaseLock` here.
    deepStrictEqual(Object.getOwnPropertyNames(ReadableStream.prototype).sort(),
        ['cancel', 'constructor', 'getReader', 'locked', 'pipeThrough', 'pipeTo', 'tee', 'values']);
});

// GUARD (not ignored): a type:'bytes' stream must keep delivering its bytes through a
// default reader while F9 is fixed — this already works and must not regress.
Deno.test('guard: a type:bytes stream still reads through a default reader', async () => {
    const rs = new ReadableStream<Uint8Array>({
        type: 'bytes',
        start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); },
    } as UnderlyingSource<Uint8Array>);
    const { value } = await rs.getReader().read();
    strictEqual(hex(value!), '010203');
});

// ============================================================================
// F10 — multipart/form-data: field names and filenames are interpolated raw
//
// cno/src/webapi/fetch/helpers.ts:483 and :486 (in serializeFormData, line 475):
//   let header = `--${boundary}\r\nContent-Disposition: form-data; name="${key}"`;
//   header += `; filename="${filename}"\r\nContent-Type: ${value.type || '...'}`;
// No escaping at all. WHATWG requires " -> %22, CR -> %0D, LF -> %0A.
//
// Measured wire bytes (boundary normalised), and the value after parsing back:
//   name `has"quote`     node name="has%22quote"      -> has"quote
//                        cno  name="has"quote"        -> `has`         (DATA LOSS)
//   filename `na"me.txt` node filename="na%22me.txt"  -> na"me.txt
//                        cno  filename="na"me.txt"    -> `na`          (DATA LOSS)
//   name `cr\rlf\n`      node name="cr%0D%0Alf%0D%0A" -> exact
//                        cno  raw CR/LF inside the header block
//   filename `a"\r\nX-Injected: yes\r\nContent-Type: text/html`
//                        node fully percent-encoded, one header
//                        cno  emits a literal extra header line `X-Injected: yes`
// Attacker-controlled CRLF therefore reaches the multipart header block verbatim — a
// part/header-injection primitive against any recipient parser.
// NOT demonstrated: field forgery through cno's own parser. createMultipartBoundary
// (helpers.ts:395) regenerates per serialization, so a payload cannot embed the live
// boundary; boundaryReused=false and the forged field did NOT appear in either runtime.
// Blob.type is not a third vector: both runtimes empty a non-ASCII type.
// ============================================================================

Deno.test({
    name: 'node oracle: a quote in a FormData field name survives a round-trip',
    ignore: true,
}, async () => {
    const fd = new FormData();
    fd.append('has"quote', 'v1');
    const r = new Response(fd);
    const ct = r.headers.get('content-type')!;
    const raw = new TextDecoder().decode(await r.arrayBuffer());
    ok(raw.includes('name="has%22quote"'),
        `the quote must be percent-encoded on the wire, got: ${JSON.stringify(raw.slice(0, 120))}`);
    const back = await new Response(raw, { headers: { 'content-type': ct } }).formData();
    strictEqual(back.get('has"quote'), 'v1', 'the field name must round-trip intact');
});

Deno.test({
    name: 'node oracle: a quote in a FormData filename survives a round-trip',
    ignore: true,
}, async () => {
    const fd = new FormData();
    fd.append('f', new Blob(['x']), 'na"me.txt');
    const r = new Response(fd);
    const ct = r.headers.get('content-type')!;
    const raw = new TextDecoder().decode(await r.arrayBuffer());
    ok(raw.includes('filename="na%22me.txt"'),
        `the filename quote must be percent-encoded, got: ${JSON.stringify(raw.slice(0, 160))}`);
    const back = await new Response(raw, { headers: { 'content-type': ct } }).formData();
    strictEqual((back.get('f') as File).name, 'na"me.txt');
});

Deno.test({
    name: 'node oracle: CRLF in a FormData name or filename cannot reach the header block',
    ignore: true,
}, async () => {
    const fd = new FormData();
    fd.append('f', new Blob(['imagebytes']), 'a"\r\nX-Injected: yes\r\nContent-Type: text/html');
    fd.append('cr\rlf\n', 'v');
    const raw = new TextDecoder().decode(await new Response(fd).arrayBuffer());
    ok(!/\r\nX-Injected: yes/.test(raw),
        'a filename must not be able to inject a header line');
    ok(raw.includes('%0D%0A'), 'CR and LF must be percent-encoded');
    // Count the header lines belonging to the first part: exactly Content-Disposition
    // and Content-Type, nothing injected between them.
    const firstPart = raw.split('\r\n\r\n')[0]!;
    const headerLines = firstPart.split('\r\n').filter((l) => /^[A-Za-z-]+:/.test(l));
    deepStrictEqual(headerLines.map((l) => l.split(':')[0]),
        ['Content-Disposition', 'Content-Type'],
        'the part must carry exactly two headers');
});

// GUARD (not ignored): the multipart wire format and payload integrity must not
// regress while F10's escaping is added. Boundary is normalised because it is random.
Deno.test('guard: multipart wire format stays byte-identical to node', async () => {
    const fd = new FormData();
    fd.append('field1', 'value1');
    fd.append('field2', 'value2');
    const r = new Response(fd);
    const ct = r.headers.get('content-type')!;
    strictEqual(ct.split(';')[0], 'multipart/form-data');
    const boundary = /boundary=(.*)$/.exec(ct)?.[1];
    ok(boundary && boundary.length > 8, 'a non-trivial boundary must be present');
    const raw = new TextDecoder().decode(await r.arrayBuffer());
    strictEqual(raw.split(boundary!).join('<B>'),
        '--<B>\r\nContent-Disposition: form-data; name="field1"\r\n\r\nvalue1\r\n'
        + '--<B>\r\nContent-Disposition: form-data; name="field2"\r\n\r\nvalue2\r\n'
        + '--<B>--\r\n');
});

Deno.test('guard: CRLF and unicode in FormData VALUES still round-trip', async () => {
    // Values are already correct in both runtimes; only names/filenames are affected.
    const fd = new FormData();
    fd.append('nl', 'line1\r\nline2');
    fd.append('uni', 'café-日本');
    fd.append('semi;colon', 'a;b');
    const back = await new Response(fd).formData();
    strictEqual(back.get('nl'), 'line1\r\nline2');
    strictEqual(back.get('uni'), 'café-日本');
    strictEqual(back.get('semi;colon'), 'a;b');
});

Deno.test('guard: a 1 KiB binary FormData payload stays byte-exact', async () => {
    const bin = new Uint8Array(1024);
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 7 + 13) & 0xff;
    const expect = sha(bin);
    const fd = new FormData();
    fd.append('blob', new Blob([bin], { type: 'application/octet-stream' }), 'b.bin');
    const back = await new Response(fd).formData();
    const got = new Uint8Array(await (back.get('blob') as File).arrayBuffer());
    strictEqual(got.byteLength, 1024);
    strictEqual(sha(got), expect, 'the binary payload must survive multipart byte for byte');
});
