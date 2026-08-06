/**
 * HTTP/1.1 silent request-body truncation.
 *
 * THE DEFECT: a truncated upload was indistinguishable from a complete one. A
 * client announcing `Content-Length: 1000`, sending 400 bytes and disconnecting
 * produced the SAME observable sequence as a whole body — `'end'` fired,
 * `req.complete === true` — so a handler that commits on `'end'` stored a partial
 * payload with no error, no warning, and nothing to check afterwards.
 *
 * Two independent bugs had to be fixed for `req.complete` to mean anything:
 *
 *   1. http/src/h1.ts — `bodyRead` was declared and reset but NEVER INCREMENTED,
 *      and `contentLength` was never compared against bytes received. `failBody()`
 *      treated every peer disconnect as a clean end-of-stream and resolved the body
 *      with `null`. Now `onBody` counts bytes and `bodyIncomplete()` compares them
 *      against the declared length (or, for chunked, against having seen the
 *      0-chunk), and a short body rejects with ECONNRESET instead.
 *
 *   2. cno/src/node/_internal/server-request-stream.ts — the node:http pump then
 *      threw that fix away: `failIncomingRequest()` classified ECONNRESET as a
 *      transport disconnect and called `completeIncomingRequest()`, setting
 *      `complete = true` and pushing null, which fired `'end'`. Fixing only h1 left
 *      the node:http path just as silent, which is why both are pinned here.
 *
 * METHOD: every case writes raw request bytes over a real loopback TCP socket and
 * then closes. A client library cannot truncate deliberately — it always frames
 * what it sends — so the bytes are written by hand. Contract measured against real
 * Node v24.18.0 on this machine; per scenario Node gives:
 *     'end' NOT fired, 'aborted' -> 'error'(ECONNRESET) -> 'close',
 *     complete=false, aborted=true, readableEnded=false, errored set.
 * A complete body gives: 'end' -> 'close', complete=true, readableEnded=true.
 */
import { ok, strictEqual } from 'node:assert';
import * as http from 'node:http';
import * as net from 'node:net';
import { createServer as createRawServer, type Server as RawServer, type HttpRequest, type HttpResponse } from '@cnojs/http/server';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface Observed {
    events: string[];
    bytes: number;
    complete: boolean;
    aborted: boolean;
    readableEnded: boolean;
    errCode: string | null;
    errored: boolean;
    response: string | null;
}

/**
 * Serve one raw request over node:http and report what the handler observed.
 * `attachErrorListener` mirrors Node's rule that 'error' is only emitted when a
 * listener exists — both branches must be safe, so both are exercised.
 */
async function observeNodeHttp(
    wire: string,
    opts: { attachErrorListener?: boolean; answerOnEnd?: boolean } = {},
): Promise<Observed> {
    const attachError = opts.attachErrorListener !== false;
    const out: Observed = {
        events: [], bytes: 0, complete: false, aborted: false,
        readableEnded: false, errCode: null, errored: false, response: null,
    };
    let settle: () => void = () => {};
    const done = new Promise<void>(r => { settle = r; });

    const server = http.createServer((req, res) => {
        req.on('data', (c: Uint8Array) => { out.bytes += c.byteLength; });
        req.on('end', () => {
            out.events.push('end');
            if (opts.answerOnEnd) { try { res.end('ok'); } catch { /* peer gone */ } }
        });
        req.on('aborted', () => out.events.push('aborted'));
        if (attachError) {
            req.on('error', (e: Error & { code?: string }) => {
                out.events.push('error');
                out.errCode = e.code ?? 'NO_CODE';
            });
        }
        req.on('close', () => {
            out.events.push('close');
            out.complete = req.complete;
            out.aborted = req.aborted;
            out.readableEnded = req.readableEnded;
            out.errored = !!(req as unknown as { errored?: unknown }).errored;
            settle();
        });
    });
    // A truncated request also reaches the server as a clientError; swallowing it
    // keeps the probe measuring the request object rather than the server's socket.
    server.on('clientError', (_e: Error, sock: net.Socket) => { try { sock.destroy(); } catch { /* ok */ } });

    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
        const sock = net.connect(port, '127.0.0.1');
        sock.on('error', () => { /* RST from our own teardown */ });
        sock.on('data', (d: Buffer) => { if (out.response === null) out.response = d.toString().split('\r\n')[0]!; });
        await new Promise<void>((r, j) => { sock.on('connect', () => r()); sock.on('error', j); });
        sock.write(wire);
        await sleep(150);
        sock.end();
        await Promise.race([done, sleep(3000)]);
    } finally {
        server.close();
        await sleep(30);
    }
    return out;
}

