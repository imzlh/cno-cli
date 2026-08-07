/**
 * Network domain audit tests.
 *
 * `src/inspector/**` is compiled into cno.exe, but importing a domain by
 * relative path loads the TypeScript from disk, so these exercise the working
 * tree with no rebuild. NetworkDomain is driven directly through its hook entry
 * points (onFetchEvent / onServeEvent / onWSEvent) and its CDP commands through
 * a real CDPDispatcher.
 *
 * Node's inspector DOES implement the Network domain, so ordering/terminal-event
 * expectations here follow CDP as Node/Chrome implement it; each test says when
 * it is reasoning from the spec rather than from a measured Node run.
 */

import { ok, strictEqual } from 'node:assert';
import { NetworkDomain } from '../../src/inspector/domains/network';
import { CDPDispatcher, CDPError, CdpErrorCode } from '../../src/inspector/worker/dispatcher';
import type { WorkerEndpoint } from '../../src/inspector/transport/worker-endpoint';
import { NetFetchKind, NetServeKind, NetWSKind } from '../../src/inspector/shared/wire';
import { getTierLimits } from '../../cno/src/utils/memory-tier';

const PREVIEW_CAP = getTierLimits().inspectorPreviewBodyBytes;

interface Rec { method: string; params: Record<string, unknown> }

function newDomain(): { net: NetworkDomain; dispatcher: CDPDispatcher; events: Rec[] } {
    const dispatcher = new CDPDispatcher();
    const events: Rec[] = [];
    const rpc = { call: () => ({}), notify: () => {} } as unknown as WorkerEndpoint;
    const net = new NetworkDomain(
        dispatcher,
        (method, params) => events.push({ method, params: (params ?? {}) as Record<string, unknown> }),
        rpc,
    );
    return { net, dispatcher, events };
}

function fetchReq(net: NetworkDomain, id: string, t = 1, url = 'https://example.test/a'): void {
    net.onFetchEvent({
        ev: NetFetchKind.Req, source: 'fetch', requestId: id, timestamp: t,
        url, method: 'GET', headers: {}, resourceType: 'Fetch',
    });
}
function fetchRes(net: NetworkDomain, id: string, t = 2, status = 200): void {
    net.onFetchEvent({
        ev: NetFetchKind.Res, source: 'fetch', requestId: id, timestamp: t,
        url: 'https://example.test/a', status, headers: { 'content-type': 'text/plain' },
    });
}
function fetchData(net: NetworkDomain, id: string, n: number, t = 3): void {
    net.onFetchEvent({
        ev: NetFetchKind.Data, source: 'fetch', requestId: id, timestamp: t,
        data: new Uint8Array(n), byteLength: n,
    });
}
function fetchDone(net: NetworkDomain, id: string, success = true, t = 4, errorText?: string): void {
    net.onFetchEvent({
        ev: NetFetchKind.Done, source: 'fetch', requestId: id, timestamp: t,
        success, errorText,
    } as Parameters<NetworkDomain['onFetchEvent']>[0]);
}

const methods = (events: Rec[]): string[] => events.map((e) => e.method);
const forId = (events: Rec[], id: string): string[] =>
    events.filter((e) => e.params.requestId === id).map((e) => e.method);

async function expectError(fn: () => Promise<unknown>, code: number, label: string): Promise<void> {
    let caught: unknown;
    try { await fn(); } catch (e) { caught = e; }
    if (!(caught instanceof CDPError)) {
        throw new Error(`${label}: expected a CDPError, got ${caught === undefined ? 'no throw' : String(caught)}`);
    }
    strictEqual(caught.code, code, `${label}: wrong error code`);
}

// ── 1. lifecycle: every started request reaches a terminal event ──────

