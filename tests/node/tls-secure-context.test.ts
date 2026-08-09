/**
 * `secureContext` must actually take effect, and the https Agent merge must not
 * be erased by present-but-undefined per-request options.
 *
 * Both defects were measured against Node v24.18.0 on the same machine:
 *
 *  1. `tls.connect` built its own SecureContext and never read
 *     `options.secureContext`, so everything the caller configured through
 *     `tls.createSecureContext()` was discarded. The verification half failed
 *     closed (a correct private CA reported UNABLE_TO_GET_ISSUER_CERT_LOCALLY
 *     where Node connected), but the version half failed OPEN: a client pinned
 *     to TLSv1.3 through a secureContext completed a TLSv1.2 handshake, while
 *     Node refuses with ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION. That is a silent
 *     protocol downgrade, which is why the pin test below is the important one.
 *
 *  2. `https.Agent.createConnection` merged with `{ ...agentOptions, ...options }`.
 *     Object spread copies keys whose value is `undefined`, so a per-request
 *     option that was merely *present* erased the agent's value. `got` always
 *     sends a full option bag with ca/cert/key/minVersion present and undefined,
 *     so `got(url, { agent: { https: new https.Agent({ ca }) } })` lost the CA.
 *
 * Every case here pairs with the positive control in the first test: a probe
 * where nothing can connect at all is indistinguishable from one where
 * everything is correctly refused, so the control has to stay.
 */
import { strictEqual, ok } from 'node:assert';
import * as tls from 'node:tls';
import * as https from 'node:https';

const ssl = import.meta.use('ssl');

/** A self-signed cert doubles as its own trust anchor when passed as `ca`. */
function certPair(): { cert: string; key: string } {
    return ssl.createSelfSignedCert({ commonName: 'localhost', days: 2 });
}

/**
 * A microtask enqueued from a handle-close callback is currently invisible to
 * libuv's aliveness test, so awaiting anything after `server.close()` can
 * abandon the rest of the test. Hold the loop open across the close.
 */
async function closeServer(server: { close: (cb?: () => void) => unknown }): Promise<void> {
    const keepalive = setTimeout(() => {}, 80);
    await new Promise<void>((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
    });
    clearTimeout(keepalive);
}

function listen(server: { listen: (p: number, h: string, cb: () => void) => unknown; address: () => unknown; once: (e: string, cb: (err: Error) => void) => unknown }): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') return reject(new Error('no port'));
            resolve((addr as { port: number }).port);
        });
    });
}

type Outcome = { connected: boolean; authorized?: boolean; code?: string; protocol?: string | null };

/** One bounded client attempt. Never throws, never hangs. */
function attempt(opts: Record<string, unknown>, timeoutMs = 8000): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
        let settled = false;
        let sock: tls.TLSSocket | undefined;
        const finish = (o: Outcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { sock?.destroy(); } catch { /* already gone */ }
            resolve(o);
        };
        const timer = setTimeout(() => finish({ connected: false, code: 'TEST_TIMEOUT' }), timeoutMs);
        try {
            sock = tls.connect(opts as never, () => finish({
                connected: true,
                authorized: sock!.authorized,
                protocol: sock!.getProtocol(),
            }));
        } catch (err) {
            return finish({ connected: false, code: (err as { code?: string }).code ?? 'THREW' });
        }
        sock.on('error', (err: Error & { code?: string }) => finish({ connected: false, code: err.code ?? 'NONE' }));
    });
}

// --- 1. positive control + the CA reaching the store only via secureContext ---

