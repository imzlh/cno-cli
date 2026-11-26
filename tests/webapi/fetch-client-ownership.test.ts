import { notStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import { createServer, type Socket } from 'node:net';
import { clearTimeout, setTimeout } from 'node:timers';

// Exercise baked fetch/HttpClient together. Disk imports create a second set of Web globals.
// Deno 2.9.8 is the contract oracle: close revokes new requests, not admitted work.
interface Connection {
    id: number;
    socket: Socket;
    closed: Promise<void>;
    isClosed: boolean;
}

interface Incoming {
    connection: Connection;
    method: string;
    path: string;
    body: string;
}

function within<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000);
        }),
    ]).finally(() => clearTimeout(timer));
}

function reply(request: Incoming, body = 'ok', status = '200 OK', headers = ''): void {
    request.connection.socket.write(
        `HTTP/1.1 ${status}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
        `X-Connection-Id: ${request.connection.id}\r\n${headers}\r\n${body}`,
    );
}

async function startOrigin(handler: (request: Incoming) => void = request => reply(request)) {
    const connections: Connection[] = [];
    const hits: Incoming[] = [];
    const server = createServer(socket => {
        const closed = Promise.withResolvers<void>();
        const connection: Connection = {
            id: connections.length + 1,
            socket,
            closed: closed.promise,
            isClosed: false,
        };
        connections.push(connection);
        socket.once('close', () => {
            connection.isClosed = true;
            closed.resolve();
        });
        socket.on('error', () => socket.destroy());
        let pending = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            while (true) {
                const headerEnd = pending.indexOf('\r\n\r\n');
                if (headerEnd === -1) return;
                const headers = pending.subarray(0, headerEnd).toString('latin1');
                const lines = headers.split('\r\n');
                const lengthHeader = lines.find(line => /^content-length:/i.test(line));
                const length = lengthHeader ? Number(lengthHeader.slice(lengthHeader.indexOf(':') + 1)) : 0;
                const bodyStart = headerEnd + 4;
                let body: string;
                let end: number;
                if (lines.some(line => /^transfer-encoding:\s*chunked/i.test(line))) {
                    // Deno can stream the upload; cno currently buffers it before perform().
                    let position = bodyStart;
                    const chunks: Buffer[] = [];
                    while (true) {
                        const lineEnd = pending.indexOf('\r\n', position);
                        if (lineEnd === -1) return;
                        const size = parseInt(pending.subarray(position, lineEnd).toString(), 16);
                        ok(Number.isFinite(size), 'fixture expects valid chunk sizes');
                        if (pending.length < lineEnd + 2 + size + 2) return;
                        position = lineEnd + 2;
                        if (size === 0) {
                            end = position + 2;
                            break;
                        }
                        chunks.push(pending.subarray(position, position + size));
                        position += size + 2;
                    }
                    body = Buffer.concat(chunks).toString();
                } else {
                    end = bodyStart + length;
                    if (pending.length < end) return;
                    body = pending.subarray(bodyStart, end).toString();
                }
                const [method, path] = lines[0].split(' ');
                const request = { connection, method, path, body };
                pending = pending.subarray(end);
                hits.push(request);
                handler(request);
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    const port = (server.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${port}`,
        connections,
        hits,
        async stop() {
            for (const { socket } of connections) socket.destroy();
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}

async function connectionId(url: string | Request, client?: Deno.HttpClient): Promise<number> {
    const response = await fetch(url, { client });
    strictEqual(await response.text(), 'ok');
    return Number(response.headers.get('x-connection-id'));
}

// Only this documented native capability varies by libcurl version; Deno always has it.
const supportsIdleEviction = (() => {
    if (!('use' in import.meta)) return true;
    const pool = new (import.meta.use('curl').ConnPool)();
    try {
        return typeof pool.closeIdleConnections === 'function';
    } finally {
        pool.close();
    }
})();

Deno.test({ name: 'fetch client ownership: separate pools reuse and close only their own sockets', timeout: 15000 }, async () => {
    const origin = await startOrigin();
    const first = Deno.createHttpClient({ http2: false });
    const sibling = Deno.createHttpClient({ http2: false });
    try {
        const publicId = await connectionId(origin.url);
        const firstId = await connectionId(origin.url, first);
        const siblingId = await connectionId(origin.url, sibling);
        strictEqual(new Set([publicId, firstId, siblingId]).size, 3, 'each owner needs a distinct native pool');
        strictEqual(await connectionId(origin.url, first), firstId);
        strictEqual(await connectionId(origin.url, sibling), siblingId);
        strictEqual(await connectionId(origin.url), publicId);

        first.close();
        await within(origin.connections[firstId - 1].closed, 'first client idle socket closes');
        strictEqual(origin.connections[publicId - 1].isClosed, false);
        strictEqual(origin.connections[siblingId - 1].isClosed, false);
        const hits = origin.hits.length;
        await rejects(fetch(`${origin.url}/revoked`, { client: first }), Deno.errors.BadResource);
        strictEqual(origin.hits.length, hits);
        throws(() => first.close(), Deno.errors.BadResource);
        first[Symbol.dispose]();
        first[Symbol.dispose]();
        strictEqual(await connectionId(origin.url), publicId, 'public pool remains reusable');
        strictEqual(await connectionId(origin.url, sibling), siblingId, 'sibling pool remains reusable');

        sibling.close();
        await within(origin.connections[siblingId - 1].closed, 'sibling idle socket closes');
    } finally {
        first[Symbol.dispose]();
        sibling[Symbol.dispose]();
        await origin.stop();
    }
});

Deno.test({ name: 'fetch client ownership: Request copies and clones retain the client, null clears it', timeout: 15000 }, async () => {
    const origin = await startOrigin();
    const client = Deno.createHttpClient({ http2: false });
    try {
        const publicId = await connectionId(origin.url);
        const ownedId = await connectionId(origin.url, client);
        const request = new Request(origin.url, { client } as RequestInit);
        strictEqual(await connectionId(new Request(request)), ownedId);
        strictEqual(await connectionId(request.clone()), ownedId);
        strictEqual(await connectionId(new Request(request, { client: null } as RequestInit)), publicId);
        const clone = request.clone();
        client.close();
        await rejects(fetch(request), Deno.errors.BadResource);
        await rejects(fetch(clone), Deno.errors.BadResource);
        const response = await fetch(request, { client: null } as RequestInit);
        strictEqual(await response.text(), 'ok');
        strictEqual(Number(response.headers.get('x-connection-id')), publicId);
    } finally {
        client[Symbol.dispose]();
        await origin.stop();
    }
});

Deno.test({ name: 'fetch client ownership: immediate close preserves an admitted upload', timeout: 15000 }, async () => {
    const origin = await startOrigin(request => reply(request, request.body || 'ok'));
    const client = Deno.createHttpClient({ http2: false });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    try {
        const responsePromise = fetch(origin.url, { method: 'POST', client, body, duplex: 'half' } as RequestInit);
        client.close();
        controller.enqueue(new TextEncoder().encode('upload after close'));
        controller.close();
        const response = await within(responsePromise, 'admitted upload');
        strictEqual(await response.text(), 'upload after close');
        await within(origin.connections[0].closed, 'pool drains after upload');
        await rejects(fetch(origin.url, { client }), Deno.errors.BadResource);
    } finally {
        client[Symbol.dispose]();
        await origin.stop();
    }
});

Deno.test({ name: 'fetch client ownership: close while awaiting headers preserves admitted work', timeout: 15000 }, async () => {
    const arrived = Promise.withResolvers<Incoming>();
    const origin = await startOrigin(request => {
        if (request.path === '/pending') arrived.resolve(request);
        else reply(request);
    });
    const client = Deno.createHttpClient({ http2: false });
    const abort = new AbortController();
    try {
        const pending = fetch(`${origin.url}/pending`, { client, signal: abort.signal });
        const request = await within(arrived.promise, 'pending request reaches origin');
        const idleId = await connectionId(origin.url, client);
        notStrictEqual(request.connection.id, idleId);
        client.close();
        await rejects(fetch(`${origin.url}/new`, { client }), Deno.errors.BadResource);
        strictEqual(request.connection.isClosed, false, 'close cannot cancel the admitted request');
        reply(request, 'completed');
        strictEqual(await (await within(pending, 'pending headers')).text(), 'completed');
        await within(Promise.all(origin.connections.map(connection => connection.closed)), 'all owned sockets drain');
    } finally {
        abort.abort();
        client[Symbol.dispose]();
        await origin.stop();
    }
});

Deno.test({ name: 'fetch client ownership: streaming body survives close and the pool drains afterwards', timeout: 15000 }, async () => {
    const arrived = Promise.withResolvers<Incoming>();
    const origin = await startOrigin(request => {
        if (request.path === '/stream') {
            request.connection.socket.write('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nfirst');
            arrived.resolve(request);
        } else reply(request);
    });
    const client = Deno.createHttpClient({ http2: false });
    const abort = new AbortController();
    try {
        const response = await fetch(`${origin.url}/stream`, { client, signal: abort.signal });
        const request = await within(arrived.promise, 'stream starts');
        const idleId = await connectionId(origin.url, client);
        const body = response.text();
        client.close();
        if (supportsIdleEviction) {
            await within(origin.connections[idleId - 1].closed, 'idle connection closes during the active body');
        }
        strictEqual(request.connection.isClosed, false, 'streaming socket must stay alive');
        request.connection.socket.write(' last');
        strictEqual(await within(body, 'stream completes'), 'first last');
        await within(Promise.all(origin.connections.map(connection => connection.closed)), 'streaming pool drains');
    } finally {
        abort.abort();
        client[Symbol.dispose]();
        await origin.stop();
    }
});

Deno.test({ name: 'fetch client ownership: abort and response cancellation release closed pools', timeout: 20000 }, async () => {
    for (const mode of ['abort', 'cancel'] as const) {
        const arrived = Promise.withResolvers<Incoming>();
        const origin = await startOrigin(request => {
            if (request.path === '/pending') {
                arrived.resolve(request);
                if (mode === 'cancel') request.connection.socket.write('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nstart');
            } else reply(request);
        });
        const client = Deno.createHttpClient({ http2: false });
        const abort = new AbortController();
        try {
            const pending = fetch(`${origin.url}/pending`, { client, signal: abort.signal });
            await within(arrived.promise, `${mode} request reaches origin`);
            await connectionId(origin.url, client);
            client.close();
            if (mode === 'abort') {
                const reason = new Error('cancel admitted request');
                const rejection = rejects(pending, (error: unknown) => error === reason);
                abort.abort(reason);
                await rejection;
            } else {
                const response = await within(pending, 'response for cancellation');
                await response.body!.cancel();
            }
            await within(Promise.all(origin.connections.map(connection => connection.closed)), `${mode} releases all sockets`);
        } finally {
            abort.abort();
            client[Symbol.dispose]();
            await origin.stop();
        }
    }
});

Deno.test({ name: 'fetch client ownership: close rejects an unadmitted redirect without contacting its target', timeout: 15000 }, async () => {
    const arrived = Promise.withResolvers<Incoming>();
    const target = await startOrigin();
    const origin = await startOrigin(request => arrived.resolve(request));
    const client = Deno.createHttpClient({ http2: false });
    const abort = new AbortController();
    try {
        const pending = fetch(`${origin.url}/redirect`, { client, signal: abort.signal });
        const rejection = rejects(pending, Deno.errors.BadResource);
        const request = await within(arrived.promise, 'redirect request');
        client.close();
        reply(request, '', '302 Found', `Location: ${target.url}/forbidden\r\n`);
        await within(rejection, 'closed client rejects the redirect');
        strictEqual(target.connections.length, 0, 'do not even connect to the redirect destination');
        strictEqual(target.hits.length, 0);
        await within(request.connection.closed, 'redirect pool releases its connection');
    } finally {
        abort.abort();
        client[Symbol.dispose]();
        await origin.stop();
        await target.stop();
    }
});

Deno.test({ name: 'fetch client ownership: admitted redirect completes after close', timeout: 15000 }, async () => {
    const arrived = Promise.withResolvers<Incoming>();
    const target = await startOrigin(request => arrived.resolve(request));
    const origin = await startOrigin(request => reply(request, '', '302 Found', `Location: ${target.url}/admitted\r\n`));
    const client = Deno.createHttpClient({ http2: false });
    const abort = new AbortController();
    try {
        const pending = fetch(origin.url, { client, signal: abort.signal });
        const request = await within(arrived.promise, 'redirect target is admitted');
        client.close();
        reply(request);
        const response = await within(pending, 'admitted redirect');
        strictEqual(response.redirected, true);
        strictEqual(response.url, `${target.url}/admitted`);
        strictEqual(await response.text(), 'ok');
        await within(Promise.all([...origin.connections, ...target.connections].map(connection => connection.closed)), 'redirect pool drains');
    } finally {
        abort.abort();
        client[Symbol.dispose]();
        await origin.stop();
        await target.stop();
    }
});

Deno.test({ name: 'fetch client ownership: preparation failure releases the last admitted lease', timeout: 15000 }, async () => {
    const origin = await startOrigin();
    const client = Deno.createHttpClient({ http2: false });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    try {
        const idleId = await connectionId(origin.url, client);
        const pending = fetch(origin.url, { client, method: 'POST', body, duplex: 'half' } as RequestInit);
        const rejection = rejects(pending);
        client.close();
        controller.error(new Error('upload producer failed'));
        await within(rejection, 'failed body preparation rejects');
        await within(origin.connections[idleId - 1].closed, 'failed preparation releases the pool');
    } finally {
        client[Symbol.dispose]();
        await origin.stop();
    }
});

Deno.test({
    name: 'fetch client ownership: interception fulfillment and failures release the admitted lease',
    timeout: 20000,
    ignore: !('use' in import.meta),
}, async () => {
    const hookKey = Symbol.for('cno.fetchInterceptHook');
    const previousHook = Reflect.get(globalThis, hookKey);
    const hadHook = Object.prototype.hasOwnProperty.call(globalThis, hookKey);
    try {
        for (const mode of ['fulfill', 'fail', 'throw'] as const) {
            const origin = await startOrigin();
            const client = Deno.createHttpClient({ http2: false });
            const failure = new Error('interceptor failed');
            try {
                const idleId = await connectionId(origin.url, client);
                Reflect.set(globalThis, hookKey, {
                    async onRequest() {
                        client.close();
                        if (mode === 'throw') throw failure;
                        if (mode === 'fail') return { action: 'fail', reason: 'BlockedByClient' };
                        return {
                            action: 'fulfill',
                            responseCode: 200,
                            responseHeaders: [],
                            body: new TextEncoder().encode('intercepted'),
                        };
                    },
                });
                const pending = fetch(`${origin.url}/intercepted`, { client });
                if (mode === 'fulfill') strictEqual(await (await pending).text(), 'intercepted');
                else if (mode === 'throw') await rejects(pending, (error: unknown) => error === failure);
                else await rejects(pending, TypeError);
                await within(origin.connections[idleId - 1].closed, `${mode} releases the closed pool`);
                strictEqual(origin.hits.length, 1, 'interception must not start a native transfer');
            } finally {
                if (hadHook) Reflect.set(globalThis, hookKey, previousHook);
                else Reflect.deleteProperty(globalThis, hookKey);
                client[Symbol.dispose]();
                await origin.stop();
            }
        }
    } finally {
        if (hadHook) Reflect.set(globalThis, hookKey, previousHook);
        else Reflect.deleteProperty(globalThis, hookKey);
    }
});
