import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { fileURLToPath } from 'node:url';

// The running binary, not a guessed path: `resolve('build/stage/cno')` has no `.exe`
// and cno's spawn rejects that with ENOENT on win32 (real Node resolves it, since
// CreateProcess appends the extension).
const CNO = Deno.execPath().replace(/ \(deleted\)$/, '');
// fileURLToPath, not URL.pathname: pathname yields `/D:/a/b` with forward slashes,
// while the runtime reports native separators.
const TARGET = fileURLToPath(new URL('./targets/serve.target.ts', import.meta.url));

// Inner budgets MUST stay strictly below the enclosing Deno.test timeout. An inner
// deadline that meets or exceeds the outer one can never expire first, so the harness
// kills the test and the real cause is replaced by an opaque "Test timed out".
//
// Sizing is MEASURED, not guessed. The ~89s cold-cache cost (oxc.dll absent, so the TS
// transform is interpreted Sucrase) is paid while the harness COMPILES this file, which
// the per-test timeout does NOT cover -- the runner races only the test fn
// (cno/src/deno/index.ts:738). Measured on a fresh CTS_CACHE_DIR: file total 93,764ms
// but in-test elapsed 542ms, with the child serving 535ms after test-fn entry. So these
// cover spawn plus a local HTTP poll, not a cold transform. The case that genuinely
// needs a large ceiling is a cold dynamic import INSIDE a test fn (measured 16,125ms);
// nothing in this file does that.
const SERVER_START_BUDGET_MS = 8_000;
const SPAWN_TEST_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms = 3000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function isSandboxSocketError(error: unknown): boolean {
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase();
    return message.includes('EPERM') || message.includes('operation not permitted');
}

function removeTree(path: string): void {
    try {
        Deno.removeSync(path, { recursive: true });
    } catch {
        // Best-effort cleanup for temporary socket directories.
    }
}

async function readUntil(conn: Deno.Conn, marker: string): Promise<string> {
    const decoder = new TextDecoder();
    const buf = new Uint8Array(1024);
    let text = '';
    while (!text.includes(marker)) {
        const n = await withTimeout(conn.read(buf));
        if (n === null) break;
        text += decoder.decode(buf.subarray(0, n), { stream: true });
    }
    return text + decoder.decode();
}

// Find a free port by spawning with port 0 is not observable via stdout here,
// so we bind a fixed port unlikely to collide.
const PORT = 18091;
let canListenTcpPromise: Promise<boolean> | undefined;
const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const WS_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';

function canListenTcp(): Promise<boolean> {
    canListenTcpPromise ??= new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', (error) => {
            if (String(error).includes('EPERM')) {
                resolve(false);
                return;
            }
            reject(error);
        });
        try {
            server.listen(0, '127.0.0.1', () => {
                server.close(() => resolve(true));
            });
        } catch (error) {
            if (String(error).includes('EPERM')) {
                resolve(false);
                return;
            }
            reject(error);
        }
    });
    return canListenTcpPromise;
}

/** A failure we can attribute; retrying it would only convert it into a timeout. */
class DefinitiveError extends Error {}

interface Target {
    proc: ChildProcess;
    readonly failure: Error | null;
    readonly stderr: string;
    stop(): Promise<void>;
}

/**
 * Spawn the serve target and latch any spawn failure or early exit. Without the
 * 'error' handler a bad executable path surfaces only as the outer test timeout, with
 * the actual ENOENT never reported.
 */
