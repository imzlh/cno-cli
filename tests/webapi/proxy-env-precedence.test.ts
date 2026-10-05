/**
 * Proxy configuration sources: environment variables vs the Windows registry,
 * and whether the raw clients (WebSocket / EventSource) honour the result.
 *
 * WHY THIS FILE MEASURES AT THE SOCKET
 * ------------------------------------
 * The obvious harness — install a counting hook via
 * `import '../../cno/src/utils/network-hooks.ts'` and assert it fired — cannot
 * work, and produced three false failures in proxy-transport.test.ts before.
 * The baked globals resolve `getRawConnectionHook()` against the *baked* copy of
 * network-hooks.ts; a disk import creates a *second* module instance with its own
 * hook variable. Nothing joins them, so the counter reads 0 while traffic flows.
 *
 * So nothing here counts through a hook. Every assertion counts TCP arrivals at
 * a `net.createServer` bound to 127.0.0.1 — a real socket cannot be fooled by
 * module identity. The sink also records each first request line, which is what
 * distinguishes "proxied" (absolute-form `GET http://example.invalid/x`) from
 * "went direct" (no arrival at all).
 *
 * The target is always `example.invalid`. It is unroutable by RFC 6761, so if a
 * bypass regression ever reappears the request fails to resolve rather than
 * leaking to a third party.
 *
 * `src/network.ts` is baked into the binary, so `startProxy()` is exercised
 * through a disk import here. That keeps one coherent graph: the disk
 * `src/network.ts` writes the hook that the disk `EventSource`/`WebSocket` read.
 */
import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import { getCurlInitHook as getCnoCurlInitHook, getRawConnectionHook, setRawConnectionHook } from '../../cno/src/utils/network-hooks.ts';
import { getCurlInitHook as getCtsCurlInitHook } from '../../cts/src/utils/curl.ts';

const PROXY_ENV = [
    'HTTP_PROXY', 'http_proxy',
    'HTTPS_PROXY', 'https_proxy',
    'ALL_PROXY', 'all_proxy',
    'NO_PROXY', 'no_proxy',
] as const;

/** The disk copy of the module under test, so its hook writes are observable. */
const { startProxy, stopNetwork, getProxyInfo } = await import('../../src/network.ts');

// --- disk client classes, with the global event classes preserved -------------
// Same constraint as proxy-transport-clients.test.ts: importing the disk webapi
// graph replaces globalThis.Event & friends at module scope. They must stay
// clobbered while the disk clients run, and be restored before worker teardown
// dispatches 'beforeunload', or that throws `Invalid event object`.

const BAKED_EVENT_GLOBALS = {
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    CustomEvent: globalThis.CustomEvent,
    ErrorEvent: globalThis.ErrorEvent,
    PromiseRejectionEvent: globalThis.PromiseRejectionEvent,
    CloseEvent: globalThis.CloseEvent,
    MessageEvent: globalThis.MessageEvent,
    DOMException: globalThis.DOMException,
    ProgressEvent: globalThis.ProgressEvent,
} as const;

const { EventSource } = await import('../../cno/src/webapi/sse.ts');
const { WebSocket } = await import('../../cno/src/webapi/websocket.ts');

Deno.test.afterAll(() => {
    for (const [name, cls] of Object.entries(BAKED_EVENT_GLOBALS)) Reflect.set(globalThis, name, cls);
});

// --- loopback counting sink --------------------------------------------------

interface Sink {
    server: Server;
    port: number;
    /** First request line of every accepted connection, in arrival order. */
    lines: string[];
    /** Every accepted connection, whether or not a request line was seen. */
    arrivals: number;
}

interface CurlRecorder {
    handle: CModuleCURL.CURL;
    proxies: Array<{ url: string; type: unknown }>;
}

function recordCurl(): CurlRecorder {
    const proxies: Array<{ url: string; type: unknown }> = [];
    const handle = {
        setProxy(url: string, type?: unknown) {
            proxies.push({ url, type });
            return this;
        },
        setOpt(_option: number, _value: unknown) {
            return this;
        },
    } as unknown as CModuleCURL.CURL;
    return { handle, proxies };
}

