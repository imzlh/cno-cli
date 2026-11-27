/**
 * HTTP/2 silent request-body truncation (@cnojs/http/h2).
 *
 * THE DEFECT: `H2Stream.ended` was set by three different things — a real
 * END_STREAM flag on HEADERS/DATA, `acceptEnd()`, and `acceptClose()`. Because
 * `acceptClose()` only raised an error for a NON-ZERO RST_STREAM code, a peer that
 * sent HEADERS + partial DATA + RST_STREAM(NO_ERROR) produced a stream that was
 * bit-for-bit indistinguishable from a clean finish: the handler drained a short
 * body, saw no error, and committed a partial payload believing it was whole.
 *
 * Zero cannot be treated as an error on its own, either: nghttp2's cb_stream_close
 * (http/ext-h2/http2.c) reports on_stream_close for EVERY stream including
 * successful ones, always with the verbatim wire code. So the only sound signal is
 * whether END_STREAM was actually observed — `endStreamSeen` — plus
 * `locallyEnded` to excuse the case where WE stopped reading (a handler that
 * answers without draining the request legitimately leaves the peer's half open,
 * and nghttp2 then reports close code 0).
 *
 * State-machine cases drive H2Stream directly in every build. The final test
 * sends a real RST_STREAM(NO_ERROR) over TCP when native HTTP/2 is enabled.
 */
import { ok, strictEqual, throws } from 'node:assert';
import { H2Stream } from '@cnojs/http/h2';
import { h2Available } from '@cnojs/http/h2-native';
import { createServer } from '@cnojs/http/server';
import { HttpVersion } from '@cnojs/http/protocol';
import * as http2 from 'node:http2';

type Reset = { id: number; code: number | string };

function stubConn(resets: Reset[] = []): unknown {
    return {
        secure: false,
        resetStream(id: number, code: string) { resets.push({ id, code }); },
        session: {
            respond() {}, write() {}, goaway() {}, destroy() {},
            reset(id: number, code: number) { resets.push({ id, code }); },
        },
    };
}

function rawStream(isServer: boolean, resets: Reset[] = [], id = 1): H2Stream {
    const C = H2Stream as unknown as new (c: unknown, i: number, s: boolean) => H2Stream;
    return new C(stubConn(resets), id, isServer);
}

const enc = new TextEncoder();
const POST = [[':method', 'POST'], [':path', '/u'], ['content-length', '10']] as Array<[string, string]>;

/** Drain a stream's body and report bytes plus the error code, if any. */
async function drain(s: H2Stream): Promise<{ bytes: number; code: string | null; message: string | null }> {
    let bytes = 0;
    try {
        for await (const c of s.bodyChunks()) bytes += c.byteLength;
        return { bytes, code: null, message: null };
    } catch (e) {
        const err = e as Error & { code?: string };
        return { bytes, code: err.code ?? 'NO_CODE', message: err.message };
    }
}

/* ── the defect: RST_STREAM(0) mid-body must not look like a clean finish ───── */

Deno.test('h2 truncation: RST_STREAM(NO_ERROR) mid-body raises ECONNRESET, not a clean end', async () => {
    const s = rawStream(true);
    s.acceptHeaders(POST, 0);
    s.acceptData(enc.encode('0123'), false); // 4 of a declared 10
    s.acceptClose(0);                        // legitimate-looking early termination

    const r = await drain(s);
    strictEqual(r.bytes, 4, 'only 4 of the declared 10 bytes ever arrived');
    strictEqual(r.code, 'ECONNRESET', 'truncation must surface as an error the handler cannot miss');
    ok(/without END_STREAM|truncated/.test(r.message ?? ''), `message names the cause: ${r.message}`);
});

Deno.test('h2 stream: outbound END_STREAM rejects later writes', () => {
    const s = rawStream(true);
    s.respond([[':status', '204']], true);
    throws(() => s.sendData(enc.encode('late')), /already ended|END_STREAM/i);
    throws(() => s.respond([[':status', '200']], false), /headers already sent/i);
});

