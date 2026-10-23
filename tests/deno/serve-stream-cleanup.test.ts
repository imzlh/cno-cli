import { ok, strictEqual } from 'node:assert';
import { createServer } from 'node:http';

const encode = (value: string) => new TextEncoder().encode(value);

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('stream cancellation timeout')), 2000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function readUntil(conn: Deno.TcpConn, marker: string): Promise<void> {
    const buffer = new Uint8Array(4096);
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes(marker)) {
        const size = await withTimeout(conn.read(buffer));
        if (size === null) throw new Error(`connection closed before ${marker}`);
        received += decoder.decode(buffer.subarray(0, size));
    }
}

for (const mode of ['idle stream', 'late response', 'HEAD'] as const) {
    Deno.test({ name: `Deno.serve: ${mode} releases its response body`, timeout: 7000 }, async () => {
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const canceled = Promise.withResolvers<unknown>();
        let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let cancelCount = 0;
        let onErrorCount = 0;
        const server = Deno.serve({
            hostname: '127.0.0.1', port: 0, onListen() {},
            onError() { onErrorCount++; return new Response('unexpected recovery', { status: 500 }); },
        }, async () => {
            started.resolve();
            if (mode === 'late response') await release.promise;
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    sourceController = controller;
                    controller.enqueue(encode('ready'));
                },
                cancel(reason) { cancelCount++; canceled.resolve(reason); },
            }));
        });
        const conn = await Deno.connect({ hostname: '127.0.0.1', port: server.addr.port });
        try {
            const method = mode === 'HEAD' ? 'HEAD' : 'GET';
            await conn.write(encode(`${method} / HTTP/1.1\r\nHost: local\r\n\r\n`));
            await withTimeout(started.promise);
            if (mode === 'late response') {
                conn.close();
                // Ensure the H1 close observer has run before the handler returns.
                await new Promise(resolve => setTimeout(resolve, 30));
                release.resolve();
            } else if (mode === 'idle stream') {
                await readUntil(conn, 'ready');
                conn.close();
            } else {
                await readUntil(conn, '\r\n\r\n');
            }
            const reason = await withTimeout(canceled.promise);
            strictEqual(cancelCount, 1, 'discarded response bodies must be canceled exactly once');
            strictEqual(onErrorCount, 0, 'peer disconnect must not invoke onError');
            if (mode !== 'HEAD') ok(reason instanceof Error);
        } finally {
            release.resolve();
            try { conn.close(); } catch { /* already closed */ }
            try { sourceController?.close(); } catch { /* already canceled */ }
            await withTimeout(server.shutdown());
        }
    });
}

for (const phase of ['before headers', 'idle body'] as const) {
    Deno.test({ name: `Deno.serve: proxy aborts its upstream fetch ${phase} on disconnect`, timeout: 7000 }, async () => {
        const upstreamStarted = Promise.withResolvers<void>();
        const upstreamClosed = Promise.withResolvers<void>();
        const upstream = createServer((_request, response) => {
            response.once('close', () => upstreamClosed.resolve());
            upstreamStarted.resolve();
            if (phase === 'idle body') {
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.write('data: ready\n\n');
            }
        });
        await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
        const address = upstream.address();
        if (!address || typeof address === 'string') throw new Error('missing upstream address');
        let requestSignal: AbortSignal | undefined;
        let onErrorCount = 0;
        const server = Deno.serve({
            hostname: '127.0.0.1', port: 0, onListen() {},
            onError() { onErrorCount++; return new Response('unexpected recovery', { status: 500 }); },
        }, async request => {
            requestSignal = request.signal;
            return await fetch(`http://127.0.0.1:${address.port}/`, { signal: request.signal });
        });
        const conn = await Deno.connect({ hostname: '127.0.0.1', port: server.addr.port });
        try {
            await conn.write(encode('GET / HTTP/1.1\r\nHost: local\r\n\r\n'));
            await withTimeout(upstreamStarted.promise);
            if (phase === 'idle body') await readUntil(conn, 'data: ready');
            conn.close();
            await withTimeout(upstreamClosed.promise);
            strictEqual(requestSignal?.aborted, true, 'the incoming Request signal must observe peer disconnect');
            strictEqual(onErrorCount, 0, 'peer disconnect must not invoke onError');
        } finally {
            try { conn.close(); } catch { /* already closed */ }
            upstream.closeAllConnections();
            await new Promise<void>(resolve => upstream.close(() => resolve()));
            await withTimeout(server.shutdown());
        }
    });
}