Deno.test('network: a successful request runs requestWillBeSent -> responseReceived -> loadingFinished', async () => {
    const { net, dispatcher, events } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'r1');
    fetchRes(net, 'r1');
    fetchData(net, 'r1', 16);
    fetchDone(net, 'r1', true);

    const seq = forId(events, 'r1');
    ok(seq.includes('Network.requestWillBeSent'), 'missing requestWillBeSent');
    ok(seq.includes('Network.responseReceived'), 'missing responseReceived');
    ok(seq.includes('Network.dataReceived'), 'missing dataReceived');
    ok(seq.includes('Network.loadingFinished'), 'missing terminal loadingFinished');
    // Ordering: the start must precede the terminal event.
    ok(seq.indexOf('Network.requestWillBeSent') < seq.indexOf('Network.loadingFinished'));
});

Deno.test('network: a failed request still reaches a terminal loadingFailed', async () => {
    const { net, dispatcher, events } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'r2');
    fetchDone(net, 'r2', false, 4, 'net::ERR_CONNECTION_REFUSED');

    const seq = forId(events, 'r2');
    ok(seq.includes('Network.loadingFailed'), 'a failed request must reach loadingFailed');
    ok(!seq.includes('Network.loadingFinished'), 'must not report both terminal events');
    const failed = events.find((e) => e.method === 'Network.loadingFailed');
    strictEqual(failed?.params.errorText, 'net::ERR_CONNECTION_REFUSED');
});

Deno.test('network: a request in flight when enable arrives is not reported at all', async () => {
    // Regression: Res/Data/Done were emitted for a requestId that never got a
    // requestWillBeSent, handing DevTools terminal events for an unknown request.
    // REASONED from the CDP ordering contract (Chrome/Node never report a request
    // that started before the domain was enabled).
    const { net, dispatcher, events } = newDomain();
    fetchReq(net, 'early');            // before enable -> dropped, correctly
    await dispatcher.dispatch('Network.enable', {});
    fetchRes(net, 'early');
    fetchData(net, 'early', 8);
    fetchDone(net, 'early', true);

    strictEqual(forId(events, 'early').length, 0,
        `no event may reference a request that was never announced, got ${forId(events, 'early').join(',')}`);
});

Deno.test('network: an unannounced request still releases its requestId-keyed state', async () => {
    const { net, dispatcher } = newDomain();
    fetchReq(net, 'orphan');
    await dispatcher.dispatch('Network.enable', {});
    fetchDone(net, 'orphan', true);
    // Its body must not be readable afterwards.
    await expectError(() => dispatcher.dispatch('Network.getResponseBody', { requestId: 'orphan' }),
        CdpErrorCode.InvalidParams, 'released orphan body');
});

// ── 2. the eviction hang ─────────────────────────────────────────────

Deno.test('network: a chunk over the eviction budget does not hang the worker', async () => {
    // Regression, OBSERVED as a real hang before the fix: ensurePendingBodyCapacity
    // re-read the map head each iteration while dropBufferedBodyForRequest zeroed the
    // entry without removing its key, so once the head had nothing left to reclaim the
    // loop spun forever, wedging the inspector worker thread at 100% CPU.
    // Reachable from ordinary traffic: two concurrent responses where one chunk
    // exceeds half the preview cap.
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'A');
    fetchReq(net, 'B');
    fetchData(net, 'A', 1024);
    fetchData(net, 'B', Math.floor(PREVIEW_CAP * 0.75));   // hung here
    fetchDone(net, 'A', true);
    fetchDone(net, 'B', true);
    ok(true, 'returned instead of spinning');
});

Deno.test('network: an already-truncated head entry does not hang the evictor', async () => {
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'A');
    fetchReq(net, 'B');
    fetchData(net, 'A', PREVIEW_CAP + 1024);                // truncates A, key stays
    fetchData(net, 'B', Math.floor(PREVIEW_CAP * 0.75));    // hung here
    ok(true, 'returned instead of spinning');
});

