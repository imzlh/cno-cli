import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { dnsCache, clearDnsCache } from '../../http/src/dns-cache.ts';
import { H1ServerConnection, HttpRequestBuilder, HttpResponseParser, h1 } from '../../http/src/h1.ts';
import type { H1ServerResponse } from '../../http/src/h1.ts';
import { ALPN, HttpVersion, alpnToProtocol, defaultAlpnProtocols } from '../../http/src/protocol.ts';
import type { ProtocolConnection, ProtocolStream, RawRequest } from '../../http/src/protocol.ts';
import type { TcpSocket } from '../../http/src/socket.ts';
import {
    StreamingCompressor,
    createCompressor,
    createDecompressor,
    parseAcceptEncoding,
    pickEncoding,
    shouldCompress,
} from '../../http/src/zlib.ts';

const engine = import.meta.use('engine');

function enc(s: string): Uint8Array {
    return new Uint8Array(engine.encodeString(s));
}

function dec(u8: Uint8Array): string {
    return engine.decodeString(u8);
}

function concat(...chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let off = 0;
    for (const chunk of chunks) {
        out.set(chunk, off);
        off += chunk.length;
    }
    return out;
}

async function fakeH1Client(responseText = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'):
    Promise<{ socket: TcpSocket; connection: ProtocolConnection; writes: Uint8Array[] }> {
    const writes: Uint8Array[] = [];
    const response = enc(responseText);
    let responseRead = false;
    const socket = {
        write: async (data: Uint8Array) => { writes.push(data.slice()); },
        read: async () => {
            if (responseRead) return null;
            responseRead = true;
            return response;
        },
        close: () => {},
    } as unknown as TcpSocket;
    const connection = await h1.client.connect(socket, {
        hostname: 'example.test', port: 80, secure: false,
    });
    return { socket, connection, writes };
}

function fakeH1Server(requestText: string, write?: (bytes: Uint8Array) => Promise<void>) {
    const writes: Uint8Array[] = [];
    const state = {
        closes: 0,
        readable: null as ((bytes: Uint8Array | null) => void) | null,
        error: null as ((fault: Error) => void) | null,
    };
    let request: Uint8Array | null = enc(requestText);
    const socket = {
        read: async () => {
            const bytes = request;
            request = null;
            return bytes;
        },
        write: async (bytes: Uint8Array) => {
            await write?.(bytes);
            writes.push(bytes.slice());
        },
        onReadable: (callback: (bytes: Uint8Array | null) => void, onError: (fault: Error) => void) => {
            state.readable = callback;
            state.error = onError;
        },
        stopReading: () => { state.readable = null; state.error = null; },
        close: () => { state.closes++; },
    } as unknown as TcpSocket;
    return { connection: new H1ServerConnection(socket, false), writes, state };
}

Deno.test('http h1: server responses and streams retain their own keep-alive exchange', async () => {
    const { connection, writes, state } = fakeH1Server(
        'GET /first HTTP/1.1\r\nHost: local\r\n\r\nGET /second HTTP/1.1\r\nHost: local\r\n\r\nGET /empty HTTP/1.1\r\nHost: local\r\n\r\n',
    );
    const connectionOwner: ProtocolConnection = connection;
    let firstResponse: H1ServerResponse | undefined;
    let firstStream: ProtocolStream | undefined;
    let terminalCloses = 0;
    connection.onTerminalClose(() => { terminalCloses++; });
    try {
        strictEqual(await connection.handleRequest(async () => {
            firstResponse = connection.currentResponse;
            firstStream = connection.createStream();
            await firstResponse.writeHead(200, 'OK', [['content-length', '5']]);
            await firstResponse.writeData('first');
            await firstResponse.release();
            await firstResponse.endResponse('late');
            firstResponse.close();
            strictEqual(state.closes, 0, 'release must detach before the handler returns');
            strictEqual(terminalCloses, 0, 'response release is not a terminal connection event');
        }), true);
        strictEqual(await connection.handleRequest(async () => {
            const response = connection.currentResponse;
            ok(firstResponse);
            ok(firstStream);
            ok(firstResponse !== response);
            const count = writes.length;
            await rejects(firstResponse.writeHead(500, 'Late', []), /Response already ended/);
            await rejects(firstResponse.writeData('late'), /Response already ended/);
            await firstResponse.endResponse('late');
            firstResponse.close();
            await rejects(firstStream.writeData(enc('late')), /Response already ended/);
            await firstStream.end(enc('late'));
            firstStream.abort();
            firstStream.close();
            const firstRequest = await firstStream.readMessage();
            ok('method' in firstRequest);
            strictEqual(firstRequest.url, '/first');
            strictEqual(writes.length, count);
            strictEqual(state.closes, 0);
            await response.endResponse('second');
        }), true);
        strictEqual(await connection.handleRequest(async () => {
            await connection.currentResponse.endResponse();
        }), true);
        const wire = dec(concat(...writes));
        strictEqual(wire.match(/HTTP\/1.1 200 OK/g)?.length, 3);
        ok(wire.includes('\r\n\r\nfirstHTTP/1.1 200 OK'), 'first response body must precede the next response');
        ok(wire.includes('transfer-encoding: chunked\r\n'));
        ok(wire.includes('\r\n\r\n6\r\nsecond\r\n0\r\n\r\nHTTP/1.1'));
        ok(wire.includes('content-length: 0\r\n'));
        ok(wire.endsWith('\r\n\r\n'));
        ok(!wire.includes('late'));
        ok(firstResponse);
        firstResponse.close();
        strictEqual(state.closes, 0, 'an old response cannot close the idle keep-alive transport');
        connectionOwner.close();
        strictEqual(state.closes, 1, 'the connection owner must still close the idle transport');
        strictEqual(terminalCloses, 1);
        connectionOwner.close();
        strictEqual(state.closes, 1);
    } finally {
        connection.close();
    }
    strictEqual(terminalCloses, 1);
});

Deno.test('http h1: response end joins pending writes before releasing the exchange', async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { connection, writes } = fakeH1Server('GET / HTTP/1.1\r\nHost: local\r\n\r\n', async bytes => {
        if (dec(bytes) === '2\r\nab\r\n') {
            blocked.resolve();
            await release.promise;
        }
    });
    let response: H1ServerResponse | undefined;
    let ending: Promise<void> | undefined;
    let handled = false;
    const handling = connection.handleRequest(() => {
        response = connection.currentResponse;
        ending = response.endResponse('ab');
    }).then(keepAlive => { handled = true; return keepAlive; });
    try {
        await blocked.promise;
        ok(response);
        connection.beginDrain();
        const duplicate = response.endResponse('ignored');
        await rejects(response.writeData('late'), /Response already ended/);
        strictEqual(handled, false, 'a queued response must retain its exchange until the write finishes');
        ok(!dec(concat(...writes)).includes('0\r\n\r\n'));
        release.resolve();
        await Promise.all([ending, duplicate]);
        strictEqual(await handling, false, 'graceful drain must wait for the response without keeping the connection alive');
        const wire = dec(concat(...writes));
        strictEqual(wire.match(/HTTP\/1.1 200 OK/g)?.length, 1);
        ok(wire.endsWith('2\r\nab\r\n0\r\n\r\n'));
    } finally {
        release.resolve();
        connection.close();
        await handling;
    }
});

