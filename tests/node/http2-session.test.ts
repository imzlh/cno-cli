/**
 * Real HTTP/2 (nghttp2) round-trip via node:http2 createServer + connect (h2c).
 */
import { strictEqual, ok, deepStrictEqual, throws } from 'node:assert';
import * as http2 from 'node:http2';
import * as net from 'node:net';
import { H2Stream } from '@cnojs/http/h2';
import { h2Available, __forceH2Unavailable } from '@cnojs/http/h2-native';
import { ClientHttp2Session } from '../../cno/src/node/http2/session.ts';

function once<T extends unknown[]>(emitter: { once(event: string, fn: (...args: T) => void): void }, event: string): Promise<T> {
    return new Promise(resolve => {
        emitter.once(event, (...args: T) => resolve(args));
    });
}

function closeServer(server: { readonly listening: boolean; close(callback?: (error?: Error) => void): unknown }): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

Deno.test({
    name: 'http2: h2c client GET round-trip against createServer',
    ignore: !h2Available(),
    timeout: 15000,
}, async () => {
    const server = http2.createServer();
    const got = once<[
        { on(e: string, fn: (...a: unknown[]) => void): void; respond(h: Record<string, unknown>, o?: { endStream?: boolean }): void; end(d?: string): void },
        Record<string, string | string[]>,
        number,
    ]>(server, 'stream');

    let session: http2.ClientHttp2Session | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.on('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });

        const addr = server.address();
        ok(addr && typeof addr === 'object' && 'port' in addr, 'server has port');
        const port = (addr as { port: number }).port;

        const activeSession = http2.connect(`http://127.0.0.1:${port}`);
        session = activeSession;
        await once(activeSession, 'connect');

        const streamPromise = got.then(([stream, headers, flags]) => {
            strictEqual(flags, http2.constants.NGHTTP2_FLAG_END_HEADERS | http2.constants.NGHTTP2_FLAG_END_STREAM);
            strictEqual(headers[':method'] ?? headers[':method'.toLowerCase()], 'GET');
            const path = headers[':path'];
            ok(path === '/hello' || (Array.isArray(path) && path[0] === '/hello'), String(path));
            stream.respond({ 'Content-Type': 'text/plain', ':status': 200 });
            stream.end('pong-h2');
        });

        const req = activeSession.request({
            ':method': 'GET',
            ':path': '/hello',
            ':scheme': 'http',
            ':authority': `127.0.0.1:${port}`,
        });
        strictEqual(req.writableEnded, true);
        req.end();

        const chunks: Buffer[] = [];
        const responseHeaders = await new Promise<Record<string, string | string[]>>((resolve, reject) => {
            req.on('response', (h: Record<string, string | string[]>) => resolve(h));
            req.on('error', reject);
            req.on('data', (c: Buffer) => chunks.push(c));
        });

        await new Promise<void>((resolve, reject) => {
            req.on('end', () => resolve());
            req.on('error', reject);
            // if already ended
            req.on('close', () => resolve());
        });

        await streamPromise;

        const status = responseHeaders[':status'];
        strictEqual(String(status), '200');
        strictEqual(responseHeaders['content-type'], 'text/plain');
        const body = Buffer.concat(chunks).toString();
        strictEqual(body, 'pong-h2');
    } finally {
        session?.destroy();
        await closeServer(server);
    }
});

Deno.test({
    name: 'http2: server stream listeners run before the request adapter',
    ignore: !h2Available(),
    timeout: 15000,
}, async () => {
    const events: string[] = [];
    const server = http2.createServer((_request, response) => {
        events.push('request');
        response.end('ok');
    });
    server.on('stream', () => events.push('server-stream'));
    server.on('session', session => session.on('stream', () => events.push('session-stream')));

    let session: http2.ClientHttp2Session | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.on('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        ok(address && typeof address === 'object' && 'port' in address);
        session = http2.connect(`http://127.0.0.1:${(address as { port: number }).port}`);
        await once(session, 'connect');

        const request = session.request({
            ':method': 'GET',
            ':path': '/',
            ':scheme': 'http',
        });
        const body = await new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(Buffer.from(chunk)));
            request.on('end', () => resolve(Buffer.concat(chunks).toString()));
            request.on('error', reject);
            request.end();
        });

        strictEqual(body, 'ok');
        deepStrictEqual(events, ['server-stream', 'request', 'session-stream']);
    } finally {
        session?.destroy();
        await closeServer(server);
    }
});

