/**
 * Network domain over a REAL CDP WebSocket against a REAL loopback HTTP server.
 *
 * cdp-network-domain.test.ts drives NetworkDomain's hook entry points directly,
 * which cannot see anything the MAIN thread decides -- notably which requestIds
 * exist at all, how a redirect chain is reported, and whether a worker's request
 * lands in the main session's stream. Those need the whole path:
 *   fetch -> native net hook -> main-thread hooks -> RPC -> worker -> CDP frame.
 *
 * Loopback only: the peer is a node:http server the target starts itself, so no
 * outbound request is made and the server is never the variable.
 *
 * Each test prints a liveness line while waiting, so a wedged event loop is
 * distinguishable from a slow pass rather than surfacing as a bare timeout.
 */

import { ok, strictEqual } from 'node:assert';
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const START_BUDGET_MS = 30_000;
const COLLECT_BUDGET_MS = 25_000;
const TEST_TIMEOUT_MS = 90_000;

const CNO = Deno.execPath().replace(/ \(deleted\)$/, '');
const TARGET = fileURLToPath(new URL('./targets/cdp-network-lifecycle.target.ts', import.meta.url));

function randomPort(): number {
    return 41000 + Math.floor(Math.random() * 18000);
}
function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

interface CdpMsg {
    id?: number;
    method?: string;
    params?: Record<string, any>;
    result?: any;
    error?: { code: number; message: string };
}

interface Session {
    events: CdpMsg[];
    send(method: string, params?: Record<string, unknown>): Promise<any>;
    /** Wait until `pred` holds over the collected events, or throw with a dump. */
    until(label: string, pred: (events: CdpMsg[]) => boolean, budgetMs?: number): Promise<void>;
    stop(): Promise<void>;
}

/**
 * Spawn the target under --inspect, discover its ws URL, attach, and collect
 * every Network event. Latches spawn failure/early exit so a crash is reported
 * as itself instead of as the outer timeout.
 */
async function attach(inspectPort: number): Promise<Session> {
    const proc: ChildProcess = spawn(
        CNO,
        [`--inspect=${HOST}:${inspectPort}`, 'run', '--allow-all', TARGET],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let failure: Error | null = null;
    let stopping = false;
    proc.on('error', (e: Error) => { failure ??= new Error(`failed to spawn ${CNO}: ${e.message}`); });
    proc.on('exit', (code: number | null, signal: string | null) => {
        if (!stopping) failure ??= new Error(`target exited early (code=${code}, signal=${signal})`);
    });
    // Drain child output; the target's stderr liveness lines are useful on failure.
    proc.stdout?.on('data', () => {});
    proc.stderr?.on('data', () => {});

    // Discover the ws URL.
    let wsUrl = '';
    const deadline = Date.now() + START_BUDGET_MS;
    let lastErr: unknown = null;
    while (Date.now() < deadline && !wsUrl) {
        if (failure) throw failure;
        try {
            const res = await fetch(`http://${HOST}:${inspectPort}/json/version`);
            if (res.ok) {
                const v: any = await res.json();
                if (typeof v?.webSocketDebuggerUrl === 'string') wsUrl = v.webSocketDebuggerUrl;
            }
        } catch (e) { lastErr = e; }
        if (!wsUrl) await sleep(120);
    }
    if (!wsUrl) throw new Error(`no ws URL within ${START_BUDGET_MS}ms; last error: ${String(lastErr)}`);

    const events: CdpMsg[] = [];
    const pending = new Map<number, (m: CdpMsg) => void>();
    let nextId = 1;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`ws open timeout to ${wsUrl}`)), 15_000);
        ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
        ws.addEventListener('error', () => { clearTimeout(t); reject(new Error(`ws error to ${wsUrl}`)); });
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
        const msg: CdpMsg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (typeof msg.id === 'number') {
            pending.get(msg.id)?.(msg);
            pending.delete(msg.id);
        } else if (msg.method) {
            events.push(msg);
        }
    });

    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
        new Promise((resolve, reject) => {
            const id = nextId++;
            const t = setTimeout(() => reject(new Error(`no reply to ${method} within 15s`)), 15_000);
            pending.set(id, (m) => {
                clearTimeout(t);
                if (m.error) reject(Object.assign(new Error(`${method}: ${m.error.message}`), { cdpCode: m.error.code }));
                else resolve(m.result);
            });
            ws.send(JSON.stringify({ id, method, params }));
        });

    const until = async (label: string, pred: (e: CdpMsg[]) => boolean, budgetMs = COLLECT_BUDGET_MS): Promise<void> => {
        const end = Date.now() + budgetMs;
        let beat = 0;
        while (Date.now() < end) {
            if (failure) throw failure;
            if (pred(events)) return;
            await sleep(200);
            // Liveness beacon: proves the harness is alive, not wedged.
            if (++beat % 15 === 0) {
                console.error(`[live] waiting for ${label}: ${events.length} events after ${beat * 200}ms`);
            }
        }
        const seen = events.filter((e) => e.method?.startsWith('Network.')).map((e) => e.method);
        throw new Error(`timed out waiting for ${label}; saw ${seen.length} Network events: ${[...new Set(seen)].join(', ')}`);
    };

    return {
        events,
        send,
        until,
        async stop() {
            stopping = true;
            try { ws.close(); } catch {}
            proc.kill('SIGKILL');
            if (proc.exitCode === null && proc.signalCode === null) {
                await new Promise((r) => proc.on('exit', r));
            }
        },
    };
}