Deno.test('http h1: response release finishes framing and rejects short content lengths', async () => {
    const { connection, writes } = fakeH1Server('GET / HTTP/1.1\r\nHost: local\r\n\r\n');
    strictEqual(await connection.handleRequest(async () => {
        const response = connection.currentResponse;
        await response.writeData('partial');
    }), true);
    const wire = dec(concat(...writes));
    ok(wire.endsWith('7\r\npartial\r\n0\r\n\r\n'), 'release must terminate chunked framing');
    connection.close();

    const short = fakeH1Server('GET / HTTP/1.1\r\nHost: local\r\n\r\n');
    await rejects(short.connection.handleRequest(async () => {
        const response = short.connection.currentResponse;
        await response.writeHead(200, 'OK', [['content-length', '3']]);
        await response.writeData('x');
    }), /response body does not match Content-Length/);
    strictEqual(dec(concat(...short.writes)).match(/HTTP\/1\.1 200 OK/g)?.length, 1);
    short.connection.close();
});

Deno.test('http h1: response release reports queued transport and framing failures', async () => {
    const fault = Object.assign(new Error('queued write failed'), { code: 'EPIPE' });
    for (const failureType of ['transport', 'framing', 'unawaited-framing'] as const) {
        const { connection, writes } = fakeH1Server('GET / HTTP/1.1\r\nHost: local\r\n\r\n', async () => {
            if (failureType === 'transport') throw fault;
        });
        let response: H1ServerResponse | undefined;
        let ending: Promise<void> | undefined;
        let writeError: unknown;
        try {
            await rejects(connection.handleRequest(async () => {
                response = connection.currentResponse;
                if (failureType === 'unawaited-framing') {
                    void response.writeHead(200, 'OK', [['content-length', 'invalid']])
                        .catch(error => { writeError = error; });
                    return;
                }
                if (failureType === 'framing') await response.writeHead(200, 'OK', [['content-length', '2']]);
                ending = response.endResponse('x');
                ending.catch(error => { writeError = error; });
            }), error => {
                strictEqual(error, writeError, 'release must preserve the queued operation error');
                if (failureType === 'transport') strictEqual(error, fault);
                else if (failureType === 'unawaited-framing') ok(error instanceof Error && /invalid Content-Length/.test(error.message));
                else ok(error instanceof Error && /does not match Content-Length/.test(error.message));
                return true;
            });
            ok(response);
            await rejects(response.writeData('late'), error => error === writeError);
            strictEqual(writes.length, failureType === 'framing' ? 2 : 0);
        } finally {
            connection.close();
            await ending?.catch(() => {});
        }
    }
});

