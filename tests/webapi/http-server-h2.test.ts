/**
 * Shared @cnojs/http Server HTTP/2 accept + handler path.
 *
 * COVERAGE WARNING — the TLS h2 round-trip below is gated `ignore: !h2Available()`,
 * and `h2Available()` is false for a BUILD reason, not a platform one:
 * `build/CMakeCache.txt` carries `CNO_EMBED_EXT_H2:BOOL=OFF`, so the native
 * nghttp2 extension was never compiled in. (OBSERVED 2026-08-04: 0 ok / 1
 * skipped.) Re-enable by building with -DCNO_EMBED_EXT_H2=ON; until then the TLS
 * h2 accept + handler path here is UNMEASURED.
 *
 * This file used to report a file-level PASS while executing ZERO tests, which is
 * worse than failing. The GATE test at the bottom therefore runs unconditionally
 * and asserts the Server's fail-closed behaviour, so the file always executes at
 * least one real assertion in either build configuration. Same shape as
 * tests/webapi/quic-native.test.ts — do not add `ignore:` to it.
 */
import { strictEqual, ok } from 'node:assert';
import { createServer } from '@cnojs/http/server';
import { HttpVersion } from '@cnojs/http/protocol';
import { h2Available, tryLoadH2 } from '@cnojs/http/h2-native';
import * as http2 from 'node:http2';

const ssl = import.meta.use('ssl');

function once<T extends unknown[]>(
    emitter: { once(event: string, fn: (...args: T) => void): void },
    event: string,
): Promise<T> {
    return new Promise(resolve => {
        emitter.once(event, (...args: T) => resolve(args));
    });
}

Deno.test({
    name: '@cnojs/http Server: TLS h2 handler GET',
    ignore: !h2Available(),
    timeout: 20000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = createServer(async (req, res) => {
        strictEqual(req.httpVersion, '2.0');
        strictEqual(req.method, 'GET');
        ok(req.url === '/core-h2' || req.url.startsWith('/core-h2'), req.url);
        await res.writeHead(200, 'OK', [['content-type', 'text/plain']]);
        await res.end('core-h2-ok');
    }, {
        hostname: '127.0.0.1',
        port: 0,
        cert,
        key,
        protocols: [HttpVersion.HTTP2, HttpVersion.HTTP11],
    });

    server.listen();
    await server.acceptLoop();
    const addr = server.address();
    ok(addr && 'port' in addr, 'has port');
    const port = (addr as { port: number }).port;

    try {
        const session = http2.connect(`https://127.0.0.1:${port}`, {
            rejectUnauthorized: false,
            ALPNProtocols: ['h2'],
        });
        await once(session, 'connect');

        const req = session.request({
            ':method': 'GET',
            ':path': '/core-h2',
            ':scheme': 'https',
            ':authority': `127.0.0.1:${port}`,
        });

        const chunks: Buffer[] = [];
        const headers = await new Promise<Record<string, string | string[]>>((resolve, reject) => {
            req.on('response', (h: Record<string, string | string[]>) => resolve(h));
            req.on('error', reject);
            req.on('data', (c: Buffer) => chunks.push(c));
        });
        await new Promise<void>((resolve, reject) => {
            req.on('end', () => resolve());
            req.on('error', reject);
            req.on('close', () => resolve());
        });

        strictEqual(String(headers[':status']), '200');
        strictEqual(Buffer.concat(chunks).toString(), 'core-h2-ok');
        session.close();
    } finally {
        await server.shutdown();
    }
});

/* ── GATE: runs in EVERY build configuration ────────────────────────────────
 * Without this test the file reported PASS while executing zero tests whenever
 * CNO_EMBED_EXT_H2=OFF. It drives the real Server accept path with a
 * prior-knowledge h2c preface and asserts the *outcome* differs correctly by
 * build, so it is meaningful with or without the extension.
 * Never add an `ignore:` to it. */

type ReadOutcome =
    | { kind: 'bytes'; bytes: Uint8Array }
    | { kind: 'eof' }
    | { kind: 'reset'; message: string }
    | { kind: 'timeout' };

/** One bounded read. Never hangs, and distinguishes a reset from a clean EOF. */
async function readOnce(conn: Deno.Conn, ms: number): Promise<ReadOutcome> {
    const buf = new Uint8Array(4096);
    let timer: number | undefined;
    const timeout = new Promise<ReadOutcome>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
    });
    const read = (async (): Promise<ReadOutcome> => {
        try {
            const n = await conn.read(buf);
            if (n === null || n === 0) return { kind: 'eof' };
            return { kind: 'bytes', bytes: buf.subarray(0, n) };
        } catch (e) {
            return { kind: 'reset', message: e instanceof Error ? e.message : String(e) };
        }
    })();
    try {
        return await Promise.race([read, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

Deno.test({
    name: '@cnojs/http Server GATE: h2c-only server fails closed when the native is absent',
    timeout: 20000,
}, async () => {
    // The gate must not contradict itself before anything else is claimed.
    strictEqual(h2Available(), tryLoadH2() !== null);

    let handlerRan = false;
    // Cleartext + protocols:[HTTP2] only. negotiateProtocol() picks HTTP2 for a
    // no-ALPN cleartext socket, so the accept path is forced through the h2
    // protocol module with no HTTP/1 fallback available to mask a failure.
    const server = createServer(async (_req, res) => {
        handlerRan = true;
        await res.writeHead(200, 'OK', [['content-type', 'text/plain']]);
        await res.end('h2c-ok');
    }, {
        hostname: '127.0.0.1',
        port: 0,
        protocols: [HttpVersion.HTTP2],
    });

    server.listen();
    await server.acceptLoop();
    const addr = server.address();
    ok(addr && 'port' in addr, 'has port');
    const port = (addr as { port: number }).port;

    let conn: Deno.Conn | null = null;
    try {
        conn = await Deno.connect({ hostname: '127.0.0.1', port });
        // RFC 9113 client connection preface (prior-knowledge h2c).
        await conn.write(new TextEncoder().encode('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'));
        const outcome = await readOnce(conn, 5000);

        if (h2Available()) {
            // With the native linked the server must actually speak h2: the first
            // thing back is its own SETTINGS frame (type 0x04 at byte offset 3).
            strictEqual(outcome.kind, 'bytes', `expected h2 SETTINGS, got ${outcome.kind}`);
            const bytes = (outcome as { bytes: Uint8Array }).bytes;
            ok(bytes.byteLength >= 9, `short frame: ${bytes.byteLength}`);
            strictEqual(bytes[3], 0x04, 'first frame must be SETTINGS');
        } else {
            // Fail closed: the connection is dropped. Anything else would mean the
            // server accepted an h2 connection it cannot serve.
            ok(
                outcome.kind === 'reset' || outcome.kind === 'eof',
                `expected the connection to be dropped, got ${outcome.kind}`,
            );
            strictEqual(handlerRan, false, 'the request handler must never run');
            // Specifically it must NOT silently downgrade to HTTP/1 — a status line
            // here would be a protocol-confusion bug, not a graceful fallback.
            if (outcome.kind === 'bytes') {
                const text = new TextDecoder().decode((outcome as { bytes: Uint8Array }).bytes);
                ok(!/^HTTP\/1\.[01] /.test(text), `silent H1 downgrade: ${text.slice(0, 40)}`);
            }
        }
    } finally {
        try {
            conn?.close();
        } catch {
            /* already reset by the peer */
        }
        await server.shutdown();
    }
});