Deno.test('network: an oversized body reports unavailable rather than a wrong body', async () => {
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'big');
    fetchRes(net, 'big');
    fetchData(net, 'big', PREVIEW_CAP + 4096);
    fetchDone(net, 'big', true);
    const body = await dispatcher.dispatch('Network.getResponseBody', { requestId: 'big' }) as { body: string };
    ok(body.body.length > 0, 'a truncated body must still answer with a placeholder');
    ok(!body.body.includes(' '), 'must not hand back raw truncated bytes');
});

// ── 3. getResponseBody / getRequestPostData on ids that do not exist ──

Deno.test('network: getResponseBody on a requestId that never existed is an error', async () => {
    // Was: `{ body: '', base64Encoded: false }`, indistinguishable from a real empty
    // 204 body.
    // MEASURED against node v24.18 via inspector.Session:
    //   Network.getResponseBody {requestId:'never-existed'} -> -32602 "Request not found"
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    await expectError(() => dispatcher.dispatch('Network.getResponseBody', { requestId: 'never-existed' }),
        CdpErrorCode.InvalidParams, 'unknown requestId');
});

Deno.test('network: streamResourceContent on an unknown requestId is an error', async () => {
    // MEASURED against node v24.18: -32602 "Request not found". Previously this
    // fell through to an RPC into the main thread for a nonexistent request.
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    await expectError(() => dispatcher.dispatch('Network.streamResourceContent', { requestId: 'ghost' }),
        CdpErrorCode.InvalidParams, 'unknown stream requestId');
});

Deno.test('network: a non-string requestId is rejected, where node v24.18 aborts', async () => {
    // OBSERVED oracle divergence in cno's favour: node v24.18 does not merely
    // error on `Network.getResponseBody {requestId: 42}` -- it fails a CHECK in
    // src/inspector/node_string.cc ("Assertion failed: state->tokenizer()->
    // TokenTag() == cbor::CBORTokenTag::STRING16") and dumps a native stack,
    // killing the process. cno must keep answering InvalidParams instead.
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    await expectError(() => dispatcher.dispatch('Network.getResponseBody', { requestId: 42 }),
        CdpErrorCode.InvalidParams, 'numeric requestId');
});

Deno.test('network: getResponseBody after the body was evicted is an error, not empty', async () => {
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'gone');
    fetchRes(net, 'gone');
    fetchDone(net, 'gone', true);
    await dispatcher.dispatch('Network.disable', {});     // releases cached bodies
    await dispatcher.dispatch('Network.enable', {});
    await expectError(() => dispatcher.dispatch('Network.getResponseBody', { requestId: 'gone' }),
        CdpErrorCode.InvalidParams, 'released body');
});

Deno.test('network: getRequestPostData with no post data is an error, not an empty string', async () => {
    // MEASURED against node v24.18: -32602 "Request not found".
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    await expectError(() => dispatcher.dispatch('Network.getRequestPostData', { requestId: 'nope' }),
        CdpErrorCode.InvalidParams, 'absent post data');
});

Deno.test('network: a buffered body round-trips through getResponseBody', async () => {
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'ok1');
    fetchRes(net, 'ok1');
    net.onFetchEvent({
        ev: NetFetchKind.Data, source: 'fetch', requestId: 'ok1', timestamp: 3,
        data: new TextEncoder().encode('hello body'), byteLength: 10,
    });
    fetchDone(net, 'ok1', true);
    const res = await dispatcher.dispatch('Network.getResponseBody', { requestId: 'ok1' }) as
        { body: string; base64Encoded: boolean };
    strictEqual(res.body, 'hello body');
    strictEqual(res.base64Encoded, false);
});

// ── 4. malformed / hostile CDP input ─────────────────────────────────

Deno.test('network: unknown Network method reports method-not-found', async () => {
    const { dispatcher } = newDomain();
    await expectError(() => dispatcher.dispatch('Network.thisDoesNotExist', {}),
        CdpErrorCode.MethodNotFound, 'unknown method');
});

