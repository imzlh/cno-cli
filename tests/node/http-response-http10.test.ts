// Regression: an HTTP/1.0 client must not be sent HTTP/1.1-only framing.
//
// The defect: `Transfer-Encoding: chunked` was sent to an HTTP/1.0 client and the
// status line echoed `HTTP/1.0`. Chunked encoding does not exist in HTTP/1.0, so
// such a client reads the chunk-size lines as body content -- silent corruption
// of every streamed response. RFC 7230 s3.3.1: a server MUST NOT send
// Transfer-Encoding to an HTTP/1.0 client. Node always replies `HTTP/1.1` and
// close-delimits the body instead (measured against node v24.18.0).
//
// Root cause: `cno/src/node/_internal/server-response-adapter.ts`
// (ensureImplicitHeaders) sets `Transfer-Encoding: chunked` whenever there is no
// Content-Length, without consulting the request's HTTP version. That makes the
// version check in `http/src/h1.ts` ("chunked on 1.1, close-delimited otherwise")
// unreachable, because by then the header looks handler-supplied.
import { strictEqual } from 'node:assert';
import * as http from 'node:http';
import * as net from 'node:net';

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') reject(new Error('no port'));
            else resolve(addr.port);
        });
        server.once('error', reject);
    });
}
const close = (s: http.Server): Promise<void> => new Promise((r) => s.close(() => r()));

/** Send raw request bytes, collect the whole reply until the peer closes. */
function rawExchange(port: number, request: string, timeoutMs = 10000): Promise<Uint8Array> {
    return new Promise((resolve) => {
        const chunks: Uint8Array[] = [];
        let settled = false;
        const sock = net.connect(port, '127.0.0.1');
        const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch { /* already gone */ }
            let total = 0;
            for (const c of chunks) total += c.length;
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            resolve(out);
        };
        const timer = setTimeout(finish, timeoutMs);
        sock.on('connect', () => sock.write(request));
        sock.on('data', (d: Uint8Array) => chunks.push(d));
        sock.on('close', finish);
        sock.on('error', finish);
    });
}

const text = (b: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
};

/** Byte offset just past the head, or -1. */
function headEnd(raw: Uint8Array): number {
    const t = text(raw);
    const i = t.indexOf('\r\n\r\n');
    return i < 0 ? -1 : i + 4;
}

/**
 * Decode a chunked body the way a conforming client does, and report how many
 * bytes it consumed. `consumed` is what makes the keep-alive assertion possible:
 * the next response must begin exactly there.
 */
function dechunk(raw: Uint8Array, start: number): { body: string; consumed: number } {
    const t = text(raw);
    let i = start;
    let body = '';
    for (;;) {
        const nl = t.indexOf('\r\n', i);
        if (nl < 0) return { body, consumed: i };
        const size = parseInt(t.slice(i, nl), 16);
        if (!Number.isFinite(size)) return { body, consumed: i };
        i = nl + 2;
        if (size === 0) return { body, consumed: i + 2 };
        body += t.slice(i, i + size);
        i += size + 2;
    }
}

Deno.test({ name: 'http: an HTTP/1.0 client must never receive chunked encoding', timeout: 20000 }, async () => {
    const server = http.createServer((_req, res) => {
        // Streamed body with no Content-Length: on 1.1 this is chunked, but a
        // 1.0 peer cannot parse chunked, so the body must be close-delimited.
        res.write('a');
        res.end('b');
    });
    const port = await listen(server);
    try {
        const raw = await rawExchange(port, 'GET / HTTP/1.0\r\nHost: x\r\n\r\n');
        const he = headEnd(raw);
        strictEqual(he > 0, true, 'response must have a header block');
        const head = text(raw.subarray(0, he));

        strictEqual(
            /transfer-encoding/i.test(head),
            false,
            `no Transfer-Encoding may be sent to an HTTP/1.0 client; head was ${JSON.stringify(head)}`,
        );
        // Node normalises the response version to 1.1 regardless of the request.
        strictEqual(head.startsWith('HTTP/1.1 200'), true, `status line must be HTTP/1.1; got ${JSON.stringify(head.split('\r\n')[0])}`);
        // Close-delimited: the body is exactly the handler's bytes, no framing.
        strictEqual(text(raw.subarray(he)), 'ab', 'body must be the raw bytes with no chunk framing');
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'http: HTTP/1.0 keep-alive must not be granted for an unframed body', timeout: 20000 }, async () => {
    // A 1.0 client asking for keep-alive can only get it if the response is
    // length-delimited. With a streamed body the server must fall back to close,
    // or the client waits forever for an EOF that never comes.
    const server = http.createServer((_req, res) => {
        res.write('a');
        res.end('b');
    });
    const port = await listen(server);
    try {
        const raw = await rawExchange(
            port,
            'GET / HTTP/1.0\r\nHost: x\r\nConnection: keep-alive\r\n\r\n',
            4000,
        );
        const he = headEnd(raw);
        strictEqual(he > 0, true, 'response must have a header block');
        const head = text(raw.subarray(0, he));
        strictEqual(/transfer-encoding/i.test(head), false, 'still no chunked for a 1.0 peer');
        strictEqual(
            /connection:\s*keep-alive/i.test(head),
            false,
            `keep-alive must not be granted for an unframed 1.0 response; head was ${JSON.stringify(head)}`,
        );
        strictEqual(text(raw.subarray(he)), 'ab', 'body must be the raw bytes');
    } finally {
        await close(server);
    }
});