function startSink(): Promise<Sink> {
    const lines: string[] = [];
    const sockets = new Set<Socket>();
    const sink = { lines, arrivals: 0 } as Sink;
    const server = createServer((socket: Socket) => {
        sink.arrivals++;
        sockets.add(socket);
        let buffer = '';
        let recorded = false;
        socket.on('data', (chunk: Buffer) => {
            if (recorded) return;
            buffer += chunk.toString('latin1');
            const end = buffer.indexOf('\r\n');
            if (end < 0) return;
            recorded = true;
            lines.push(buffer.slice(0, end));
            // Refuse rather than emulate a proxy: arrival is the assertion,
            // and a definite response keeps the client from hanging.
            try { socket.end('HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch { /* already gone */ }
        });
        socket.on('error', () => { /* client aborts are expected */ });
        socket.on('close', () => sockets.delete(socket));
    });
    server.on('error', () => { /* surfaced by the listen callback failing */ });
    (sink as { destroyAll?: () => void }).destroyAll = () => { for (const s of sockets) try { s.destroy(); } catch { /* ignore */ } };
    return new Promise<Sink>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (typeof address === 'string' || address === null) { reject(new Error('sink: no port')); return; }
            sink.server = server;
            sink.port = address.port;
            resolve(sink);
        });
    });
}

function closeSink(sink: Sink): Promise<void> {
    (sink as { destroyAll?: () => void }).destroyAll?.();
    return new Promise<void>(resolve => sink.server.close(() => resolve()));
}

// --- environment control -----------------------------------------------------

function clearProxyEnv(): void {
    for (const name of PROXY_ENV) { try { Deno.env.delete(name); } catch { /* absent */ } }
}

function childProxyEnv(values: { http?: string; https?: string }): Record<string, string> {
    return {
        HTTP_PROXY: values.http ?? '',
        http_proxy: values.http ?? '',
        HTTPS_PROXY: values.https ?? '',
        https_proxy: values.https ?? '',
        ALL_PROXY: '',
        all_proxy: '',
        NO_PROXY: '',
        no_proxy: '',
    };
}

/** Replace the proxy env with exactly `values`, then re-read configuration. */
function withProxyEnv(values: Record<string, string>): void {
    clearProxyEnv();
    for (const [name, value] of Object.entries(values)) Deno.env.set(name, value);
    startProxy();
}

/**
 * True when this machine has an enabled proxy in the registry. The env-wins and
 * registry-fallback cases mean different things depending on this, so it is read
 * rather than assumed.
 */
function registryProxyEnabled(): boolean {
    const win32 = import.meta.use('win32') as {
        HKCU?: number;
        readRegistry?: (root: number, key: string, name: string) => unknown;
    } | undefined;
    if (win32?.HKCU === undefined || !win32.readRegistry) return false;
    const key = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    try {
        if (!win32.readRegistry(win32.HKCU, key, 'ProxyEnable')) return false;
        const server = win32.readRegistry(win32.HKCU, key, 'ProxyServer');
        return typeof server === 'string' && server.length > 0;
    } catch {
        // Reading an absent value throws `InternalError: Win32 error 0`.
        return false;
    }
}

const REGISTRY_PROXY = registryProxyEnabled();

/** Drive the raw-connection hook the way EventSource and WebSocket do. */
async function connectThroughHook(url: string): Promise<void> {
    const hook = getRawConnectionHook();
    ok(hook, 'startProxy() must install a raw-connection hook');
    const connection = await hook(new URL(url));
    try { connection.socket.close(); } catch { /* already closed */ }
}

function settle(client: { close(): void }, label: string, timeoutMs = 4000): Promise<string> {
    return new Promise<string>(resolve => {
        let done = false;
        const finish = (outcome: string) => {
            if (done) return;
            done = true;
            try { client.close(); } catch { /* already closing */ }
            resolve(`${label}:${outcome}`);
        };
        const target = client as unknown as Record<string, unknown>;
        target['onopen'] = () => finish('open');
        target['onerror'] = () => finish('error');
        target['onclose'] = () => finish('close');
        setTimeout(() => finish('timeout'), timeoutMs);
    });
}