Deno.test('http h1: queued heads permit informational responses only before the final head', async () => {
    const blocked = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const { connection, writes } = fakeH1Server('GET / HTTP/1.1\r\nHost: local\r\n\r\n', async bytes => {
        if (dec(bytes).startsWith('HTTP/1.1 200')) {
            blocked.resolve();
            await unblock.promise;
        }
    });
    const handling = connection.handleRequest(async () => {
        const response = connection.currentResponse;
        await response.writeHead(103, 'Early Hints', [['link', '</style.css>; rel=preload']]);
        strictEqual(response.headersSent, false);
        const head = response.writeHead(200, 'OK', [['content-length', '2']]);
        const duplicate = rejects(response.writeHead(201, 'Duplicate', []), /Headers already sent/);
        const lateHints = rejects(response.writeHead(103, 'Late Hints', []), /Headers already sent/);
        await head;
        strictEqual(response.headersSent, true);
        await Promise.all([duplicate, lateHints]);
        await response.endResponse('ok');
    });
    handling.catch(() => {});
    try {
        await blocked.promise;
        strictEqual(connection.currentResponse.headersSent, false);
        unblock.resolve();
        strictEqual(await handling, true, 'rejected duplicate heads must not poison the valid response');
        const wire = dec(concat(...writes));
        strictEqual(wire.match(/HTTP\/1.1 /g)?.length, 2);
        ok(wire.endsWith('\r\n\r\nok'));
    } finally {
        unblock.resolve();
        connection.close();
        await handling.catch(() => {});
    }
});