function startTarget(args: string[]): Target {
    const proc = spawn(CNO, args, {
        env: { ...process.env, CNO_SERVE_PORT: String(PORT) },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let failure: Error | null = null;
    let stderr = '';
    let stopping = false;
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('error', (e: Error) => {
        failure ??= new DefinitiveError(`failed to spawn ${CNO}: ${e.message}`);
    });
    proc.on('exit', (code: number | null, signal: string | null) => {
        if (stopping) return;
        failure ??= new DefinitiveError(
            `serve target exited before listening (code=${code}, signal=${signal}); see its stderr above`,
        );
    });
    return {
        proc,
        get failure() {
            return failure;
        },
        get stderr() {
            return stderr;
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
 * Poll until the target serves. A transport error means "not listening yet" and is
 * retried; a spawn failure or early child exit is definitive and is surfaced at once
 * rather than retried until the harness timeout replaces it. `target` is required so
 * the budget is always the one sized against the outer timeout.
 */
async function waitForServer(target: Target): Promise<void> {
    const deadline = Date.now() + SERVER_START_BUDGET_MS;
    let lastTransportError: unknown = null;
    while (Date.now() < deadline) {
        if (target.failure) throw target.failure;
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/text`);
            if (r.ok) return;
            await r.text();
            throw new DefinitiveError(`GET /text -> HTTP ${r.status} ${r.statusText}`);
        } catch (e) {
            if (e instanceof DefinitiveError) throw e;
            lastTransportError = e;
        }
        await sleep(120);
    }
    const detail = lastTransportError instanceof Error ? lastTransportError.message : String(lastTransportError);
    throw new Error(`server did not start within ${SERVER_START_BUDGET_MS}ms; last transport error: ${detail}`);
}

Deno.test('deno: upgradeWebSocket returns a 101 response and negotiated socket', () => {
    const request = new Request('http://localhost/ws', {
        headers: {
            upgrade: 'websocket',
            connection: 'keep-alive, Upgrade',
            'sec-websocket-key': WS_KEY,
            'sec-websocket-version': '13',
            'sec-websocket-protocol': 'chat, superchat',
        },
    });
    const upgrade = Deno.upgradeWebSocket(request, { protocol: 'superchat' });

    strictEqual(upgrade.response.status, 101);
    strictEqual(upgrade.response.headers.get('upgrade'), 'websocket');
    strictEqual(upgrade.response.headers.get('connection'), 'Upgrade');
    strictEqual(upgrade.response.headers.get('sec-websocket-accept'), WS_ACCEPT);
    strictEqual(upgrade.response.headers.get('sec-websocket-protocol'), 'superchat');
    ok(upgrade.socket instanceof WebSocket);
    strictEqual(upgrade.socket.readyState, WebSocket.CONNECTING);
});

Deno.test('deno: upgradeWebSocket validates required upgrade headers only', () => {
    const validHeaders = {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': WS_KEY,
    };
    strictEqual(Deno.upgradeWebSocket(new Request('http://localhost/ws', {
        headers: { ...validHeaders, 'sec-websocket-version': '12' },
    })).response.status, 101);
    strictEqual(Deno.upgradeWebSocket(new Request('http://localhost/ws', {
        headers: validHeaders,
    })).response.status, 101);

    throws(() => Deno.upgradeWebSocket(new Request('http://localhost/ws')), /'upgrade' header must contain 'websocket'/);
    throws(() => Deno.upgradeWebSocket(new Request('http://localhost/ws', {
        headers: { ...validHeaders, upgrade: 'h2c' },
    })), /'upgrade' header must contain 'websocket'/);
    throws(() => Deno.upgradeWebSocket(new Request('http://localhost/ws', {
        headers: { ...validHeaders, connection: 'keep-alive' },
    })), /'connection' header must contain 'Upgrade'/);
    throws(() => Deno.upgradeWebSocket(new Request('http://localhost/ws', {
        headers: { upgrade: 'websocket', connection: 'Upgrade' },
    })), /'sec-websocket-key' header must be set/);
});

Deno.test('deno: HttpClient constructors expose stable public shape', () => {
    const client = Deno.createHttpClient();
    try {
        ok(client instanceof Deno.HttpClient);
        strictEqual(typeof client.close, 'function');
        deepStrictEqual(Object.keys(client), []);
    } finally {
        client.close();
    }

    const direct = new Deno.HttpClient({
        proxy: { url: 'http://localhost:8080', basicAuth: { username: 'user', password: 'pass' } },
        poolIdleTimeout: 1,
        http2: true,
    });
    try {
        ok(direct instanceof Deno.HttpClient);
        deepStrictEqual(Object.keys(direct), []);
    } finally {
        direct.close();
    }
});

Deno.test('deno: HttpClient exposes proxy helpers and rejects connections after close', async () => {
    const client = new Deno.HttpClient({
        proxy: {
            url: 'http://proxy.local:8080',
            basicAuth: { username: 'user', password: 'pass' },
        },
    }) as Deno.HttpClient & {
        shouldUseProxy(url: URL): boolean;
        getProxyUrl(): URL | null;
        getProxyAuth(): string | null;
        connect(hostname: string, port: number, isSecure: boolean): Promise<unknown>;
    };

    strictEqual(client.shouldUseProxy(new URL('https://example.test/')), true);
    strictEqual(client.getProxyUrl()?.href, 'http://proxy.local:8080/');
    strictEqual(client.getProxyAuth(), 'Basic dXNlcjpwYXNz');

    client.close();
    let err: Error | null = null;
    try {
        await client.connect('example.test', 443, true);
    } catch (error) {
        err = error as Error;
    }
    ok(err);
    strictEqual(err!.message, 'HttpClient is closed');
});

Deno.test('deno: HttpClient uses the shared NO_PROXY matcher', () => {
    const previousUpper = Deno.env.get('NO_PROXY');
    const previousLower = Deno.env.get('no_proxy');
    const client = new Deno.HttpClient({ proxy: { url: 'http://proxy.local:8080' } }) as Deno.HttpClient & {
        shouldUseProxy(url: URL): boolean;
    };
    try {
        Deno.env.delete('no_proxy');
        Deno.env.set('NO_PROXY', 'example.test:443; <local>; [::1]:8080');

        strictEqual(client.shouldUseProxy(new URL('https://api.example.test/')), false);
        strictEqual(client.shouldUseProxy(new URL('http://intranet/')), false);
        strictEqual(client.shouldUseProxy(new URL('http://[::1]:8080/')), false);
        strictEqual(client.shouldUseProxy(new URL('http://[::1]:8081/')), true);
    } finally {
        client.close();
        if (previousUpper === undefined) Deno.env.delete('NO_PROXY');
        else Deno.env.set('NO_PROXY', previousUpper);
        if (previousLower === undefined) Deno.env.delete('no_proxy');
        else Deno.env.set('no_proxy', previousLower);
    }
});

Deno.test({ name: 'deno: Deno.serve lifecycle exposes addr onListen finished abort and onError', timeout: 10000 }, async () => {
    if (!await canListenTcp()) return;

    const controller = new AbortController();
    const listened: Deno.NetAddr[] = [];
    const server = Deno.serve({
        hostname: '127.0.0.1',
        port: 0,
        signal: controller.signal,
        onListen(addr) {
            listened.push(addr);
        },
        onError(error) {
            return new Response(`handled:${(error as Error).message}`, { status: 418 });
        },
    }, (request, info) => {
        const url = new URL(request.url);
        if (url.pathname === '/boom') throw new Error('serve-boom');
        return Response.json({
            path: url.pathname,
            transport: info.remoteAddr.transport,
            completed: info.completed instanceof Promise,
        });
    });

    try {
        server.ref();
        server.unref();
        server.ref();
        strictEqual(server.addr.transport, 'tcp');
        strictEqual(server.addr.hostname, '127.0.0.1');
        ok(server.addr.port > 0);
        deepStrictEqual(listened, [server.addr]);
        strictEqual('then' in server, false);

        const done = withTimeout(server.finished.then(() => 'finished'));

        const response = await fetch(`http://127.0.0.1:${server.addr.port}/lifecycle`);
        strictEqual(response.status, 200);
        deepStrictEqual(await response.json(), {
            path: '/lifecycle',
            transport: 'tcp',
            completed: true,
        });

        const handled = await fetch(`http://127.0.0.1:${server.addr.port}/boom`);
        strictEqual(handled.status, 418);
        strictEqual(await handled.text(), 'handled:serve-boom');

        controller.abort();
        strictEqual(await done, 'finished');
    } finally {
        try { await server.shutdown(); } catch {}
    }
});

Deno.test({ name: 'deno: Deno.serve shutdown drains active requests', timeout: 10000 }, async () => {
    if (!await canListenTcp()) return;

    const requestStarted = Promise.withResolvers<void>();
    const releaseRequest = Promise.withResolvers<void>();
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0 }, async () => {
        requestStarted.resolve();
        await releaseRequest.promise;
        return new Response('graceful-response');
    });
    let shutdownPromise: Promise<void> | undefined;

    try {
        const responsePromise = fetch(`http://127.0.0.1:${server.addr.port}/slow`);
        void responsePromise.catch(() => {});
        await withTimeout(requestStarted.promise);

        let shutdownFinished = false;
        let serverFinished = false;
        const finishedPromise = server.finished.then(() => { serverFinished = true; });
        shutdownPromise = server.shutdown().then(() => { shutdownFinished = true; });

        await sleep(25);
        strictEqual(shutdownFinished, false, 'shutdown must wait for the active request');
        strictEqual(serverFinished, false, 'finished must wait for the active request');

        releaseRequest.resolve();
        const response = await withTimeout(responsePromise);
        strictEqual(response.status, 200);
        strictEqual(await response.text(), 'graceful-response');

        await withTimeout(shutdownPromise);
        await withTimeout(finishedPromise);
        strictEqual(shutdownFinished, true);
        strictEqual(serverFinished, true);
    } finally {
        releaseRequest.resolve();
        try { await withTimeout(shutdownPromise ?? server.shutdown()); } catch {}
    }
});

// Client abort mid-stream must not call onError / invent a 500.
Deno.test({
    name: 'deno: Deno.serve client abort mid-response does not invoke onError',
    timeout: 10000,
}, async () => {
    if (!await canListenTcp()) return;

    const onErrorHits: unknown[] = [];
    const controller = new AbortController();
    let firstChunk: () => void;
    const firstChunkGate = new Promise<void>((r) => { firstChunk = r; });

    const server = Deno.serve({
        hostname: '127.0.0.1',
        port: 0,
        signal: controller.signal,
        onError(error) {
            onErrorHits.push(error);
            return new Response('should-not-run', { status: 500 });
        },
    }, () => {
        // Streaming body so the peer can leave before end().
        const body = new ReadableStream<Uint8Array>({
            start(ctrl) {
                const enc = new TextEncoder();
                ctrl.enqueue(enc.encode('chunk1'));
                firstChunk();
                const tick = () => {
                    try {
                        ctrl.enqueue(enc.encode('x'.repeat(8 * 1024)));
                        setTimeout(tick, 0);
                    } catch {
                        // Controller closed after client abort.
                    }
                };
                setTimeout(tick, 0);
            },
            cancel() {
                // Peer cancel is expected.
            },
        });
        return new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
        });
    });

    try {
        const port = server.addr.port;
        const res = await fetch(`http://127.0.0.1:${port}/stream-abort`);
        ok(res.body);
        const reader = res.body.getReader();
        await reader.read();
        await firstChunkGate;
        await reader.cancel();
        // Let the server drain the write/EPIPE path.
        await sleep(150);
        strictEqual(onErrorHits.length, 0, `onError must not fire on peer disconnect: ${onErrorHits}`);
    } finally {
        controller.abort();
        try { await withTimeout(server.finished); } catch {}
        try { await server.shutdown(); } catch {}
    }
});

