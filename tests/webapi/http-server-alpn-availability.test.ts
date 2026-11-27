/** ALPN advertisement and dispatch must match the protocols available in this build. */
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { createServer } from '@cnojs/http/server';
import { HttpVersion } from '@cnojs/http/protocol';
import { h2Available } from '@cnojs/http/h2-native';
import * as http2 from 'node:http2';
import * as tls from 'node:tls';

const ssl = import.meta.use('ssl');

type Outcome =
    | { kind: 'bytes'; text: string }
    | { kind: 'eof' }
    | { kind: 'reset'; message: string }
    | { kind: 'timeout' };

/** One bounded read. Never hangs; distinguishes a drop from a real response. */
function readOnce(sock: tls.TLSSocket, ms: number): Promise<Outcome> {
    return new Promise(resolve => {
        let done = false;
        const finish = (o: Outcome) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(o);
        };
        const timer = setTimeout(() => finish({ kind: 'timeout' }), ms);
        sock.once('data', (d: Buffer) => finish({ kind: 'bytes', text: d.toString('latin1') }));
        sock.once('end', () => finish({ kind: 'eof' }));
        sock.once('close', () => finish({ kind: 'eof' }));
        sock.once('error', (e: Error) => finish({ kind: 'reset', message: e.message }));
    });
}

interface Probe {
    alpn: string | null;
    outcome: Outcome;
    handlerRan: boolean;
    effective: HttpVersion[];
    unavailable: HttpVersion[];
}

/**
 * Stand up a TLS server with `protocols`, connect offering `clientAlpn`, send the
 * matching protocol preface, and report negotiation/dispatch state.
 */
async function probe(protocols: HttpVersion[], clientAlpn: string[]): Promise<Probe> {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    let handlerRan = false;
    const server = createServer(async (_req, res) => {
        handlerRan = true;
        await res.writeHead(200, 'OK', [['content-type', 'text/plain']]);
        await res.end('alpn-ok');
    }, { hostname: '127.0.0.1', port: 0, cert, key, protocols });

    server.listen();
    await server.acceptLoop();
    const addr = server.address();
    ok(addr && 'port' in addr, 'server has a port');
    const port = (addr as { port: number }).port;

    try {
        const sock = tls.connect({
            host: '127.0.0.1', port,
            rejectUnauthorized: false,
            ALPNProtocols: clientAlpn,
        });
        const hs = await new Promise<{ ok: boolean; err?: string }>(resolve => {
            const t = setTimeout(() => resolve({ ok: false, err: 'handshake timeout' }), 10000);
            sock.once('secureConnect', () => { clearTimeout(t); resolve({ ok: true }); });
            sock.once('error', (e: Error) => { clearTimeout(t); resolve({ ok: false, err: e.message }); });
        });
        ok(hs.ok, `TLS handshake failed: ${hs.err}`);

        const raw = (sock as unknown as { alpnProtocol: string | false | null }).alpnProtocol;
        const alpn = raw === false || raw === undefined ? null : raw;
        if (alpn === 'h2') {
            sock.write(Buffer.concat([
                Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'),
                Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0]),
            ]));
        } else {
            sock.write('GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
        }
        const outcome = await readOnce(sock, 6000);
        try { sock.destroy(); } catch { /* peer may already be gone */ }
        return {
            alpn, outcome, handlerRan,
            effective: server.effectiveProtocols,
            unavailable: server.unavailableProtocols,
        };
    } finally {
        await server.shutdown();
    }
}

Deno.test({
    name: 'ALPN: a server never advertises a protocol this build cannot serve',
    timeout: 30000,
}, async () => {
    const p = await probe([HttpVersion.HTTP2, HttpVersion.HTTP11], ['h2', 'http/1.1']);

    if (h2Available()) {
        // Complete build: h2 is preferred and nothing is dropped.
        strictEqual(p.alpn, 'h2', 'a build with the native must still select h2');
        deepStrictEqual(p.unavailable, [], 'nothing is unavailable on a complete build');
        strictEqual(p.outcome.kind, 'bytes');
        if (p.outcome.kind === 'bytes') strictEqual(p.outcome.text.charCodeAt(3), 4, 'server SETTINGS');
    } else {
        // THE DEFECT. Advertising h2 here steered the client into a protocol we
        // cannot serve; it must not be offered at all.
        strictEqual(p.alpn, 'http/1.1',
            `h2 must not be advertised without the native (got ${JSON.stringify(p.alpn)})`);
        deepStrictEqual(p.effective, [HttpVersion.HTTP11], 'only H1 is servable');
        deepStrictEqual(p.unavailable, [HttpVersion.HTTP2], 'H2 is reported unavailable');
        // And the connection must actually WORK, not merely negotiate politely.
        strictEqual(p.outcome.kind, 'bytes',
            `expected an HTTP/1.1 response, got ${p.outcome.kind}`);
        ok(/^HTTP\/1\.1 200 /.test((p.outcome as { text: string }).text),
            `expected 200, got ${(p.outcome as { text: string }).text.slice(0, 40)}`);
        strictEqual(p.handlerRan, true, 'the request handler must run');
    }
});