for (const code of ['ECONNRESET', 'EPIPE']) {
    Deno.test(`http h1: an unfinished response preserves its terminal ${code}`, async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const fault = Object.assign(new Error('peer gone'), { code });
        const { connection, state } = fakeH1Server('GET / HTTP/1.1\r\nHost: local\r\n\r\n');
        let response: H1ServerResponse | undefined;
        const handling = connection.handleRequest(async () => {
            response = connection.currentResponse;
            entered.resolve();
            await release.promise;
        });
        try {
            await entered.promise;
            ok(state.error);
            state.error(fault);
            strictEqual(await handling, false);
            ok(response);
            await rejects(response.writeData('late'), error => error === fault);
            await rejects(response.endResponse(), error => error === fault);
            response.close();
            strictEqual(state.closes, 1);
        } finally {
            release.resolve();
            connection.close();
            await handling;
        }
    });
}

Deno.test('http h1: connection owner force close releases a reused exchange with a blocked response write', async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let blockWrites = false;
    const { connection, state, writes } = fakeH1Server(
        'GET /first HTTP/1.1\r\nHost: local\r\n\r\nGET /second HTTP/1.1\r\nHost: local\r\n\r\n',
        async () => {
            if (!blockWrites) return;
            blocked.resolve();
            await release.promise;
        },
    );
    const connectionOwner: ProtocolConnection = connection;
    let firstResponse: H1ServerResponse | undefined;
    strictEqual(await connection.handleRequest(async () => {
        firstResponse = connection.currentResponse;
        await firstResponse.endResponse();
    }), true);
    const completedWrites = writes.length;
    blockWrites = true;
    let response: H1ServerResponse | undefined;
    let ending: Promise<void> | undefined;
    const handling = connection.handleRequest(() => {
        response = connection.currentResponse;
        ending = response.endResponse('blocked');
    });
    try {
        await blocked.promise;
        ok(firstResponse);
        firstResponse.close();
        strictEqual(state.closes, 0, 'the first response cannot close the active second exchange');
        connectionOwner.close();
        strictEqual(await handling, false, 'terminal close must not wait for the blocked writer');
        strictEqual(state.closes, 1);
        release.resolve();
        ok(ending);
        await rejects(ending);
        strictEqual(writes.length, completedWrites + 1, 'a released response must not enqueue body bytes after its blocked header');
        ok(response);
        response.close();
        strictEqual(state.closes, 1);
    } finally {
        release.resolve();
        connection.close();
        await ending?.catch(() => {});
        await handling;
    }
});

Deno.test('http h1: response drain policy and upgrade handoff keep transport ownership', async () => {
    const { connection, writes, state } = fakeH1Server(
        'GET / HTTP/1.1\r\nHost: local\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\nleftover',
    );
    let response: H1ServerResponse | undefined;
    try {
        strictEqual(await connection.handleRequest(async () => {
            response = connection.currentResponse;
            await response.writeHead(101, 'Switching Protocols', [['connection', 'Upgrade'], ['upgrade', 'echo']]);
            response.markUpgraded();
            await response.endResponse();
            response.close();
            await rejects(response.writeData('late'), /Response already ended/);
        }), false);
        strictEqual(state.closes, 0);
        strictEqual(dec(connection.takeUpgradeLeftover()!), 'leftover');
        connection.beginDrain();
        strictEqual(state.closes, 0, 'a graceful drain must exclude the upgraded transport');
        ok(dec(concat(...writes)).includes('connection: Upgrade\r\n'));
    } finally {
        connection.close();
    }
});

Deno.test('http h1: client request drains StreamPoll with chunked framing', async () => {
    const { connection, writes } = await fakeH1Client();
    const chunks: Array<Uint8Array | null> = [enc('ab'), enc('cd'), null];
    const req: RawRequest = {
        method: 'POST', url: '/upload', headers: [['host', 'example.test']],
        httpVersion: '1.1', body: async () => chunks.shift() ?? null,
    };

    const response = await h1.client.request(connection, req);
    strictEqual(response.status, 200);
    const wire = dec(concat(...writes));
    ok(wire.includes('transfer-encoding: chunked\r\n'));
    ok(wire.endsWith('2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n'));
});