Deno.test({ name: 'tls: secureContext supplies the CA (with positive control)', timeout: 30000 }, async () => {
    const { cert, key } = certPair();
    const server = tls.createServer({ cert, key }, (socket) => { socket.end('ok'); });
    server.on('tlsClientError', () => { /* expected for the refusal case */ });
    const port = await listen(server as never);

    try {
        // POSITIVE CONTROL: ca passed the ordinary way must connect. If this
        // fails, nothing below can be trusted to mean anything.
        const control = await attempt({
            port, host: '127.0.0.1', servername: 'localhost',
            ca: cert,
            // Isolate the trust decision from name checking: createSelfSignedCert
            // emits no subjectAltName, so the built-in identity check is not what
            // this test is about.
            checkServerIdentity: () => undefined,
        });
        ok(control.connected, `positive control must connect, got code=${control.code}`);
        strictEqual(control.authorized, true, 'positive control must be authorized');

        // The CA lives ONLY in the secureContext. Before the fix this reported
        // DEPTH_ZERO_SELF_SIGNED_CERT because the context was discarded and the
        // rebuilt one fell back to the platform trust store.
        const viaContext = await attempt({
            port, host: '127.0.0.1', servername: 'localhost',
            checkServerIdentity: () => undefined,
            secureContext: tls.createSecureContext({ ca: cert }),
        });
        ok(viaContext.connected, `secureContext ca must be honoured, got code=${viaContext.code}`);
        strictEqual(viaContext.authorized, true, 'secureContext ca must produce authorized=true');

        // NEGATIVE CONTROL: no trust anchor anywhere still has to be refused.
        // Without this, "the context is honoured" could just mean "verification
        // stopped happening".
        const noTrust = await attempt({ port, host: '127.0.0.1', servername: 'localhost', checkServerIdentity: () => undefined });
        strictEqual(noTrust.connected, false, 'an untrusted self-signed cert must still be refused');
    } finally {
        await closeServer(server as never);
    }
});

// --- 2. the security case: a version pin in a secureContext must take effect --

Deno.test({ name: 'tls: minVersion in a secureContext is not silently ignored', timeout: 30000 }, async () => {
    const { cert, key } = certPair();
    // Server speaks TLSv1.2 at most.
    const server = tls.createServer({ cert, key, maxVersion: 'TLSv1.2' }, (socket) => { socket.end('ok'); });
    server.on('tlsClientError', () => { /* expected: the client refuses the version */ });
    const port = await listen(server as never);

    try {
        // POSITIVE CONTROL: without a pin the handshake succeeds at TLSv1.2, so
        // a refusal below is attributable to the pin and not to a broken server.
        const control = await attempt({ port, host: '127.0.0.1', servername: 'localhost', rejectUnauthorized: false });
        ok(control.connected, `control must connect to the 1.2-only server, got code=${control.code}`);
        strictEqual(control.protocol, 'TLSv1.2', 'control must negotiate TLSv1.2');

        // Pin TLSv1.3 through the secureContext. Node refuses
        // (ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION). Before the fix cno connected
        // over TLSv1.2 with the pin silently dropped.
        const pinned = await attempt({
            port, host: '127.0.0.1', servername: 'localhost',
            rejectUnauthorized: false,
            secureContext: tls.createSecureContext({ minVersion: 'TLSv1.3' }),
        });
        strictEqual(
            pinned.connected,
            false,
            `a TLSv1.3 pin in a secureContext must refuse a TLSv1.2-only server, but connected over ${pinned.protocol}`,
        );
        ok(pinned.code !== 'TEST_TIMEOUT', 'the pinned attempt must be refused, not hang');
    } finally {
        await closeServer(server as never);
    }
});

// --- 3. a maxVersion pin in a secureContext bounds the negotiated protocol ---

