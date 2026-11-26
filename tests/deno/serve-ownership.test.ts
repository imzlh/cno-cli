import { ok, rejects, strictEqual, throws } from 'node:assert';
import { getEventListeners } from 'node:events';
import * as http2 from 'node:http2';
import { h2Available } from '@cnojs/http/h2-native';

async function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), 2000);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function address(server: Deno.HttpServer): string {
    const addr = server.addr;
    if (addr.transport !== 'tcp') throw new Error('expected TCP listener');
    return `http://${addr.hostname}:${addr.port}`;
}

Deno.test('Deno.serve: an already aborted signal releases the listener', async () => {
    const controller = new AbortController();
    controller.abort();
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, signal: controller.signal }, () => new Response('unused'));
    try {
        await deadline(server.finished, 'already aborted server kept listening');
        strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
        await server.shutdown();
    }
});

Deno.test('Deno.serve: shutdown removes its signal subscription and is idempotent', async () => {
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, 'abort').length;
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, signal: controller.signal }, () => new Response('ok'));
    strictEqual(getEventListeners(controller.signal, 'abort').length, before + 1);
    await Promise.all([server.shutdown(), server.shutdown(), server.finished]);
    strictEqual(getEventListeners(controller.signal, 'abort').length, before);
    controller.abort();
    await server.shutdown();
});

Deno.test('Deno.serve: remoteAddr identifies the accepted client rather than the listener', async () => {
    const peer = Promise.withResolvers<Deno.Addr>();
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0 }, (_request, info) => {
        peer.resolve(info.remoteAddr);
        return new Response('ok');
    });
    const addr = server.addr as Deno.NetAddr;
    const connection = await Deno.connect({ hostname: addr.hostname, port: addr.port });
    try {
        await connection.write(new TextEncoder().encode('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'));
        const remote = await deadline(peer.promise, 'accepted request did not expose its peer');
        strictEqual(remote.transport, 'tcp');
        if (remote.transport !== 'tcp') throw new Error('expected TCP peer');
        strictEqual(remote.hostname, connection.localAddr.hostname);
        strictEqual(remote.port, connection.localAddr.port);
        ok(remote.port !== addr.port, 'client ephemeral port must differ from the listener');
    } finally {
        connection.close();
        await server.shutdown();
    }
});

for (const refAgain of [false, true]) {
    Deno.test(`Deno.serve: listener ${refAgain ? 'ref restores' : 'unref releases'} event loop ownership`, async () => {
        const source = `
            const server = Deno.serve({ hostname: '127.0.0.1', port: 0 }, () => new Response('unused'));
            server.unref();
            ${refAgain ? 'server.ref();' : ''}
            const timer = setTimeout(async () => {
                console.log('timer');
                await server.shutdown();
            }, 100);
            timer.unref();
            console.log('ready');
        `;
        const child = new Deno.Command(Deno.execPath(), { args: ['eval', source], stdout: 'piped', stderr: 'piped' }).spawn();
        try {
            const output = await deadline(child.output(), 'listener ownership child did not exit');
            strictEqual(output.code, 0, new TextDecoder().decode(output.stderr));
            strictEqual(new TextDecoder().decode(output.stdout), refAgain ? 'ready\ntimer\n' : 'ready\n');
        } finally {
            try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
        }
    });
}

Deno.test('Deno.serve: a throwing onListen releases the newly opened port', async () => {
    const error = new Error('onListen failed');
    let port = 0;
    throws(() => Deno.serve({
        hostname: '127.0.0.1', port: 0,
        onListen(addr) {
            if (addr.transport !== 'tcp') throw new Error('expected TCP listener');
            port = addr.port;
            throw error;
        },
    }, () => new Response('unused')), value => value === error);
    ok(port > 0);
    // Native close releases its fd in the next loop turn.
    await new Promise<void>(resolve => setTimeout(resolve, 1));
    const next = Deno.serve({ hostname: '127.0.0.1', port }, () => new Response('reused'));
    try {
        strictEqual(await (await fetch(address(next))).text(), 'reused');
    } finally {
        await next.shutdown();
    }
});

Deno.test('Deno.serve: producer cancellation cannot stall failed response completion', async () => {
    const cleanup = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<unknown>();
    const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
        cancel() { cancelled.resolve(); return cleanup.promise; },
    });
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0 }, (_request, info) => {
        void info.completed.then(() => completed.resolve(undefined), completed.resolve);
        return new Response(body, { headers: { 'content-length': '1' } });
    });
    const response = fetch(address(server)).then(result => result.arrayBuffer());
    void response.catch(() => {});
    try {
        await deadline(cancelled.promise, 'response producer was not cancelled');
        ok(await deadline(completed.promise, 'completion waited for producer cancellation') instanceof Deno.errors.Interrupted);
        strictEqual(body.locked, false);
        await deadline(server.shutdown(), 'shutdown waited for producer cancellation');
        await rejects(() => response);
    } finally {
        cleanup.resolve();
        await server.shutdown();
    }
});