Deno.test({
    name: 'http2: requests queued before connect preserve headers, bodies and session stream identity',
    ignore: !h2Available(),
    timeout: 20000,
}, async () => {
    let serverSession: http2.ServerHttp2Session | undefined;
    const streamEvents: string[] = [];
    let serverArgs: unknown[] = [];
    const observedRemote: number[] = [];
    const observedLocal: Array<number | string> = [];
    const server = http2.createServer({ settings: {
        initialWindowSize: 65536, maxConcurrentStreams: 7, maxHeaderSize: 17000,
    } });
    server.updateSettings({ initialWindowSize: 196608 });
    server.on('session', session => {
        serverSession = session;
        session.on('remoteSettings', settings => {
            strictEqual(settings, session.remoteSettings);
            observedRemote.push(Number(settings.initialWindowSize));
        });
        session.prependListener('stream', () => streamEvents.push('prepended'));
        session.on('stream', (...args) => {
            streamEvents.push('session');
            strictEqual(args.length, 4);
            args.forEach((arg, index) => strictEqual(arg, serverArgs[index]));
        });
    });
    server.on('stream', (stream, headers, flags, raw) => {
        streamEvents.push('server');
        serverArgs = [stream, headers, flags, raw];
        strictEqual(flags, http2.constants.NGHTTP2_FLAG_END_HEADERS);
        deepStrictEqual(raw.slice(-2), ['x-queued', 'original']);
        ok(raw.every(value => typeof value === 'string'));
        strictEqual(headers['x-queued'], 'original');
        strictEqual(stream.session, serverSession);
        strictEqual(stream.session!.remoteSettings.initialWindowSize, 262144);
        strictEqual(stream.session!.remoteSettings.maxHeaderListSize, 19000);
        stream.respond({ ':status': 200 });
        stream.pipe(stream);
    });
    let session: http2.ClientHttp2Session | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        ok(address && typeof address === 'object');
        const activeSession = http2.connect(`http://127.0.0.1:${address.port}`, {
            settings: { initialWindowSize: 131072, maxHeaderSize: 19000 },
        });
        session = activeSession;
        deepStrictEqual(activeSession.remoteSettings, {});
        const settingsAck = new Promise<void>(resolve => activeSession.settings({ initialWindowSize: 262144 }, () => {
            observedLocal.push('callback');
            resolve();
        }));
        activeSession.on('localSettings', settings => observedLocal.push(Number(settings.initialWindowSize)));
        const serverSettings = new Promise<void>(resolve => activeSession.once('remoteSettings', settings => {
            strictEqual(settings, activeSession.remoteSettings);
            strictEqual(settings.initialWindowSize, 196608);
            strictEqual(settings.maxConcurrentStreams, 7);
            strictEqual(settings.maxHeaderSize, 17000);
            strictEqual(settings.maxHeaderListSize, 17000);
            resolve();
        }));
        const failure = Promise.withResolvers<never>();
        activeSession.on('error', failure.reject);
        const payload = Buffer.alloc(256 * 1024, 0x51);
        const values = ['original'];
        const request = activeSession.request({ ':method': 'POST', ':path': '/queued', 'x-queued': values }, { endStream: false });
        values[0] = 'changed';
        strictEqual(request.session, activeSession);
        strictEqual(request.pending, true);
        strictEqual(request.id, undefined);
        const lifecycle: string[] = [];
        activeSession.once('connect', () => lifecycle.push('connect'));
        const ready = new Promise<void>(resolve => request.once('ready', () => {
            lifecycle.push('ready');
            resolve();
        }));
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        const ended = new Promise<void>((resolve, reject) => {
            request.once('end', resolve);
            request.once('error', reject);
        });
        request.end(payload);
        await Promise.race([Promise.all([ready, ended, settingsAck, serverSettings]), failure.promise]);
        strictEqual(request.pending, false);
        strictEqual(request.id, 1);
        deepStrictEqual(lifecycle, ['connect', 'ready']);
        deepStrictEqual(Buffer.concat(chunks), payload);
        deepStrictEqual(streamEvents, ['prepended', 'server', 'session']);
        strictEqual(serverSession?.localSettings.initialWindowSize, 196608);
        deepStrictEqual(observedRemote, [131072, 262144]);
        deepStrictEqual(observedLocal, [131072, 'callback', 262144]);
    } finally {
        session?.destroy();
        await closeServer(server);
    }
});