Deno.test({ name: 'tls: maxVersion in a secureContext bounds the protocol', timeout: 30000 }, async () => {
    const { cert, key } = certPair();
    const server = tls.createServer({ cert, key, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' }, (socket) => { socket.end('ok'); });
    server.on('tlsClientError', () => {});
    const port = await listen(server as never);

    try {
        // Unpinned: the pair picks TLSv1.3.
        const free = await attempt({ port, host: '127.0.0.1', servername: 'localhost', rejectUnauthorized: false });
        ok(free.connected, `control must connect, got code=${free.code}`);
        strictEqual(free.protocol, 'TLSv1.3', 'unpinned handshake should reach TLSv1.3');

        // Capped at 1.2 through the context: before the fix this still reported
        // TLSv1.3 because the context was thrown away.
        const capped = await attempt({
            port, host: '127.0.0.1', servername: 'localhost',
            rejectUnauthorized: false,
            secureContext: tls.createSecureContext({ maxVersion: 'TLSv1.2' }),
        });
        ok(capped.connected, `capped attempt must still connect, got code=${capped.code}`);
        strictEqual(capped.protocol, 'TLSv1.2', 'a maxVersion pin in a secureContext must bound the protocol');
    } finally {
        await closeServer(server as never);
    }
});

// --- 4. https Agent options survive present-but-undefined request options ----

Deno.test({ name: 'https: an undefined per-request option does not erase the agent value', timeout: 30000 }, async () => {
    const { cert, key } = certPair();
    const server = https.createServer({ cert, key }, (_req, res) => { res.writeHead(200); res.end('agent-ok'); });
    const port = await listen(server as never);

    const request = (opts: Record<string, unknown>): Promise<{ status?: number; body?: string; code?: string }> =>
        new Promise((resolve) => {
            let settled = false;
            const finish = (r: { status?: number; body?: string; code?: string }) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(r);
            };
            const timer = setTimeout(() => finish({ code: 'TEST_TIMEOUT' }), 8000);
            const req = https.request(opts as never);
            req.on('response', (res: { statusCode?: number; resume: () => void; on: (e: string, cb: (c?: unknown) => void) => void; setEncoding: (e: string) => void }) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk?: unknown) => { body += String(chunk); });
                res.on('end', () => finish({ status: res.statusCode, body }));
            });
            req.on('error', (err: Error & { code?: string }) => finish({ code: err.code ?? 'NONE' }));
            req.end();
        });

    try {
        // POSITIVE CONTROL: ca on the agent, nothing conflicting per-request.
        const control = await request({
            host: '127.0.0.1', port, servername: 'localhost', path: '/control',
            agent: new https.Agent({ ca: cert, checkServerIdentity: () => undefined }),
        });
        strictEqual(control.status, 200, `positive control must succeed, got code=${control.code}`);

        // The `got` shape: `ca` present but undefined. Before the fix this
        // clobbered the agent's CA and the request failed with
        // UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
        const undefinedCa = await request({
            host: '127.0.0.1', port, servername: 'localhost', path: '/undef-ca',
            ca: undefined,
            agent: new https.Agent({ ca: cert, checkServerIdentity: () => undefined }),
        });
        strictEqual(undefinedCa.status, 200, `an undefined ca must not erase the agent ca, got code=${undefinedCa.code}`);
        strictEqual(undefinedCa.body, 'agent-ok');

        // Same for rejectUnauthorized, which is the option whose loss silently
        // changes the security decision.
        const undefinedReject = await request({
            host: '127.0.0.1', port, servername: 'localhost', path: '/undef-ru',
            rejectUnauthorized: undefined,
            agent: new https.Agent({ rejectUnauthorized: false }),
        });
        strictEqual(undefinedReject.status, 200, `an undefined rejectUnauthorized must not erase the agent value, got code=${undefinedReject.code}`);

        // NEGATIVE CONTROL: a defined per-request value must still win over the
        // agent, otherwise this fix would have made agent options unoverridable.
        const explicitWins = await request({
            host: '127.0.0.1', port, servername: 'localhost', path: '/explicit',
            ca: undefined, rejectUnauthorized: true,
            agent: new https.Agent({ rejectUnauthorized: false }),
        });
        strictEqual(explicitWins.status, undefined, 'an explicit rejectUnauthorized:true must override the agent and refuse');
        ok(explicitWins.code && explicitWins.code !== 'TEST_TIMEOUT', `expected a refusal code, got ${explicitWins.code}`);
    } finally {
        await closeServer(server as never);
    }
});