Deno.test({
    name: 'ALPN: negotiated h2 dispatches a request to the handler',
    ignore: !h2Available(),
    timeout: 20000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    let handlerCalls = 0;
    const server = createServer(async (_request, response) => {
        handlerCalls++;
        await response.end('h2-handler-ok');
    }, {
        hostname: '127.0.0.1', port: 0, cert, key, protocols: [HttpVersion.HTTP2],
    });
    let session: http2.ClientHttp2Session | undefined;
    try {
        server.listen();
        await server.acceptLoop();
        const address = server.address();
        ok(address && 'port' in address);
        const client = http2.connect(`https://127.0.0.1:${address.port}`, {
            rejectUnauthorized: false,
            ALPNProtocols: ['h2'],
        });
        session = client;
        await new Promise<void>((resolve, reject) => {
            client.once('connect', resolve);
            client.once('error', reject);
        });
        strictEqual(client.alpnProtocol, 'h2');

        const request = client.request({ ':method': 'GET', ':path': '/alpn-dispatch' });
        let status: unknown;
        const chunks: Buffer[] = [];
        const responseDone = new Promise<void>((resolve, reject) => {
            request.once('response', headers => { status = headers[':status']; });
            request.on('data', chunk => chunks.push(chunk));
            request.once('error', reject);
            request.once('end', resolve);
        });
        await responseDone;
        strictEqual(String(status), '200');
        strictEqual(Buffer.concat(chunks).toString(), 'h2-handler-ok');
        strictEqual(handlerCalls, 1);
    } finally {
        session?.destroy();
        await server.shutdown();
    }
});

Deno.test({
    name: 'ALPN: an h2-only TLS server on a build without h2 fails closed, not mid-connection',
    timeout: 30000,
}, async () => {
    // Filtering the advertised list is not enough on its own: with protocols=[H2]
    // the filtered list is EMPTY, so no ALPN extension is sent, so
    // negotiateProtocol() runs with undefined — and its no-ALPN fallback used to
    // return HTTP2 regardless and throw after the handshake. Availability has to
    // reach negotiation too, which is what this asserts.
    const p = await probe([HttpVersion.HTTP2], ['h2', 'http/1.1']);

    if (h2Available()) {
        strictEqual(p.alpn, 'h2');
        deepStrictEqual(p.unavailable, []);
    } else {
        deepStrictEqual(p.effective, [], 'nothing is servable for an h2-only config');
        deepStrictEqual(p.unavailable, [HttpVersion.HTTP2]);
        // Fail closed. It must NOT silently downgrade to HTTP/1.1: the caller
        // asked for h2 exclusively, and answering in H1 would be protocol
        // confusion rather than a graceful fallback.
        ok(p.outcome.kind === 'eof' || p.outcome.kind === 'reset',
            `expected the connection to be dropped, got ${p.outcome.kind}`);
        strictEqual(p.handlerRan, false, 'the handler must never run');
    }
});

Deno.test({
    name: 'ALPN: h2-only server, client offering only http/1.1, is refused without a throw',
    timeout: 30000,
}, async () => {
    const p = await probe([HttpVersion.HTTP2], ['http/1.1']);

    if (h2Available()) {
        deepStrictEqual(p.unavailable, []);
        strictEqual(p.handlerRan, false);
        ok(p.outcome.kind === 'eof' || p.outcome.kind === 'reset', `expected refusal, got ${p.outcome.kind}`);
    } else {
        deepStrictEqual(p.effective, []);
        strictEqual(p.handlerRan, false, 'the handler must never run');
        ok(p.outcome.kind === 'eof' || p.outcome.kind === 'reset',
            `expected the connection to be dropped, got ${p.outcome.kind}`);
    }
});

Deno.test({
    name: 'ALPN: effectiveProtocols/unavailableProtocols agree with h2Available before listen()',
}, () => {
    // The downgrade must be discoverable by the PROGRAM, not just by a reader of a
    // debug log. A caller that wants h2 for a performance or security reason has
    // to be able to detect that it did not get it — and before it starts serving.
    const server = createServer(async () => {}, {
        hostname: '127.0.0.1', port: 0,
        protocols: [HttpVersion.HTTP2, HttpVersion.HTTP11],
    });
    // Deliberately NOT calling listen(): availability is fixed at module load.
    if (h2Available()) {
        deepStrictEqual(server.effectiveProtocols, [HttpVersion.HTTP2, HttpVersion.HTTP11]);
        deepStrictEqual(server.unavailableProtocols, []);
    } else {
        deepStrictEqual(server.effectiveProtocols, [HttpVersion.HTTP11]);
        deepStrictEqual(server.unavailableProtocols, [HttpVersion.HTTP2]);
    }
    // The two must partition the config exactly — no protocol lost, none invented.
    strictEqual(
        server.effectiveProtocols.length + server.unavailableProtocols.length,
        2, 'effective + unavailable must partition config.protocols',
    );
    // H1-only configs are unaffected in every build.
    const h1Only = createServer(async () => {}, {
        hostname: '127.0.0.1', port: 0, protocols: [HttpVersion.HTTP11],
    });
    deepStrictEqual(h1Only.effectiveProtocols, [HttpVersion.HTTP11]);
    deepStrictEqual(h1Only.unavailableProtocols, []);
});