/** Same wire bytes against the raw @cnojs/http server, bypassing the node adapter. */
async function observeRawH1(wire: string): Promise<{ bytes: number; sawNull: boolean; code: string | null }> {
    const result = { bytes: 0, sawNull: false, code: null as string | null };
    let settle: () => void = () => {};
    const done = new Promise<void>(r => { settle = r; });
    let server: RawServer | null = null;
    try {
        server = createRawServer(async (req: HttpRequest, res: HttpResponse) => {
            try {
                for (;;) {
                    const chunk = await req.body?.();
                    if (chunk === null || chunk === undefined) { result.sawNull = true; break; }
                    result.bytes += chunk.byteLength;
                }
            } catch (e) {
                result.code = (e as { code?: string }).code ?? 'NO_CODE';
            }
            settle();
            try { await res.writeHead(200, 'OK', [['content-length', '2']]); await res.end('ok'); } catch { /* peer gone */ }
        }, { hostname: '127.0.0.1', port: 0 });
        server.listen();
        void server.acceptLoop();
        const addr = server.address();
        if (!addr || !('port' in addr)) throw new Error('no port');
        const sock = net.connect(addr.port, '127.0.0.1');
        sock.on('error', () => { /* expected */ });
        await new Promise<void>((r, j) => { sock.on('connect', () => r()); sock.on('error', j); });
        sock.write(wire);
        await sleep(150);
        sock.end();
        await Promise.race([done, sleep(3000)]);
    } finally {
        try { server?.close(); } catch { /* already closed */ }
        await sleep(30);
    }
    return result;
}

const head = (path: string, framing: string) => `POST /${path} HTTP/1.1\r\nHost: x\r\n${framing}\r\n\r\n`;
const CL_TRUNC = head('t', 'Content-Length: 1000') + 'x'.repeat(400);
const CHUNK_NOTERM = head('t', 'Transfer-Encoding: chunked') + '1a\r\n' + 'y'.repeat(26) + '\r\n';
const CHUNK_TRUNC = head('t', 'Transfer-Encoding: chunked') + '1a\r\n' + 'y'.repeat(10);
const CL_COMPLETE = head('t', 'Content-Length: 400') + 'x'.repeat(400);
const CHUNK_COMPLETE = head('t', 'Transfer-Encoding: chunked') + '1a\r\n' + 'y'.repeat(26) + '\r\n0\r\n\r\n';

/* ── node:http — req.complete is the signal a handler can actually check ────── */

Deno.test('h1 truncation: Content-Length short + FIN does not fire end and leaves complete=false', async () => {
    const o = await observeNodeHttp(CL_TRUNC);
    strictEqual(o.bytes, 400, '400 of the declared 1000 bytes arrived');
    ok(!o.events.includes('end'), `'end' must NOT fire for a truncated body; got ${o.events.join('->')}`);
    strictEqual(o.complete, false, 'req.complete is THE signal that separates truncation from completion');
    strictEqual(o.aborted, true);
    strictEqual(o.readableEnded, false);
    strictEqual(o.errCode, 'ECONNRESET', "Node's code for this exact condition");
    ok(o.events.includes('close'), "'close' always fires");
});

Deno.test('h1 truncation: chunked with no terminating 0-chunk is treated as truncated', async () => {
    const o = await observeNodeHttp(CHUNK_NOTERM);
    strictEqual(o.bytes, 26, 'the one complete chunk was delivered');
    ok(!o.events.includes('end'), `no 0-chunk means no clean end; got ${o.events.join('->')}`);
    strictEqual(o.complete, false);
    strictEqual(o.errCode, 'ECONNRESET');
});

Deno.test('h1 truncation: chunked cut mid-payload is treated as truncated', async () => {
    const o = await observeNodeHttp(CHUNK_TRUNC);
    ok(o.bytes < 26, `a chunk declaring 26 bytes delivered only ${o.bytes}`);
    ok(!o.events.includes('end'), `'end' must not fire mid-chunk; got ${o.events.join('->')}`);
    strictEqual(o.complete, false);
    strictEqual(o.errCode, 'ECONNRESET');
});

Deno.test('h1 truncation: event order is aborted -> error -> close, matching Node', async () => {
    const o = await observeNodeHttp(CL_TRUNC);
    strictEqual(
        o.events.join('->'), 'aborted->error->close',
        "'aborted' precedes 'error': it is the documented signal, and the only one a " +
        'handler without an error listener can rely on besides close',
    );
});

