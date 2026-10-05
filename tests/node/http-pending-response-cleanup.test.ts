import { ok, strictEqual } from 'node:assert';
import { createServer, type Server } from 'node:http';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const encode = (value: string) => new TextEncoder().encode(value);

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    return address.port;
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('HTTP connection cleanup timeout');
        await delay(5);
    }
}

async function writeAll(conn: Deno.TcpConn, data: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < data.length) offset += await conn.write(data.subarray(offset));
}

async function readUntil(conn: Deno.TcpConn, marker: string): Promise<string> {
    const buffer = new Uint8Array(65536);
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes(marker)) {
        const count = await conn.read(buffer);
        if (count === null) throw new Error(`connection closed before ${marker}`);
        received += decoder.decode(buffer.subarray(0, count));
    }
    return received;
}

function retainedConnections(server: Server): number {
    const core = Reflect.get(server, '_httpServer');
    return Reflect.get(server, '_httpConnections').size
        + Reflect.get(server, '_httpActiveSockets').size
        + core.connections.size + core.inflight.size;
}

for (const mode of ['GET', 'POST', 'SSE'] as const) {
    Deno.test({ name: `http: disconnect releases an idle ${mode} response`, timeout: 10000 }, async () => {
        let ready = false;
        let responseClosed = false;
        const server = createServer({ requestTimeout: 100, keepAliveTimeout: 100 }, (req, res) => {
            res.once('close', () => { responseClosed = true; });
            if (mode === 'POST') {
                req.resume();
                req.once('end', () => { ready = true; });
            } else if (mode === 'SSE') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write('data: ready\n\n');
                ready = true;
            } else {
                ready = true;
            }
        });
        const port = await listen(server);
        const conn = await Deno.connect({ hostname: '127.0.0.1', port });
        try {
            const request = mode === 'POST'
                ? 'POST / HTTP/1.1\r\nHost: local\r\nContent-Length: 4\r\n\r\nbody'
                : 'GET / HTTP/1.1\r\nHost: local\r\n\r\n';
            await writeAll(conn, encode(request));
            await waitFor(() => ready);
            if (mode === 'SSE') await readUntil(conn, 'data: ready\n\n');
            // The response remains valid after the upload deadline expires.
            await delay(150);
            strictEqual(responseClosed, false);
            conn.close();
            await waitFor(() => responseClosed && retainedConnections(server) === 0);
        } finally {
            try { conn.close(); } catch { /* already closed */ }
            await close(server);
        }
    });
}

Deno.test({ name: 'http: disconnect releases core tracking despite an unresolved async handler', timeout: 10000 }, async () => {
    let ready = false;
    const server = createServer(() => {
        ready = true;
        return new Promise<void>(() => {});
    });
    const port = await listen(server);
    const conn = await Deno.connect({ hostname: '127.0.0.1', port });
    try {
        await writeAll(conn, encode('GET / HTTP/1.1\r\nHost: local\r\n\r\n'));
        await waitFor(() => ready);
        conn.close();
        await waitFor(() => retainedConnections(server) === 0);
    } finally {
        try { conn.close(); } catch { /* already closed */ }
        await close(server);
    }
});

Deno.test({ name: 'http: response read-ahead preserves a pipelined upload with bounded buffering', timeout: 10000 }, async () => {
    let releaseFirst: (() => void) | undefined;
    let uploaded = 0;
    let sum = 0;
    const server = createServer((req, res) => {
        if (req.url === '/first') {
            releaseFirst = () => res.end('FIRST');
            return;
        }
        req.on('data', (data: Uint8Array) => {
            uploaded += data.byteLength;
            for (const byte of data) sum += byte;
        });
        req.once('end', () => res.end('SECOND'));
    });
    const port = await listen(server);
    const conn = await Deno.connect({ hostname: '127.0.0.1', port });
    let send: Promise<void> | undefined;
    try {
        await writeAll(conn, encode('GET /first HTTP/1.1\r\nHost: local\r\n\r\n'));
        await waitFor(() => !!releaseFirst);
        const size = 2 * 1024 * 1024;
        await writeAll(conn, encode(`POST /second HTTP/1.1\r\nHost: local\r\nContent-Length: ${size}\r\nConnection: close\r\n\r\n`));
        send = writeAll(conn, new Uint8Array(size).fill(65));
        send.catch(() => {});
        await delay(100);
        const core = Reflect.get(server, '_httpServer');
        const connection = [...core.connections][0];
        ok(connection.pendingInput?.byteLength <= 128 * 1024,
            `pipelined read-ahead retained ${connection.pendingInput?.byteLength} bytes`);
        releaseFirst!();
        await send;
        const received = await readUntil(conn, 'SECOND');
        ok(received.includes('FIRST'), received);
        strictEqual(uploaded, size);
        strictEqual(sum, size * 65);
    } finally {
        try { conn.close(); } catch { /* already closed */ }
        await send?.catch(() => {});
        await close(server);
    }
});
