import { ok, strictEqual } from 'node:assert';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

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
        if (Date.now() >= deadline) throw new Error('request state timeout');
        await delay(5);
    }
}

async function writeAll(conn: Deno.TcpConn, bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) offset += await conn.write(bytes.subarray(offset));
}

async function upload(conn: Deno.TcpConn, size: number): Promise<void> {
    const chunk = new Uint8Array(64 * 1024).fill(65);
    for (let sent = 0; sent < size; sent += chunk.length) {
        await writeAll(conn, chunk.subarray(0, Math.min(chunk.length, size - sent)));
    }
}

async function readAll(conn: Deno.TcpConn): Promise<string> {
    const buffer = new Uint8Array(65536);
    const decoder = new TextDecoder();
    let result = '';
    while (true) {
        const count = await conn.read(buffer);
        if (count === null) return result;
        result += decoder.decode(buffer.subarray(0, count));
    }
}

async function readUntil(conn: Deno.TcpConn, marker: string): Promise<void> {
    const buffer = new Uint8Array(65536);
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes(marker)) {
        const count = await conn.read(buffer);
        if (count === null) throw new Error(`connection closed before ${marker}`);
        received += decoder.decode(buffer.subarray(0, count));
    }
}

Deno.test({ name: 'http: unread upload stays bounded and drains after response for keep-alive', timeout: 15000 }, async () => {
    let incoming: IncomingMessage | undefined;
    let response: ServerResponse | undefined;
    const server = createServer((req, res) => {
        if (req.url === '/second') {
            res.end('SECOND');
            return;
        }
        incoming = req;
        response = res;
    });
    const port = await listen(server);
    const conn = await Deno.connect({ hostname: '127.0.0.1', port });
    let send: Promise<void> | undefined;
    try {
        const size = 4 * 1024 * 1024;
        await writeAll(conn, encode(`POST / HTTP/1.1\r\nHost: local\r\nContent-Length: ${size}\r\n\r\n`));
        send = upload(conn, size);
        send.catch(() => {});
        await waitFor(() => (incoming?.readableLength ?? 0) > 0);
        await delay(150);
        ok(incoming!.readableLength <= 128 * 1024,
            `unread upload grew to ${incoming!.readableLength} bytes`);
        response!.end('FIRST');
        await send;
        await writeAll(conn, encode('GET /second HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n'));
        const received = await readAll(conn);
        ok(received.includes('FIRST') && received.includes('SECOND'), received);
        strictEqual(incoming!.complete, true);
        strictEqual(incoming!.readableLength, 0);
    } finally {
        try { conn.close(); } catch { /* already closed */ }
        await send?.catch(() => {});
        await close(server);
    }
});

Deno.test({ name: 'http: paused upload resumes without losing body bytes', timeout: 15000 }, async () => {
    const size = 2 * 1024 * 1024;
    let consumed = 0;
    let sum = 0;
    let peak = 0;
    let incoming: IncomingMessage | undefined;
    const server = createServer((req, res) => {
        incoming = req;
        req.on('data', (chunk: Uint8Array) => {
            consumed += chunk.length;
            for (const byte of chunk) sum += byte;
            req.pause();
            setTimeout(() => req.resume(), 2);
        });
        req.on('end', () => res.end('COMPLETE'));
    });
    const port = await listen(server);
    const conn = await Deno.connect({ hostname: '127.0.0.1', port });
    const sampler = setInterval(() => { peak = Math.max(peak, incoming?.readableLength ?? 0); }, 1);
    try {
        await writeAll(conn, encode(`POST / HTTP/1.1\r\nHost: local\r\nContent-Length: ${size}\r\nConnection: close\r\n\r\n`));
        await upload(conn, size);
        ok((await readAll(conn)).includes('COMPLETE'));
        strictEqual(consumed, size);
        strictEqual(sum, size * 65);
        ok(peak <= 128 * 1024, `paused upload grew to ${peak} bytes`);
    } finally {
        clearInterval(sampler);
        try { conn.close(); } catch { /* already closed */ }
        await close(server);
    }
});

