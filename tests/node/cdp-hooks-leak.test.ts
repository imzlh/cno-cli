/**
 * hooks.ts leak/idempotency measurements.
 *
 * `Hooks` is exported and its constructor takes only (endpoint, serializer), so a
 * relative-path import loads the working-tree TypeScript and lets these poke the
 * real maps. Private fields are reached through a cast: the point is to MEASURE
 * container sizes, which is not otherwise observable.
 */

import { ok, strictEqual } from 'node:assert';
import { Hooks } from '../../src/inspector/main/hooks';
import type { MainEndpoint } from '../../src/inspector/transport/main-endpoint';
import type { Serializer } from '../../src/inspector/main/remote-object';

/** The private shape these tests measure. */
interface HooksInternals {
    liveStreamedFetchRequests: Set<string>;
    liveStreamedServeRequests: Set<string>;
    droppedFetchBodyRequests: Set<string>;
    droppedServeBodyRequests: Set<string>;
    fetchBodyTotals: Map<string, number>;
    serveBodyTotals: Map<string, number>;
    fetchBodyBuffers: Map<string, { chunks: Uint8Array[]; total: number; createdAt: number }>;
    serveBodyBuffers: Map<string, { chunks: Uint8Array[]; total: number; createdAt: number }>;
    completedFetchBodies: Map<string, unknown>;
    completedServeBodies: Map<string, unknown>;
    fetchBodyBufferBytes: number;
    serveBodyBufferBytes: number;
    streamRegisteredAt: Map<string, number>;
    lastBufferCleanupTime: number;
    cleanupStaleBodyBuffers(): void;
}

function newHooks(): { hooks: Hooks; priv: HooksInternals } {
    const endpoint = {
        notify: () => true,
        notifyQuietly: () => true,
        call: () => ({}),
    } as unknown as MainEndpoint;
    const serializer = { serialize: () => ({ type: 'undefined' }) } as unknown as Serializer;
    const hooks = new Hooks(endpoint, serializer);
    return { hooks, priv: hooks as unknown as HooksInternals };
}

/** Force the 30 s-throttled reaper to run now. */
function runReaper(priv: HooksInternals): void {
    priv.lastBufferCleanupTime = 0;
    priv.cleanupStaleBodyBuffers();
}

Deno.test('hooks: the reaper reclaims live-streamed ids that hold no body buffer', () => {
    // Regression, MEASURED as a real leak before the fix: enableStreamingForRequest
    // drops the body buffer, and the reaper only iterated fetchBodyBuffers /
    // serveBodyBuffers, so the id became unreachable. With the Done event lost --
    // the exact case the reaper exists to cover -- it reclaimed 0 of 500 ids in
    // BOTH side sets. Now tracked by registration timestamp.
    const { hooks, priv } = newHooks();
    for (let i = 0; i < 500; i++) hooks.enableStreamingForRequest(`req-${i}`, 'fetch');

    strictEqual(priv.liveStreamedFetchRequests.size, 500, 'ids were registered');
    strictEqual(priv.fetchBodyBuffers.size, 0, 'streaming means no buffer is retained');

    // Age them past the 120 s stale cutoff, then reap.
    for (const id of priv.streamRegisteredAt.keys()) priv.streamRegisteredAt.set(id, Date.now() - 200_000);
    runReaper(priv);

    strictEqual(priv.liveStreamedFetchRequests.size, 0,
        `reaper must reclaim stale streamed ids, ${priv.liveStreamedFetchRequests.size} left`);
    strictEqual(priv.streamRegisteredAt.size, 0, 'timestamp map must drain too');
});

Deno.test('hooks: the reaper does not evict a still-fresh streamed id', () => {
    const { hooks, priv } = newHooks();
    hooks.enableStreamingForRequest('fresh', 'fetch');
    runReaper(priv);
    ok(priv.liveStreamedFetchRequests.has('fresh'), 'a live streaming request must survive the reaper');
});

Deno.test('hooks: enableStreamingForRequest no longer poisons the other source', () => {
    // Regression, MEASURED before the fix: the method could not tell a fetch id
    // from a serve id, so it marked BOTH sets. The wrong-source entry had no Done
    // event to clear it -- a guaranteed permanent leak per call. The worker knows
    // the source (NetworkDomain.reqMeta), so it is now passed over the RPC.
    const { hooks, priv } = newHooks();
    hooks.enableStreamingForRequest('a-fetch-id', 'fetch');
    ok(priv.liveStreamedFetchRequests.has('a-fetch-id'), 'correct set marked');
    ok(!priv.liveStreamedServeRequests.has('a-fetch-id'),
        'a fetch id must NOT be marked live-streamed as a serve request');

    hooks.enableStreamingForRequest('a-serve-id', 'serve');
    ok(priv.liveStreamedServeRequests.has('a-serve-id'), 'correct set marked');
    ok(!priv.liveStreamedFetchRequests.has('a-serve-id'),
        'a serve id must NOT be marked live-streamed as a fetch request');
});

