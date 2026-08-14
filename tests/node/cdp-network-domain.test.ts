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

function newDomain(
    call: (method: string, params: unknown) => unknown = () => ({}),
): { net: NetworkDomain; dispatcher: CDPDispatcher; events: Rec[] } {
    const dispatcher = new CDPDispatcher();
    const events: Rec[] = [];
    const rpc = { call, notify: () => {} } as unknown as WorkerEndpoint;
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

Deno.test('network: streamResourceContent returns main-thread buffered history', async () => {
    const history = new TextEncoder().encode('history-before-streaming');
    const calls: Array<{ method: string; params: unknown }> = [];
    const { net, dispatcher, events } = newDomain((method, params) => {
        calls.push({ method, params });
        return { bufferedData: history };
    });
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'streamed');
    fetchRes(net, 'streamed');

    const response = await dispatcher.dispatch('Network.streamResourceContent', {
        requestId: 'streamed',
    }) as { bufferedData: string };
    const decoded = Uint8Array.from(atob(response.bufferedData), c => c.charCodeAt(0));
    strictEqual(new TextDecoder().decode(decoded), 'history-before-streaming');
    strictEqual(calls[0]?.method, 'streamResourceContent');

    net.onFetchEvent({
        ev: NetFetchKind.Data,
        source: 'fetch',
        requestId: 'streamed',
        timestamp: 3,
        data: new TextEncoder().encode('live'),
        byteLength: 4,
    });
    const dataEvent = events.find(e => e.method === 'Network.dataReceived' && e.params.requestId === 'streamed');
    ok(typeof dataEvent?.params.data === 'string' && dataEvent.params.data.length > 0,
        'subsequent chunks must be carried inline after streaming starts');
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

Deno.test('network: searchInResponseBody finds a string the cached body contains', async () => {
    // Was `() => ({ result: [] })`, which ignored requestId AND query. The defect
    // was not a missing feature but a WRONG ANSWER on valid input: the same id
    // that getResponseBody happily returns 'NEEDLE ...' for reported no matches,
    // so DevTools' Network-panel body search silently found nothing.
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    const body = 'first line\nNEEDLE is present in this body\nthird line\nneedle again lowercase\n';
    fetchReq(net, 'srch');
    fetchRes(net, 'srch');
    net.onFetchEvent({
        ev: NetFetchKind.Data, source: 'fetch', requestId: 'srch', timestamp: 3,
        data: new TextEncoder().encode(body), byteLength: new TextEncoder().encode(body).byteLength,
    });
    fetchDone(net, 'srch', true);

    // Precondition: the body really is readable for this id.
    const got = await dispatcher.dispatch('Network.getResponseBody', { requestId: 'srch' }) as { body: string };
    ok(got.body.includes('NEEDLE'), 'precondition: the cached body contains NEEDLE');

    // Default search is case-INsensitive, so both lines match.
    const res = await dispatcher.dispatch('Network.searchInResponseBody',
        { requestId: 'srch', query: 'needle' }) as
        { result: Array<{ lineNumber: number; lineContent: string }> };
    strictEqual(res.result.length, 2,
        `a string the body contains must be found, got ${JSON.stringify(res.result)}`);
    // CDP SearchMatch.lineNumber is 0-based.
    strictEqual(res.result[0]?.lineNumber, 1);
    strictEqual(res.result[0]?.lineContent, 'NEEDLE is present in this body');
    strictEqual(res.result[1]?.lineNumber, 3);
});

Deno.test('network: searchInResponseBody honours caseSensitive and isRegex', async () => {
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    const body = 'alpha\nNEEDLE upper\nneedle lower\nbeta\n';
    fetchReq(net, 'srch2');
    fetchRes(net, 'srch2');
    net.onFetchEvent({
        ev: NetFetchKind.Data, source: 'fetch', requestId: 'srch2', timestamp: 3,
        data: new TextEncoder().encode(body), byteLength: new TextEncoder().encode(body).byteLength,
    });
    fetchDone(net, 'srch2', true);

    const sensitive = await dispatcher.dispatch('Network.searchInResponseBody',
        { requestId: 'srch2', query: 'NEEDLE', caseSensitive: true }) as { result: unknown[] };
    strictEqual(sensitive.result.length, 1, 'caseSensitive must exclude the lowercase line');

    // Anchored regex, case-sensitive: only the lowercase line starts with it.
    const rx = await dispatcher.dispatch('Network.searchInResponseBody',
        { requestId: 'srch2', query: '^needle', isRegex: true, caseSensitive: true }) as
        { result: Array<{ lineNumber: number }> };
    strictEqual(rx.result.length, 1, 'an anchored regex matches per line');
    strictEqual(rx.result[0]?.lineNumber, 2);

    // Case-insensitive, same anchor: now both NEEDLE-initial lines match, which
    // shows the flag reaches the regex path too.
    const rxi = await dispatcher.dispatch('Network.searchInResponseBody',
        { requestId: 'srch2', query: '^needle', isRegex: true }) as { result: unknown[] };
    strictEqual(rxi.result.length, 2, 'caseSensitive must apply to the regex path');

    // The anchor is real: 'lower' occurs in line 2 but not at its start.
    const anchored = await dispatcher.dispatch('Network.searchInResponseBody',
        { requestId: 'srch2', query: '^lower', isRegex: true }) as { result: unknown[] };
    strictEqual(anchored.result.length, 0, 'a mid-line term must not match an anchored pattern');

    const none = await dispatcher.dispatch('Network.searchInResponseBody',
        { requestId: 'srch2', query: 'ABSENT-FROM-BODY' }) as { result: unknown[] };
    strictEqual(none.result.length, 0, 'a genuinely absent string yields an empty result');
});

Deno.test('network: searchInResponseBody rejects an unknown id and a missing param', async () => {
    // The same standard getResponseBody applies to an unknown id, which the old
    // implementation contradicted by fabricating a successful empty search.
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    await expectError(() => dispatcher.dispatch('Network.searchInResponseBody',
        { requestId: 'no-such-id', query: 'x' }), CdpErrorCode.InvalidParams, 'unknown id');
    await expectError(() => dispatcher.dispatch('Network.searchInResponseBody', {}),
        CdpErrorCode.InvalidParams, 'no params');
    await expectError(() => dispatcher.dispatch('Network.searchInResponseBody', { requestId: 'no-such-id' }),
        CdpErrorCode.InvalidParams, 'missing query');
    await expectError(() => dispatcher.dispatch('Network.searchInResponseBody',
        { requestId: 42, query: 'x' }), CdpErrorCode.InvalidParams, 'non-string requestId');
});

Deno.test('network: searchInResponseBody rejects an invalid regex rather than reporting no matches', async () => {
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'srch3');
    fetchRes(net, 'srch3');
    net.onFetchEvent({
        ev: NetFetchKind.Data, source: 'fetch', requestId: 'srch3', timestamp: 3,
        data: new TextEncoder().encode('body'), byteLength: 4,
    });
    fetchDone(net, 'srch3', true);
    await expectError(() => dispatcher.dispatch('Network.searchInResponseBody',
        { requestId: 'srch3', query: '([unclosed', isRegex: true }),
        CdpErrorCode.InvalidParams, 'invalid regex');
});

Deno.test('network: searchInResponseBody on a truncated body says so instead of answering no matches', async () => {
    // A truncated entry holds no bytes, only the "too large" placeholder. `[]`
    // would claim a search of content the domain never had; searching the
    // placeholder text would invent matches.
    const { net, dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'big');
    fetchRes(net, 'big');
    const over = PREVIEW_CAP + 1024;
    net.onFetchEvent({
        ev: NetFetchKind.Data, source: 'fetch', requestId: 'big', timestamp: 3,
        data: new Uint8Array(over), byteLength: over,
    });
    fetchDone(net, 'big', true);
    // Precondition: getResponseBody reports it as unavailable rather than real bytes.
    const got = await dispatcher.dispatch('Network.getResponseBody', { requestId: 'big' }) as { body: string };
    strictEqual(got.body, 'Content too large to display', 'precondition: entry is truncated');
    await expectError(() => dispatcher.dispatch('Network.searchInResponseBody',
        { requestId: 'big', query: 'anything' }), CdpErrorCode.InvalidParams, 'truncated body');
});



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

Deno.test('network: setter commands reject a missing or wrong-typed required param', async () => {
    // This test previously asserted the OPPOSITE — that every one of these was
    // absorbed and answered success. That leniency was not harmless: each of the
    // first three performs a DESTRUCTIVE state change on the degraded path.
    //   setExtraHTTPHeaders {}        -> stringHeadersFromRecord(undefined) -> {}
    //                                    -> silently WIPED a previously-set
    //                                       override, answering {} as success.
    //   setUserAgentOverride {ua:12345} -> str() -> undefined -> CLEARED the
    //                                       installed override, answering success.
    //   deleteCookies {}              -> filter(c.name !== undefined) kept every
    //                                    cookie, so a client that deleted one and
    //                                    saw success still had it.
    //   setCookie {}                  -> stored an empty-NAME cookie, observable
    //                                    via getCookies, and claimed
    //                                    {success:true}.
    //   setCookies {cookies:'nope'}   -> stored nothing, reported the batch set.
    // A malformed command must not mutate state and must not claim success. All
    // of these are `required` in the CDP spec.
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    const cases: Array<[string, Record<string, unknown>]> = [
        ['Network.setExtraHTTPHeaders', {}],
        ['Network.setExtraHTTPHeaders', { headers: 'not-an-object' }],
        ['Network.setUserAgentOverride', { userAgent: 12345 }],
        ['Network.setUserAgentOverride', {}],
        ['Network.setCookies', { cookies: 'nope' }],
        ['Network.setCookie', { name: null, value: [] }],
        ['Network.setCookie', {}],
        ['Network.deleteCookies', {}],
    ];
    for (const [method, params] of cases) {
        await expectError(() => dispatcher.dispatch(method, params),
            CdpErrorCode.InvalidParams, `${method} ${JSON.stringify(params)}`);
    }
});

Deno.test('network: a rejected setter leaves previously-set state intact', async () => {
    // The point of the change above: the destructive path must not run. Uses the
    // cookie jar because it is readable back through the CDP surface.
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    await dispatcher.dispatch('Network.setCookie', { name: 'keep', value: 'v' });
    await expectError(() => dispatcher.dispatch('Network.deleteCookies', {}),
        CdpErrorCode.InvalidParams, 'deleteCookies with no name');
    await expectError(() => dispatcher.dispatch('Network.setCookie', {}),
        CdpErrorCode.InvalidParams, 'setCookie with no name/value');
    const { cookies } = await dispatcher.dispatch('Network.getCookies', {}) as
        { cookies: Array<{ name: string }> };
    strictEqual(cookies.length, 1, `a rejected setter must not mutate the jar, got ${JSON.stringify(cookies)}`);
    strictEqual(cookies[0]?.name, 'keep', 'the surviving cookie must be the one that was set');
    // And a well-formed delete still works.
    await dispatcher.dispatch('Network.deleteCookies', { name: 'keep' });
    const after = await dispatcher.dispatch('Network.getCookies', {}) as { cookies: unknown[] };
    strictEqual(after.cookies.length, 0, 'a well-formed deleteCookies must still delete');
});

Deno.test('network: well-formed setter payloads are still accepted, and stay lenient inside', async () => {
    // The validation is on REQUIRED PARAMS, not on their contents: a well-formed
    // container with junk inside is still best-effort, which is what keeps a
    // hostile payload from crashing the worker.
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    // Non-string header VALUES are skipped, not rejected.
    await dispatcher.dispatch('Network.setExtraHTTPHeaders', { headers: { a: 1, b: 'ok' } });
    await dispatcher.dispatch('Network.setExtraHTTPHeaders', { headers: {} });
    await dispatcher.dispatch('Network.setUserAgentOverride', { userAgent: '' });
    // Junk ENTRIES inside a well-formed array are skipped, not rejected.
    await dispatcher.dispatch('Network.setCookies', { cookies: ['junk', 42, { name: 'a', value: 'b' }] });
    const { cookies } = await dispatcher.dispatch('Network.getCookies', {}) as
        { cookies: Array<{ name: string }> };
    strictEqual(cookies.length, 1, 'only the well-formed cookie entry is stored');
    strictEqual(cookies[0]?.name, 'a');
});

Deno.test('network: emulateNetworkConditions does not claim to emulate what it cannot', async () => {
    // canEmulateNetworkConditions answers false, so answering {} to a throttling
    // request was self-contradictory: the domain said it could not emulate, then
    // reported that it had. A request for NO throttling is a real no-op and is
    // honoured; a request for actual emulation is refused.
    const { dispatcher } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    const can = await dispatcher.dispatch('Network.canEmulateNetworkConditions', {}) as { result: boolean };
    strictEqual(can.result, false, 'precondition: this domain reports it cannot emulate');

    await expectError(() => dispatcher.dispatch('Network.emulateNetworkConditions', {}),
        CdpErrorCode.InvalidParams, 'no params at all');
    await expectError(() => dispatcher.dispatch('Network.emulateNetworkConditions',
        { offline: false, latency: 500, downloadThroughput: -1, uploadThroughput: -1 }),
        CdpErrorCode.InvalidParams, 'a real latency request must not report success');
    await expectError(() => dispatcher.dispatch('Network.emulateNetworkConditions',
        { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }),
        CdpErrorCode.InvalidParams, 'offline must not report success');
    // The genuine no-op: unthrottled is the state cno is actually in.
    await dispatcher.dispatch('Network.emulateNetworkConditions',
        { offline: false, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    ok(true, 'a no-throttling request is honoured');
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

Deno.test('network: a stream survives the request-path cleanup ticks the fix added', async () => {
    // Specific to FIX 1. Eviction now also runs from the REQUEST path, so a
    // long-lived stream is exposed to many more ticks than before -- the old test
    // above drives exactly one (from a single unrelated Done). Here unrelated
    // traffic ARRIVES continuously for 300 simulated seconds alongside the stream,
    // so ticks fire throughout its life. It must keep every chunk: eviction is
    // keyed on last activity, and each data chunk refreshes it.
    const { net, dispatcher, events } = newDomain();
    await dispatcher.dispatch('Network.enable', {});
    fetchReq(net, 'stream', 0);
    fetchRes(net, 'stream', 1);
    for (let t = 10; t <= 300; t += 10) {
        net.onFetchEvent({
            ev: NetFetchKind.Data, source: 'fetch', requestId: 'stream', timestamp: t,
            data: new TextEncoder().encode('ab'), byteLength: 2,
        });
        // Unrelated request STARTING (not completing) now drives a tick too.
        fetchReq(net, `noise-${t}`, t);
    }
    fetchDone(net, 'stream', true, 310);

    const seq = forId(events, 'stream');
    const chunks = seq.filter((m) => m === 'Network.dataReceived').length;
    strictEqual(chunks, 30, 'precondition: every chunk was reported');
    ok(seq.includes('Network.loadingFinished'), 'the stream must still reach its terminal event');
    const body = await dispatcher.dispatch('Network.getResponseBody', { requestId: 'stream' }) as { body: string };
    strictEqual(body.body.length, chunks * 2,
        `no chunk may be lost to a request-path tick (${chunks * 2} bytes expected), got ${body.body.length}`);
    // Deliberately NO assertion on the noise ids here. This test is a regression
    // GUARD -- it must pass both before and against the fix, because its job is to
    // show the extra ticks are harmless. The leak itself is asserted by the two
    // growth tests in section 8, which is where a bound belongs.
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