for (const disconnect of ['request destroy', 'peer close'] as const) {
    Deno.test({ name: `http: ${disconnect} releases a paused request body`, timeout: 10000 }, async () => {
        let incoming: IncomingMessage | undefined;
        let requestClosed = false;
        const server = createServer((req, _res) => {
            incoming = req;
            req.once('close', () => { requestClosed = true; });
        });
        const port = await listen(server);
        const conn = await Deno.connect({ hostname: '127.0.0.1', port });
        try {
            await writeAll(conn, encode('POST / HTTP/1.1\r\nHost: local\r\nContent-Length: 1048576\r\n\r\n'));
            await upload(conn, 128 * 1024);
            await waitFor(() => (incoming?.readableLength ?? 0) > 0);
            if (disconnect === 'request destroy') incoming!.destroy();
            else conn.close();
            await waitFor(() => requestClosed);
            strictEqual(incoming!.aborted, true);
            strictEqual(incoming!.readableLength, 0);
            await waitFor(() => incoming!.socket.destroyed);
        } finally {
            try { conn.close(); } catch { /* already closed */ }
            await close(server);
        }
    });
}

for (const reused of [false, true]) {
    Deno.test({ name: `http: requestTimeout releases a stalled ${reused ? 'keep-alive' : 'first'} upload`, timeout: 10000 }, async () => {
        let incoming: IncomingMessage | undefined;
        let requestClosed = false;
        const server = createServer({ requestTimeout: 350, keepAliveTimeout: 40 }, (req, res) => {
            if (req.url === '/first') { res.end('FIRST'); return; }
            incoming = req;
            req.once('close', () => { requestClosed = true; });
        });
        const port = await listen(server);
        const conn = await Deno.connect({ hostname: '127.0.0.1', port });
        let send: Promise<void> | undefined;
        try {
            if (reused) {
                await writeAll(conn, encode('GET /first HTTP/1.1\r\nHost: local\r\n\r\n'));
                await readUntil(conn, 'FIRST');
            }
            await writeAll(conn, encode('POST / HTTP/1.1\r\nHost: local\r\nContent-Length: 33554432\r\n\r\n'));
            send = upload(conn, 2 * 1024 * 1024);
            send.catch(() => {});
            await waitFor(() => (incoming?.readableLength ?? 0) > 0);
            await delay(100);
            strictEqual(requestClosed, false, 'an active upload must not use the shorter keepAliveTimeout');
            // With the protocol queue full, a disconnected peer is not observed
            // by another read; the body deadline must still release this request.
            if (!reused) conn.close();
            await waitFor(() => requestClosed);
            strictEqual(incoming!.complete, false);
            strictEqual(incoming!.aborted, true);
            strictEqual(incoming!.readableLength, 0);
            await waitFor(() => incoming!.socket.destroyed);
        } finally {
            try { conn.close(); } catch { /* already closed */ }
            await send?.catch(() => {});
            await close(server);
        }
    });
}

Deno.test({ name: 'http: requestTimeout excludes response work after a complete upload', timeout: 10000 }, async () => {
    const server = createServer({ requestTimeout: 100, keepAliveTimeout: 1000 }, (req, res) => {
        req.resume();
        req.once('end', () => setTimeout(() => res.end('COMPLETE'), 250));
    });
    const port = await listen(server);
    const conn = await Deno.connect({ hostname: '127.0.0.1', port });
    try {
        for (let i = 0; i < 2; i++) {
            await writeAll(conn, encode('POST / HTTP/1.1\r\nHost: local\r\nContent-Length: 16384\r\n\r\n'));
            await upload(conn, 16384);
            await readUntil(conn, 'COMPLETE');
        }
    } finally {
        try { conn.close(); } catch { /* already closed */ }
        await close(server);
    }
});

Deno.test({ name: 'http: requestTimeout zero permits a paused upload until the handler replies', timeout: 10000 }, async () => {
    let incoming: IncomingMessage | undefined;
    let response: ServerResponse | undefined;
    const server = createServer({ requestTimeout: 0, keepAliveTimeout: 40 }, (req, res) => {
        incoming = req;
        response = res;
    });
    const port = await listen(server);
    const conn = await Deno.connect({ hostname: '127.0.0.1', port });
    let send: Promise<void> | undefined;
    try {
        await writeAll(conn, encode('POST / HTTP/1.1\r\nHost: local\r\nContent-Length: 2097152\r\nConnection: close\r\n\r\n'));
        send = upload(conn, 2 * 1024 * 1024);
        send.catch(() => {});
        await waitFor(() => (incoming?.readableLength ?? 0) > 0);
        await delay(120);
        strictEqual(incoming!.destroyed, false);
        response!.end('COMPLETE');
        await send;
        ok((await readAll(conn)).includes('COMPLETE'));
    } finally {
        try { conn.close(); } catch { /* already closed */ }
        await send?.catch(() => {});
        await close(server);
    }
});