Deno.test({
    name: 'http2: server updateSettings applies to future sessions only',
    ignore: !h2Available(),
    timeout: 15000,
}, async () => {
    let initialReads = 0;
    let updateReads = 0;
    const server = http2.createServer({ settings: {
        get maxConcurrentStreams() { return ++initialReads === 1 ? 7 : 70; },
        maxHeaderSize: 18000, maxHeaderListSize: 17000,
    } });
    let original: http2.ClientHttp2Session | undefined;
    let next: http2.ClientHttp2Session | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        ok(address && typeof address === 'object');
        const authority = `http://127.0.0.1:${address.port}`;
        original = http2.connect(authority);
        await once(original, 'remoteSettings');
        strictEqual(original.remoteSettings.maxConcurrentStreams, 7);
        strictEqual(original.remoteSettings.maxHeaderListSize, 18000);
        server.updateSettings({
            get maxConcurrentStreams() { return ++updateReads === 1 ? 11 : 110; },
            maxHeaderListSize: 19000, maxHeaderSize: 20000,
        });
        next = http2.connect(authority);
        await once(next, 'remoteSettings');
        const ack = Promise.withResolvers<void>();
        original.ping(Buffer.alloc(8), error => error ? ack.reject(error) : ack.resolve());
        await ack.promise;
        strictEqual(original.remoteSettings.maxConcurrentStreams, 7);
        strictEqual(next.remoteSettings.maxConcurrentStreams, 11);
        strictEqual(next.remoteSettings.maxHeaderListSize, 20000);
        deepStrictEqual([initialReads, updateReads], [1, 1]);
    } finally {
        original?.destroy();
        next?.destroy();
        await closeServer(server);
    }
});

Deno.test('http2: request argument access cannot enqueue work on a terminated session', () => {
    const destroyed = new ClientHttp2Session();
    throws(() => destroyed.request({ get path() { destroyed.destroy(); return '/'; } }),
        { code: 'ERR_HTTP2_INVALID_SESSION' });
    strictEqual(destroyed.listenerCount('connect'), 0);

    const closed = new ClientHttp2Session();
    throws(() => closed.request({}, { get endStream() { closed.close(); return true; } }),
        { code: 'ERR_HTTP2_GOAWAY_SESSION' });
    strictEqual(closed.listenerCount('connect'), 0);
});

Deno.test('http2: request method tokens remain case-sensitive', () => {
    const session = new ClientHttp2Session();
    const requests: Array<{ headers: Array<[string, string]>; endStream: boolean }> = [];
    const conn = {
        request(headers: Array<[string, string]>, endStream: boolean) {
            requests.push({ headers, endStream });
            return {
                id: requests.length,
                localEnded: false,
                headerList: [],
                whenError() {},
                whenClosed() {},
                whenHeaders() {},
                sendData() {},
                abort() {},
            } as unknown as H2Stream;
        },
        destroy() {},
    };
    Reflect.set(session, 'conn', conn);

    const lowercaseGet = session.request({ ':method': 'get' });
    const lowercaseHead = session.request({ ':method': 'head' });
    const uppercaseHead = session.request({ ':method': 'HEAD' });

    deepStrictEqual(requests.map(({ headers, endStream }) => ({
        method: headers.find(([name]) => name === ':method')?.[1],
        endStream,
    })), [
        { method: 'get', endStream: false },
        { method: 'head', endStream: false },
        { method: 'HEAD', endStream: true },
    ]);
    strictEqual(lowercaseGet.writableEnded, false);
    strictEqual(lowercaseHead.writableEnded, false);
    strictEqual(uppercaseHead.writableEnded, true);
    session.destroy();
});

Deno.test('http2: ready listeners run after the connect dispatch for queued streams', async () => {
    const session = new ClientHttp2Session();
    const first = session.request();
    const second = session.request();
    let id = 1;
    const conn = {
        request() {
            const stream = new H2Stream(conn as unknown as ConstructorParameters<typeof H2Stream>[0], id, false);
            id += 2;
            return stream;
        },
        destroy() {},
    };
    Reflect.set(session, 'conn', conn);
    const ready: string[] = [];
    first.once('ready', () => ready.push('first'));
    second.once('ready', () => ready.push('second'));
    try {
        session.once('connect', () => ready.push('connect'));
        session.emit('connect');
        await new Promise<void>(resolve => queueMicrotask(resolve));
        strictEqual(first.destroyed, false);
        strictEqual(first.id, 1);
        strictEqual(second.id, 3);
        deepStrictEqual(ready, ['connect', 'first', 'second']);
    } finally {
        session.destroy();
    }
});

