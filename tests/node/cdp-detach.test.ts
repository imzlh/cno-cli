/**
 * What happens when DevTools goes away, driven against the working tree
 * (`src/inspector/**`) rather than the CDP code baked into cno.exe.
 *
 * No end-to-end test reaches these paths: the cdp-* tests always "detach" by
 * killing the process, so nothing exercises a detach that the program has to
 * survive. Two of them are hangs rather than leaks — a paused Fetch request never
 * settles its native promise, and a console left `enabled` drops every message
 * emitted while nobody is attached.
 */

import { ok, strictEqual } from 'node:assert';
import { ConsoleDomain } from '../../src/inspector/domains/console';
import { FetchDomain } from '../../src/inspector/domains/fetch';
import { CDPDispatcher } from '../../src/inspector/worker/dispatcher';
import { isLoopbackHost } from '../../src/inspector/main/inspector';
import type { FetchInterceptPayload } from '../../src/inspector/shared/wire';
import type { WorkerEndpoint } from '../../src/inspector/transport/worker-endpoint';

function intercept(requestId: string, url = `http://example.test/${requestId}`): FetchInterceptPayload {
    return { requestId, url, method: 'GET', headers: {} } as FetchInterceptPayload;
}

/**
 * An rpc stand-in that records fetchInterceptResult settlements. Fire-and-forget
 * sites use notify(); request/response sites use call(). Both must be present or
 * the stub silently diverges from WorkerEndpoint.
 */
function recordingRpc(settled: Array<{ requestId: string; result: unknown }>): WorkerEndpoint {
    const record = (method: string, params: unknown): void => {
        if (method === 'fetchInterceptResult') {
            settled.push(params as { requestId: string; result: unknown });
        }
    };
    return {
        notify: (method: string, params: unknown) => { record(method, params); },
        call: (method: string, params: unknown) => {
            record(method, params);
            return Promise.resolve({});
        },
        isPaused: () => false,
    } as unknown as WorkerEndpoint;
}

Deno.test('console detach: buffering resumes so a reattaching frontend sees output', async () => {
    const dispatcher = new CDPDispatcher();
    const emitted: string[] = [];
    const domain = new ConsoleDomain(dispatcher, (method) => emitted.push(method));

    await dispatcher.dispatch('Console.enable', {});
    domain.onConsole('log', [{ type: 'string', value: 'attached' }], 1);
    strictEqual(emitted.length, 1);

    // `enabled` is per-session state in V8. Left set after a detach, every message
    // emitted while nobody is attached goes to a dead sink and is lost, so the next
    // frontend opens on an empty console.
    domain.setConnected(false);
    domain.onConsole('log', [{ type: 'string', value: 'detached' }], 2);
    strictEqual(emitted.length, 1, 'a detached console must not emit');

    await dispatcher.dispatch('Console.enable', {});
    strictEqual(emitted.length, 2, 'the message buffered while detached must be replayed');
});

Deno.test('console detach: setConnected(true) does not clear the backlog', async () => {
    const dispatcher = new CDPDispatcher();
    const emitted: string[] = [];
    const domain = new ConsoleDomain(dispatcher, (method) => emitted.push(method));

    // Messages logged before any frontend attaches must survive the attach itself;
    // only Console.enable drains the backlog.
    domain.onConsole('log', [{ type: 'string', value: 'early' }], 1);
    domain.setConnected(true);
    strictEqual(emitted.length, 0);
    await dispatcher.dispatch('Console.enable', {});
    strictEqual(emitted.length, 1, 'early output must be replayed on enable');
});

Deno.test('fetch detach: every paused request is released', async () => {
    const dispatcher = new CDPDispatcher();
    const settled: Array<{ requestId: string; result: unknown }> = [];
    const domain = new FetchDomain(dispatcher, () => {}, recordingRpc(settled));

    await dispatcher.dispatch('Fetch.enable', {});
    domain.onInterceptRequest(intercept('r1'));
    domain.onInterceptRequest(intercept('r2'));
    strictEqual(settled.length, 0, 'a matched request must be held, not auto-continued');

    // The native fetch promise behind Fetch.requestPaused is waiting for a
    // continue/fulfill that can no longer arrive. Without this the program hangs
    // on that request for as long as it runs.
    domain.setConnected(false);
    strictEqual(settled.length, 2, 'both paused requests must be released');
    ok(settled.every((s) => s.result === null), 'a released request must proceed unchanged');
});

Deno.test('fetch detach: interception is off, so later requests are not stranded', async () => {
    const dispatcher = new CDPDispatcher();
    const settled: Array<{ requestId: string; result: unknown }> = [];
    const domain = new FetchDomain(dispatcher, () => {}, recordingRpc(settled));

    await dispatcher.dispatch('Fetch.enable', {});
    domain.setConnected(false);

    // A request arriving after the detach must pass straight through. If `enabled`
    // stayed set it would be paused with no client left to continue it.
    domain.onInterceptRequest(intercept('later'));
    strictEqual(settled.length, 1);
    strictEqual(settled[0]?.requestId, 'later');
    strictEqual(settled[0]?.result, null);
});