const netEvents = (s: Session): CdpMsg[] => s.events.filter((e) => e.method?.startsWith('Network.'));
const byId = (s: Session, id: string): string[] =>
    netEvents(s).filter((e) => e.params?.requestId === id).map((e) => e.method!);

/** requestIds that got a requestWillBeSent, in arrival order. */
function announcedIds(s: Session): string[] {
    return netEvents(s)
        .filter((e) => e.method === 'Network.requestWillBeSent')
        .map((e) => String(e.params?.requestId));
}

// ── 1. the whole path works, and every id is well-formed ─────────────

Deno.test({ name: 'network e2e: real loopback traffic produces a complete CDP lifecycle', timeout: TEST_TIMEOUT_MS }, async () => {
    const s = await attach(randomPort());
    try {
        await s.send('Network.enable');
        await s.until('a finished request', (e) =>
            e.some((x) => x.method === 'Network.loadingFinished'));

        const ids = announcedIds(s);
        ok(ids.length > 0, 'must announce at least one request');
        // Every announced id must be a non-empty string.
        for (const id of ids) ok(id && id !== 'undefined', `bad requestId ${JSON.stringify(id)}`);

        // At least one id must run start -> response -> terminal.
        const complete = ids.find((id) => {
            const seq = byId(s, id);
            return seq.includes('Network.responseReceived') && seq.includes('Network.loadingFinished');
        });
        ok(complete, `no id completed a full lifecycle; ids=${ids.slice(0, 6).join(',')}`);
    } finally {
        await s.stop();
    }
});

Deno.test({ name: 'network e2e: no terminal event ever references an unannounced requestId', timeout: TEST_TIMEOUT_MS }, async () => {
    // The contract the domain's `announced` set exists to enforce, checked over
    // real traffic rather than synthesised hook calls.
    const s = await attach(randomPort());
    try {
        await s.send('Network.enable');
        await s.until('several finished requests', (e) =>
            e.filter((x) => x.method === 'Network.loadingFinished').length >= 4);

        const announced = new Set<string>();
        const violations: string[] = [];
        for (const ev of netEvents(s)) {
            const id = String(ev.params?.requestId ?? '');
            if (ev.method === 'Network.requestWillBeSent' || ev.method === 'Network.webSocketCreated') {
                announced.add(id);
                continue;
            }
            const terminal = ev.method === 'Network.loadingFinished' || ev.method === 'Network.loadingFailed';
            if (terminal && !announced.has(id)) violations.push(`${ev.method} for unannounced ${id}`);
        }
        strictEqual(violations.length, 0, `terminal events for ids never announced: ${violations.slice(0, 5).join('; ')}`);
    } finally {
        await s.stop();
    }
});

Deno.test({ name: 'network e2e: a requestId is never reused for a second request', timeout: TEST_TIMEOUT_MS }, async () => {
    const s = await attach(randomPort());
    try {
        await s.send('Network.enable');
        await s.until('many requests', (e) =>
            e.filter((x) => x.method === 'Network.requestWillBeSent').length >= 12);

        const ids = announcedIds(s);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        strictEqual(dupes.length, 0, `requestId reused: ${[...new Set(dupes)].join(',')}`);
    } finally {
        await s.stop();
    }
});

// ── 2. concurrency: interleaved requests keep their ids straight ──────