Deno.test('hooks: an omitted source still works and stays reclaimable', () => {
    // Back-compat: without `source` the old both-sets behaviour is kept, but the
    // registration timestamp means the reaper can still reclaim it.
    const { hooks, priv } = newHooks();
    hooks.enableStreamingForRequest('unknown-source');
    ok(priv.liveStreamedFetchRequests.has('unknown-source'));
    ok(priv.liveStreamedServeRequests.has('unknown-source'));
    priv.streamRegisteredAt.set('unknown-source', Date.now() - 200_000);
    runReaper(priv);
    strictEqual(priv.liveStreamedFetchRequests.size, 0, 'reclaimed from the fetch set');
    strictEqual(priv.liveStreamedServeRequests.size, 0, 'reclaimed from the serve set');
});

Deno.test('hooks: enabling fetch streaming returns and releases buffered history', () => {
    const { hooks, priv } = newHooks();
    const first = new TextEncoder().encode('alpha-');
    const second = new TextEncoder().encode('beta');
    priv.fetchBodyBuffers.set('history', {
        chunks: [first, second],
        total: first.byteLength + second.byteLength,
        createdAt: Date.now(),
    });
    priv.fetchBodyBufferBytes = first.byteLength + second.byteLength;

    const buffered = hooks.enableStreamingForRequest('history', 'fetch');
    strictEqual(new TextDecoder().decode(buffered), 'alpha-beta');
    strictEqual(priv.fetchBodyBuffers.has('history'), false, 'the handed-off bytes must not remain retained');
    strictEqual(priv.fetchBodyBufferBytes, 0);
    ok(priv.liveStreamedFetchRequests.has('history'));
});

Deno.test('hooks: completed truncated history is handed off exactly once', () => {
    const { hooks, priv } = newHooks();
    priv.completedFetchBodies.set('completed', {
        data: new TextEncoder().encode('prefix'),
        createdAt: Date.now(),
    });

    strictEqual(
        new TextDecoder().decode(hooks.enableStreamingForRequest('completed', 'fetch')),
        'prefix',
    );
    strictEqual(hooks.enableStreamingForRequest('completed', 'fetch').byteLength, 0);
    strictEqual(priv.completedFetchBodies.has('completed'), false);
});

Deno.test('hooks: a double console install still tears down cleanly', () => {
    // Regression: installConsole() captured globalThis.console's CURRENT methods as
    // its originals. A second install therefore captured the first install's
    // wrappers, so teardown restored a wrapper rather than the real method and the
    // hook became permanent. Now guarded on consoleOriginals.
    const realLog = globalThis.console.log;
    const { hooks } = newHooks();
    const priv2 = hooks as unknown as { installConsole(): void; teardown(): void };

    priv2.installConsole();
    const afterFirst = globalThis.console.log;
    ok(afterFirst !== realLog, 'the first install must wrap console.log');

    priv2.installConsole();          // second install — previously poisoned teardown
    priv2.teardown();

    strictEqual(globalThis.console.log, realLog,
        'teardown must restore the REAL console.log, not a surviving wrapper');
});

Deno.test('hooks: side maps are cleared by teardown', () => {
    // MEASURED: teardown DOES clear these (100 -> 0), so the read-only audit's
    // "no connection gating" concern does not apply to the side maps themselves.
    // What remains true is that teardown is only reached from Inspector.stop() /
    // forceStop() (src/inspector/main/inspector.ts:249,269) -- NOT from a client
    // detach, which routes to onConnectedChange via the setConnected RPC.
    const { hooks, priv } = newHooks();
    for (let i = 0; i < 100; i++) hooks.enableStreamingForRequest(`d-${i}`, 'fetch');
    const before = priv.liveStreamedFetchRequests.size;
    const teardown = (hooks as unknown as { teardown?: () => void }).teardown;
    if (typeof teardown !== 'function') throw new Error('teardown missing');
    teardown.call(hooks);
    strictEqual(before, 100);
    strictEqual(priv.liveStreamedFetchRequests.size, 0, 'teardown clears the side maps');
    strictEqual(priv.streamRegisteredAt.size, 0, 'and the timestamp map');
});

Deno.test('hooks: releasing pending interceptions resumes every request exactly once', () => {
    const { hooks } = newHooks();
    const pending = (hooks as unknown as {
        pendingIntercepts: Map<string, (result: unknown) => void>;
        releasePendingIntercepts(): void;
    });
    const results: unknown[] = [];

    pending.pendingIntercepts.set('first', (result) => results.push(result));
    pending.pendingIntercepts.set('second', (result) => results.push(result));

    pending.releasePendingIntercepts();
    strictEqual(results.length, 2);
    strictEqual(results[0], null);
    strictEqual(results[1], null);
    strictEqual(pending.pendingIntercepts.size, 0);

    pending.releasePendingIntercepts();
    strictEqual(results.length, 2, 'releasing an already-empty map must be idempotent');
});