Deno.test('h2 cancellation: input cancellation waits for sent response frames and wakes pending reads', async () => {
    const resets: Reset[] = [];
    const stream = rawStream(true, resets);
    stream.acceptHeaders(POST, 0);
    const body = stream.bodyChunks();
    const pending = body.next();
    stream.cancelBody();
    strictEqual((await pending).done, true);
    // Cancelled uploads must not accumulate bytes while the response is blocked.
    for (let index = 0; index < 20; index++) stream.acceptData(new Uint8Array(1024 * 1024), false);
    stream.respond([[':status', '200']]);
    stream.sendData(enc.encode('accepted'), true);
    let complete = false;
    const sent = stream.waitForLocalEnd().then(() => { complete = true; });
    await Promise.resolve();
    strictEqual(complete, false, 'submitting END_STREAM is not completion');
    strictEqual(resets.length, 0);
    stream.acceptLocalEnd(Promise.resolve());
    await sent;
    strictEqual(resets.length, 1);
    strictEqual(resets[0]!.code, 0);
    stream.acceptClose(0);
    strictEqual((await drain(stream)).code, null);
});

Deno.test('h2 cancellation: cancelling completed input preserves clean stream completion', async () => {
    const resets: Reset[] = [];
    const stream = rawStream(true, resets);
    stream.acceptHeaders(POST, 0);
    stream.acceptData(enc.encode('0123456789'), true);
    stream.cancelBody();
    stream.respond([[':status', '204']], true);
    stream.acceptLocalEnd(Promise.resolve());
    stream.acceptClose(0);
    await stream.waitForLocalEnd();
    strictEqual(resets.length, 0);
    strictEqual((await drain(stream)).bytes, 0);
});

Deno.test('h2 truncation: a truncated stream is now DISTINGUISHABLE from a complete one', async () => {
    const clean = rawStream(true);
    clean.acceptHeaders(POST, 0);
    clean.acceptData(enc.encode('0123456789'), true);
    clean.acceptClose(0); // nghttp2 reports this for successful streams too
    const cleanR = await drain(clean);

    const cut = rawStream(true);
    cut.acceptHeaders(POST, 0);
    cut.acceptData(enc.encode('0123'), false);
    cut.acceptClose(0);
    const cutR = await drain(cut);

    strictEqual(cleanR.code, null, 'a genuinely finished stream must stay clean');
    strictEqual(cleanR.bytes, 10);
    strictEqual(cutR.code, 'ECONNRESET');
    ok(cleanR.code !== cutR.code, 'the two outcomes must not be observationally identical');
});

Deno.test('h2 truncation: readMessage() rejects for a body cut short', async () => {
    const s = rawStream(true);
    s.acceptHeaders(POST, 0);
    s.acceptData(enc.encode('0123'), false);
    s.acceptClose(0);
    let code: string | null = null;
    try { await s.readMessage(); } catch (e) { code = (e as { code?: string }).code ?? 'NO_CODE'; }
    strictEqual(code, 'ECONNRESET', 'the whole-message API must fail too, not just the stream');
});

Deno.test('h2 truncation: zero-length body with no END_STREAM is still truncation', async () => {
    // No DATA at all, then RST(0). Nothing arrived, and nothing said the body ended.
    const s = rawStream(true);
    s.acceptHeaders(POST, 0);
    s.acceptClose(0);
    const r = await drain(s);
    strictEqual(r.bytes, 0);
    strictEqual(r.code, 'ECONNRESET', 'an empty short body is as wrong as a partial one');
});

/* ── the false-positive side: every clean shape must stay clean ─────────────── */