Deno.test({ name: 'network e2e: concurrent requests do not cross-contaminate their event streams', timeout: TEST_TIMEOUT_MS }, async () => {
    // /a (delayed body) and /b (immediate) are issued together by the target, so
    // their events necessarily interleave on the wire.
    const s = await attach(randomPort());
    try {
        await s.send('Network.enable');
        await s.until('both concurrent urls', (e) => {
            const urls = e.filter((x) => x.method === 'Network.requestWillBeSent')
                .map((x) => String(x.params?.request?.url ?? ''));
            return urls.some((u) => u.endsWith('/a')) && urls.some((u) => u.endsWith('/b'));
        });

        const idFor = (suffix: string): string | undefined =>
            netEvents(s).find((e) => e.method === 'Network.requestWillBeSent'
                && String(e.params?.request?.url ?? '').endsWith(suffix))?.params?.requestId;
        const idA = idFor('/a');
        const idB = idFor('/b');
        ok(idA && idB, 'both concurrent requests must be announced');
        ok(idA !== idB, 'concurrent requests must get distinct ids');

        // Each id's response must carry its OWN url.
        for (const [id, suffix] of [[idA, '/a'], [idB, '/b']] as Array<[string, string]>) {
            const res = netEvents(s).find((e) => e.method === 'Network.responseReceived' && e.params?.requestId === id);
            if (!res) continue;   // may not have landed inside the window
            const url = String(res.params?.response?.url ?? '');
            ok(url.endsWith(suffix), `id ${id} announced ${suffix} but responseReceived carries ${url}`);
        }
    } finally {
        await s.stop();
    }
});

// ── 3. an aborted request still reaches a terminal event ─────────────

Deno.test({ name: 'network e2e: a request aborted mid-body reaches a terminal event', timeout: TEST_TIMEOUT_MS }, async () => {
    // /slow sends headers then never ends; the target aborts it after 30ms. A
    // request that starts must not be left dangling with no terminal event --
    // that is precisely the shape that leaks requestId-keyed state.
    const s = await attach(randomPort());
    try {
        await s.send('Network.enable');
        await s.until('an aborted /slow request', (e) => {
            const slow = e.find((x) => x.method === 'Network.requestWillBeSent'
                && String(x.params?.request?.url ?? '').endsWith('/slow'));
            if (!slow) return false;
            const id = slow.params?.requestId;
            return e.some((x) => x.params?.requestId === id
                && (x.method === 'Network.loadingFailed' || x.method === 'Network.loadingFinished'));
        });

        const slow = netEvents(s).find((e) => e.method === 'Network.requestWillBeSent'
            && String(e.params?.request?.url ?? '').endsWith('/slow'));
        const id = String(slow!.params!.requestId);
        const seq = byId(s, id);
        ok(seq.includes('Network.loadingFailed') || seq.includes('Network.loadingFinished'),
            `aborted request ${id} got no terminal event; saw ${seq.join(',')}`);
    } finally {
        await s.stop();
    }
});

// ── 4. redirect chain ────────────────────────────────────────────────

Deno.test({ name: 'network e2e: a followed redirect is reported as a single fetch-side request', timeout: TEST_TIMEOUT_MS }, async () => {
    // DOCUMENTS CURRENT BEHAVIOUR: a deliberate divergence from Chrome. curl
    // follows the 302 internally and perform.ts:418-426 discards every
    // intermediate hop, so cno reports the chain as ONE fetch-side request with
    // no `redirectResponse`. Chrome emits a requestWillBeSent per hop.
    //
    // Scoped to `fetch-` ids on purpose. The target is both client and server on
    // loopback, so each request also appears as a `node-serve-` id -- and /final
    // legitimately IS a separate inbound request there, because curl really did
    // make a second HTTP request to the server. An earlier version of this test
    // asserted /final was never announced at all and failed for that reason.
    const s = await attach(randomPort());
    try {
        await s.send('Network.enable');
        await s.until('the redirect request', (e) =>
            e.some((x) => x.method === 'Network.requestWillBeSent'
                && String(x.params?.requestId ?? '').startsWith('fetch-')
                && String(x.params?.request?.url ?? '').includes('/redirect')));

        const fetchStarts = netEvents(s).filter((e) => e.method === 'Network.requestWillBeSent'
            && String(e.params?.requestId ?? '').startsWith('fetch-'));

        // No fetch-side start may carry a redirectResponse: hops are not reported.
        const withRedirectResponse = fetchStarts.filter((e) => e.params?.redirectResponse !== undefined);
        strictEqual(withRedirectResponse.length, 0,
            'cno does not report redirect hops, so no redirectResponse may appear');

        // /final must never be announced as its own FETCH-side request: the
        // program only ever called fetch() on /redirect.
        const finalFetchStarts = fetchStarts.filter((e) =>
            String(e.params?.request?.url ?? '').endsWith('/final'));
        strictEqual(finalFetchStarts.length, 0,
            'the redirect target must not appear as a separate client request');

        const id = String(fetchStarts.find((e) =>
            String(e.params?.request?.url ?? '').includes('/redirect'))!.params!.requestId);
        ok(byId(s, id).includes('Network.requestWillBeSent'), `redirect id ${id} lost its start event`);
    } finally {
        await s.stop();
    }
});