// --- tests: precedence and merging ------------------------------------------

Deno.test('env: HTTP_PROXY is honoured on every platform, registry or not', () => {
    try {
        withProxyEnv({ HTTP_PROXY: 'http://127.0.0.1:19001' });
        const hook = getCnoCurlInitHook();
        ok(hook, 'HTTP_PROXY must install the curl hook');
        const http = recordCurl();
        hook(http.handle, new URL('http://example.invalid/'));
        strictEqual(http.proxies[0]?.url, 'http://127.0.0.1:19001/');
        strictEqual(http.proxies[0]?.type, 'http');
    } finally { clearProxyEnv(); stopNetwork(); }
});

Deno.test('env wins over the Windows registry', () => {
    try {
        withProxyEnv({ HTTP_PROXY: 'http://127.0.0.1:19002', HTTPS_PROXY: 'http://127.0.0.1:19002' });
        const config = getProxyInfo();
        ok(config, 'a proxy must be configured');
        strictEqual(new URL(config.url).port, '19002',
            'the env var must beat any registry ProxyServer');
    } finally { clearProxyEnv(); stopNetwork(); }
});

Deno.test('registry is the fallback when the env names no proxy', () => {
    try {
        clearProxyEnv();
        startProxy();
        const config = getProxyInfo();
        if (REGISTRY_PROXY) ok(config, 'an enabled registry proxy must still be used');
        else strictEqual(config, null, 'no registry proxy and no env means no proxy');
    } finally { stopNetwork(); }
});

Deno.test('neither source configured leaves no proxy', () => {
    if (REGISTRY_PROXY) return; // not expressible on this machine
    try {
        clearProxyEnv();
        startProxy();
        strictEqual(getProxyInfo(), null);
    } finally { stopNetwork(); }
});

Deno.test('per-scheme merge: HTTPS_PROXY alone does not blank the http proxy', () => {
    try {
        withProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:19003' });
        const config = getProxyInfo();
        ok(config, 'HTTPS_PROXY must produce a proxy config');
        strictEqual(new URL(config.url).port, '19003');
    } finally { clearProxyEnv(); stopNetwork(); }
});

Deno.test('ALL_PROXY is the fallback and a scheme-specific var overrides it', () => {
    try {
        withProxyEnv({ ALL_PROXY: 'http://127.0.0.1:19004' });
        strictEqual(new URL(getProxyInfo()!.url).port, '19004');
        withProxyEnv({ ALL_PROXY: 'http://127.0.0.1:19004', HTTPS_PROXY: 'http://127.0.0.1:19005' });
        strictEqual(new URL(getProxyInfo()!.url).port, '19005',
            'HTTPS_PROXY must beat ALL_PROXY for https, matching curl');
    } finally { clearProxyEnv(); stopNetwork(); }
});

Deno.test('lowercase env spellings are honoured', () => {
    try {
        withProxyEnv({ http_proxy: 'http://127.0.0.1:19006' });
        const hook = getCnoCurlInitHook();
        ok(hook, 'http_proxy must install the curl hook');
        const http = recordCurl();
        hook(http.handle, new URL('http://example.invalid/'));
        strictEqual(http.proxies[0]?.url, 'http://127.0.0.1:19006/');
    } finally { clearProxyEnv(); stopNetwork(); }
});

Deno.test('a malformed env proxy does not prevent hook installation', () => {
    try {
        withProxyEnv({ HTTP_PROXY: 'gopher://nope', HTTPS_PROXY: 'gopher://nope' });
        // The value is unusable, but startProxy must not throw out and leave the
        // raw clients unhooked — that is the bypass this file exists to prevent.
        ok(getRawConnectionHook(), 'the raw-connection hook must be installed anyway');
    } finally { clearProxyEnv(); stopNetwork(); }
});