Deno.test('network: commands requiring requestId reject a missing param', async () => {
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    for (const method of ['Network.getResponseBody', 'Network.getRequestPostData', 'Network.streamResourceContent']) {
        await expectError(() => dispatcher.dispatch(method, {}), CdpErrorCode.InvalidParams, `${method} missing`);
    }
});

Deno.test('network: commands requiring requestId reject wrong param types', async () => {
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    const bad: unknown[] = [42, null, {}, [], true];
    for (const value of bad) {
        await expectError(() => dispatcher.dispatch('Network.getResponseBody', { requestId: value }),
            CdpErrorCode.InvalidParams, `requestId=${JSON.stringify(value) ?? 'undefined'}`);
    }
});

Deno.test('network: wrong-typed params on setter commands do not throw', async () => {
    // These are best-effort setters; a hostile payload must be ignored, not crash
    // the worker. A clean result is the correct outcome.
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    await dispatcher.dispatch('Network.setExtraHTTPHeaders', { headers: 'not-an-object' });
    await dispatcher.dispatch('Network.setExtraHTTPHeaders', { headers: { a: 1, b: 'ok' } });
    await dispatcher.dispatch('Network.setUserAgentOverride', { userAgent: 12345 });
    await dispatcher.dispatch('Network.setCookies', { cookies: 'nope' });
    await dispatcher.dispatch('Network.setCookie', { name: null, value: [] });
    await dispatcher.dispatch('Network.deleteCookies', {});
    ok(true, 'malformed setter payloads were absorbed');
});

Deno.test('network: a huge payload is handled without hanging', async () => {
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    const hugeId = 'x'.repeat(1_000_000);
    await expectError(() => dispatcher.dispatch('Network.getResponseBody', { requestId: hugeId }),
        CdpErrorCode.InvalidParams, 'huge requestId');
    const manyHeaders: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) manyHeaders[`h${i}`] = 'v';
    await dispatcher.dispatch('Network.setExtraHTTPHeaders', { headers: manyHeaders });
    ok(true, 'huge payloads did not hang');
});

Deno.test('network: duplicate enable is idempotent and does not double-report', async () => {
    const { net, dispatcher, events } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    await dispatcher.dispatch('Network.enable', {});
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'dup');
    strictEqual(events.filter((e) => e.method === 'Network.requestWillBeSent').length, 1,
        'duplicate enable must not multiply events');
});

Deno.test('network: disable without enable succeeds and leaves the domain quiet', async () => {
    const { net, dispatcher, events } = newDomain();
    await dispatcher.dispatch('Network.disable', {});
    await dispatcher.dispatch('Network.disable', {});
    fetchReq(net, 'quiet');
    fetchDone(net, 'quiet', true);
    strictEqual(events.length, 0, 'a disabled domain must emit nothing');
});

Deno.test('network: events are gated on enable', async () => {
    const { net, dispatcher, events } = newDomain();
    fetchReq(net, 'g1');
    fetchRes(net, 'g1');
    strictEqual(events.length, 0, 'nothing before enable');
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'g2');
    ok(events.length > 0, 'events flow after enable');
    await dispatcher.dispatch('Network.disable', {});
    const afterDisable = events.length;
    fetchReq(net, 'g3');
    fetchDone(net, 'g3', true);
    strictEqual(events.length, afterDisable, 'nothing after disable');
});

// ── 5. detach / reattach ─────────────────────────────────────────────

Deno.test('network: detach resets enable so session 2 does not inherit it', async () => {
    // Regression: NetworkDomain had no setConnected at all and was absent from
    // ConnectionDeps, so `enabled` survived the client that set it -- the same
    // class of leak already fixed for Fetch.enable.
    const { net, dispatcher, events } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    net.setConnected(false);
    fetchReq(net, 's2');
    strictEqual(events.length, 0, 'a fresh session must not inherit Network.enable');
});