for (const method of ['GET', 'POST']) Deno.test({
    name: `http2: destroying one active ${method} stream resets its peer and preserves sibling requests`,
    ignore: !h2Available(),
    timeout: 15000,
}, async () => {
    const cancelled = Promise.withResolvers<http2.ServerHttp2Stream>();
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
        stream.on('error', () => {});
        if (headers[':path'] === '/cancel') {
            stream.resume();
            cancelled.resolve(stream);
        } else {
            stream.respond({ ':status': 200 });
            stream.end('sibling response');
        }
    });
    let session: http2.ClientHttp2Session | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        ok(address && typeof address === 'object');
        const activeSession = http2.connect(`http://127.0.0.1:${address.port}`);
        session = activeSession;
        activeSession.on('error', () => {});
        await once(activeSession, 'connect');
        const request = activeSession.request({ ':method': method, ':path': '/cancel' }, { endStream: method === 'GET' });
        request.on('error', () => {});
        if (method === 'POST') request.write('partial upload');
        const peer = await cancelled.promise;
        const peerClosed = once(peer, 'close');
        const requestClosed = once(request, 'close');
        request.destroy();
        await Promise.all([peerClosed, requestClosed]);
        strictEqual(peer.destroyed, true);
        strictEqual(activeSession.destroyed, false);
        const sibling = activeSession.request({ ':path': '/sibling' });
        const chunks: Buffer[] = [];
        sibling.on('data', chunk => chunks.push(chunk));
        await new Promise<void>((resolve, reject) => {
            sibling.once('end', resolve);
            sibling.once('error', reject);
        });
        strictEqual(Buffer.concat(chunks).toString(), 'sibling response');
    } finally {
        session?.destroy();
        await closeServer(server);
    }
});

Deno.test({
    name: 'http2: failed or closed connecting sessions settle queued request writes',
    ignore: !h2Available(),
    timeout: 15000,
}, async () => {
    const peer = net.createServer(socket => socket.destroy());
    try {
        await new Promise<void>((resolve, reject) => {
            peer.once('error', reject);
            peer.listen(0, '127.0.0.1', resolve);
        });
        const address = peer.address();
        ok(address && typeof address === 'object');
        for (const termination of ['peer-close', 'close', 'socket-close'] as const) {
            let socket: net.Socket | undefined;
            const session = http2.connect(`http://127.0.0.1:${address.port}`, termination === 'socket-close'
                ? { createConnection: () => { socket = new net.Socket(); return socket; } }
                : undefined);
            try {
                session.on('error', () => {});
                const request = session.request({ ':method': 'POST' }, { endStream: false });
                request.on('error', () => {});
                const closed = once(request, 'close');
                let closedSessions = 0;
                session.on('close', () => { closedSessions++; });
                const written = new Promise<Error | null>(resolve => {
                    request.write('pending body', error => resolve(error ?? null));
                });
                if (termination === 'close') session.close();
                if (termination === 'socket-close') socket!.destroy();
                const [, writeError] = await Promise.all([closed, written]);
                if (termination !== 'peer-close') ok(writeError instanceof Error);
                strictEqual(request.destroyed, true);
                strictEqual(session.closed, true);
                strictEqual(closedSessions, 1);
                strictEqual(session.listenerCount('connect'), 0);
                strictEqual(Reflect.get(session, 'pendingRequests').size, 0);
            } finally {
                session.destroy();
                socket?.destroy();
            }
        }
    } finally {
        await closeServer(peer);
    }
});

Deno.test({
    name: 'http2: duplicate attach destroys the unowned socket',
    ignore: !h2Available(),
    timeout: 15000,
}, async () => {
    const server = net.createServer(socket => socket.on('error', () => {}));
    const session = new ClientHttp2Session();
    session.on('error', () => {});
    let first: net.Socket | undefined;
    let second: net.Socket | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        ok(address && typeof address === 'object');
        first = net.connect(address.port, '127.0.0.1');
        await once(first, 'connect');
        session.attach(first, false);

        second = net.connect(address.port, '127.0.0.1');
        await once(second, 'connect');
        session.attach(second, false);
        strictEqual(second.destroyed, true);
        await once(second, 'close');
    } finally {
        session.destroy();
        first?.destroy();
        second?.destroy();
        await closeServer(server);
    }
});