Deno.test('fetch detach: Fetch.disable releases paused requests too', async () => {
    const dispatcher = new CDPDispatcher();
    const settled: Array<{ requestId: string; result: unknown }> = [];
    const domain = new FetchDomain(dispatcher, () => {}, recordingRpc(settled));

    await dispatcher.dispatch('Fetch.enable', {});
    domain.onInterceptRequest(intercept('r1'));
    strictEqual(settled.length, 0);

    // Same hazard as a detach, reached by an explicit command instead.
    await dispatcher.dispatch('Fetch.disable', {});
    strictEqual(settled.length, 1);
    strictEqual(settled[0]?.result, null);
});

Deno.test('fetch: Fetch.enable with no patterns intercepts everything', async () => {
    const dispatcher = new CDPDispatcher();
    const settled: Array<{ requestId: string; result: unknown }> = [];
    const domain = new FetchDomain(dispatcher, () => {}, recordingRpc(settled));

    // CDP: an omitted `patterns` means intercept all. An empty pattern list would
    // instead match nothing, silently disabling interception the client asked for.
    await dispatcher.dispatch('Fetch.enable', {});
    domain.onInterceptRequest(intercept('r1', 'https://deep.example/a/b/c?q=1'));
    strictEqual(settled.length, 0, 'an omitted pattern list must still intercept');
});

Deno.test('fetch: urlPattern wildcards span slashes, per CDP', async () => {
    const dispatcher = new CDPDispatcher();
    const settled: Array<{ requestId: string; result: unknown }> = [];
    const domain = new FetchDomain(dispatcher, () => {}, recordingRpc(settled));

    // CDP Fetch.RequestPattern defines '*' as "zero or more of ANY character" and
    // '?' as "exactly one" — there is no path-segment concept, unlike a filesystem
    // glob. Compiling '*' to '[^/]*' made every pattern fail on any URL containing
    // a slash, which is every real URL.
    await dispatcher.dispatch('Fetch.enable', { patterns: [{ urlPattern: '*example*' }] });
    domain.onInterceptRequest(intercept('hit', 'https://a.example/deep/path?q=1'));
    strictEqual(settled.length, 0, 'a wildcard must span slashes and hold the request');

    // A non-matching pattern must still pass the request straight through.
    domain.onInterceptRequest(intercept('miss', 'https://other.test/deep/path'));
    strictEqual(settled.length, 1, 'a non-matching request must not be held');
    strictEqual(settled[0]?.requestId, 'miss');
    strictEqual(settled[0]?.result, null);
});

Deno.test('fetch: an explicit "*" pattern intercepts every URL', async () => {
    const dispatcher = new CDPDispatcher();
    const settled: Array<{ requestId: string; result: unknown }> = [];
    const domain = new FetchDomain(dispatcher, () => {}, recordingRpc(settled));

    // '*' is the CDP default and what DevTools sends for "intercept everything";
    // '**' is accepted as a synonym so previously-written patterns keep working.
    await dispatcher.dispatch('Fetch.enable', { patterns: [{ urlPattern: '*' }, { urlPattern: '**' }] });
    for (const url of ['http://a.test/x/y', 'https://b.test/', 'https://c.test/a?q=1&r=2']) {
        domain.onInterceptRequest(intercept(url, url));
    }
    strictEqual(settled.length, 0, "'*' must intercept every URL");
});

Deno.test('fetch: a wildcard-heavy urlPattern cannot hang the worker', async () => {
    const dispatcher = new CDPDispatcher();
    const settled: Array<{ requestId: string; result: unknown }> = [];
    const domain = new FetchDomain(dispatcher, () => {}, recordingRpc(settled));

    // globToRegex compiled every '*' to '.*', so `*a*a*a...` became a chain of
    // adjacent '.*' groups: catastrophic backtracking on a URL that ALMOST matches.
    // MEASURED on node v24.18 with the same compiled source: 4 wildcards took 8.8ms,
    // 8 took 70,741ms, and 20 did not finish in 60s. The only guard was a 256-char
    // pattern cap, which this is nowhere near — the file's claim to "reject nested
    // quantifiers" was never implemented.
    //
    // Severity is bounded (the pattern comes from an already-authenticated DevTools
    // client), but it is a trivially reachable hang of the debug worker: a user who
    // types `*a*a*b` into the network filter wedges the inspector with no error.
    const pattern = `${'*a'.repeat(20)}b`;
    ok(pattern.length < 256, 'the pattern must be within the existing length cap');
    await dispatcher.dispatch('Fetch.enable', { patterns: [{ urlPattern: pattern }] });

    // Matches every `a` run but never the trailing `b`, i.e. the worst case.
    const url = `http://x.test/${'a'.repeat(60)}`;
    const started = Date.now();
    domain.onInterceptRequest(intercept('probe', url));
    const elapsed = Date.now() - started;

    ok(elapsed < 1_000, `pattern matching must be linear, took ${elapsed}ms`);
    strictEqual(settled.length, 1, 'a non-matching URL must pass through');
    strictEqual(settled[0]?.result, null);
});

