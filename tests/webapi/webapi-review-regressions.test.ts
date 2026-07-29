import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert';

Deno.test('Web API regressions: iterable Headers and Blob parts follow sequence conversion', () => {
    const headers = new Headers([new Set(['x-sequence', 'value']) as unknown as [string, string]]);
    strictEqual(headers.get('x-sequence'), 'value');

    const record: Record<string, string> = {};
    Object.defineProperty(record, 'hidden', { value: 'nope', enumerable: false });
    record.visible = 'yes';
    strictEqual(new Headers(record).has('hidden'), false);
    strictEqual(new Headers(record).get('visible'), 'yes');

    strictEqual(new Blob(new Set(['a', 'b']) as unknown as BlobPart[]).size, 2);
    throws(() => new Blob(null as unknown as BlobPart[]), TypeError);
});

Deno.test('Web API regressions: Abort reasons preserve explicit null', () => {
    strictEqual(AbortSignal.abort(null).reason, null);
    const controller = new AbortController();
    controller.abort(null);
    strictEqual(controller.signal.reason, null);
});

Deno.test('Web API regressions: Request body metadata and following signals', async () => {
    const source = new AbortController();
    const request = new Request('http://example.test/', { method: 'POST', body: '', signal: source.signal });
    strictEqual(request.body !== null, true);
    strictEqual(request.headers.get('content-type'), 'text/plain;charset=UTF-8');
    strictEqual(request.signal === source.signal, false);
    source.abort('stop');
    strictEqual(request.signal.reason, 'stop');

    const clone = new Request(request);
    strictEqual(clone.signal === request.signal, false);
    strictEqual(await clone.text(), '');
});

Deno.test('Web API regressions: Response metadata and validation', async () => {
    const response = new Response('hello');
    strictEqual(response.headers.get('content-type'), 'text/plain;charset=UTF-8');
    strictEqual((await response.blob()).type, 'text/plain;charset=utf-8');
    throws(() => new Response(null, { statusText: 'bad\ntext' }), TypeError);
    throws(() => new Response(null, { status: 101 }), RangeError);
    throws(() => Response.json(undefined), TypeError);
});

Deno.test('Web API regressions: pipeThrough returns transform readable and Writable serializes', async () => {
    const source = new ReadableStream<string>({ start(controller) { controller.enqueue('x'); controller.close(); } });
    const transform = new TransformStream<string, string>({
        transform(chunk, controller) { controller.enqueue(chunk.toUpperCase()); },
    });
    const piped = source.pipeThrough(transform);
    strictEqual(piped, transform.readable);
    const reader = piped.getReader();
    deepStrictEqual(await reader.read(), { value: 'X', done: false });
    deepStrictEqual(await reader.read(), { value: undefined, done: true });

    const order: string[] = [];
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const writable = new WritableStream<string>({
        async start() { await startGate; order.push('start'); },
        async write(chunk) { order.push(`write:${chunk}`); },
        close() { order.push('close'); },
    });
    const writer = writable.getWriter();
    const write = writer.write('a');
    strictEqual(order.length, 0);
    releaseStart();
    await write;
    await writer.close();
    deepStrictEqual(order, ['start', 'write:a', 'close']);
    writer.releaseLock();

    const locked = new WritableStream();
    locked.getWriter();
    await rejects(locked.abort('x'), TypeError);
});

Deno.test('Web API regressions: URL serializes Unicode and explicit empty fragments', () => {
    const url = new URL('http://example.test/你好?q=你好#你好');
    strictEqual(
        url.href,
        'http://example.test/%E4%BD%A0%E5%A5%BD?q=%E4%BD%A0%E5%A5%BD#%E4%BD%A0%E5%A5%BD',
    );
    strictEqual(new URL('http://example.test/#').href, 'http://example.test/#');
});

Deno.test('Web API regressions: WebSocket validates protocols and connecting sends', () => {
    throws(() => new WebSocket('ws://127.0.0.1:1/', ['bad protocol']), DOMException);
    const socket = new WebSocket('ws://127.0.0.1:1/', ['chat', 'superchat']);
    try {
        strictEqual(socket.protocol, '');
        socket.binaryType = 'invalid' as BinaryType;
        strictEqual(socket.binaryType, 'blob');
        throws(() => socket.send('early'), DOMException);
    } finally {
        socket.close();
    }
});
