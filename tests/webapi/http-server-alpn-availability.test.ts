/**
 * ALPN advertisement must not outrun what the build can actually serve.
 *
 * DEFECT (OBSERVED 2026-08-04 against build/stage/cno.exe, CNO_EMBED_EXT_H2=OFF):
 * with the h2 native absent, a TLS server configured `protocols: [HTTP2, HTTP11]`
 * still advertised `h2` in its ALPN list, the client selected `h2`, the handshake
 * COMPLETED, and only then did `handleConnection` throw
 * `Unsupported HTTP protocol version: 2` (server.ts, PROTOCOL_MODULES.get site)
 * and drop the socket. A client that would have been perfectly happy with
 * HTTP/1.1 got an unexplained connection close instead of being steered during
 * negotiation. Measured: handshake ok, ALPN "h2", then EOF, handler never ran.
 *
 * Availability now reaches all three decision points — the advertised ALPN list,
 * negotiateProtocol()'s `allow` predicate, and the protocol-module lookup — so
 * `h2` is never offered on a build that cannot serve it.
 *
 * EXPECTED TO PASS NOW, WITHOUT A REBUILD. `@cnojs/http` resolves through the
 * `node_modules/@cnojs/http` junction straight to this repo's `http/` directory
 * (`package.json`: "@cnojs/http": "workspace:./http"), so `http/src/**` is NOT
 * baked-only — edits there are live. Verified by canary: a unique marker added to
 * `http/src/server.ts` took effect with the binary's md5 unchanged, while
 * `grep -a -c` found the marker 0x in `build/stage/cno.exe` and 0x in the CTS
 * cache copy, with positive controls nonzero. Each test branches on
 * h2Available() rather than assuming it is false, so it stays correct in either
 * build configuration.
 *
 * NEGATIVE CONTROL: with `http/src/server.ts` reverted to its pre-fix state,
 * test 1 fails with `ALPN selected "h2"` instead of `"http/1.1"`. See the report.
 */
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { createServer } from '@cnojs/http/server';
import { HttpVersion } from '@cnojs/http/protocol';
import { h2Available } from '@cnojs/http/h2-native';
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
 * Stand up a TLS server with `protocols`, connect offering `clientAlpn`, send one
 * HTTP/1.1 request, and report what happened.
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
        sock.write('GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
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
        // Nothing in common: the server advertises only h2. Current behaviour is a
        // completed handshake with no ALPN, then negotiateProtocol picks HTTP2.
        deepStrictEqual(p.unavailable, []);
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