Deno.test('http h1: ProtocolStream sends request data and validates Content-Length', async () => {
    const { connection, writes } = await fakeH1Client();
    const stream = connection.createStream();
    const req: RawRequest = {
        method: 'POST', url: '/upload', headers: [
            ['host', 'example.test'], ['content-length', '4'],
        ], httpVersion: '1.1', body: async () => null,
    };

    await stream.writeHead(req);
    await stream.writeData(enc('ab'));
    await stream.end(enc('cd'));
    const response = await stream.readMessage();
    if ('method' in response) throw new Error('expected an HTTP response');
    strictEqual(response.status, 200);
    const wire = dec(concat(...writes));
    ok(wire.endsWith('ab' + 'cd'));
    ok(!wire.includes('transfer-encoding: chunked\r\n'));
});

Deno.test('http h1: a null request body ends at the head', async () => {
    const { connection, writes } = await fakeH1Client();
    const stream = connection.createStream();
    await stream.writeHead({
        method: 'GET', url: '/', headers: [['host', 'example.test']],
        httpVersion: '1.1', body: null,
    });
    const response = await stream.readMessage();
    if ('method' in response) throw new Error('expected an HTTP response');
    strictEqual(response.status, 200);
    ok(!dec(concat(...writes)).includes('transfer-encoding: chunked\r\n'));
});

Deno.test('http h1: request builder emits defaults without overriding explicit headers', () => {
    const body = enc('hello');
    const builder = new HttpRequestBuilder({
        method: 'post',
        path: '/submit',
        host: 'example.test',
        headers: [['accept', 'application/json'], ['connection', 'close']],
        body,
    });

    const text = dec(builder.build());
    ok(text.startsWith('POST /submit HTTP/1.1\r\n'));
    ok(text.includes('host: example.test\r\n'));
    ok(text.includes('content-length: 5\r\n'));
    ok(text.includes('accept: application/json\r\n'));
    ok(!text.includes('accept: text/html'));
    ok(text.includes('connection: close\r\n'));
    ok(text.endsWith('\r\n\r\nhello'));
});

Deno.test('http h1: request builder supports full URL request-target and HTTP/1.0 close', () => {
    const builder = new HttpRequestBuilder({
        method: 'GET',
        host: 'proxy.test',
        useFullUrl: 'http://proxy.test/resource?q=1',
        httpVersion: '1.0',
    });

    const text = dec(builder.build());
    ok(text.startsWith('GET http://proxy.test/resource?q=1 HTTP/1.0\r\n'));
    ok(text.includes('host: proxy.test\r\n'));
    ok(text.includes('connection: close\r\n'));
});

Deno.test('http h1: response parser handles incremental headers and body', () => {
    const parser = new HttpResponseParser();
    const data: Uint8Array[] = [];
    let complete = false;
    let seenStatus = 0;
    let seenHeaders: Array<[string, string]> = [];

    parser.onHeadersComplete = (status, headers) => {
        seenStatus = status;
        seenHeaders = headers;
    };
    parser.onData = (chunk) => data.push(chunk);
    parser.onComplete = () => { complete = true; };

    parser.feed(enc('HTTP/1.1 201 Created\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhe'));
    strictEqual(parser.isHeadersComplete, true);
    strictEqual(seenStatus, 201);
    deepStrictEqual(seenHeaders, [['content-type', 'text/plain'], ['content-length', '5']]);
    parser.feed(enc('llo'));

    strictEqual(complete, true);
    strictEqual(parser.isCompleted, true);
    strictEqual(parser.getStatusCode(), 201);
    strictEqual(parser.getStatusText(), 'Created');
    strictEqual(parser.getHttpVersion(), '1.1');
    strictEqual(dec(concat(...data)), 'hello');
});

