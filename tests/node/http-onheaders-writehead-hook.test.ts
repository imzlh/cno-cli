/**
 * The implicit response head must be emitted through the response's own
 * `writeHead` property, and ServerResponse must expose the legacy
 * `_header` / `_implicitHeader` internals.
 *
 * Both are load-bearing for real express middleware:
 *
 *  - `on-headers` (a dependency of `compression`, `morgan` and `serve-static`)
 *    replaces `res.writeHead` and expects its listener to run before the head
 *    goes out. cno used to emit the head from the response adapter's own
 *    writeHead, so the listener never fired. `compression` then never installed
 *    its gzip stream AND never attached the deferred `drain` listener that
 *    pipe() registers, so a piped 100KB file stalled after exactly 16384 bytes
 *    -- a valid-looking truncated body.
 *
 *  - `compression`'s res.write/res.end open-code Node's own guard,
 *    `if (!this._header) { this._implicitHeader(); }`. With `_implicitHeader`
 *    missing that threw "TypeError: not a function" before any head was
 *    emitted, so the client received ZERO bytes and hung until it timed out.
 *
 * Measured against Node v24.18.0 on the same machine, which passes all four
 * assertions. Asserts on body BYTES, not just status.
 */
import { match, ok, strictEqual } from 'node:assert';
import * as http from 'node:http';
import * as net from 'node:net';

/** Collects a whole HTTP/1.1 response off a raw socket (Connection: close). */
function rawGet(port: number, path: string, headers = ''): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1');
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => {
            sock.destroy();
            // Resolve rather than reject: a hang is a real outcome the
            // assertions below must be able to describe.
            resolve(Buffer.concat(chunks));
        }, 10000);
        sock.on('connect', () => {
            sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${headers}\r\n`);
        });
        sock.on('data', (c) => chunks.push(c as Buffer));
        sock.on('error', (e) => { clearTimeout(timer); reject(e); });
        sock.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    });
}

function splitResponse(raw: Buffer): { head: string; body: Buffer } {
    const idx = raw.indexOf('\r\n\r\n');
    if (idx < 0) return { head: raw.toString('latin1'), body: Buffer.alloc(0) };
    return { head: raw.slice(0, idx).toString('latin1'), body: raw.slice(idx + 4) };
}

/** Decodes a chunked body; returns null if the terminator never arrived. */
function dechunk(body: Buffer): Buffer | null {
    const parts: Buffer[] = [];
    let p = 0;
    for (;;) {
        const nl = body.indexOf('\r\n', p, 'latin1');
        if (nl < 0) return null;
        const size = parseInt(body.slice(p, nl).toString('latin1').split(';')[0], 16);
        if (Number.isNaN(size)) return null;
        if (size === 0) return Buffer.concat(parts);
        if (nl + 2 + size > body.length) return null;
        parts.push(body.slice(nl + 2, nl + 2 + size));
        p = nl + 2 + size + 2;
    }
}

Deno.test({
    name: 'http: implicit head runs the response\'s own writeHead, and _header/_implicitHeader exist',
    timeout: 30000,
}, async () => {
    // Body big enough to exceed the 16KB stream watermark, so a swallowed
    // 'drain' listener shows up as a truncated body rather than a pass.
    const PAYLOAD = Buffer.from('x'.repeat(64 * 1024));

    let sawImplicitHeaderType = '';
    let implicitHeaderThrew: string | null = null;
    let headerBeforeWasFalsy = false;
    let headerAfterWasTruthy = false;
    let onHeadersListenerFired = false;

    const server = http.createServer((req, res) => {
        // --- emulate `on-headers`: replace writeHead, expect to be called ---
        const inner = res.writeHead.bind(res);
        (res as unknown as { writeHead: unknown }).writeHead = function patched(
            this: unknown,
            ...args: unknown[]
        ) {
            onHeadersListenerFired = true;
            res.setHeader('X-Hook', 'ran');
            return (inner as (...a: unknown[]) => unknown)(...args);
        };

        // --- emulate `compression`'s guard, exactly as written upstream ---
        const r = res as unknown as { _header?: unknown; _implicitHeader?: () => void };
        sawImplicitHeaderType = typeof r._implicitHeader;
        headerBeforeWasFalsy = !r._header;
        try {
            if (!r._header) { r._implicitHeader!(); }
        } catch (e) {
            implicitHeaderThrew = (e as Error)?.message ?? String(e);
        }
        headerAfterWasTruthy = !!r._header;

        // Write in two pieces so the body crosses a write boundary.
        res.write(PAYLOAD.slice(0, 1024));
        res.end(PAYLOAD.slice(1024));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
        const raw = await rawGet(port, '/hooked');
        const { head, body } = splitResponse(raw);

        strictEqual(
            sawImplicitHeaderType,
            'function',
            'res._implicitHeader must be a function (compression calls it directly)',
        );
        strictEqual(
            implicitHeaderThrew,
            null,
            `res._implicitHeader() must not throw, got: ${implicitHeaderThrew}`,
        );
        ok(headerBeforeWasFalsy, 'res._header must be falsy before the head is emitted');
        ok(headerAfterWasTruthy, 'res._header must be truthy once the head is emitted');

        ok(
            onHeadersListenerFired,
            'a wrapper installed on res.writeHead must run before the head is emitted (on-headers contract)',
        );
        match(head, /^HTTP\/1\.1 200/, `expected 200 status line, got: ${head.slice(0, 80)}`);
        match(head, /x-hook: ran/i, 'header set by the writeHead wrapper must reach the wire');

        // The whole body must arrive: the original defect stalled at 16384.
        const decoded = /transfer-encoding:\s*chunked/i.test(head) ? dechunk(body) : body;
        ok(decoded !== null, 'chunked body must be terminated, not left hanging');
        strictEqual(
            decoded!.length,
            PAYLOAD.length,
            `body must not be truncated: expected ${PAYLOAD.length} bytes, got ${decoded!.length}`,
        );
        ok(decoded!.equals(PAYLOAD), 'body bytes must match exactly');
    } finally {
        server.close();
    }
});