Deno.test({
    name: 'deno: Deno.serve supports Unix domain socket path and reports Unix addr',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
}, async () => {
    const dir = Deno.makeTempDirSync();
    const socketPath = `${dir}/serve.sock`;
    const controller = new AbortController();
    const listened: Deno.UnixAddr[] = [];
    let server: Deno.HttpServer | undefined;
    let conn: Deno.UnixConn | undefined;

    try {
        server = Deno.serve({
            path: socketPath,
            signal: controller.signal,
            onListen(addr) {
                if (addr.transport === 'unix') listened.push(addr);
            },
        }, (_request, info) => {
            deepStrictEqual(info.remoteAddr, { transport: 'unix', path: socketPath });
            return new Response('unix-ok');
        });

        deepStrictEqual(server.addr, { transport: 'unix', path: socketPath });
        deepStrictEqual(listened, [{ transport: 'unix', path: socketPath }]);

        conn = await Deno.connect({ transport: 'unix', path: socketPath });
        await conn.write(new TextEncoder().encode([
            'GET /unix HTTP/1.1',
            'Host: localhost',
            'Connection: close',
            '',
            '',
        ].join('\r\n')));
        const raw = await readUntil(conn, 'unix-ok');
        ok(raw.includes('HTTP/1.1 200'));
        const lowerRaw = raw.toLowerCase();
        ok(lowerRaw.includes('content-length: 7') || lowerRaw.includes('transfer-encoding: chunked'));
        ok(raw.includes('unix-ok'));

        controller.abort();
        await withTimeout(server.finished);
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    } finally {
        try { conn?.close(); } catch {}
        try { await server?.shutdown(); } catch {}
        removeTree(dir);
    }
});

