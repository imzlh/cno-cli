/**
 * `fetch(url, { client })` must honour the client, or throw.
 *
 * The option used to be dropped silently: `Request` does not retain unknown init
 * keys, and `setRequestClient` — the function that hands the client to
 * performFetch — was exported but never called anywhere in the tree. The receiving
 * half (`applyClientToCurl`, which sets the curl proxy, CA bundle, cert and key)
 * was already written and correct; nothing ever fed it. So every caller that
 * configured a proxy, pinned a CA, or supplied a client certificate got an ordinary
 * default connection and no signal that its configuration had been discarded. For
 * proxy routing, CA pinning and mTLS that is a silent security downgrade.
 *
 * Contract measured against Deno 2.9.3 (/c/Windows/deno.exe):
 *   fetch(url, { client: {} })           -> TypeError: Failed to construct 'Request':
 *                                           Argument 2 `client` must be a Deno.HttpClient
 *   fetch(url, { client: 42 | 'str' })   -> same TypeError (duck-typing refused)
 *   fetch(url, { client: null })         -> accepted, means "no client"
 *   fetch(url, { client: undefined })    -> accepted, means "no client"
 *   fetch(new Request(url, {client}))    -> client survives, request is proxied
 *   createHttpClient({ cert } alone)     -> TypeError (key required, and vice versa)
 *   createHttpClient({ proxy: 'bogus' }) -> URIError: relative URL without a base
 *   createHttpClient({ proxy: {} })      -> TypeError: missing field `url`
 *   createHttpClient({caCerts:['junk']}) -> accepted; not validated at construction
 *   using a closed client               -> BadResource: Bad resource ID
 *
 * These tests deliberately use the GLOBAL `fetch` and `Deno.createHttpClient`, both
 * baked into the binary. Importing perform.ts from disk does not work: disk-loaded
 * fetch dies with `TypeError: Illegal invocation` inside performFetch's
 * `signal.addEventListener`, because a disk-created AbortSignal is not the baked
 * EventTarget the C layer accepts. That reproduces on the UNPATCHED perform.ts with
 * no client involved, so it is the disk/baked boundary, not this feature.
 *
 * Consequence: these tests require a rebuild to pass. Against a binary predating
 * the fix they fail by observing the request arrive at the ORIGIN instead of the
 * PROXY — i.e. they witness the silent drop directly.
 */

import { ok, rejects, strictEqual, throws } from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';

interface ListeningServer { server: Server; port: number; }

async function listen(handler: (socket: Socket) => void): Promise<ListeningServer | null> {
    const server = createServer(handler);
    try {
        await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    } catch (error) {
        if (String(error).includes('EPERM') || String(error).includes('operation not permitted')) return null;
        throw error;
    }
    return { server, port: (server.address() as { port: number }).port };
}