Deno.test('Deno.serve: HEAD completes while the unused producer is still cancelling', async () => {
    const cleanup = Promise.withResolvers<void>();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; return cleanup.promise; },
    });
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0 }, () => new Response(body));
    try {
        const response = await deadline(fetch(address(server), { method: 'HEAD' }), 'HEAD waited for producer cleanup');
        strictEqual(response.status, 200);
        strictEqual(await response.text(), '');
        strictEqual(cancelled, true);
        strictEqual(body.locked, false);
    } finally {
        cleanup.resolve();
        await server.shutdown();
    }
});

Deno.test('Deno.serve: a throwing onError terminates its response and leaves the server usable', async () => {
    const completed = Promise.withResolvers<unknown>();
    const errors: unknown[] = [];
    const server = Deno.serve({
        hostname: '127.0.0.1', port: 0,
        onError(error) { errors.push(error); throw new Error('recovery failed'); },
    }, (request, info) => {
        if (new URL(request.url).pathname === '/healthy') return new Response('healthy');
        void info.completed.then(() => completed.resolve(undefined), completed.resolve);
        throw new Error('handler failed');
    });
    try {
        await deadline(rejects(() => fetch(address(server))), 'failed response stayed open');
        ok(await completed.promise instanceof Deno.errors.Interrupted);
        strictEqual(errors.length, 1);
        strictEqual(await (await fetch(`${address(server)}/healthy`)).text(), 'healthy');
    } finally {
        await server.shutdown();
    }
});

