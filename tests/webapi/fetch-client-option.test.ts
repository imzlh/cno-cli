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

import { ok, rejects, strictEqual } from 'node:assert';
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

/**
 * Construction-time validation.
 *
 * Only the "not silent" property is pinned here, because `Deno.createHttpClient`
 * lives in cno/src/deno/07_http.ts, outside this change's scope. Measured
 * divergences from Deno 2.9.3 there, all still OPEN and all measured on the
 * 13:00 binary, for whoever owns that file:
 *
 *   createHttpClient({cert:'x'})           Deno: TypeError (key required)   cno: NO THROW
 *   createHttpClient({key:'y'})            Deno: TypeError (cert required)  cno: NO THROW
 *   createHttpClient({proxy:{}})           Deno: TypeError missing `url`    cno: NO THROW
 *   createHttpClient({proxy:{url:'bogus'}) Deno: URIError at construction   cno: throws later, at getProxyUrl()
 *   createHttpClient({caCerts:['junk']})   Deno: accepted (TLS validates)   cno: THROWS TypeError  <- inverted
 *
 * The cert-without-key case is the same class of defect as the one this file fixes:
 * a client certificate is accepted and then silently not used, so a caller believes
 * it configured mTLS and did not.
 */
Deno.test({ name: 'fetch client: an unusable proxy url is reported, not ignored', timeout: 20000 }, async () => {
    // cno defers URL parsing to getProxyUrl(), so force the lazy path. Either point
    // is acceptable; silence is not.
    const client = Deno.createHttpClient({ proxy: { url: 'bogus' } });
    try {
        await rejects(
            () => fetch('http://127.0.0.1:1/', { client } as RequestInit),
            'a relative proxy url must surface an error somewhere, as Deno 2.9.3 does',
        );
    } finally {
        client.close();
    }
});

console.log('REACHED END');
