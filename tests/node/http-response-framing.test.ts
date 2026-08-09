// Regression: the bytes a node:http server puts on the wire must be a valid
// HTTP/1.1 message frame. These cases are invisible to a `fetch`-based test
// because fetch parses one response and discards the rest of the socket -- the
// two defects below are only observable as raw bytes, and the keep-alive one
// corrupts the NEXT response rather than this one.
//
// Defect 1: a zero-length `res.write()` was encoded as a chunked frame. A
// zero-length chunked frame IS the terminator `0\r\n\r\n`, so the peer stopped
// reading there and every later byte was discarded. Measured against node
// v24.18.0: `write('a'); write(''); write('b'); end()` must put "ab" on the
// wire; the defect put "a" plus 11 stray bytes, and on a keep-alive socket the
// stray `0\r\n\r\n` was parsed as the head of the next response.
// Reached in practice by SSE keep-alive pings (`res.write('')`), by any
// Transform/zlib stage that buffers a chunk and returns nothing, and by
// `res.end('')`.
//
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

Deno.test({ name: 'http: a zero-length write() must not terminate the chunked body', timeout: 20000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.write('a');
        res.write('');                 // must be a wire no-op, not `0\r\n\r\n`
        res.write(new Uint8Array(0));  // same, via an empty buffer
        res.write('b');
        res.end();
    });
    const port = await listen(server);
    try {
        const raw = await rawExchange(port, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
        const he = headEnd(raw);
        strictEqual(he > 0, true, 'response must have a header block');
        const head = text(raw.subarray(0, he));
        strictEqual(/transfer-encoding:\s*chunked/i.test(head), true, 'write() without a Content-Length implies chunked');

        const { body, consumed } = dechunk(raw, he);
        // The load-bearing assertion: both real chunks must arrive. The defect
        // delivered only 'a'.
        strictEqual(body, 'ab', 'every non-empty chunk must reach the client');
        // And the frame must end exactly at the end of the response: a stray
        // terminator leaves trailing bytes that desynchronise the socket.
        strictEqual(consumed, raw.length, 'no bytes may follow the terminating chunk');
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'http: end("") must not leave a stray terminator on a keep-alive socket', timeout: 20000 }, async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/first') {
            res.write('a');
            res.end('');   // empty terminal chunk: the defect emitted an extra `0\r\n\r\n`
        } else {
            res.setHeader('Content-Length', '11');
            res.end('SECOND-BODY');
        }
    });
    const port = await listen(server);
    try {
        // Both requests pipelined, so response ordering cannot be blamed on the client.
        const raw = await rawExchange(
            port,
            'GET /first HTTP/1.1\r\nHost: x\r\n\r\n'
            + 'GET /second HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
        );
        const he = headEnd(raw);
        strictEqual(he > 0, true, 'first response must have a header block');
        const { body, consumed } = dechunk(raw, he);
        strictEqual(body, 'a', 'first response body');

        // A conforming client resumes parsing at `consumed`. That must be the
        // start of the second response, not a leftover chunk terminator.
        const rest = text(raw.subarray(consumed));
        strictEqual(
            rest.startsWith('HTTP/1.1'),
            true,
            `second response must start immediately after the first; got ${JSON.stringify(rest.slice(0, 24))}`,
        );
        strictEqual(rest.includes('SECOND-BODY'), true, 'second response body must survive');
    } finally {
        await close(server);
    }
});