Deno.test('http h1: response parser joins callback fragments across feed boundaries', () => {
    const parser = new HttpResponseParser();
    parser.feed(enc('HTTP/1.1 200 O'));
    parser.feed(enc('K\r\nContent-Len'));
    parser.feed(enc('gth: 3\r\nX-Test: a'));
    parser.feed(enc('bc\r\n\r\nxyz'));

    strictEqual(parser.getStatusText(), 'OK');
    deepStrictEqual(parser.getHeaders(), [
        ['content-length', '3'],
        ['x-test', 'abc'],
    ]);
    strictEqual(dec(concat(...parser.getBodyChunks())), 'xyz');
});

Deno.test('http h1: response parser buffers body when no data callback is set', () => {
    const parser = new HttpResponseParser();
    parser.feed(enc('HTTP/1.0 204 No Content\r\nContent-Length: 0\r\n\r\n'));
    strictEqual(parser.isCompleted, true);
    strictEqual(parser.isHttp10, true);
    strictEqual(parser.getStatusCode(), 204);
    deepStrictEqual(parser.getBodyChunks(), []);

    parser.reset();
    parser.feed(enc('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody'));
    const chunks = parser.getBodyChunks();
    strictEqual(dec(concat(...chunks)), 'body');
    deepStrictEqual(parser.getBodyChunks(), []);
});

Deno.test('http h1: parse errors call onError instead of throwing when installed', () => {
    const parser = new HttpResponseParser();
    let error: Error | null = null;
    parser.onError = (err) => { error = err; };
    parser.feed(enc('not a response\r\n\r\n'));
    ok(error);
    ok(error.message.includes('HTTP parse error'));

    const throwingParser = new HttpResponseParser();
    throws(() => throwingParser.feed(enc('not a response\r\n\r\n')), /HTTP parse error/);
});

Deno.test('http h1: response parser skips informational responses and preserves final body', () => {
    const parser = new HttpResponseParser();
    const statuses: number[] = [];
    const body: Uint8Array[] = [];
    parser.onHeadersComplete = (status) => statuses.push(status);
    parser.onData = (chunk) => body.push(chunk);
    parser.feed(enc('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello'));
    deepStrictEqual(statuses, [200]);
    strictEqual(dec(concat(...body)), 'hello');
    strictEqual(parser.getStatusCode(), 200);
});

Deno.test('http h1: response parser handles informational response split across reads', () => {
    const parser = new HttpResponseParser();
    const statuses: number[] = [];
    const body: Uint8Array[] = [];
    parser.onHeadersComplete = (status) => statuses.push(status);
    parser.onData = (chunk) => body.push(chunk);
    parser.feed(enc('HTTP/1.1 100 Continue\r\n\r\n'));
    parser.feed(enc('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'));
    deepStrictEqual(statuses, [200]);
    strictEqual(dec(concat(...body)), 'ok');
    strictEqual(parser.isCompleted, true);
});

Deno.test('http h1: gzip response validates and emits complete decoded body', () => {
    const source = enc('compressed response payload');
    const compressed = createCompressor('gzip')!(source);
    const parser = new HttpResponseParser();
    const body: Uint8Array[] = [];
    parser.onData = (chunk) => body.push(chunk);
    const head = enc(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${compressed.length}\r\n\r\n`);
    parser.feed(concat(head, compressed));
    strictEqual(dec(concat(...body)), dec(source));
    strictEqual(parser.isCompleted, true);
});

Deno.test('http h1: truncated gzip response fails completion', () => {
    const source = enc('truncated compressed response');
    const compressed = createCompressor('gzip')!;
    const truncated = compressed(source).slice(0, -8);
    const parser = new HttpResponseParser();
    parser.feed(concat(
        enc(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${truncated.length}\r\n\r\n`),
        truncated,
    ));
    parser.finishOnEof();
    strictEqual(parser.isCompleted, false);
});

