import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { resolve } from 'node:path';

const CNO = resolve('build/stage/cno');
const TARGET = resolve('tests/deno/targets/serve.target.ts');
const TIMEOUT_MS = 15_000;

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

async function waitForServer(): Promise<void> {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/text`);
            if (r.ok) return;
        } catch { /* not up yet */ }
        await sleep(120);
    }
    throw new Error('server did not start');
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

Deno.test({ name: 'deno: Deno.serve handles text/json/404 routes', timeout: 10000 }, async () => {
    if (!await canListenTcp()) return;
    const child = spawn(CNO, ['run', '--allow-net', `--inspect=0`, TARGET], {
        env: { ...process.env, CNO_SERVE_PORT: String(PORT) },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    try {
        await waitForServer();

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
        child.kill('SIGKILL');
        await new Promise((r) => child.on('exit', r));
    }
});

Deno.test({ name: 'deno: Deno.serve handles request body HEAD stream and handler errors', timeout: 10000 }, async () => {
    if (!await canListenTcp()) return;
    const child = spawn(CNO, ['run', '--allow-net', TARGET], {
        env: { ...process.env, CNO_SERVE_PORT: String(PORT) },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    try {
        await waitForServer();
        const header = await fetch(`http://127.0.0.1:${PORT}/headers`, {
            headers: { 'x-foo': 'bar' },
        });
        strictEqual(await header.text(), 'bar');

        const echoed = await fetch(`http://127.0.0.1:${PORT}/echo`, {
            method: 'POST',
            body: 'request-body',
        });
        strictEqual(echoed.status, 200);
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
    } finally {
        child.kill('SIGKILL');
        await new Promise((r) => child.on('exit', r));
    }
});
