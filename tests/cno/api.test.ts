import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';

const engine = import.meta.use('engine');

function textBytes(text: string): Uint8Array {
    return engine.encodeString(text);
}

function decodeBytes(bytes: Uint8Array | ArrayBuffer): string {
    return engine.decodeString(bytes);
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

// specs/run/_071_location_unset: without --location, location is undefined.
Deno.test('location: undefined without --location (Deno default)', () => {
    strictEqual(globalThis.location, undefined);
    ok(typeof Location === 'function');
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