function closeServer(server: Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

/** Records the request line of anything that reaches it, then answers `body`. */
function recorder(sink: string[], body: string) {
    return (socket: Socket) => {
        let request = '';
        const onData = (chunk: Buffer) => {
            request += chunk.toString('latin1');
            if (!request.includes('\r\n\r\n')) return;
            socket.removeListener('data', onData);
            sink.push(request.split('\r\n')[0] ?? '');
            socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        };
        socket.on('data', onData);
        socket.on('error', () => socket.destroy());
    };
}

/** Respond with 407 until the expected proxy credential is sent. */
function authenticatedProxyRecorder(sink: string[], expected: string) {
    return (socket: Socket) => {
        let request = '';
        const onData = (chunk: Buffer) => {
            request += chunk.toString('latin1');
            if (!request.includes('\r\n\r\n')) return;
            socket.removeListener('data', onData);
            sink.push(request);
            if (request.toLowerCase().includes(`proxy-authorization: ${expected}`.toLowerCase())) {
                socket.end('HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nclient-proxy');
            } else {
                socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            }
        };
        socket.on('data', onData);
        socket.on('error', () => socket.destroy());
    };
}

interface Fixture { origin: ListeningServer; proxy: ListeningServer; originHits: string[]; proxySeen: string[] }

/** Origin + forward proxy on loopback. Arrival at a real socket is the measurement. */
async function startFixture(): Promise<Fixture | null> {
    const originHits: string[] = [];
    const proxySeen: string[] = [];
    const origin = await listen(recorder(originHits, 'origin'));
    if (!origin) return null;
    const proxy = await listen(recorder(proxySeen, 'proxy'));
    if (!proxy) { await closeServer(origin.server); return null; }
    return { origin, proxy, originHits, proxySeen };
}

async function stopFixture(fixture: Fixture): Promise<void> {
    await closeServer(fixture.origin.server);
    await closeServer(fixture.proxy.server);
}

interface KeepAliveFixture {
    server: Server;
    port: number;
    sockets: Socket[];
}

async function startKeepAliveFixture(): Promise<KeepAliveFixture | null> {
    const sockets: Socket[] = [];
    const server = createServer(socket => {
        sockets.push(socket);
        let pending = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            while (true) {
                const headerEnd = pending.indexOf('\r\n\r\n');
                if (headerEnd === -1) return;
                pending = pending.subarray(headerEnd + 4);
                socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok');
            }
        });
        socket.on('error', () => socket.destroy());
    });
    try {
        await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    } catch (error) {
        if (String(error).includes('EPERM') || String(error).includes('operation not permitted')) return null;
        throw error;
    }
    return { server, port: (server.address() as { port: number }).port, sockets };
}

async function stopKeepAliveFixture(fixture: KeepAliveFixture): Promise<void> {
    for (const socket of fixture.sockets) socket.destroy();
    await closeServer(fixture.server);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

Deno.test({ name: 'fetch client: a client proxy is applied, so traffic arrives at the proxy not the origin', timeout: 20000 }, async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const { origin, proxy, originHits, proxySeen } = fixture;
    const client = Deno.createHttpClient({ proxy: { url: `http://127.0.0.1:${proxy.port}` } });
    try {
        const response = await fetch(`http://127.0.0.1:${origin.port}/via-proxy`, { client } as RequestInit);
        const body = await response.text();

        // Before the fix: proxySeen=0, originHits=1 — the client was dropped and the
        // request went straight out. That is the silent downgrade this pins.
        strictEqual(proxySeen.length, 1, `proxy must receive exactly one request, saw ${proxySeen.length}`);
        strictEqual(originHits.length, 0, 'request must NOT bypass the proxy and reach the origin directly');
        ok(proxySeen[0]?.includes(`http://127.0.0.1:${origin.port}/via-proxy`), `proxy must see absolute-form target, saw: ${proxySeen[0]}`);
        strictEqual(body, 'proxy', 'the body must come from the proxy');
    } finally {
        client.close();
        await stopFixture(fixture);
    }
});

Deno.test({ name: 'fetch client: a closed client rejects before contacting the server', timeout: 20000 }, async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const { origin, originHits } = fixture;
    const client = Deno.createHttpClient();
    client.close();
    try {
        await rejects(
            () => fetch(`http://127.0.0.1:${origin.port}/closed-client`, { client } as RequestInit),
            Deno.errors.BadResource,
        );
        strictEqual(originHits.length, 0, 'a closed client must be rejected before opening a connection');
    } finally {
        await stopFixture(fixture);
    }
});

