import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { dnsCache, clearDnsCache } from '../../http/src/dns-cache.ts';
import { HttpRequestBuilder, HttpResponseParser, h1 } from '../../http/src/h1.ts';
import { ALPN, HttpVersion, alpnToProtocol, defaultAlpnProtocols } from '../../http/src/protocol.ts';
import type { ProtocolConnection, RawRequest } from '../../http/src/protocol.ts';
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
    deepStrictEqual(await dnsCache.resolve('127.0.0.1'), [{ ip: '127.0.0.1', family: 4 }]);
    deepStrictEqual(dnsCache.resolveSync('::1'), [{ ip: '::1', family: 6 }]);
    deepStrictEqual(dnsCache.resolveSync('::ffff:192.0.2.128'), [{ ip: '::ffff:192.0.2.128', family: 6 }]);

    for (const invalid of ['::::', '1::2::3', '1:::2', '192.0.2.1::', '001.2.3.4']) {
        try {
            const resolved = dnsCache.resolveSync(invalid);
            ok(!resolved.some((entry) => entry.ip === invalid), `${invalid} must not be treated as a literal`);
        } catch {
            // A resolver rejection is also proof that the value was not accepted as a literal.
        }
    }
    strictEqual(dnsCache.getStats().size, 0);
});
