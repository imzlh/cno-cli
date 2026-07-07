import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { dnsCache, clearDnsCache } from '../../http/src/dns-cache.ts';
import { HttpRequestBuilder, HttpResponseParser } from '../../http/src/h1.ts';
import { ALPN, HttpVersion, alpnToProtocol, defaultAlpnProtocols } from '../../http/src/protocol.ts';
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
    strictEqual(dnsCache.getStats().size, 0);
});