Deno.test('fetch: glob semantics are exact, per CDP', async () => {
    const dispatcher = new CDPDispatcher();
    const settled: Array<{ requestId: string; result: unknown }> = [];
    const domain = new FetchDomain(dispatcher, () => {}, recordingRpc(settled));

    // Pin CDP's semantics precisely so the ReDoS fix cannot quietly change matching:
    // '*' is zero-or-more of any char, '?' is exactly one, everything else literal
    // (including regex metacharacters).
    const cases: Array<{ pattern: string; url: string; match: boolean }> = [
        { pattern: '*', url: 'http://a.test/x', match: true },
        { pattern: '**', url: 'http://a.test/x', match: true },
        { pattern: 'http://a.test/x', url: 'http://a.test/x', match: true },
        { pattern: 'http://a.test/x', url: 'http://a.test/xy', match: false },
        { pattern: '*example*', url: 'https://a.example/deep/path?q=1', match: true },
        { pattern: '*example*', url: 'https://other.test/p', match: false },
        { pattern: 'http://a.test/?', url: 'http://a.test/x', match: true },
        { pattern: 'http://a.test/?', url: 'http://a.test/xy', match: false },
        { pattern: 'http://a.test/??', url: 'http://a.test/xy', match: true },
        // A '.' in the pattern is a literal dot, not "any char".
        { pattern: 'http://a.test/f.js', url: 'http://a.test/fxjs', match: false },
        // Regex metacharacters must stay literal.
        { pattern: 'http://a.test/a+b', url: 'http://a.test/a+b', match: true },
        { pattern: 'http://a.test/a(b)', url: 'http://a.test/a(b)', match: true },
        { pattern: '*/api/*', url: 'http://a.test/v1/api/users', match: true },
        { pattern: '*.css', url: 'http://a.test/site.css', match: true },
        { pattern: '*.css', url: 'http://a.test/site.css?v=2', match: false },
        // A trailing '*' must accept the empty remainder.
        { pattern: 'http://a.test/x*', url: 'http://a.test/x', match: true },
        // Overlap guard: one '*' must not let the head and tail share characters.
        { pattern: 'aaa*aaa', url: 'aaaaa', match: false },
        { pattern: 'aaa*aaa', url: 'aaaaaa', match: true },
    ];

    for (const [i, c] of cases.entries()) {
        settled.length = 0;
        await dispatcher.dispatch('Fetch.enable', { patterns: [{ urlPattern: c.pattern }] });
        domain.onInterceptRequest(intercept(`c${i}`, c.url));
        const held = settled.length === 0;
        strictEqual(held, c.match, `pattern ${JSON.stringify(c.pattern)} vs ${JSON.stringify(c.url)}`);
        await dispatcher.dispatch('Fetch.disable', {});
    }
});

Deno.test('fetch: the fulfilled-body cache is bounded', async () => {
    const dispatcher = new CDPDispatcher();
    const settled: Array<{ requestId: string; result: unknown }> = [];
    const domain = new FetchDomain(dispatcher, () => {}, recordingRpc(settled));
    await dispatcher.dispatch('Fetch.enable', {});

    // DevTools never releases fulfilled bodies, so an unbounded cache grows for the
    // whole session. Drive past the 50-entry cap and confirm the oldest went.
    for (let i = 0; i < 60; i++) {
        domain.onInterceptRequest(intercept(`r${i}`));
        await dispatcher.dispatch('Fetch.fulfillRequest', {
            requestId: `r${i}`,
            responseCode: 200,
            body: '',
        });
    }
    const cache = Reflect.get(domain, 'bodyCache') as Map<string, Uint8Array>;
    ok(cache.size <= 50, `bodyCache must stay bounded, got ${cache.size}`);
    // Eviction is oldest-first, so the newest fulfilment must still be readable.
    ok(cache.has('r59'), 'the newest body must be retained');
    strictEqual(cache.has('r0'), false, 'the oldest body must have been evicted');

    // A body evicted (or never cached) reads back empty rather than throwing.
    const gone = await dispatcher.dispatch('Fetch.getResponseBody', { requestId: 'r0' }) as { body: string };
    strictEqual(gone.body, '');
});

Deno.test('inspector: only real loopback addresses count as loopback', () => {
    // Drives the "bound to a routable address" warning. Too loose and it stays
    // silent on the bind that actually exposes RCE to the network; too strict and
    // it fires on every ordinary run until people stop reading it.
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1', '']) {
        strictEqual(isLoopbackHost(host), true, `${host} must be loopback`);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'example.com', '128.0.0.1', '::ffff:10.0.0.1']) {
        strictEqual(isLoopbackHost(host), false, `${host} must NOT be loopback`);
    }
});