Deno.test({ name: 'deno: Deno.serve handles text/json/404 routes', timeout: SPAWN_TEST_TIMEOUT_MS }, async () => {
    if (!await canListenTcp()) return;
    const target = startTarget(['--inspect=0', 'run', '--allow-net', TARGET]);
    try {
        await waitForServer(target);

        const text = await fetch(`http://127.0.0.1:${PORT}/text`);
        strictEqual(await text.text(), 'hello');
        strictEqual(text.status, 200);

        const json = await fetch(`http://127.0.0.1:${PORT}/json`);
        strictEqual(json.status, 200);
        const j = await json.json();
        strictEqual(j.ok, true);

        const miss = await fetch(`http://127.0.0.1:${PORT}/nope`);
        strictEqual(miss.status, 404);
    } finally {
        await target.stop();
    }
});

Deno.test({ name: 'deno: Deno.serve handles request body HEAD stream and handler errors', timeout: SPAWN_TEST_TIMEOUT_MS }, async () => {
    if (!await canListenTcp()) return;
    const target = startTarget(['run', '--allow-net', TARGET]);
    try {
        await waitForServer(target);
        const header = await fetch(`http://127.0.0.1:${PORT}/headers`, {
            headers: { 'x-foo': 'bar' },
        });
        strictEqual(await header.text(), 'bar');

        const echoed = await fetch(`http://127.0.0.1:${PORT}/echo`, {
            method: 'POST',
            body: 'request-body',
        });
        strictEqual(echoed.status, 200, target.stderr);
        strictEqual(await echoed.text(), 'request-body');

        const head = await fetch(`http://127.0.0.1:${PORT}/text`, { method: 'HEAD' });
        strictEqual(head.status, 200);
        strictEqual(await head.text(), '');

        const stream = await fetch(`http://127.0.0.1:${PORT}/stream`);
        strictEqual(stream.status, 200);
        strictEqual(await stream.text(), 'stream-body');

        const bad = await fetch(`http://127.0.0.1:${PORT}/bad`);
        strictEqual(bad.status, 500);
        strictEqual(await bad.text(), 'Internal Server Error');

        const thrown = await fetch(`http://127.0.0.1:${PORT}/throw`);
        strictEqual(thrown.status, 500);
        strictEqual(await thrown.text(), 'Internal Server Error');
        await withTimeout((async () => {
            while (!target.stderr.includes('serve-target-boom')) await sleep(10);
        })());
        ok(target.stderr.includes('Deno.serve request error'));
    } finally {
        await target.stop();
    }
});
