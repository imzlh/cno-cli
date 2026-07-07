import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';

function textBytes(text: string): Uint8Array {
    return CNO.engine.encodeString(text);
}

function decodeBytes(bytes: Uint8Array | ArrayBuffer): string {
    return CNO.engine.decodeString(bytes);
}

function concatBytes(...chunks: Array<Uint8Array | ArrayBuffer>): Uint8Array {
    const views = chunks.map((chunk) => chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    const out = new Uint8Array(views.reduce((n, chunk) => n + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of views) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

async function streamText(body: ReadableStream<Uint8Array> | null): Promise<string> {
    if (!body) return '';
    return decodeBytes(await new Response(body).arrayBuffer());
}

Deno.test('CNO.engine: string codec and serialize round trip structured data', () => {
    const bytes = CNO.engine.encodeString('hello \u2713');
    ok(bytes instanceof Uint8Array);
    strictEqual(CNO.engine.decodeString(bytes), 'hello \u2713');
    strictEqual(CNO.engine.decodeString(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), 'hello \u2713');

    const encoded = CNO.engine.serialize({ name: 'cno', values: [1, 2, 3], nested: { ok: true } });
    ok(encoded instanceof Uint8Array);
    deepStrictEqual(CNO.engine.deserialize(encoded), {
        name: 'cno',
        values: [1, 2, 3],
        nested: { ok: true },
    });
});

Deno.test('CNO.engine: compileModule emits bytecode and evalModule runs module side effects', async () => {
    const bytecode = CNO.engine.compileModule('export const value = 42;');
    ok(bytecode instanceof Uint8Array);
    ok(bytecode.byteLength > 0);

    Reflect.deleteProperty(globalThis, '__cnoEvalModuleMarker');
    await CNO.engine.evalModule('globalThis.__cnoEvalModuleMarker = "ran"; export {};');
    strictEqual(Reflect.get(globalThis, '__cnoEvalModuleMarker'), 'ran');
    Reflect.deleteProperty(globalThis, '__cnoEvalModuleMarker');
});

Deno.test('CNO.engine: versions and gc expose stable runtime shape', () => {
    ok(CNO.engine.versions && typeof CNO.engine.versions === 'object');
    ok(typeof CNO.engine.versions.quickjs === 'string' && CNO.engine.versions.quickjs.length > 0);
    ok(typeof CNO.engine.versions.core === 'string' && CNO.engine.versions.core.length > 0);
    ok(CNO.engine.gc && typeof CNO.engine.gc.run === 'function');
    const threshold = CNO.engine.gc.getThreshold();
    ok(typeof threshold === 'number');
});

Deno.test('CNO.compress: one-shot deflate and gzip round trip bytes', () => {
    const payload = textBytes('compressible payload'.repeat(8));

    strictEqual(decodeBytes(CNO.compress.inflate(CNO.compress.deflate(payload, CNO.compress.BEST_SPEED))), decodeBytes(payload));
    strictEqual(decodeBytes(CNO.compress.gunzip(CNO.compress.gzip(payload, CNO.compress.BEST_COMPRESSION))), decodeBytes(payload));

    strictEqual(CNO.compress.crc32(textBytes('abc')), 0x352441c2);
    strictEqual(CNO.compress.adler32(textBytes('abc')), 0x024d0127);
    strictEqual(typeof CNO.compress.DEFAULT_COMPRESSION, 'number');
    strictEqual(typeof CNO.compress.NO_COMPRESSION, 'number');
});

Deno.test('CNO.compress: streaming gzip and gunzip can be chunked and reset', () => {
    const gzip = CNO.compress.createGzip(CNO.compress.BEST_SPEED);
    const compressed = concatBytes(
        gzip.deflate(textBytes('stream ')),
        gzip.deflate(textBytes('payload')),
        gzip.finish(),
    );

    const gunzip = CNO.compress.createGunzip();
    const plain = concatBytes(
        gunzip.inflate(compressed.subarray(0, 5)),
        gunzip.inflate(compressed.subarray(5)),
    );
    strictEqual(decodeBytes(plain), 'stream payload');

    gzip.reset();
    strictEqual(decodeBytes(CNO.compress.gunzip(gzip.finish(textBytes('again')))), 'again');
});

Deno.test('CNO.llhttp: formats and parses requests with body and headers', async () => {
    const raw = CNO.llhttp.formatRequest('POST', '/submit?q=1', new Headers([['X-Test', 'yes']]), 'body');
    const text = decodeBytes(raw);
    ok(text.startsWith('POST /submit?q=1 HTTP/1.1\r\n'));
    ok(text.includes('x-test: yes\r\n'));
    ok(text.includes('content-length: 4\r\n'));
    ok(text.endsWith('\r\n\r\nbody'));

    const parsed = CNO.llhttp.parseRequest(raw);
    strictEqual(parsed.method, 'POST');
    strictEqual(parsed.url, '/submit?q=1');
    strictEqual(parsed.httpVersion, '1.1');
    strictEqual(parsed.headers.get('x-test'), 'yes');
    strictEqual(parsed.headers.get('content-length'), '4');
    strictEqual(await streamText(parsed.body), 'body');
});

Deno.test('CNO.llhttp: formats and parses responses and converts to Web Response', async () => {
    const raw = CNO.llhttp.formatResponse(201, 'Created', new Headers([['Content-Type', 'text/plain']]), 'ok');
    const parsed = CNO.llhttp.parseResponse(raw);
    strictEqual(parsed.statusCode, 201);
    strictEqual(parsed.statusText, 'Created');
    strictEqual(parsed.headers.get('content-type'), 'text/plain');
    strictEqual(await streamText(parsed.body), 'ok');

    const response = CNO.llhttp.toWebResponse(CNO.llhttp.parseResponse(raw));
    strictEqual(response.status, 201);
    strictEqual(response.statusText, 'Created');
    strictEqual(await response.text(), 'ok');
});

Deno.test('CNO.llhttp: streaming request parser reports expect-continue and parse errors', () => {
    const messages: CNO.HttpRequestMessage[] = [];
    const errors: Error[] = [];
    const parser = CNO.llhttp.createRequestStreamParser((msg) => messages.push(msg), (err) => errors.push(err));

    parser.feed(textBytes('POST /upload HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\nExpect: 100-continue\r\nContent-Length: 0\r\n\r\n'));
    strictEqual(parser.expectContinue, true);
    strictEqual(messages.length, 1);
    strictEqual(messages[0].headers.get('expect'), '100-continue');

    parser.reset();
    parser.feed(textBytes('not http\r\n\r\n'));
    strictEqual(messages.length, 1);
    strictEqual(errors.length, 1);
    ok(errors[0].message.includes('HTTP parse error'));
});

Deno.test('CNO.llhttp: Web Request/Response conversion preserves method, URL and body', async () => {
    const request = new Request('http://example.test/path', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
    });
    const requestMessage = CNO.llhttp.fromWebRequest(request);
    strictEqual(requestMessage.method, 'POST');
    strictEqual(requestMessage.url, 'http://example.test/path');
    strictEqual(requestMessage.headers.get('content-type'), 'text/plain');
    strictEqual(await streamText(requestMessage.body), 'hello');

    const responseMessage = await CNO.llhttp.fromWebResponse(new Response('world', {
        status: 202,
        statusText: 'Accepted',
        headers: { 'x-response': 'yes' },
    }));
    strictEqual(responseMessage.statusCode, 202);
    strictEqual(responseMessage.statusText, 'Accepted');
    strictEqual(responseMessage.headers.get('x-response'), 'yes');
    strictEqual(await streamText(responseMessage.body), 'world');
});

Deno.test('CNO.ssl: exposes version and can inspect generated PEM', () => {
    ok(typeof CNO.ssl.version === 'string' && CNO.ssl.version.length > 0);

    const cert = CNO.ssl.createSelfSignedCert({ commonName: 'cno.test', days: 1 });
    ok(cert.cert.includes('BEGIN CERTIFICATE'));
    ok(cert.key.includes('BEGIN'));
    const info = CNO.ssl.loadPEM(cert.cert, 'certificate');
    ok(info);
    ok(typeof info.type === 'string' || typeof info.subject === 'string' || typeof info.bits === 'number');
});

Deno.test('location: about:blank URL shape and unsupported navigation methods', () => {
    strictEqual(location.href, 'about:blank');
    strictEqual(location.protocol, 'about:');
    strictEqual(location.origin, 'null');
    strictEqual(location.ancestorOrigins.length, 0);
    strictEqual(location.ancestorOrigins.contains('https://example.test'), false);
    strictEqual(location.ancestorOrigins.item(0), null);
    throws(() => location.assign('https://example.test/'), /Not supported/);
    throws(() => location.reload(), /Not supported/);
    throws(() => location.replace('https://example.test/'), /Not supported/);
});

Deno.test('reportError: dispatches ErrorEvent without throwing', () => {
    const error = new Error('reported');
    let seen: ErrorEvent | null = null;
    const onError = (event: ErrorEvent) => {
        seen = event;
        event.preventDefault();
    };

    globalThis.addEventListener('error', onError, { once: true });
    try {
        reportError(error);
    } finally {
        globalThis.removeEventListener('error', onError);
    }

    ok(seen instanceof ErrorEvent);
    strictEqual(seen.message, 'reported');
    strictEqual(seen.error, error);
});

Deno.test('global timers: queueMicrotask and setImmediate validate callbacks', async () => {
    throws(() => queueMicrotask('bad' as unknown as () => void), TypeError);
    throws(() => setImmediate('bad' as unknown as () => void), TypeError);

    let order = '';
    const done = new Promise<void>((resolve) => {
        setImmediate((value: string) => {
            order += value;
            resolve();
        }, 'immediate');
    });
    order += 'sync:';
    await done;
    strictEqual(order, 'sync:immediate');
});
