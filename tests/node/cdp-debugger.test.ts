import { ok, strictEqual } from 'node:assert';
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 9240;

// Inner budgets MUST stay strictly below TEST_TIMEOUT_MS, or the inner deadline can
// never expire first and every failure is reported as an opaque harness timeout
// instead of its real cause.
//
// Sizing is MEASURED, not guessed: on a cold cache the child's time-to-first-HTTP-
// response was 1,166ms for --inspect. The per-test timeout does NOT cover the runner's
// own module load (a cold file taking 190s to import still passes a 10s per-test
// timeout), so these cover only spawn plus the CDP exchange, at ~25x the observed
// figure for headroom under concurrent load.
const START_BUDGET_MS = 30_000;
const WS_BUDGET_MS = 15_000;
const TEST_TIMEOUT_MS = 60_000;

// The running binary, not a guessed path: `resolve('build/stage/cno')` has no `.exe`
// and cno's spawn rejects it with ENOENT on win32.
const CNO = Deno.execPath().replace(/ \(deleted\)$/, '');
// fileURLToPath, not URL.pathname: pathname yields `/D:/a/b` with forward slashes,
// while the runtime reports native separators in stack traces. Keeps the
// cwd-independence of a URL-based path without changing the separator form.
const TARGET = fileURLToPath(new URL('./targets/cdp-discovery.target.ts', import.meta.url));

/** A failure we can attribute; retrying it would only convert it into a timeout. */
class DefinitiveError extends Error {}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Target {
    proc: ChildProcess;
    readonly failure: Error | null;
    stop(): Promise<void>;
}

/**
 * Spawn the inspector target and latch any spawn failure or early exit; without these
 * handlers a bad executable path or instant crash shows up only as a test timeout.
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
                await new Promise((resolve) => proc.on('exit', resolve));
            }
        },
    };
}

/**
 * Poll until the endpoint answers 2xx. A transport error means "not listening yet"
 * and is retried; an HTTP status means the server answered and is definitive, so it
 * is surfaced immediately rather than retried into a timeout.
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
        } catch (error) {
            if (error instanceof DefinitiveError) throw error;
            lastTransportError = error;
        }
        await sleep(120);
    }
    const detail = lastTransportError instanceof Error ? lastTransportError.message : String(lastTransportError);
    throw new Error(`no 2xx from ${path} within ${START_BUDGET_MS}ms; last transport error: ${detail}`);
}

async function discoverWsUrl(target?: Target): Promise<string> {
    const version = await getJson('/json/version', target) as { webSocketDebuggerUrl?: string };
    const wsUrl = version.webSocketDebuggerUrl;
    if (!wsUrl) throw new DefinitiveError('/json/version carried no webSocketDebuggerUrl');
    return wsUrl;
}

function sendCommand(wsUrl: string, command: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
            ws.close();
            reject(new Error(`no reply to ${String(command.method)} within ${WS_BUDGET_MS}ms`));
        }, WS_BUDGET_MS);
        ws.addEventListener('open', () => ws.send(JSON.stringify(command)));
        ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
            if (msg.id !== command.id) return;
            clearTimeout(timer);
            ws.close();
            resolve(msg);
        });
        ws.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error(`WebSocket to ${wsUrl} failed`));
        });
    });
}

Deno.test({ name: 'cdp: Debugger rejects invalid breakpoint line numbers', timeout: TEST_TIMEOUT_MS }, async () => {
    const target = startTarget();
    try {
        const wsUrl = await discoverWsUrl(target);
        const reply = await sendCommand(wsUrl, {
            id: 1,
            method: 'Debugger.setBreakpointByUrl',
            params: { url: `file://${TARGET}`, lineNumber: -1 },
        });
        ok(reply.error, 'invalid breakpoint request must return an error');
        strictEqual(reply.error.code, -32602);
    } finally {
        await target.stop();
    }
});

Deno.test({ name: 'cdp: Debugger rejects invalid pause-on-exceptions state', timeout: TEST_TIMEOUT_MS }, async () => {
    const target = startTarget();
    try {
        const wsUrl = await discoverWsUrl(target);
        const reply = await sendCommand(wsUrl, {
            id: 1,
            method: 'Debugger.setPauseOnExceptions',
            params: { state: 'sometimes' },
        });
        ok(reply.error, 'invalid pause-on-exceptions request must return an error');
        strictEqual(reply.error.code, -32602);
    } finally {
        await target.stop();
    }
});