Deno.test({ name: 'network e2e: EXPECTED-RED responseReceived reports the post-redirect URL', timeout: TEST_TIMEOUT_MS }, async () => {
    // EXPECTED RED -- documents defect N-1, unfixed at time of writing.
    //
    // OBSERVED: for fetch('/redirect') that 302s to '/final', the runtime knows
    // the truth (Response.url === '.../final', Response.redirected === true,
    // body 'FINAL-BODY') but CDP reports response.url === '.../redirect' with
    // status 200 and the /final body -- a request/response pair that never
    // existed on the wire. The server answered /redirect with 302.
    //
    // Root cause is OUTSIDE network.ts: cno/src/webapi/fetch/perform.ts:441
    // hands `netHook.onResponse` the original `url.href`. The correct value is
    // already computed in the same function by readFinalUrl()/CURLINFO_EFFECTIVE_URL
    // and used at perform.ts:580-582 for Response.url. network.ts:349 faithfully
    // forwards whatever it is given.
    //
    // When perform.ts is fixed this test turns green as-is; it is the contract.
    const s = await attach(randomPort());
    try {
        await s.send('Network.enable');
        await s.until('a completed fetch-side redirect', (e) =>
            e.some((x) => x.method === 'Network.responseReceived'
                && String(x.params?.requestId ?? '').startsWith('fetch-')
                && String(x.params?.response?.url ?? '').includes('/redirect')));

        const res = netEvents(s).find((e) => e.method === 'Network.responseReceived'
            && String(e.params?.requestId ?? '').startsWith('fetch-')
            && String(e.params?.response?.url ?? '').includes('/redirect'))!;
        const url = String(res.params?.response?.url);
        const status = res.params?.response?.status;

        // The response carrying status 200 must describe the resource that
        // actually returned 200, i.e. /final -- not the URL that returned 302.
        strictEqual(status, 200, 'precondition: the reported status is the final 200');
        ok(url.endsWith('/final'),
            `responseReceived.response.url must be the post-redirect URL; got ${url} with status ${status}, `
            + 'a pair the server never sent (perform.ts:441 passes the pre-redirect url.href)');
    } finally {
        await s.stop();
    }
});

// ── 5. worker attribution ────────────────────────────────────────────

Deno.test({ name: 'network e2e: a worker-issued request does not corrupt the main session stream', timeout: TEST_TIMEOUT_MS }, async () => {
    // The target runs a worker that fetches /ok?from=worker in a loop. Whatever
    // the attribution policy is, the main session's stream must stay coherent:
    // if a worker request appears, it must carry a well-formed id and obey the
    // same announce-before-terminal contract as a main-thread request.
    const s = await attach(randomPort());
    try {
        await s.send('Network.enable');
        await s.until('main-thread traffic', (e) =>
            e.filter((x) => x.method === 'Network.loadingFinished').length >= 3);

        const workerStarts = netEvents(s).filter((e) => e.method === 'Network.requestWillBeSent'
            && String(e.params?.request?.url ?? '').includes('from=worker'));

        // Report which way it went; both are defensible, incoherence is not.
        console.error(`[info] worker-issued requests visible in main session: ${workerStarts.length}`);

        const announced = new Set(announcedIds(s));
        for (const ev of netEvents(s)) {
            const id = String(ev.params?.requestId ?? '');
            const terminal = ev.method === 'Network.loadingFinished' || ev.method === 'Network.loadingFailed';
            if (terminal) {
                ok(announced.has(id) || id === '', `terminal event for un-announced id ${id}`);
            }
        }
        // Every id in the stream must be well-formed regardless of origin.
        for (const ev of netEvents(s)) {
            const id = ev.params?.requestId;
            if (id !== undefined) ok(typeof id === 'string' && id.length > 0, `malformed requestId ${JSON.stringify(id)}`);
        }
    } finally {
        await s.stop();
    }
});