Deno.test('http zlib: accept-encoding ignores q=0 and picks supported codecs', () => {
    deepStrictEqual(parseAcceptEncoding('br, gzip;q=0.8, deflate, gzip'), ['gzip', 'deflate']);
    deepStrictEqual(parseAcceptEncoding('gzip;q=0, deflate;q=0.5'), ['deflate']);
    deepStrictEqual(parseAcceptEncoding('gzip;q=0, deflate;q=0'), []);
    strictEqual(pickEncoding(['deflate', 'gzip']), 'gzip');
    strictEqual(pickEncoding(['deflate']), 'deflate');
    strictEqual(pickEncoding([]), null);
});

Deno.test('http zlib: compression predicates cover text and structured types', () => {
    strictEqual(shouldCompress('text/html; charset=utf-8'), true);
    strictEqual(shouldCompress('application/json'), true);
    strictEqual(shouldCompress('application/ld+json'), true);
    strictEqual(shouldCompress('application/octet-stream'), false);
    strictEqual(shouldCompress(null), false);
});

Deno.test('http zlib: one-shot and streaming gzip round-trip bytes', () => {
    const gzip = createCompressor('gzip')!;
    const gunzip = createDecompressor('gzip')!;
    strictEqual(dec(gunzip(gzip(enc('payload')))), 'payload');
    strictEqual(createCompressor('br'), null);
    strictEqual(createDecompressor('br'), null);

    const streaming = new StreamingCompressor('gzip');
    const compressed = concat(streaming.compress(enc('pay')), streaming.compress(enc('load')), streaming.finish());
    strictEqual(dec(gunzip(compressed)), 'payload');
});

Deno.test('http protocol: ALPN helpers map supported protocol versions', () => {
    strictEqual(alpnToProtocol(ALPN.HTTP11), HttpVersion.HTTP11);
    strictEqual(alpnToProtocol(ALPN.HTTP2), HttpVersion.HTTP2);
    strictEqual(alpnToProtocol('unknown'), null);
    deepStrictEqual(defaultAlpnProtocols([HttpVersion.HTTP2, HttpVersion.HTTP11, HttpVersion.HTTP10]), [
        ALPN.HTTP2,
        ALPN.HTTP11,
        ALPN.HTTP10,
    ]);
});

Deno.test('http dns-cache: literal addresses resolve without touching cache', async () => {
    clearDnsCache();
    try {
        deepStrictEqual(await dnsCache.resolve('127.0.0.1'), [{ ip: '127.0.0.1', family: 4 }]);
        deepStrictEqual(dnsCache.resolveSync('::1'), [{ ip: '::1', family: 6 }]);
        deepStrictEqual(dnsCache.resolveSync('::ffff:192.0.2.128'), [{ ip: '::ffff:192.0.2.128', family: 6 }]);
        strictEqual(dnsCache.getStats().size, 0, 'literals must not be cached');

        for (const invalid of ['::::', '1::2::3', '1:::2', '192.0.2.1::']) {
            let resolved: ReturnType<typeof dnsCache.resolveSync>;
            try {
                resolved = dnsCache.resolveSync(invalid);
            } catch {
                // A resolver rejection is also proof that the value was not accepted as a literal.
                continue;
            }
            ok(!resolved.some((entry) => entry.ip === invalid), `${invalid} must not be treated as a literal`);
        }
        // The cache rejects padded IPv4 text as a literal, but libc may either
        // resolve or reject it. Check only the cache side effect, not the
        // platform's returned spelling.
        clearDnsCache();
        let paddedResolved = false;
        try {
            dnsCache.resolveSync('001.2.3.4');
            paddedResolved = true;
        } catch {
            // musl and other resolvers may reject the padded form.
        }
        strictEqual(dnsCache.getStats().size, paddedResolved ? 1 : 0);
    } finally {
        clearDnsCache();
    }
});
