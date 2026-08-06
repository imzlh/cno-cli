import { ok, strictEqual } from 'node:assert';
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 9239;

// Inner budgets MUST stay strictly below TEST_TIMEOUT_MS. An inner deadline that meets
// or exceeds the outer one can never expire first, so the harness kills the test and
// every failure is reported as an opaque "Test timed out" instead of its real cause.
//
// Sizing is MEASURED, not guessed. On a cold cache (fresh CTS_CACHE_DIR + `cno setup`)
// the child's time-to-first-HTTP-response was 1,166ms for --inspect. The per-test
// timeout does NOT cover the runner's own module load -- a cold file that takes 190s to
// import still passes a 10s per-test timeout -- so these need only cover spawn plus the
// CDP exchange. The budgets below are ~25x the observed figure, headroom for a machine
// running many test processes at once; tighten if they ever mask a real slowdown.
const START_BUDGET_MS = 30_000;
const WS_BUDGET_MS = 15_000;
const TEST_TIMEOUT_MS = 60_000;

// The running binary, not a guessed path: `resolve('build/stage/cno')` has no `.exe`
// and cno's spawn rejects it with ENOENT on win32.
const CNO = Deno.execPath().replace(/ \(deleted\)$/, '');
// fileURLToPath, not URL.pathname: pathname yields `/D:/a/b` with forward slashes,
// while the runtime reports native separators in stack traces. cdp-paused-stack
// compares TARGET-derived paths against a parsed stack frame, so the separator
// form is load-bearing. This is also cwd-independent, unlike resolve().
const TARGET = fileURLToPath(new URL('./targets/cdp-discovery.target.ts', import.meta.url));

/** A failure we can attribute; retrying it would only convert it into a timeout. */
class DefinitiveError extends Error {}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

interface Target {
    proc: ChildProcess;
    readonly failure: Error | null;
    stop(): Promise<void>;
}

/**
 * Spawn the inspector target and latch any spawn failure or early exit. Without the
 * 'error' and 'exit' handlers a bad executable path or an instant crash surfaces
 * only as the outer test timeout, with the actual ENOENT/exit code never reported.
 */
function startTarget(): Target {
    const proc = spawn(CNO, ['run', `--inspect=${HOST}:${PORT}`, TARGET], {
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    let failure: Error | null = null;
    let stopping = false;
    proc.on('error', (e: Error) => {
        failure ??= new DefinitiveError(`failed to spawn ${CNO}: ${e.message}`);
    });
    proc.on('exit', (code: number | null, signal: string | null) => {
        if (stopping) return;
        failure ??= new DefinitiveError(
            `inspector target exited before serving (code=${code}, signal=${signal}); see its stderr above`,
        );
    });
    return {
        proc,
        get failure() {
            return failure;
        },
        async stop() {
            stopping = true;
            proc.kill('SIGKILL');
            if (proc.exitCode === null && proc.signalCode === null) {
                await new Promise((r) => proc.on('exit', r));
            }
        },
    };
}

/**
 * Poll until the endpoint answers 2xx. Transport errors mean "not listening yet" and
 * are retried; an HTTP status means the server answered and is therefore definitive —
 * surfacing it immediately is the whole point, since retrying a 403 until the outer
 * timeout is what hid the real cause.
 */
async function getJson(path: string, target?: Target) {
    const deadline = Date.now() + START_BUDGET_MS;
    let lastTransportError: unknown = null;
    while (Date.now() < deadline) {
        if (target?.failure) throw target.failure;
        try {
            const res = await fetch(`http://${HOST}:${PORT}${path}`);
            if (res.ok) return await res.json();
            const body = (await res.text()).slice(0, 200);
            throw new DefinitiveError(
                `GET ${path} -> HTTP ${res.status} ${res.statusText}${body ? ` body=${JSON.stringify(body)}` : ' (empty body)'}`,
            );
        } catch (e) {
            if (e instanceof DefinitiveError) throw e;
            lastTransportError = e;
        }
        await sleep(120);
    }
    const detail = lastTransportError instanceof Error ? lastTransportError.message : String(lastTransportError);
    throw new Error(`no 2xx from ${path} within ${START_BUDGET_MS}ms; last transport error: ${detail}`);
}

Deno.test({ name: 'cdp: /json/version exposes protocol version and webSocketDebuggerUrl', timeout: TEST_TIMEOUT_MS }, async () => {
    const target = startTarget();
    try {
        const version: any = await getJson('/json/version', target);
        ok(version, '/json/version must respond');
        strictEqual(version?.Browser?.startsWith('cno'), true, `Browser should start with cno, got ${version?.Browser}`);
        ok(typeof version['Protocol-Version'] === 'string', 'Protocol-Version must be a string');
        ok(typeof version['webSocketDebuggerUrl'] === 'string' && version.webSocketDebuggerUrl.startsWith('ws://'),
            'webSocketDebuggerUrl must be a ws:// URL');
    } finally {
        await target.stop();
    }
});

Deno.test({ name: 'cdp: /json lists a page target with a debugger ws URL', timeout: TEST_TIMEOUT_MS }, async () => {
    const target = startTarget();
    try {
        const list: any[] = await getJson('/json', target);
        ok(Array.isArray(list) && list.length >= 1, '/json must return a non-empty target list');
        // cno advertises Node-style targets (type "node"), not browser pages.
        const entry = list.find((t) => t.type === 'node' || t.type === 'page');
        ok(entry, 'must expose a node/page target');
        ok(typeof entry.webSocketDebuggerUrl === 'string' && entry.webSocketDebuggerUrl.startsWith('ws://'),
            'target must carry a ws debugger URL');
        ok(entry.title !== undefined && entry.id !== undefined, 'target must have title and id');
    } finally {
        await target.stop();
    }
});

Deno.test({ name: 'cdp: WebSocket attach accepts a Runtime.evaluate round-trip', timeout: TEST_TIMEOUT_MS }, async () => {
    const target = startTarget();
    try {
        const version: any = await getJson('/json/version', target);
        const wsUrl = version?.webSocketDebuggerUrl;
        ok(wsUrl, 'must discover a ws URL');

        const result = await new Promise<any>((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            const timer = setTimeout(() => { ws.close(); reject(new Error(`no Runtime.evaluate reply within ${WS_BUDGET_MS}ms`)); }, WS_BUDGET_MS);
            ws.addEventListener('open', () => {
                ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1 + 2' } }));
            });
            ws.addEventListener('message', (ev) => {
                const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
                if (msg.id === 1) {
                    clearTimeout(timer);
                    ws.close();
                    resolve(msg.result);
                }
            });
            ws.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error(`WebSocket to ${wsUrl} failed`));
            });
        });
        ok(result && result.result, 'evaluate must return a result');
        strictEqual(result.result.value, 3, '1 + 2 must evaluate to 3');
    } finally {
        await target.stop();
    }
});