Deno.test('CURL hooks select the system proxy from the target scheme', () => {
    try {
        withProxyEnv({
            HTTP_PROXY: 'http://127.0.0.1:19008',
            HTTPS_PROXY: 'http://127.0.0.1:19009',
        });
        for (const hook of [getCnoCurlInitHook(), getCtsCurlInitHook()]) {
            ok(hook, 'startProxy() must install each curl hook');
            const http = recordCurl();
            hook(http.handle, new URL('http://example.invalid/x'));
            strictEqual(http.proxies[0]?.url, 'http://127.0.0.1:19008/');

            const https = recordCurl();
            hook(https.handle, new URL('https://example.invalid/x'));
            strictEqual(https.proxies[0]?.url, 'http://127.0.0.1:19009/');
        }
    } finally { clearProxyEnv(); stopNetwork(); }
});

Deno.test('a malformed HTTPS_PROXY does not fall back to HTTP_PROXY', () => {
    try {
        withProxyEnv({
            HTTP_PROXY: 'http://127.0.0.1:19010',
            HTTPS_PROXY: 'gopher://invalid',
        });
        const hook = getCnoCurlInitHook();
        ok(hook, 'startProxy() must install the curl hook');

        const http = recordCurl();
        hook(http.handle, new URL('http://example.invalid/x'));
        strictEqual(http.proxies[0]?.url, 'http://127.0.0.1:19010/');

        const https = recordCurl();
        hook(https.handle, new URL('https://example.invalid/x'));
        strictEqual(https.proxies.length, 0);
    } finally { clearProxyEnv(); stopNetwork(); }
});

Deno.test('startProxy installs the raw-connection hook that the clients read', () => {
    try {
        withProxyEnv({ HTTP_PROXY: 'http://127.0.0.1:19007' });
        ok(getRawConnectionHook(), 'WebSocket/EventSource read this hook via connectHttp()');
    } finally { clearProxyEnv(); stopNetwork(); }
});

// --- tests: traffic actually arrives at the proxy ----------------------------

Deno.test({ name: 'raw connections reach the env-named proxy', timeout: 20000 }, async () => {
    const sink = await startSink();
    try {
        withProxyEnv({ HTTP_PROXY: `http://127.0.0.1:${sink.port}` });
        await connectThroughHook('http://example.invalid/x');
        strictEqual(sink.arrivals, 1, 'the proxy must receive the connection');
    } finally { clearProxyEnv(); stopNetwork(); setRawConnectionHook(null); await closeSink(sink); }
});

Deno.test({ name: 'EventSource reaches the env-named proxy', timeout: 20000 }, async () => {
    const sink = await startSink();
    try {
        withProxyEnv({ HTTP_PROXY: `http://127.0.0.1:${sink.port}` });
        const source = new EventSource('http://example.invalid/stream');
        await settle(source, 'sse');
        strictEqual(sink.arrivals, 1, 'EventSource must go through the proxy, not direct');
        ok(sink.lines[0]?.startsWith('GET http://example.invalid/stream'),
            `absolute-form request expected, got ${JSON.stringify(sink.lines[0])}`);
    } finally { clearProxyEnv(); stopNetwork(); setRawConnectionHook(null); await closeSink(sink); }
});

Deno.test({ name: 'WebSocket reaches the env-named proxy', timeout: 20000 }, async () => {
    const sink = await startSink();
    try {
        withProxyEnv({ HTTP_PROXY: `http://127.0.0.1:${sink.port}` });
        const socket = new WebSocket('ws://example.invalid/ws');
        await settle(socket, 'ws');
        strictEqual(sink.arrivals, 1, 'WebSocket must go through the proxy, not direct');
        ok(sink.lines[0]?.startsWith('GET http://example.invalid/ws'),
            `absolute-form request expected, got ${JSON.stringify(sink.lines[0])}`);
    } finally { clearProxyEnv(); stopNetwork(); setRawConnectionHook(null); await closeSink(sink); }
});

/**
 * fetch is pinned against the real binary, not the disk graph.
 *
 * The curl hook lives in the baked graph, so a disk import cannot observe fetch.
 * The child invokes the actual CLI path with `--system-proxy` instead.
 */