Deno.test('network: session 1 response bodies are not readable by session 2', async () => {
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'secret');
    fetchRes(net, 'secret');
    net.onFetchEvent({
        ev: NetFetchKind.Data, source: 'fetch', requestId: 'secret', timestamp: 3,
        data: new TextEncoder().encode('session-1 payload'), byteLength: 17,
    });
    fetchDone(net, 'secret', true);
    // Session 1 can read it.
    const own = await dispatcher.dispatch('Network.getResponseBody', { requestId: 'secret' }) as { body: string };
    strictEqual(own.body, 'session-1 payload');

    net.setConnected(false);              // detach
    await dispatcher.dispatch('Network.enable', {});   // session 2 enables
    await expectError(() => dispatcher.dispatch('Network.getResponseBody', { requestId: 'secret' }),
        CdpErrorCode.InvalidParams, 'cross-session body read');
});

Deno.test('network: cookies set in session 1 do not leak into session 2', async () => {
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    await dispatcher.dispatch('Network.setCookie', { name: 'sid', value: 'abc123', domain: 'example.test' });
    const before = await dispatcher.dispatch('Network.getCookies', {}) as { cookies: unknown[] };
    strictEqual(before.cookies.length, 1);

    net.setConnected(false);
    await dispatcher.dispatch('Network.enable', {});
    const after = await dispatcher.dispatch('Network.getCookies', {}) as { cookies: unknown[] };
    strictEqual(after.cookies.length, 0, 'session 2 must not see session 1 cookies');
});

Deno.test('network: a request spanning a detach does not emit into session 2', async () => {
    const { net, dispatcher, events } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'span');
    net.setConnected(false);
    await dispatcher.dispatch('Network.enable', {});
    const mark = events.length;
    fetchRes(net, 'span');
    fetchDone(net, 'span', true);
    strictEqual(events.length - mark, 0,
        'terminal events for a session-1 request must not surface in session 2');
});

Deno.test('network: setConnected(true) does not clear live state', async () => {
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    await dispatcher.dispatch('Network.setCookie', { name: 'k', value: 'v' });
    net.setConnected(true);
    const c = await dispatcher.dispatch('Network.getCookies', {}) as { cookies: unknown[] };
    strictEqual(c.cookies.length, 1, 'attach must not wipe state');
});

// ── 6. WebSocket lifecycle and its maps ──────────────────────────────

Deno.test('network: a websocket runs created -> handshake -> frames -> closed', async () => {
    const { net, dispatcher, events } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    net.onWSEvent({
        ev: NetWSKind.Created, source: 'fetch', requestId: 'ws1', timestamp: 1,
        url: 'ws://127.0.0.1:9/s', requestHeaders: [['upgrade', 'websocket']],
    } as Parameters<NetworkDomain['onWSEvent']>[0]);
    net.onWSEvent({
        ev: NetWSKind.Handshake, source: 'fetch', requestId: 'ws1', timestamp: 2,
        status: 101, headers: [['upgrade', 'websocket']],
    } as Parameters<NetworkDomain['onWSEvent']>[0]);
    net.onWSEvent({
        ev: NetWSKind.Sent, source: 'fetch', requestId: 'ws1', timestamp: 3,
        opcode: 1, masked: true, payloadData: 'ping',
    } as Parameters<NetworkDomain['onWSEvent']>[0]);
    net.onWSEvent({
        ev: NetWSKind.Recv, source: 'fetch', requestId: 'ws1', timestamp: 4,
        opcode: 1, masked: false, payloadData: 'pong',
    } as Parameters<NetworkDomain['onWSEvent']>[0]);
    net.onWSEvent({
        ev: NetWSKind.Closed, source: 'fetch', requestId: 'ws1', timestamp: 5, code: 1000,
    } as Parameters<NetworkDomain['onWSEvent']>[0]);

    const seq = forId(events, 'ws1');
    ok(seq.includes('Network.webSocketCreated'), 'missing webSocketCreated');
    ok(seq.includes('Network.webSocketWillSendHandshakeRequest'), 'missing handshake request');
    ok(seq.includes('Network.webSocketHandshakeResponseReceived'), 'missing handshake response');
    ok(seq.includes('Network.webSocketFrameSent'), 'missing frameSent');
    ok(seq.includes('Network.webSocketFrameReceived'), 'missing frameReceived');
    ok(seq.includes('Network.webSocketClosed'), 'missing terminal webSocketClosed');
    // A clean 1000 close is not an error.
    ok(!seq.includes('Network.webSocketFrameError'), 'a normal close must not report frameError');
});