Deno.test({ name: 'fetch client: curl surfaces a real proxy transport failure', timeout: 20000 }, async () => {
    let proxyHits = 0;
    const proxy = await listen(socket => {
        proxyHits++;
        socket.destroy();
    });
    if (!proxy) return;
    const client = Deno.createHttpClient({ proxy: { url: `http://127.0.0.1:${proxy.port}` } });
    const previousNoProxy = Deno.env.get('NO_PROXY');
    const previousNoProxyLower = Deno.env.get('no_proxy');
    try {
        Deno.env.set('NO_PROXY', '');
        Deno.env.set('no_proxy', '');
        await rejects(() => fetch('http://example.invalid/proxy-failure', { client } as RequestInit));
        strictEqual(proxyHits, 1, 'the request must reach the configured proxy before failing');
    } finally {
        client.close();
        if (previousNoProxy === undefined) Deno.env.delete('NO_PROXY');
        else Deno.env.set('NO_PROXY', previousNoProxy);
        if (previousNoProxyLower === undefined) Deno.env.delete('no_proxy');
        else Deno.env.set('no_proxy', previousNoProxyLower);
        await closeServer(proxy.server);
    }
});

Deno.test({ name: 'fetch client: poolIdleTimeout closes idle keep-alive sockets', timeout: 20000 }, async () => {
    const fixture = await startKeepAliveFixture();
    if (!fixture) return;
    const client = Deno.createHttpClient({ http2: false, poolIdleTimeout: 20 });
    try {
        const url = `http://127.0.0.1:${fixture.port}/idle-timeout`;
        strictEqual(await (await fetch(url, { client } as RequestInit)).text(), 'ok');
        strictEqual(fixture.sockets.length, 1);
        await waitFor(() => fixture.sockets[0]?.destroyed === true, 'poolIdleTimeout to close the idle socket');

        strictEqual(await (await fetch(url, { client } as RequestInit)).text(), 'ok');
        strictEqual(fixture.sockets.length, 2, 'the next request must establish a new connection');
    } finally {
        client.close();
        await stopKeepAliveFixture(fixture);
    }
});

Deno.test({ name: 'fetch client: custom proxy credentials replace system proxy credentials', timeout: 60000 }, async () => {
    const systemRequests: string[] = [];
    const clientRequests: string[] = [];
    const clientAuth = Buffer.from('client-user:client-pass').toString('base64');
    const systemAuth = Buffer.from('system-user:system-pass').toString('base64');
    const systemProxy = await listen(recorder(systemRequests, 'system-proxy'));
    if (!systemProxy) return;
    const clientProxy = await listen(authenticatedProxyRecorder(clientRequests, `Basic ${clientAuth}`));
    if (!clientProxy) { await closeServer(systemProxy.server); return; }

    const tempDir = await Deno.makeTempDir({ prefix: 'cno-client-proxy-' });
    const script = `${tempDir}/client-proxy.mjs`;
    await Deno.writeTextFile(script, [
        `const client = Deno.createHttpClient({`,
        `  proxy: {`,
        `    url: ${JSON.stringify(`http://127.0.0.1:${clientProxy.port}`)},`,
        `    basicAuth: { username: 'client-user', password: 'client-pass' },`,
        `  },`,
        `});`,
        `try {`,
        `  const response = await fetch('http://example.invalid/through-client', { client });`,
        `  if (response.status !== 200 || await response.text() !== 'client-proxy') throw new Error('client proxy was not used');`,
        `  console.log('REACHED END');`,
        `} finally { client.close(); }`,
    ].join('\n'));
    try {
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['--system-proxy', 'run', script],
            env: {
                HTTP_PROXY: `http://system-user:system-pass@127.0.0.1:${systemProxy.port}`,
                http_proxy: `http://system-user:system-pass@127.0.0.1:${systemProxy.port}`,
                HTTPS_PROXY: '',
                https_proxy: '',
                ALL_PROXY: '',
                all_proxy: '',
                NO_PROXY: '',
                no_proxy: '',
            },
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const stdout = new TextDecoder().decode(output.stdout);
        ok(stdout.includes('REACHED END'), `child did not finish: ${stdout}`);
        strictEqual(systemRequests.length, 0, 'a custom HttpClient proxy must replace the system proxy');
        ok(clientRequests.some(request => request.toLowerCase().includes(`proxy-authorization: basic ${clientAuth}`.toLowerCase())),
            'the custom proxy must receive its own credentials');
        ok(clientRequests.every(request => !request.toLowerCase().includes(`proxy-authorization: basic ${systemAuth}`.toLowerCase())),
            'system proxy credentials must never reach the custom proxy');
    } finally {
        await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
        await Promise.all([closeServer(systemProxy.server), closeServer(clientProxy.server)]);
    }
});