Deno.test({ name: 'fetch reaches the env-named proxy (spawned binary)', timeout: 60000 }, async () => {
    const sink = await startSink();
    const tempDir = await Deno.makeTempDir({ prefix: 'cno-envproxy-' });
    const script = `${tempDir}/fetch-child.mjs`;
    await Deno.writeTextFile(script, [
        `try {`,
        `  const r = await fetch('http://example.invalid/x', { signal: AbortSignal.timeout(8000) });`,
        `  console.log('status=' + r.status);`,
        `  await r.text().catch(() => undefined);`,
        `} catch (e) { console.log('err=' + e.name); }`,
        `console.log('REACHED END');`,
    ].join('\n'));
    try {
        const command = new Deno.Command(Deno.execPath(), {
            args: ['--system-proxy', 'run', script],
            env: childProxyEnv({ http: `http://127.0.0.1:${sink.port}` }),
            stdout: 'piped',
            stderr: 'piped',
        });
        const output = await command.output();
        const stdout = new TextDecoder().decode(output.stdout);
        ok(stdout.includes('REACHED END'), `child did not finish: ${stdout}`);
        strictEqual(sink.arrivals, 1, `fetch must go through the proxy; child said: ${stdout.trim()}`);
        ok(sink.lines[0]?.startsWith('GET http://example.invalid/x'),
            `absolute-form request expected, got ${JSON.stringify(sink.lines[0])}`);
    } finally {
        await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
        await closeSink(sink);
    }
});

Deno.test({ name: 'CLI proxy settings survive entry completion and timer work', timeout: 15000 }, async () => {
    const proxy = await startSink();
    const origin = await startSink();
    const tempDir = await Deno.makeTempDir({ prefix: 'cno-proxy-lifetime-' });
    const script = `${tempDir}/proxy-child.mjs`;
    const url = `http://127.0.0.1:${origin.port}`;
    const code = `
        function request(label) {
            return new Promise((resolve, reject) => {
                const client = new EventSource(${JSON.stringify(url)} + '/' + label);
                const timer = setTimeout(() => {
                    client.close(); reject(new Error('proxy request timed out'));
                }, 2500);
                client.onerror = () => {
                    clearTimeout(timer); client.close();
                    console.log('PROXY:' + label); resolve();
                };
            });
        }
        await request('entry');
        setTimeout(() => request('timer').catch(error => {
            console.error(error); process.exitCode = 1;
        }), 25);
    `;
    await Deno.writeTextFile(script, code);
    try {
        for (const command of [['run', script], ['eval', code]]) {
            const output = await new Deno.Command(Deno.execPath(), {
                args: ['--system-proxy', ...command],
                env: { ...childProxyEnv({ http: `http://127.0.0.1:${proxy.port}` }), NODE_OPTIONS: '' },
                stdout: 'piped', stderr: 'piped',
            }).output();
            const stdout = new TextDecoder().decode(output.stdout);
            strictEqual(output.code, 0, stdout + new TextDecoder().decode(output.stderr));
            deepStrictEqual(stdout.trim().split(/\r?\n/), ['PROXY:entry', 'PROXY:timer']);
        }
        strictEqual(origin.arrivals, 0, 'neither entry nor deferred requests may bypass the configured proxy');
        deepStrictEqual(proxy.lines, [
            `GET ${url}/entry HTTP/1.1`, `GET ${url}/timer HTTP/1.1`,
            `GET ${url}/entry HTTP/1.1`, `GET ${url}/timer HTTP/1.1`,
        ]);
    } finally {
        await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
        await Promise.all([closeSink(proxy), closeSink(origin)]);
    }
});