Deno.test('network: a websocket upgrade does not also report an HTTP terminal event', async () => {
    const { net, dispatcher, events } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    net.onServeEvent({
        ev: NetServeKind.Req, source: 'serve', requestId: 'u1', timestamp: 1,
        url: 'http://127.0.0.1:8000/ws', method: 'GET',
        headers: { upgrade: 'websocket', connection: 'Upgrade' },
    } as Parameters<NetworkDomain['onServeEvent']>[0]);
    net.onServeEvent({
        ev: NetServeKind.Done, source: 'serve', requestId: 'u1', timestamp: 2, success: true,
    } as Parameters<NetworkDomain['onServeEvent']>[0]);
    const seq = forId(events, 'u1');
    ok(!seq.includes('Network.loadingFinished'), 'an upgrade must not close as a plain HTTP load');
});

Deno.test('network: websocket events for an unknown id do not crash', async () => {
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    net.onWSEvent({
        ev: NetWSKind.Closed, source: 'fetch', requestId: 'never', timestamp: 1, code: 1006,
    } as Parameters<NetworkDomain['onWSEvent']>[0]);
    net.onWSEvent({
        ev: NetWSKind.Recv, source: 'fetch', requestId: 'never2', timestamp: 2,
        opcode: 1, masked: false, payloadData: 'x',
    } as Parameters<NetworkDomain['onWSEvent']>[0]);
    ok(true, 'unknown websocket ids were absorbed');
});

// ── 7. staleness eviction must not evict a live long request ─────────

Deno.test('network: a long-running request is not evicted while still active', async () => {
    // Regression, OBSERVED on the pre-fix code: eviction was keyed on START time
    // and only ever ran from a Done event, so a still-streaming request could be
    // evicted by an UNRELATED request completing. Baseline measured 28 dataReceived
    // events but a recovered body of only 9 chunks -- silent mid-flight body loss,
    // plus loss of reqMeta (so a subsequent loadingFailed reported type 'Other').
    // Now keyed on last activity.
    const { net, dispatcher, events } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'slow', 0);
    fetchRes(net, 'slow', 1);
    for (let t = 10; t <= 190; t += 10) {
        net.onFetchEvent({
            ev: NetFetchKind.Data, source: 'fetch', requestId: 'slow', timestamp: t,
            data: new TextEncoder().encode('ab'), byteLength: 2,
        });
    }
    // An unrelated request completing at t=200 drives the cleanup tick (cutoff=80).
    fetchReq(net, 'other', 200);
    fetchDone(net, 'other', true, 200);
    for (let t = 210; t <= 290; t += 10) {
        net.onFetchEvent({
            ev: NetFetchKind.Data, source: 'fetch', requestId: 'slow', timestamp: t,
            data: new TextEncoder().encode('ab'), byteLength: 2,
        });
    }
    fetchDone(net, 'slow', true, 300);

    const seq = forId(events, 'slow');
    const chunks = seq.filter((m) => m === 'Network.dataReceived').length;
    ok(seq.includes('Network.loadingFinished'), 'a still-active request must reach its terminal event');
    const body = await dispatcher.dispatch('Network.getResponseBody', { requestId: 'slow' }) as { body: string };
    strictEqual(body.body.length, chunks * 2,
        `body must hold every chunk received (${chunks} chunks = ${chunks * 2} bytes), got ${body.body.length}`);
});