Deno.test('h2 truncation: END_STREAM on HEADERS (bodyless request) stays clean', async () => {
    const s = rawStream(true);
    s.acceptHeaders([[':method', 'GET'], [':path', '/']], 0x1);
    s.acceptClose(0);
    const r = await drain(s);
    strictEqual(r.code, null, 'a GET whose END_STREAM rode on HEADERS is complete');
    strictEqual(r.bytes, 0);
});

Deno.test('h2 truncation: acceptEnd() (empty DATA + END_STREAM) counts as a real END_STREAM', async () => {
    // nghttp2 does not surface an empty END_STREAM DATA frame through ondata; the
    // frame observer calls acceptEnd() instead. That IS a real end and must not error.
    const s = rawStream(true);
    s.acceptHeaders([[':method', 'POST'], [':path', '/u']], 0);
    s.acceptData(enc.encode('0123'), false);
    s.acceptEnd();
    s.acceptClose(0);
    const r = await drain(s);
    strictEqual(r.code, null, 'acceptEnd() must set endStreamSeen, not just ended');
    strictEqual(r.bytes, 4);
});

Deno.test('h2 truncation: END_STREAM on trailers stays clean', async () => {
    const s = rawStream(true);
    s.acceptHeaders([[':method', 'POST'], [':path', '/u']], 0);
    s.acceptData(enc.encode('0123'), false);
    s.acceptTrailers([['x-checksum', 'abc']], 0x1);
    s.acceptClose(0);
    const r = await drain(s);
    strictEqual(r.code, null, 'a body terminated by END_STREAM on a trailer block is complete');
    strictEqual(r.bytes, 4);
});

Deno.test('h2 truncation: a handler that answers without draining is not reported as truncated', async () => {
    // The load-bearing false-positive case. A server replying 401 without reading
    // the upload closes its side; nghttp2 then reports on_stream_close(0). That is
    // OUR choice, not the peer truncating, so locallyEnded must suppress the error.
    const resets: Reset[] = [];
    const s = rawStream(true, resets);
    s.acceptHeaders(POST, 0);
    s.acceptData(enc.encode('0123'), false);
    s.close();          // handler done, stopped reading
    s.acceptClose(0);
    const r = await drain(s);
    strictEqual(r.code, null, 'we ended it; that is not a peer fault');
    ok(resets.length > 0, 'close() must still RST the stream');
});

Deno.test('h2 truncation: abort() then close(0) is not reported as truncated', async () => {
    const s = rawStream(true);
    s.acceptHeaders(POST, 0);
    s.acceptData(enc.encode('0123'), false);
    s.abort(8);
    s.acceptClose(0);
    const r = await drain(s);
    strictEqual(r.code, null, 'a locally aborted stream must not blame the peer');
});

Deno.test('h2 truncation: RST before any HEADERS produces no error (documented boundary)', async () => {
    // Nothing was ever delivered to a handler, so there is no partial payload to
    // mistake for a whole one. Pinned so the `headers !== null` guard is deliberate.
    const s = rawStream(true);
    s.acceptClose(0);
    const r = await drain(s);
    strictEqual(r.code, null, 'no headers means no request to truncate');
});

Deno.test('h2 client: close before response HEADERS rejects the whole-message waiter', async () => {
    const s = rawStream(false);
    s.acceptClose(0);
    let code: string | null = null;
    try { await s.readMessage(); } catch (e) { code = (e as { code?: string }).code ?? 'NO_CODE'; }
    strictEqual(code, 'ECONNRESET', 'a client with no response headers must not wait forever');
});

/* ── unchanged behaviour that must not regress ──────────────────────────────── */

Deno.test('h2 truncation: a non-zero RST_STREAM code still surfaces as ERR_HTTP2_STREAM_ERROR', async () => {
    const s = rawStream(true);
    s.acceptHeaders(POST, 0);
    s.acceptData(enc.encode('0123'), false);
    s.acceptClose(8); // CANCEL
    const r = await drain(s);
    strictEqual(r.code, 'ERR_HTTP2_STREAM_ERROR', 'explicit peer errors keep their own code');
});

