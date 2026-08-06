/**
 * In-process tests for the DevTools HTTP/WS endpoint (`src/inspector/worker/server.ts`).
 *
 * These import startServer from the working tree rather than spawning `cno.exe`, so
 * they validate the *source* and stay meaningful without a rebuild. That matters for
 * the security surface: the token gate, the DNS-rebinding Host check and the
 * discovery JSON are only reachable through real HTTP requests.
 *
 * Everything speaks raw TCP rather than fetch(), for two reasons:
 *   1. MEASURED: importing this module loads a second copy of `cno/src/webapi/*`,
 *      and the global fetch then throws `TypeError: Illegal invocation` from
 *      performFetch → addEventListener, because its AbortSignal brand check fails
 *      across the two copies. fetch() is simply not usable in this module graph.
 *   2. The Host cases need a forged and even duplicated Host header, which the
 *      fetch API forbids by design.
 *
 * Ports are randomised: a fixed port fails spuriously when test files run at once.
 */

import { ok, strictEqual } from 'node:assert';
import { connect } from 'node:net';
import { startServer, type ServerHandle } from '../../src/inspector/worker/server';

const HOST = '127.0.0.1';
// Well above the ephemeral range the fixed-port cdp-* tests use.
function randomPort(): number {
    return 40000 + Math.floor(Math.random() * 20000);
}

interface Endpoint {
    port: number;
    handle: ServerHandle;
    /** onConnect count — proves an upgrade reached the CDP wiring, not just 101. */
    connections: number;
}

async function withEndpoint(fn: (ep: Endpoint) => Promise<void>): Promise<void> {
    let lastError: unknown = null;
    // A random port can still collide; retry a few times before giving up.
    for (let attempt = 0; attempt < 5; attempt++) {
        const port = randomPort();
        const ep: Endpoint = { port, handle: null as unknown as ServerHandle, connections: 0 };
        let handle: ServerHandle;
        try {
            handle = await startServer({
                port,
                host: HOST,
                entryUrl: 'file:///test/entry.ts',
                onConnect: () => { ep.connections++; },
            });
        } catch (e) {
            lastError = e;
            continue;
        }
        ep.handle = handle;
        try {
            await fn(ep);
            return;
        } finally {
            try { handle.close(); } catch { /* already down */ }
        }
    }
    throw new Error(`could not bind an inspector endpoint: ${lastError}`);
}

interface RawResponse {
    status: number;
    /** Raw header block, lowercased for case-insensitive assertions. */
    head: string;
    body: string;
}

/**
 * One HTTP request over a raw socket. `Connection: close` makes the socket close
 * the end-of-response signal; a 101 never closes, so that is detected explicitly.
 * The explicit timeout keeps a hang from surfacing as an opaque outer timeout.
 */
function raw(port: number, requestLines: string[]): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: HOST, port }, () => {
            socket.write(requestLines.join('\r\n') + '\r\n\r\n');
        });
        let buf = '';
        let settled = false;
        const timer = setTimeout(() => {
            socket.destroy();
            if (!settled) {
                settled = true;
                reject(new Error(`raw request timed out; received ${JSON.stringify(buf.slice(0, 200))}`));
            }
        }, 5_000);
        const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const split = buf.indexOf('\r\n\r\n');
            const head = split === -1 ? buf : buf.slice(0, split);
            resolve({
                status: Number(head.split('\r\n')[0]?.split(' ')[1] ?? 0),
                head: head.toLowerCase(),
                body: split === -1 ? '' : buf.slice(split + 4),
            });
        };
        socket.on('data', (chunk: Buffer | string) => {
            buf += typeof chunk === 'string' ? chunk : chunk.toString();
            // A successful upgrade holds the connection open by definition.
            if (buf.startsWith('HTTP/1.1 101') && buf.includes('\r\n\r\n')) {
                socket.destroy();
                finish();
            }
        });
        socket.on('error', (e: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(e);
        });
        socket.on('close', finish);
    });
}