Deno.test('network: an abandoned request is evicted once it goes stale', async () => {
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'abandoned', 1);      // never completes
    // Unrelated later traffic drives the cleanup tick past the cutoff.
    fetchReq(net, 'later', 500);
    fetchDone(net, 'later', true, 501);
    await expectError(() => dispatcher.dispatch('Network.getResponseBody', { requestId: 'abandoned' }),
        CdpErrorCode.InvalidParams, 'stale abandoned request');
});

// ── 8. eviction is only ever driven by a Done event ──────────────────
//
// `cleanupStaleEntries` is called from exactly two places, both inside
// handleNetworkDoneEvent (network.ts:694 and :750). There is no timer. So a
// workload that produces no Done events never evicts anything, and the maps the
// evictor is responsible for grow for the process lifetime.
//
// These read private maps deliberately: the leak is invisible from the CDP
// surface (the whole problem is that nothing is emitted for these ids), so the
// map is the only observable.

/** Total entries across every requestId-keyed map. */
function stateSize(net: NetworkDomain): number {
    const n = net as unknown as Record<string, { size: number } | undefined>;
    const maps = ['responseBodyCache', 'requestBodyCache', 'pendingBodies', 'streamedBodies',
        'reqStartTimes', 'reqMeta', 'wsMeta', 'wsUpgradeRequests', 'announced', 'lastSeen'];
    return maps.reduce((sum, m) => sum + (n[m]?.size ?? 0), 0);
}
function mapSize(net: NetworkDomain, name: string): number {
    return (net as unknown as Record<string, { size: number } | undefined>)[name]?.size ?? 0;
}

Deno.test('network: EXPECTED-RED requests that never complete do not accumulate state', async () => {
    // EXPECTED RED -- documents the unbounded leak, unfixed at time of writing.
    //
    // OBSERVED growth, measured at three values of N with no decay (exactly 5
    // retained entries per request: pendingBodies, reqStartTimes, reqMeta,
    // announced, lastSeen):
    //     N=100  -> 500 entries
    //     N=1000 -> 5000 entries
    //     N=5000 -> 25000 entries
    // Cause: nothing calls cleanupStaleEntries except a Done event, so a request
    // that never completes is never reclaimed. The evictor itself is correct --
    // see the mixed-traffic test below, where it does bound the same ids.
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});

    // Timestamps advance 1s per request, so by the end the early ids are far
    // past the 120s staleness cutoff and SHOULD have been reclaimed.
    for (let i = 0; i < 1000; i++) {
        const id = `never-${i}`;
        fetchReq(net, id, i);
        fetchRes(net, id, i);
        fetchData(net, id, 64, i);
        // deliberately no Done
    }

    const size = stateSize(net);
    // A bound comparable to the body caches' own caps. 1000 requests spanning
    // ~1000 simulated seconds should leave only the recent window live.
    ok(size < 1000,
        `requestId-keyed state must stay bounded for requests that never complete; `
        + `1000 abandoned requests retained ${size} entries `
        + `(reqMeta=${mapSize(net, 'reqMeta')}, announced=${mapSize(net, 'announced')}, `
        + `lastSeen=${mapSize(net, 'lastSeen')}, reqStartTimes=${mapSize(net, 'reqStartTimes')}, `
        + `pendingBodies=${mapSize(net, 'pendingBodies')})`);
});