Deno.test({ name: 'fetch client: without a client the request goes direct (control)', timeout: 20000 }, async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const { origin, originHits, proxySeen } = fixture;
    try {
        strictEqual(await (await fetch(`http://127.0.0.1:${origin.port}/direct`)).text(), 'origin');
        strictEqual(originHits.length, 1, 'control: request must reach the origin');
        strictEqual(proxySeen.length, 0, 'control: the proxy must be untouched');
    } finally {
        await stopFixture(fixture);
    }
});

Deno.test({ name: 'fetch client: a non-HttpClient client throws TypeError, never silently ignored', timeout: 20000 }, async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const { origin, originHits } = fixture;
    try {
        const url = `http://127.0.0.1:${origin.port}/bogus`;
        // Deno 2.9.3 refuses duck-typed objects too, so `{ close(){} }` must fail.
        for (const bogus of [{}, 42, 'str', { close() { /* duck-typed */ } }, true, []]) {
            await rejects(
                () => fetch(url, { client: bogus } as RequestInit),
                (error: unknown) => {
                    ok(error instanceof TypeError, `expected TypeError for ${JSON.stringify(bogus)}, got ${error}`);
                    ok(/must be a Deno\.HttpClient/.test((error as Error).message), `message must name the constraint, got: ${(error as Error).message}`);
                    return true;
                },
                `client=${JSON.stringify(bogus)} must be rejected, not ignored`,
            );
        }
        // A rejected client must abort before anything touches the network.
        strictEqual(originHits.length, 0, 'a bogus client must not produce a connection');
    } finally {
        await stopFixture(fixture);
    }
});

Deno.test({ name: 'fetch client: null and undefined mean "no client" and are accepted', timeout: 20000 }, async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const { origin, originHits } = fixture;
    try {
        const url = `http://127.0.0.1:${origin.port}/nullclient`;
        strictEqual(await (await fetch(url, { client: null } as RequestInit)).text(), 'origin');
        strictEqual(await (await fetch(url, { client: undefined } as RequestInit)).text(), 'origin');
        strictEqual(originHits.length, 2, 'both null and undefined must proceed as if no client was given');
    } finally {
        await stopFixture(fixture);
    }
});

/**
 * REMAINING GAP, deliberately not asserted here.
 *
 * Deno keeps a client attached through `fetch(new Request(url, { client }))` —
 * measured on 2.9.3, the request is still proxied. cno cannot: `request.ts` never
 * reads `init.client` (verified: the only `client` token in that file is the
 * `'about:client'` referrer default), so the client is gone before `fetch` sees the
 * Request, and no change confined to perform.ts can recover it. Making that work
 * requires `request.ts` to validate and retain `init.client` the way Deno's Request
 * constructor does — outside this change's scope.
 *
 * `fetchAsync` does carry a client off an input Request when one is registered, so
 * the plumbing is ready for that change; there is currently no baked way to register
 * one, hence no test.
 */

Deno.test('fetch client: invalid constructor options are rejected eagerly', () => {
    throws(() => Deno.createHttpClient({ cert: 'x' }), TypeError);
    throws(() => Deno.createHttpClient({ key: 'y' }), TypeError);
    throws(() => Deno.createHttpClient({ proxy: {} as { url: string } }), TypeError);
    throws(() => Deno.createHttpClient({ proxy: { url: 'bogus' } }), TypeError);
});