Deno.test('h2 truncation: the first error wins — a real code is not overwritten by the close', async () => {
    const s = rawStream(true);
    s.acceptHeaders(POST, 0);
    s.acceptConnectionError(Object.assign(new Error('GOAWAY'), { code: 'ERR_HTTP2_SESSION_ERROR' }));
    s.acceptClose(0);
    const r = await drain(s);
    strictEqual(r.code, 'ERR_HTTP2_SESSION_ERROR', 'setStreamError keeps the first, more specific cause');
});

Deno.test({
    name: 'h2 truncation: a wire RST_STREAM(NO_ERROR) rejects a partial request body',
    ignore: !h2Available(),
    timeout: 15000,
}, async () => {
    const partial = Promise.withResolvers<void>();
    const outcome = Promise.withResolvers<{ bytes: number; code: unknown }>();
    const failure = Promise.withResolvers<never>();
    const server = createServer(async (request) => {
        let bytes = 0;
        try {
            for (;;) {
                const chunk = await request.body?.();
                if (!chunk) break;
                bytes += chunk.byteLength;
                partial.resolve();
            }
            outcome.resolve({ bytes, code: null });
        } catch (error) {
            outcome.resolve({ bytes, code: Reflect.get(error as object, 'code') });
        }
    }, { hostname: '127.0.0.1', port: 0, protocols: [HttpVersion.HTTP2] });
    server.listen();
    await server.acceptLoop();
    const address = server.address();
    ok(address && 'port' in address);
    const session = http2.connect(`http://127.0.0.1:${address.port}`);
    session.on('error', failure.reject);
    try {
        await Promise.race([
            new Promise<void>(resolve => session.once('connect', resolve)),
            failure.promise,
        ]);
        const request = session.request({ ':method': 'POST', ':path': '/partial', 'content-length': '10' }, { endStream: false });
        request.on('error', failure.reject);
        request.write('0123');
        await Promise.race([partial.promise, failure.promise]);
        request.close(http2.constants.NGHTTP2_NO_ERROR);
        const received = await Promise.race([outcome.promise, failure.promise]);
        strictEqual(received.bytes, 4);
        strictEqual(received.code, 'ECONNRESET');
    } finally {
        session.destroy();
        await server.shutdown();
    }
});

/* ── client side: a server that cuts a response short is the same defect ────── */

Deno.test('h2 truncation: client stream — server RST(0) mid-response is ECONNRESET', async () => {
    const s = rawStream(false);
    s.acceptHeaders([[':status', '200'], ['content-length', '10']], 0);
    s.acceptData(enc.encode('0123'), false);
    s.acceptClose(0);
    const r = await drain(s);
    strictEqual(r.code, 'ECONNRESET', 'a short response body must not read as a complete one');
    strictEqual(r.bytes, 4);
});

Deno.test('h2 truncation: client stream — a complete response stays clean', async () => {
    const s = rawStream(false);
    s.acceptHeaders([[':status', '200'], ['content-length', '4']], 0);
    s.acceptData(enc.encode('0123'), true);
    s.acceptClose(0);
    const r = await drain(s);
    strictEqual(r.code, null);
    strictEqual(r.bytes, 4);
});

Deno.test('h2 client: informational headers do not replace the final response headers', async () => {
    const s = rawStream(false);
    s.acceptHeaders([[':status', '103'], ['link', '</app.css>']], 0);
    // The native adapter reports the later response HEADERS through its generic
    // headers callback after an informational response.
    s.acceptTrailers([[':status', '200'], ['content-length', '2']], 0);
    s.acceptData(enc.encode('ok'), true);
    const msg = await s.readMessage();
    strictEqual((msg as { status: number }).status, 200);
    strictEqual(Array.from((msg as { body: Uint8Array }).body).join(','), '111,107');
});
