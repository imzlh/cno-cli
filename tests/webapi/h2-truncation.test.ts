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
 * METHOD — read this before trusting any of it. The native nghttp2 extension is
 * NOT available in this binary (`h2Available() === false`, verified in-test
 * below), so a real HTTP/2 connection cannot be established and `H2Connection` is
 * unconstructible: its constructor calls requireH2(), which throws. These tests
 * therefore construct the REAL `H2Stream` class directly and drive the callbacks
 * nghttp2 would drive (acceptHeaders / acceptData / acceptEnd / acceptClose), with
 * a stub object standing in for the connection.
 *
 * What that does and does not prove:
 *   - PROVEN: the END_STREAM-vs-RST_STREAM(0) accounting in H2Stream, which is
 *     where the entire defect lives and is pure JS bookkeeping.
 *   - NOT PROVEN: nghttp2 frame parsing, and that the C layer calls these methods
 *     with the flags asserted here. A previous agent's h2-body-cap tests passed
 *     12/12 against a stubbed *H2Connection* while proving nothing about the real
 *     path; the difference here is that the class under test is the real one and
 *     the stub is only its collaborator.
 * Deliberately does NOT import node:http2 — that module is independently broken in
 * this tree (duplicate invalidArgType) and would mask these results as a syntax error.
 */
import { ok, strictEqual } from 'node:assert';
import { H2Stream } from '@cnojs/http/h2';
import { h2Available } from '@cnojs/http/h2-native';

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

/* ── the method disclosure is itself an assertion ───────────────────────────── */

Deno.test('h2 truncation: METHOD — native h2 is unavailable, so these drive H2Stream directly', () => {
    strictEqual(
        h2Available(), false,
        'if this ever becomes true, rewrite these tests against a real connection — ' +
        'direct construction stops being the honest method',
    );
});

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