Deno.test({
    name: 'http2: custom connections preserve authority and connect listener ordering',
    ignore: !h2Available(),
    timeout: 15000,
}, async () => {
    const server = http2.createServer();
    let socket: net.Socket | undefined;
    let session: http2.ClientHttp2Session | undefined;
    try {
        server.on('stream', stream => {
            stream.respond({ ':status': 200 });
            stream.end('custom');
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        ok(address && typeof address === 'object');
        const authority = `http://127.0.0.1:${address.port}`;
        const lifecycle: string[] = [];
        const options = {
            createConnection(target: string | URL, actual: http2.ClientSessionOptions) {
                strictEqual(new URL(target).origin, authority);
                strictEqual(actual.createConnection, options.createConnection);
                socket = net.connect({ port: address.port, host: '127.0.0.1' });
                return socket;
            },
        };
        const activeSession = http2.connect(authority, options, () => lifecycle.push('connect'));
        session = activeSession;
        const failure = Promise.withResolvers<never>();
        activeSession.on('error', failure.reject);
        const request = activeSession.request();
        request.once('ready', () => lifecycle.push('ready'));
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        await Promise.race([new Promise<void>((resolve, reject) => {
            request.once('end', resolve);
            request.once('error', reject);
        }), failure.promise]);
        strictEqual(activeSession.socket.remotePort, socket!.remotePort);
        strictEqual(request.id, 1);
        strictEqual(Buffer.concat(chunks).toString(), 'custom');
        deepStrictEqual(lifecycle, ['connect', 'ready']);
    } finally {
        session?.destroy();
        socket?.destroy();
        await closeServer(server);
    }
});

Deno.test({
    name: 'http2: connect request is not a throw-only stub when H2 is available',
    ignore: !h2Available(),
}, () => {
    // Structural: request method exists and is a function (not never-throw stub).
    const session = http2.connect('http://127.0.0.1:1');
    session.on('error', () => {});
    try {
        ok(typeof session.request === 'function');
    } finally {
        session.destroy();
    }
});

Deno.test({
    name: 'http2: createServer/connect fail closed when H2 gate forced missing',
}, () => {
    // Runs on H2-ON builds via __forceH2Unavailable (same path as embed OFF).
    __forceH2Unavailable(true);
    try {
        ok(h2Available() === false);
        try {
            http2.createServer();
            ok(false, 'expected createServer to throw without H2');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ok(/HTTP\/2|CNO_EMBED_EXT_H2|not available/i.test(msg), msg);
        }
        try {
            http2.connect('http://127.0.0.1:1');
            ok(false, 'expected connect to throw without H2');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ok(/HTTP\/2|CNO_EMBED_EXT_H2|not available/i.test(msg), msg);
        }
    } finally {
        __forceH2Unavailable(false);
    }
});

Deno.test({
    name: 'http2: request callback streams a flow-controlled POST body',
    ignore: !h2Available(),
    timeout: 20000,
}, async () => {
    const payload = Buffer.alloc(256 * 1024, 0x61);
    let callbackError: Error | null = null;
    const server = http2.createServer((request, response) => {
        try {
            strictEqual(request === response, false);
            strictEqual(request.method, 'POST');
            strictEqual(request.url, '/upload');
            strictEqual(request.httpVersion, '2.0');
            strictEqual(request.headers['x-test'], 'callback');
        } catch (error) {
            callbackError = error instanceof Error ? error : new Error(String(error));
        }
        let received = 0;
        request.on('data', (chunk: Buffer) => { received += chunk.byteLength; });
        request.on('end', () => {
            response.statusCode = 201;
            response.setHeader('content-type', 'text/plain');
            response.end(String(received));
        });
    });

    let session: http2.ClientHttp2Session | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.listen(0, '127.0.0.1', resolve);
            server.on('error', reject);
        });
        const addr = server.address();
        ok(addr && typeof addr === 'object' && 'port' in addr, 'server has port');
        const port = (addr as { port: number }).port;
        const activeSession = http2.connect(`http://127.0.0.1:${port}`);
        session = activeSession;
        await once(activeSession, 'connect');
        const request = activeSession.request({
            ':method': 'POST',
            ':path': '/upload',
            ':scheme': 'http',
            ':authority': `127.0.0.1:${port}`,
            'x-test': 'callback',
        }, { endStream: false });
        const chunks: Buffer[] = [];
        const responseHeaders = new Promise<Record<string, string | string[]>>((resolve, reject) => {
            request.on('response', resolve);
            request.on('error', reject);
        });
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        const ended = once(request, 'end');
        request.end(payload);

        const headers = await responseHeaders;
        await ended;
        if (callbackError) throw callbackError;
        strictEqual(String(headers[':status']), '201');
        strictEqual(headers['content-type'], 'text/plain');
        strictEqual(Buffer.concat(chunks).toString(), String(payload.byteLength));
    } finally {
        session?.destroy();
        await closeServer(server);
    }
});