Deno.test('h1 truncation: no error listener must not crash, and errored is still set', async () => {
    // Node's IncomingMessage emits 'error' only when a listener exists (its onError:
    // "an error is emitted only if there are listeners attached"). Peer disconnect is
    // outside a handler's control, so it must never become an unhandled 'error'.
    const o = await observeNodeHttp(CL_TRUNC, { attachErrorListener: false });
    ok(!o.events.includes('end'), 'still no clean end without a listener');
    strictEqual(o.complete, false, 'complete is readable from close, which always fires');
    strictEqual(o.errored, true, 'errored records the cause even with nobody listening');
    strictEqual(o.errCode, null, 'and no error event was emitted');
});

/* ── the controls: a complete body must still complete ──────────────────────── */

Deno.test('h1 truncation: a complete Content-Length body fires end with complete=true', async () => {
    const o = await observeNodeHttp(CL_COMPLETE, { answerOnEnd: true });
    strictEqual(o.bytes, 400);
    ok(o.events.includes('end'), `a whole body must still end; got ${o.events.join('->')}`);
    strictEqual(o.complete, true);
    strictEqual(o.readableEnded, true);
    strictEqual(o.errCode, null, 'no error for a healthy request');
    strictEqual(o.response, 'HTTP/1.1 200 OK', 'and the handler could answer');
});

Deno.test('h1 truncation: a complete chunked body fires end with complete=true', async () => {
    const o = await observeNodeHttp(CHUNK_COMPLETE, { answerOnEnd: true });
    strictEqual(o.bytes, 26);
    ok(o.events.includes('end'));
    strictEqual(o.complete, true);
    strictEqual(o.errCode, null);
    strictEqual(o.response, 'HTTP/1.1 200 OK');
});

Deno.test('h1 truncation: a bodyless GET is complete, not truncated', async () => {
    // expectBody is false here, so bodyIncomplete() must not fire on the disconnect
    // that follows. A GET with no body is the most common request there is.
    const o = await observeNodeHttp('GET /t HTTP/1.1\r\nHost: x\r\n\r\n', { answerOnEnd: true });
    ok(o.events.includes('end'), `a GET must end cleanly; got ${o.events.join('->')}`);
    strictEqual(o.complete, true);
    strictEqual(o.errCode, null);
});

Deno.test('h1 truncation: Content-Length: 0 is complete, not truncated', async () => {
    const o = await observeNodeHttp('POST /t HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n', { answerOnEnd: true });
    ok(o.events.includes('end'));
    strictEqual(o.complete, true);
    strictEqual(o.errCode, null);
});

Deno.test('h1 truncation: truncation is distinguishable from completion on every observable', async () => {
    const cut = await observeNodeHttp(CL_TRUNC);
    const whole = await observeNodeHttp(CL_COMPLETE, { answerOnEnd: true });
    ok(
        cut.complete !== whole.complete,
        'req.complete must differ — this single boolean is what a handler checks',
    );
    ok(
        cut.events.includes('end') !== whole.events.includes('end'),
        "the presence of 'end' must differ",
    );
    strictEqual(cut.readableEnded, false);
    strictEqual(whole.readableEnded, true);
});

/* ── the protocol layer beneath the adapter, pinned separately ──────────────── */

Deno.test('h1 truncation: the h1 layer itself rejects a short body instead of resolving null', async () => {
    // Direct @cnojs/http server: no node:http adapter involved. Resolving null here
    // is what made the adapter report a clean end, so the rejection is the root fix.
    const r = await observeRawH1(CL_TRUNC);
    strictEqual(r.bytes, 400);
    strictEqual(r.sawNull, false, 'req.body() must NOT resolve null for a short body');
    strictEqual(r.code, 'ECONNRESET');
});

Deno.test('h1 truncation: the h1 layer resolves null for a genuinely complete body', async () => {
    const r = await observeRawH1(CL_COMPLETE);
    strictEqual(r.bytes, 400);
    strictEqual(r.sawNull, true, 'a whole body still ends by resolving null');
    strictEqual(r.code, null);
});

Deno.test('h1 truncation: the h1 layer rejects chunked with no terminator', async () => {
    const r = await observeRawH1(CHUNK_NOTERM);
    strictEqual(r.bytes, 26);
    strictEqual(r.sawNull, false);
    strictEqual(r.code, 'ECONNRESET');
});