function get(port: number, path: string, extra: string[] = [], host = `${HOST}:${port}`): Promise<RawResponse> {
    return raw(port, [`GET ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: close', ...extra]);
}

function upgradeLines(port: number, path: string, extra: string[] = []): string[] {
    return [
        `GET ${path} HTTP/1.1`,
        `Host: ${HOST}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...extra,
    ];
}

Deno.test({ name: 'cdp endpoint: devtoolsFrontendUrl carries the ws token', timeout: 20_000 }, async () => {
    await withEndpoint(async ({ port, handle }) => {
        const res = await get(port, '/json');
        strictEqual(res.status, 200, '/json must be reachable without a token');
        const list = JSON.parse(res.body) as Array<Record<string, string>>;
        const entry = list[0];
        ok(entry, '/json must list one target');

        // `ok()` is not an assertion signature here (no node ambients in this
        // project's tsconfig), so narrow explicitly rather than leaning on it.
        const token = new URL(handle.wsUrl).searchParams.get('token');
        if (token === null || token.length === 0) throw new Error('webSocketDebuggerUrl must carry a token');
        strictEqual(entry.webSocketDebuggerUrl, handle.wsUrl);

        // The regression this pins: `ws=` used to be host+path only, so every
        // "inspect" click from chrome://inspect opened a tokenless socket and got a
        // 403 on the upgrade. No other test reads this field, so a fully green run
        // did not catch it.
        const frontend = entry.devtoolsFrontendUrl;
        if (!frontend) throw new Error('devtoolsFrontendUrl must be present');
        ok(frontend.includes(token), `devtoolsFrontendUrl must contain the token, got ${frontend}`);

        // And it must be the token DevTools will actually send: parse the ws param
        // back out the way the frontend does.
        const wsParam = new URL(frontend.replace(/^devtools:\/\//, 'https://')).searchParams.get('ws');
        if (wsParam === null) throw new Error('devtoolsFrontendUrl must have a ws param');
        const reconstructed = new URL(`ws://${wsParam}`);
        strictEqual(reconstructed.searchParams.get('token'), token);
        strictEqual(reconstructed.pathname, new URL(handle.wsUrl).pathname);
    });
});

Deno.test({ name: 'cdp endpoint: discovery is unauthenticated', timeout: 20_000 }, async () => {
    await withEndpoint(async ({ port }) => {
        // Gating these on the token is unsatisfiable: /json/version is how a client
        // learns the token in the first place. This is what broke the six cdp tests.
        for (const path of ['/json', '/json/list', '/json/version']) {
            const res = await get(port, path);
            strictEqual(res.status, 200, `${path} must be reachable without a token`);
        }
        const version = JSON.parse((await get(port, '/json/version')).body) as Record<string, string>;
        strictEqual(version['Protocol-Version'], '1.3');
        ok(version.webSocketDebuggerUrl.startsWith('ws://'));
    });
});

Deno.test({ name: 'cdp endpoint: discovery sends no CORS headers', timeout: 20_000 }, async () => {
    await withEndpoint(async ({ port }) => {
        const res = await get(port, '/json/version', ['Origin: http://evil.example']);
        strictEqual(res.status, 200);
        // Unauthenticated discovery is only safe because a cross-origin page cannot
        // READ the response. If anyone ever adds Access-Control-Allow-Origin here,
        // any web page could lift the token, and the token is arbitrary code
        // execution with no permission layer behind it.
        ok(!res.head.includes('access-control-allow-origin'), 'discovery must not be CORS-readable');
    });
});

Deno.test({ name: 'cdp endpoint: a rebound Host is rejected on every route', timeout: 20_000 }, async () => {
    await withEndpoint(async ({ port }) => {
        // DNS rebinding: a browser can be made to resolve evil.example to 127.0.0.1,
        // but it cannot forge Host. Real node answers 400 here too.
        for (const path of ['/json', '/json/list', '/json/version', '/nope']) {
            const res = await get(port, path, [], 'evil.example');
            strictEqual(res.status, 400, `${path} with a DNS Host must be 400`);
        }
    });
});

Deno.test({ name: 'cdp endpoint: IP-literal and localhost Hosts are accepted', timeout: 20_000 }, async () => {
    await withEndpoint(async ({ port }) => {
        for (const host of [`${HOST}:${port}`, `localhost:${port}`, '[::1]', HOST]) {
            const res = await get(port, '/json/version', [], host);
            strictEqual(res.status, 200, `Host ${host} must be accepted, got ${res.status}`);
        }
    });
});

Deno.test({ name: 'cdp endpoint: malformed IP literals and ports are rejected', timeout: 20_000 }, async () => {
    await withEndpoint(async ({ port }) => {
        for (const host of [
            '999.999.999.999',
            '127.0.0.256',
            '[not-an-ip]',
            '[12345::1]',
            '127.0.0.1:not-a-port',
            '127.0.0.1:65536',
            // The bracketed forms below all parsed as a valid IPv6 host under the cno
            // URL polyfill (real node throws on every one), so the old URL-round-trip
            // isIpv6Literal accepted them and the rebinding guard was bypassable.
            '[g::1]',
            '[]',
            '[1:::2]',
            '[::1::2]',
            '[1:2:3:4:5:6:7:8:9]',
            '[1:2:3:4:5:6:7]',
            '[fe80::1%25eth0]',
            '[::ffff:999.1.1.1]',
            '[1.2.3.4]',
        ]) {
            const res = await get(port, '/json/version', [], host);
            strictEqual(res.status, 400, `malformed Host ${host} must be rejected, got ${res.status}`);
        }
    });
});

Deno.test({ name: 'cdp endpoint: valid IPv6 Host forms are still accepted', timeout: 20_000 }, async () => {
    await withEndpoint(async ({ port }) => {
        // Guards the opposite direction: a hand-written IPv6 validator must not
        // reject compression, the IPv4-mapped tail, or a bracketed host:port.
        for (const host of ['[::1]', '[::]', '[1:2:3:4:5:6:7:8]', '[::ffff:1.2.3.4]', '[2001:db8::1]', `[::1]:${port}`]) {
            const res = await get(port, '/json/version', [], host);
            strictEqual(res.status, 200, `valid Host ${host} must be accepted, got ${res.status}`);
        }
    });
});

Deno.test({ name: 'cdp endpoint: a duplicated Host fails closed', timeout: 20_000 }, async () => {
    await withEndpoint(async ({ port }) => {
        // The H1 parser rejects a duplicate Content-Length but not a duplicate Host.
        // A last-wins map lookup would read only one of these and let a rebound
        // origin through, so EVERY occurrence has to pass.
        const sane = await raw(port, [
            'GET /json/version HTTP/1.1',
            `Host: ${HOST}:${port}`,
            'Connection: close',
        ]);
        strictEqual(sane.status, 200, 'a single valid Host must still work');

        const evilFirst = await raw(port, [
            'GET /json/version HTTP/1.1',
            'Host: evil.example',
            `Host: ${HOST}:${port}`,
            'Connection: close',
        ]);
        strictEqual(evilFirst.status, 400, 'evil.example + 127.0.0.1 must be rejected');

        const evilLast = await raw(port, [
            'GET /json/version HTTP/1.1',
            `Host: ${HOST}:${port}`,
            'Host: evil.example',
            'Connection: close',
        ]);
        strictEqual(evilLast.status, 400, '127.0.0.1 + evil.example must be rejected');
    });
});

Deno.test({ name: 'cdp endpoint: unknown paths 404 and leak no token', timeout: 20_000 }, async () => {
    await withEndpoint(async ({ port, handle }) => {
        const token = new URL(handle.wsUrl).searchParams.get('token') ?? '';
        const res = await get(port, '/not-a-route');
        strictEqual(res.status, 404);
        ok(!res.body.includes(token), 'a 404 must not carry the token');
    });
});

Deno.test({ name: 'cdp endpoint: ws upgrade without a token is refused', timeout: 20_000 }, async () => {
    await withEndpoint(async ({ port, handle }) => {
        const wsPath = new URL(handle.wsUrl).pathname;
        const res = await raw(port, upgradeLines(port, wsPath));
        strictEqual(res.status, 403, 'a tokenless upgrade must be refused');
    });
});

Deno.test({ name: 'cdp endpoint: ws upgrade with a wrong token is refused', timeout: 20_000 }, async () => {
    await withEndpoint(async ({ port, handle }) => {
        const url = new URL(handle.wsUrl);
        const token = url.searchParams.get('token') ?? '';
        // Same length as the real token, so this exercises the comparison itself and
        // not the length short-circuit in safeEqual.
        const wrong = token.replace(/[0-9a-f]/, (c) => (c === 'a' ? 'b' : 'a'));
        strictEqual(wrong.length, token.length);
        const res = await raw(port, upgradeLines(port, `${url.pathname}?token=${wrong}`));
        strictEqual(res.status, 403);
    });
});

Deno.test({ name: 'cdp endpoint: cross-origin ws upgrade is refused even with the token', timeout: 20_000 }, async () => {
    await withEndpoint(async ({ port, handle }) => {
        const url = new URL(handle.wsUrl);
        // A DevTools frontend sends no Origin; a page driven by an attacker always
        // does. Driving the debugger is arbitrary code execution, so reject it.
        const res = await raw(
            port,
            upgradeLines(port, `${url.pathname}${url.search}`, ['Origin: http://evil.example']),
        );
        strictEqual(res.status, 403);
    });
});

Deno.test({ name: 'cdp endpoint: a valid token upgrades and reaches onConnect', timeout: 20_000 }, async () => {
    await withEndpoint(async (ep) => {
        const url = new URL(ep.handle.wsUrl);
        const res = await raw(ep.port, upgradeLines(ep.port, `${url.pathname}${url.search}`));
        strictEqual(res.status, 101, `an authenticated same-origin upgrade must switch protocols, got ${res.status}`);
        ok(res.head.includes('sec-websocket-accept'), 'a 101 must carry Sec-WebSocket-Accept');
    });
});

Deno.test({ name: 'cdp endpoint: an unauthenticated local process can reach code execution', timeout: 20_000 }, async () => {
    await withEndpoint(async (ep) => {
        // This test exists to PIN the auth posture, not to assert it is good.
        //
        // It walks the entire chain a local process with no credentials can walk:
        //   1. GET /json  (no token, no Origin, nothing) -> 200 with the ws URL
        //   2. read the token straight out of webSocketDebuggerUrl
        //   3. replay it on the ws upgrade -> 101, i.e. a live CDP session
        // A CDP session is arbitrary code execution in the process, and `--allow-*`
        // is bookkeeping only, so there is no second layer behind this.
        //
        // The token therefore authenticates NOTHING against a local process; it only
        // forces one extra HTTP request. This matches real node, which has no token
        // at all (MEASURED: node v24.18 /json/list with no credentials -> 200), so
        // this is a deliberate parity choice, not an oversight. The real boundary is
        // the loopback bind plus the Host and Origin checks, which stop a *remote* or
        // *browser-driven* attacker but by design not a local one.
        const discovery = await get(ep.port, '/json');
        strictEqual(discovery.status, 200, 'discovery is reachable with no credentials');
        const entry = (JSON.parse(discovery.body) as Array<Record<string, string>>)[0];
        if (!entry) throw new Error('discovery listed no target');

        const stolen = new URL(entry.webSocketDebuggerUrl!);
        const token = stolen.searchParams.get('token');
        if (token === null || token.length === 0) throw new Error('expected a token to steal');

        const res = await raw(ep.port, upgradeLines(ep.port, `${stolen.pathname}${stolen.search}`));
        strictEqual(res.status, 101, 'a token read from open discovery is accepted on the upgrade');
        strictEqual(ep.connections, 1, 'and it reaches the CDP wiring, i.e. code execution');
    });
});

Deno.test({ name: 'cdp endpoint: the ws path alone is not sufficient without the token', timeout: 20_000 }, async () => {
    await withEndpoint(async (ep) => {
        // The one thing the token does buy over node: guessing/leaking the path is
        // not enough. Node's path UUID is its only secret, so a path leak there is
        // full compromise; here the token is still required.
        const url = new URL(ep.handle.wsUrl);
        const res = await raw(ep.port, upgradeLines(ep.port, url.pathname));
        strictEqual(res.status, 403);
        strictEqual(ep.connections, 0, 'no CDP session may be established');
    });
});

Deno.test({ name: 'cdp endpoint: /json/version carries a usable ws URL', timeout: 20_000 }, async () => {
    await withEndpoint(async (ep) => {
        // /json/version is the endpoint whose token gate was unsatisfiable: it is how
        // a client learns the ws URL, so requiring the token to read it meant nothing
        // could ever attach. Prove the URL it serves actually works.
        const version = JSON.parse((await get(ep.port, '/json/version')).body) as Record<string, string>;
        const wsUrl = version.webSocketDebuggerUrl;
        if (!wsUrl) throw new Error('/json/version must carry webSocketDebuggerUrl');
        const url = new URL(wsUrl);
        const res = await raw(ep.port, upgradeLines(ep.port, `${url.pathname}${url.search}`));
        strictEqual(res.status, 101, 'the URL advertised by /json/version must be attachable');
        strictEqual(ep.connections, 1);
    });
});

Deno.test({ name: 'cdp endpoint: devtoolsFrontendUrl ws param is what DevTools will dial', timeout: 20_000 }, async () => {
    await withEndpoint(async (ep) => {
        // Closes the loop on the frontend-URL gap: extract `ws=` exactly as the
        // DevTools frontend does, dial it, and require a 101. A test that only checks
        // the token substring would still pass if the nested `?token=` were mangled
        // into the wrong parameter.
        const entry = (JSON.parse((await get(ep.port, '/json')).body) as Array<Record<string, string>>)[0];
        if (!entry) throw new Error('discovery listed no target');
        const wsParam = new URL(entry.devtoolsFrontendUrl!.replace(/^devtools:\/\//, 'https://')).searchParams.get('ws');
        if (wsParam === null) throw new Error('devtoolsFrontendUrl must carry a ws param');

        // DevTools prefixes the scheme and dials this verbatim.
        const dialed = new URL(`ws://${wsParam}`);
        strictEqual(dialed.host, `${HOST}:${ep.port}`, 'the ws param must name this endpoint');
        const res = await raw(ep.port, upgradeLines(ep.port, `${dialed.pathname}${dialed.search}`));
        strictEqual(res.status, 101, 'the ws param from devtoolsFrontendUrl must upgrade');
        strictEqual(ep.connections, 1, 'a DevTools frontend can actually attach');
    });
});