for (const framing of ['content-length', 'chunked'] as const) {
Deno.test(`Deno.serve: cancelling a partial ${framing} body preserves its response and framing`, async () => {
    const cancelled = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<unknown>();
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, requestTimeout: 0 }, async (request, info) => {
        if (request.method === 'GET') return new Response('healthy');
        void info.completed.then(() => completed.resolve(undefined), completed.resolve);
        const reader = request.body!.getReader();
        try {
            ok(!(await reader.read()).done);
            await reader.cancel('stop upload');
            cancelled.resolve();
        } finally {
            reader.releaseLock();
        }
        return new Response('accepted');
    });
    const addr = server.addr as Deno.NetAddr;
    const connection = await Deno.connect({ hostname: addr.hostname, port: addr.port });
    try {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const readUntil = async (marker: string) => {
            let received = '';
            const buffer = new Uint8Array(1024);
            while (!received.includes(marker)) {
                const size = await deadline(connection.read(buffer), `response never reached ${marker}`);
                if (size === null) throw new Error(`connection closed before ${marker}: ${received}`);
                received += decoder.decode(buffer.subarray(0, size));
            }
            return received;
        };
        const head = framing === 'content-length' ? 'Content-Length: 10' : 'Transfer-Encoding: chunked';
        const partial = framing === 'content-length' ? 'partial' : '7\r\npartial\r\n';
        await connection.write(encoder.encode(`POST /upload HTTP/1.1\r\nHost: localhost\r\n${head}\r\n\r\n${partial}`));
        await deadline(cancelled.promise, 'body cancellation hung');
        const response = await readUntil('accepted');
        ok(response.includes('HTTP/1.1 200 '), response);
        strictEqual(await deadline(completed.promise, 'cancelled request never completed'), undefined);
        const tail = framing === 'content-length' ? 'end' : '3\r\nend\r\n0\r\n\r\n';
        await connection.write(encoder.encode(`${tail}GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
        const nextResponse = await readUntil('healthy');
        ok(nextResponse.includes('HTTP/1.1 200 '), nextResponse);
    } finally {
        connection.close();
        await deadline(server.shutdown(), 'cancelled upload blocked shutdown');
    }
});
}

Deno.test('Deno.serve: a response can finish when a retained H1 body is cancelled after handler return', async () => {
    const readerReady = Promise.withResolvers<ReadableStreamDefaultReader<Uint8Array>>();
    const handlerReturned = Promise.withResolvers<void>();
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, requestTimeout: 0 }, request => {
        if (request.method === 'GET') return new Response('healthy');
        const reader = request.body!.getReader();
        readerReady.resolve(reader);
        handlerReturned.resolve();
        return new Response('accepted');
    });
    const addr = server.addr as Deno.NetAddr;
    const connection = await Deno.connect({ hostname: addr.hostname, port: addr.port });
    try {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const readUntil = async (marker: string) => {
            let received = '';
            const buffer = new Uint8Array(1024);
            while (!received.includes(marker)) {
                const size = await deadline(connection.read(buffer), `response never reached ${marker}`);
                if (size === null) throw new Error(`connection closed before ${marker}: ${received}`);
                received += decoder.decode(buffer.subarray(0, size));
            }
            return received;
        };
        await connection.write(encoder.encode(
            'POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\npartial',
        ));
        const reader = await deadline(readerReady.promise, 'request body reader was not retained');
        await deadline(handlerReturned.promise, 'handler did not return');
        await reader.cancel('stop upload after handler return');
        const response = await readUntil('accepted');
        ok(response.includes('HTTP/1.1 200 '), response);

        await connection.write(encoder.encode(
            'endGET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
        ));
        const nextResponse = await readUntil('healthy');
        ok(nextResponse.includes('HTTP/1.1 200 '), nextResponse);
    } finally {
        connection.close();
        await deadline(server.shutdown(), 'retained-body cancellation blocked shutdown');
    }
});

Deno.test('Deno.serve: retained bodies stay with their own keep-alive requests', async () => {
    const previous = new Map<string, Request>();
    const currentStarted = Promise.withResolvers<void>();
    const readCurrent = Promise.withResolvers<void>();
    const currentBody = Promise.withResolvers<string>();
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0 }, async request => {
        const path = new URL(request.url).pathname;
        if (path !== '/current') {
            previous.set(path, request);
            return new Response(null, { status: 204 });
        }
        currentStarted.resolve();
        await readCurrent.promise;
        try {
            currentBody.resolve(await request.text());
        } catch (error) {
            currentBody.reject(error);
        }
        return new Response(null, { status: 204 });
    });
    void currentBody.promise.catch(() => {});
    const addr = server.addr as Deno.NetAddr;
    const connection = await Deno.connect({ hostname: addr.hostname, port: addr.port });
    const encoder = new TextEncoder();
    try {
        await connection.write(encoder.encode(
            'POST /read HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nold'
            + 'POST /cancel HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\ndrop'
            + 'POST /current HTTP/1.1\r\nHost: localhost\r\nContent-Length: 8\r\n\r\nnew-',
        ));
        await deadline(currentStarted.promise, 'connection did not advance to the third request');
        await previous.get('/cancel')!.body!.cancel();
        strictEqual(await deadline(previous.get('/read')!.text(), 'old body waited for new upload'), 'old');
        await connection.write(encoder.encode('body'));
        readCurrent.resolve();
        strictEqual(await deadline(currentBody.promise, 'old cancellation interrupted new upload'), 'new-body');
    } finally {
        readCurrent.resolve();
        connection.close();
        await deadline(server.shutdown(), 'keep-alive connection did not release');
    }
});

Deno.test('Deno.serve: a rejected upgrade response fails the returned WebSocket', async () => {
    const closed = Promise.withResolvers<void>();
    let socket: WebSocket | undefined;
    let errors = 0;
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0 }, request => {
        const upgrade = Deno.upgradeWebSocket(request);
        socket = upgrade.socket;
        socket.onerror = () => { errors++; };
        socket.onclose = () => closed.resolve();
        upgrade.response.headers.set('content-length', '1');
        return upgrade.response;
    });
    const addr = server.addr as Deno.NetAddr;
    const connection = await Deno.connect({ hostname: addr.hostname, port: addr.port });
    try {
        await connection.write(new TextEncoder().encode(
            'GET /upgrade HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        ));
        await deadline(closed.promise, 'failed upgrade stayed CONNECTING');
        strictEqual(socket!.readyState, WebSocket.CLOSED);
        strictEqual(errors, 1);
    } finally {
        connection.close();
        await server.shutdown();
    }
});

Deno.test({
    name: 'Deno.serve: cancelling an H2 request body leaves other streams usable',
    ignore: !h2Available(),
}, async () => {
    const ssl = import.meta.use('ssl');
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const cancelled = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<unknown>();
    // Larger than the stream window: resetting when end() is queued loses data.
    const payload = 'accepted'.repeat(65536);
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, cert, key }, async (request, info) => {
        if (request.method === 'GET') return new Response('healthy');
        void info.completed.then(() => completed.resolve(undefined), completed.resolve);
        const reader = request.body!.getReader();
        try {
            await reader.read();
            await reader.cancel();
            cancelled.resolve();
        } finally {
            reader.releaseLock();
        }
        return new Response(payload);
    });
    const addr = server.addr as Deno.NetAddr;
    const session = http2.connect(`https://${addr.hostname}:${addr.port}`, { rejectUnauthorized: false });
    try {
        await deadline(new Promise<void>((resolve, reject) => {
            session.once('connect', resolve);
            session.once('error', reject);
        }), 'H2 session did not connect');
        const upload = session.request({ ':method': 'POST', ':path': '/upload' });
        const uploadChunks: Buffer[] = [];
        upload.on('data', chunk => uploadChunks.push(chunk));
        const uploadDone = new Promise<void>((resolve, reject) => {
            upload.once('end', resolve);
            upload.once('error', reject);
        });
        void uploadDone.catch(() => {});
        upload.write('partial');
        await deadline(cancelled.promise, 'H2 cancellation did not run');
        await deadline(uploadDone, 'cancelling H2 input discarded its response');
        strictEqual(Buffer.concat(uploadChunks).toString(), payload);
        strictEqual(await deadline(completed.promise, 'H2 response completion stayed pending'), undefined);
        const request = session.request({ ':path': '/healthy' });
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(chunk));
        const done = new Promise<void>((resolve, reject) => {
            request.once('end', resolve);
            request.once('error', reject);
        });
        request.end();
        await deadline(done, 'another H2 stream stopped after body cancellation');
        strictEqual(Buffer.concat(chunks).toString(), 'healthy');
    } finally {
        session.destroy();
        await server.shutdown();
    }
});