Deno.test({ name: 'fetch system proxy selects HTTP_PROXY and HTTPS_PROXY independently', timeout: 60000 }, async () => {
    const httpProxy = await startSink();
    const httpsProxy = await startSink();
    const tempDir = await Deno.makeTempDir({ prefix: 'cno-proxy-schemes-' });
    const script = `${tempDir}/fetch-child.mjs`;
    await Deno.writeTextFile(script, [
        `for (const url of ['http://example.invalid/http', 'https://example.invalid/https']) {`,
        `  try { await fetch(url, { signal: AbortSignal.timeout(8000) }); } catch {}`,
        `}`,
        `console.log('REACHED END');`,
    ].join('\n'));
    try {
        const command = new Deno.Command(Deno.execPath(), {
            args: ['--system-proxy', 'run', script],
            env: childProxyEnv({
                http: `http://127.0.0.1:${httpProxy.port}`,
                https: `http://127.0.0.1:${httpsProxy.port}`,
            }),
            stdout: 'piped',
            stderr: 'piped',
        });
        const output = await command.output();
        const stdout = new TextDecoder().decode(output.stdout);
        ok(stdout.includes('REACHED END'), `child did not finish: ${stdout}`);
        strictEqual(httpProxy.arrivals, 1, 'HTTP fetch must reach HTTP_PROXY');
        strictEqual(httpsProxy.arrivals, 1, 'HTTPS fetch must reach HTTPS_PROXY');
        ok(httpProxy.lines[0]?.startsWith('GET http://example.invalid/http'),
            `HTTP proxy must receive an absolute-form request, got ${JSON.stringify(httpProxy.lines[0])}`);
        ok(httpsProxy.lines[0]?.startsWith('CONNECT example.invalid:443'),
            `HTTPS proxy must receive CONNECT, got ${JSON.stringify(httpsProxy.lines[0])}`);
    } finally {
        await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
        await Promise.all([closeSink(httpProxy), closeSink(httpsProxy)]);
    }
});

// --- tests: NO_PROXY --------------------------------------------------------

Deno.test({ name: 'NO_PROXY bypasses the proxy for a matching host', timeout: 20000 }, async () => {
    const sink = await startSink();
    try {
        withProxyEnv({ HTTP_PROXY: `http://127.0.0.1:${sink.port}`, NO_PROXY: 'example.invalid' });
        await connectThroughHook('http://example.invalid/x').catch(() => undefined);
        strictEqual(sink.arrivals, 0, 'a NO_PROXY host must not reach the proxy');
    } finally { clearProxyEnv(); stopNetwork(); setRawConnectionHook(null); await closeSink(sink); }
});

Deno.test({ name: 'no_proxy lowercase also bypasses', timeout: 20000 }, async () => {
    const sink = await startSink();
    try {
        withProxyEnv({ http_proxy: `http://127.0.0.1:${sink.port}`, no_proxy: 'example.invalid' });
        await connectThroughHook('http://example.invalid/x').catch(() => undefined);
        strictEqual(sink.arrivals, 0, 'lowercase no_proxy must be honoured');
    } finally { clearProxyEnv(); stopNetwork(); setRawConnectionHook(null); await closeSink(sink); }
});

Deno.test({ name: 'NO_PROXY that does not match still proxies', timeout: 20000 }, async () => {
    const sink = await startSink();
    try {
        withProxyEnv({ HTTP_PROXY: `http://127.0.0.1:${sink.port}`, NO_PROXY: 'other.invalid' });
        await connectThroughHook('http://example.invalid/x');
        strictEqual(sink.arrivals, 1, 'a non-matching NO_PROXY must not disable the proxy');
    } finally { clearProxyEnv(); stopNetwork(); setRawConnectionHook(null); await closeSink(sink); }
});

Deno.test('env NO_PROXY applies to a registry-sourced proxy', () => {
    if (!REGISTRY_PROXY) return; // needs a registry proxy to override
    try {
        withProxyEnv({ NO_PROXY: 'example.invalid' });
        const config = getProxyInfo();
        ok(config, 'the registry proxy must still be in effect');
        strictEqual(config.noProxy, 'example.invalid',
            'env NO_PROXY must reach a registry-sourced proxy');
    } finally { clearProxyEnv(); stopNetwork(); }
});

Deno.test('stopNetwork clears the hook and the config', () => {
    withProxyEnv({ HTTP_PROXY: 'http://127.0.0.1:19008' });
    ok(getProxyInfo());
    clearProxyEnv();
    stopNetwork();
    strictEqual(getProxyInfo(), null);
    strictEqual(getRawConnectionHook(), null);
    strictEqual(getCnoCurlInitHook(), null);
    strictEqual(getCtsCurlInitHook(), null);
});