Deno.test('network: EXPECTED-RED a closed client websocket does not leak reqStartTimes', async () => {
    // EXPECTED RED -- documents the second, more reachable leak.
    //
    // NetWSKind.Created sets reqStartTimes (network.ts:558). NetWSKind.Closed
    // deletes reqStartTimes/reqMeta only when the id is in `wsUpgradeRequests`
    // (network.ts:628-632), and that set is populated ONLY by the serve-side
    // HTTP-upgrade path (:437, :487). A CLIENT websocket (`new WebSocket()`,
    // source 'fetch') therefore never takes that branch: Closed drops lastSeen
    // but keeps reqStartTimes.
    //
    // The id is then invisible to cleanupStaleEntries' FIRST loop (it iterates
    // lastSeen) and reclaimable only by the SECOND loop -- which runs only on an
    // HTTP Done. A pure-WebSocket workload has none.
    //
    // OBSERVED: 100 -> 100, 1000 -> 1000, 5000 -> 5000. One permanent entry per
    // closed connection, for the process lifetime. Reconnecting clients make it
    // monotonic. No adversary and no failure required.
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});

    for (let i = 0; i < 1000; i++) {
        const id = `ws-${i}`;
        net.onWSEvent({
            ev: NetWSKind.Created, source: 'fetch', requestId: id, timestamp: i,
            url: `ws://127.0.0.1:9/${id}`, requestHeaders: [['upgrade', 'websocket']],
        } as Parameters<NetworkDomain['onWSEvent']>[0]);
        net.onWSEvent({
            ev: NetWSKind.Closed, source: 'fetch', requestId: id, timestamp: i, code: 1000,
        } as Parameters<NetworkDomain['onWSEvent']>[0]);
    }

    strictEqual(mapSize(net, 'reqStartTimes'), 0,
        `a closed websocket must release reqStartTimes; 1000 open/close cycles left `
        + `${mapSize(net, 'reqStartTimes')} entries (total state ${stateSize(net)})`);
});

Deno.test('network: mixed traffic DOES bound the same websocket ids', async () => {
    // The control that isolates the cause. Identical websocket workload to the
    // test above, except one HTTP request completes every 50 cycles -- which is
    // all it takes to drive the cleanup tick. If this passes while the test above
    // fails, the eviction LOGIC is correct and only its trigger is missing.
    // OBSERVED: flattens at 170 entries for N=1000 and N=5000 alike.
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});

    for (let i = 0; i < 1000; i++) {
        const id = `wsm-${i}`;
        net.onWSEvent({
            ev: NetWSKind.Created, source: 'fetch', requestId: id, timestamp: i,
            url: `ws://127.0.0.1:9/${id}`, requestHeaders: [['upgrade', 'websocket']],
        } as Parameters<NetworkDomain['onWSEvent']>[0]);
        net.onWSEvent({
            ev: NetWSKind.Closed, source: 'fetch', requestId: id, timestamp: i, code: 1000,
        } as Parameters<NetworkDomain['onWSEvent']>[0]);
        if (i % 50 === 0) {
            fetchReq(net, `http-${i}`, i);
            fetchDone(net, `http-${i}`, true, i);
        }
    }

    ok(mapSize(net, 'reqStartTimes') < 400,
        `with Done events present the evictor must bound reqStartTimes, got ${mapSize(net, 'reqStartTimes')}`);
});

Deno.test('network: Network.disable releases all per-request state', async () => {
    // The one reclamation path that IS reliable today, asserted so a future fix
    // to the leaks above cannot regress it.
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    for (let i = 0; i < 200; i++) {
        const id = `d-${i}`;
        fetchReq(net, id, i);
        fetchRes(net, id, i);
        fetchData(net, id, 64, i);
    }
    ok(stateSize(net) > 0, 'precondition: state accumulated');
    await dispatcher.dispatch('Network.disable', {});
    strictEqual(stateSize(net), 0, `Network.disable must release every map, ${stateSize(net)} entries left`);
});

Deno.test('network: client detach releases all per-request state', async () => {
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    for (let i = 0; i < 200; i++) {
        const id = `x-${i}`;
        fetchReq(net, id, i);
        fetchRes(net, id, i);
        fetchData(net, id, 64, i);
    }
    ok(stateSize(net) > 0, 'precondition: state accumulated');
    net.setConnected(false);
    strictEqual(stateSize(net), 0, `detach must release every map, ${stateSize(net)} entries left`);
});
