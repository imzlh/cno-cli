import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { decodeUtf8 } from '../_helpers/bytes.ts';

const intArrayCtors = [
    Int8Array,
    Int16Array,
    Int32Array,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Uint8ClampedArray,
    Float32Array,
    Float64Array,
];

Deno.test('webapi fetch upstream: Headers iteration callbacks and Set-Cookie edge cases', () => {
    const headers = new Headers({
        name1: 'value1',
        Name2: 'value2',
        'content-Type': 'value3',
    });
    const entries: Array<[string, string, Headers]> = [];
    headers.forEach((value, key, parent) => entries.push([key, value, parent]));
    deepStrictEqual(entries.map(([key, value]) => [key, value]), [
        ['content-type', 'value3'],
        ['name1', 'value1'],
        ['name2', 'value2'],
    ]);
    ok(entries.every(([, , parent]) => parent === headers));
    deepStrictEqual([...headers], [
        ['content-type', 'value3'],
        ['name1', 'value1'],
        ['name2', 'value2'],
    ]);

    const cookies = new Headers([
        ['Set-Cookie', 'foo=bar'],
        ['set-Cookie', 'bar=baz'],
    ]);
    cookies.append('Set-cookie', 'baz=qat');
    deepStrictEqual([...cookies], [
        ['set-cookie', 'foo=bar'],
        ['set-cookie', 'bar=baz'],
        ['set-cookie', 'baz=qat'],
    ]);
    strictEqual(cookies.get('SET-COOKIE'), 'foo=bar, bar=baz, baz=qat');
    deepStrictEqual(cookies.getSetCookie(), ['foo=bar', 'bar=baz', 'baz=qat']);
});

Deno.test('webapi fetch upstream: Headers iteration observes live mutations', () => {
    const headers = new Headers([
        ['a', '1'],
        ['b', '2'],
    ]);
    const seen: string[] = [];
    headers.forEach((_value, key) => {
        seen.push(key);
        if (key === 'a') {
            headers.delete('b');
            headers.append('c', '3');
        }
    });
    deepStrictEqual(seen, ['a', 'c']);
    deepStrictEqual([...headers], [
        ['a', '1'],
        ['c', '3'],
    ]);

    const single = new Headers([['b', '2']]);
    const iterator = single.entries();
    deepStrictEqual(iterator.next().value, ['b', '2']);
    single.append('a', '1');
    deepStrictEqual(iterator.next().value, ['b', '2']);
    deepStrictEqual(iterator.next(), { done: true, value: undefined });
});

Deno.test('webapi fetch upstream: Headers reject malformed names values and init pairs', () => {
    throws(() => new Headers({ 'He y': 'ok' }), TypeError);
    throws(() => new Headers({ 'H\u00e9-y': 'ok' }), TypeError);
    throws(() => new Headers({ 'He-y': '\u0103k' }), TypeError);
    throws(() => new Headers([['1']] as unknown as Array<[string, string]>), TypeError);
    throws(() => new Headers([['x', '\u0000x']]), TypeError);

    const headers = new Headers();
    for (const method of ['delete', 'get', 'has', 'forEach'] as const) {
        throws(() => Reflect.apply(headers[method], headers, []), TypeError);
    }
    for (const method of ['append', 'set'] as const) {
        throws(() => Reflect.apply(headers[method], headers, []), TypeError);
        throws(() => Reflect.apply(headers[method], headers, ['foo']), TypeError);
    }
});

Deno.test('webapi fetch upstream: Headers string tag is web-compatible', () => {
    strictEqual(Headers.name, 'Headers');
    strictEqual(new Headers().toString(), '[object Headers]');
    strictEqual(Object.prototype.toString.call(new Headers()), '[object Headers]');
});

Deno.test('webapi fetch upstream: Headers init is robust against RegExp prototype pollution', () => {
    const originalExec = RegExp.prototype.exec;
    try {
        RegExp.prototype.exec = () => {
            throw new Error('polluted');
        };
        const headers = new Headers([
            ['X-Deno', 'foo'],
            ['X-Deno', 'bar'],
        ]);
        strictEqual(headers.get('x-deno'), 'foo, bar');
    } finally {
        RegExp.prototype.exec = originalExec;
    }
});

Deno.test('webapi fetch upstream: Body reads typed arrays and URLSearchParams', async () => {
    const buffer = new TextEncoder().encode('ahoyhoy8').buffer;
    for (const Ctor of intArrayCtors) {
        const body = new Request('http://foo/', {
            body: new Ctor(buffer as ArrayBuffer),
            method: 'POST',
        });
        strictEqual(decodeUtf8(await body.arrayBuffer()), 'ahoyhoy8');
    }

    const params = new URLSearchParams({ hello: 'world' });
    strictEqual(await new Request('http://foo/', {
        body: params,
        method: 'POST',
    }).text(), 'hello=world');
});

Deno.test('webapi fetch upstream: Body parses multipart non-ASCII names filenames and extra headers', async () => {
    const boundary = '----01230123';
    const payload = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="文字"`,
        '',
        '文字',
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="文字"`,
        'Content-Length: 1',
        'Content-Type: application/octet-stream',
        'last-modified: Wed, 04 Oct 2023 20:28:45 GMT',
        '',
        'y',
        `--${boundary}--`,
    ].join('\r\n');

    const body = new Request('http://foo/', {
        body: new TextEncoder().encode(payload),
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        method: 'POST',
    });
    const formData = await body.formData();
    strictEqual(formData.get('文字'), '文字');
    const file = formData.get('file');
    ok(file instanceof File);
    strictEqual(file.name, '文字');
    strictEqual(file.size, 1);
    strictEqual(file.type, 'application/octet-stream');
    strictEqual(await file.text(), 'y');
});

Deno.test('webapi fetch upstream: Body round-trips multipart non-ASCII FormData', async () => {
    const input = new FormData();
    input.append('文字', '文字');
    input.append('file', new File([], '文字'));

    const body = new Request('http://foo/', {
        body: input,
        method: 'POST',
    });
    const formData = await body.formData();
    strictEqual(formData.get('文字'), '文字');
    const file = formData.get('file');
    ok(file instanceof File);
    strictEqual(file.name, '文字');
});

Deno.test('webapi fetch upstream: Body consumes large multi-chunk streams', async () => {
    const parts = Array.from({ length: 4096 }, () => new Uint8Array([1]));
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            const chunk = parts[index++];
            if (chunk) controller.enqueue(chunk);
            else controller.close();
        },
    });
    const request = new Request('http://foo/', { body: stream, method: 'POST' });
    strictEqual((await request.arrayBuffer()).byteLength, parts.length);
    await rejects(() => request.arrayBuffer(), TypeError);
});

Deno.test('webapi fetch upstream: Request accepts URL-like input and clones stream bodies', async () => {
    const nonString = {
        toString() {
            return 'http://foo/';
        },
    };
    strictEqual(new Request(nonString as unknown as string).url, 'http://foo/');
    strictEqual(new Request('http://foo/', { method: undefined }).method, 'GET');
    strictEqual(new Request(new URL('http://foo/')).url, 'http://foo/');

    const stream = new Request('http://foo/', {
        body: 'a test body',
        method: 'POST',
    }).body;
    const request = new Request('http://foo/', {
        body: stream,
        method: 'POST',
    });
    const clone = request.clone();

    strictEqual(await request.text(), 'a test body');
    strictEqual(await clone.text(), 'a test body');
});

Deno.test('webapi fetch upstream: Request validates and normalizes HTTP methods', () => {
    strictEqual(new Request('http://foo/', { method: 'post' }).method, 'POST');
    strictEqual(new Request('http://foo/', { method: 'MkCoL' }).method, 'MkCoL');
    strictEqual(new Request('http://foo/', { method: null as unknown as string }).method, 'null');
    strictEqual(new Request('http://foo/', { method: 123 as unknown as string }).method, '123');

    for (const method of ['CONNECT', 'trace', 'TRACK', '', 'BAD METHOD']) {
        throws(() => new Request('http://foo/', { method }), TypeError);
    }

    const base = new Request('http://foo/', { method: 'POST' });
    strictEqual(new Request(base, { method: undefined }).method, 'POST');
    strictEqual(new Request(base, { method: 'put' }).method, 'PUT');
});

Deno.test('webapi fetch upstream: fetch supports data and blob local protocols', async () => {
    const text = await fetch('data:text/plain;charset=utf-8,hello%20fetch');
    strictEqual(text.status, 200);
    strictEqual(text.url, 'data:text/plain;charset=utf-8,hello%20fetch');
    strictEqual(text.headers.get('content-type'), 'text/plain;charset=utf-8');
    strictEqual(await text.text(), 'hello fetch');

    const binary = await fetch('data:application/octet-stream;base64,AQID/w==');
    strictEqual(binary.headers.get('content-type'), 'application/octet-stream');
    deepStrictEqual(await binary.bytes(), new Uint8Array([1, 2, 3, 255]));

    const defaultType = await fetch('data:,plain');
    strictEqual(defaultType.headers.get('content-type'), 'text/plain;charset=US-ASCII');
    strictEqual(await defaultType.text(), 'plain');

    const blobUrl = URL.createObjectURL(new Blob(['blob-body'], { type: 'text/plain' }));
    try {
        const blob = await fetch(blobUrl);
        strictEqual(blob.status, 200);
        strictEqual(blob.headers.get('content-type'), 'text/plain');
        strictEqual(await blob.text(), 'blob-body');
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
});

Deno.test('webapi fetch upstream: Request constructed from consumed Request keeps override body independent', async () => {
    const original = new Request('https://example.com', {
        method: 'POST',
        body: 'foo',
        headers: { 'x-original': 'yes' },
    });
    strictEqual(await original.text(), 'foo');
    await rejects(() => original.text(), TypeError);

    const replacement = new Request(original, {
        method: 'PUT',
        body: 'bar',
    });
    strictEqual(original.method, 'POST');
    strictEqual(replacement.method, 'PUT');
    strictEqual(await replacement.text(), 'bar');

    strictEqual(original.headers.get('x-new'), null);
    replacement.headers.set('x-new', 'value');
    strictEqual(original.headers.get('x-new'), null);
    strictEqual(replacement.headers.get('x-new'), 'value');
    strictEqual(replacement.headers.get('x-original'), 'yes');
});

Deno.test('webapi fetch upstream: Request and Response preserve typed-array view ranges', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    deepStrictEqual(
        await new Request('https://example.com', {
            method: 'POST',
            body: bytes.subarray(1, 4),
        }).bytes(),
        new Uint8Array([2, 3, 4]),
    );
    deepStrictEqual(await new Response(bytes.subarray(2)).bytes(), new Uint8Array([3, 4, 5]));

    const dataView = new DataView(bytes.buffer, 1, 3);
    deepStrictEqual(
        await new Request('https://example.com', {
            method: 'POST',
            body: dataView as BodyInit,
        }).bytes(),
        new Uint8Array([2, 3, 4]),
    );
});

Deno.test('webapi fetch upstream: Body tracks direct reader use', async () => {
    const response = new Response('reader-body');
    const responseReader = response.body!.getReader();
    strictEqual(response.bodyUsed, false);
    strictEqual(response.body!.locked, true);
    strictEqual(decodeUtf8((await responseReader.read()).value!), 'reader-body');
    strictEqual(response.bodyUsed, true);
    responseReader.releaseLock();
    await rejects(() => response.text(), TypeError);

    const request = new Request('http://foo/', { method: 'POST', body: 'cancel-body' });
    const requestReader = request.body!.getReader();
    strictEqual(request.bodyUsed, false);
    await requestReader.cancel('done');
    strictEqual(request.bodyUsed, true);
    requestReader.releaseLock();
    await rejects(() => request.text(), TypeError);
});

Deno.test('webapi fetch upstream: Response accepts iterable bodies and boxed strings', async () => {
    const iterable = (function* () {
        yield new Uint8Array([1, 2, 3]);
        yield new Uint8Array([4, 5]);
    })();
    deepStrictEqual(await new Response(iterable).bytes(), new Uint8Array([1, 2, 3, 4, 5]));

    const asyncIterable = (async function* () {
        yield new Uint8Array([6, 7]);
        yield new Uint8Array([8, 9, 10]);
    })();
    deepStrictEqual(await new Response(asyncIterable).bytes(), new Uint8Array([6, 7, 8, 9, 10]));

    strictEqual(await new Response(Object('hello')).text(), 'hello');
    strictEqual(await new Request('http://foo/', { method: 'POST', body: Object('hello') as BodyInit }).text(), 'hello');
});

Deno.test('webapi fetch upstream: Response readers blob formData and bodyUsed', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    const blob = await response.blob();
    ok(blob instanceof Blob);
    strictEqual(blob.size, 3);
    deepStrictEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([1, 2, 3]));
    strictEqual(response.bodyUsed, true);
    await rejects(() => response.arrayBuffer(), TypeError);

    const params = new URLSearchParams('hello=world&multi=one&multi=two');
    const urlEncoded = new Response(params, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const parsed = await urlEncoded.formData();
    strictEqual(parsed.get('hello'), 'world');
    deepStrictEqual(parsed.getAll('multi'), ['one', 'two']);

    const input = new FormData();
    input.append('name', 'value');
    const multipart = new Response(input);
    ok(multipart.headers.get('content-type')?.startsWith('multipart/form-data'));
    strictEqual((await multipart.formData()).get('name'), 'value');
});

Deno.test('webapi fetch upstream: Response init validation and clone semantics', async () => {
    throws(() => new Response('', 0 as unknown as ResponseInit), TypeError);
    for (const status of [0, 100, 199, 600, NaN, '', null] as unknown as number[]) {
        throws(() => new Response('', { status }), RangeError);
    }
    for (const status of [204, 205, 304]) {
        throws(() => new Response('body', { status }), TypeError);
        strictEqual(new Response(null, { status }).body, null);
    }
    strictEqual(new Response('', null as unknown as ResponseInit).status, 200);
    strictEqual(new Response('', { status: undefined }).status, 200);

    const original = new Response('clone-body', { headers: { 'x-test': 'yes' } });
    const clone = original.clone();
    strictEqual(await original.text(), 'clone-body');
    strictEqual(await clone.text(), 'clone-body');
    strictEqual(clone.headers.get('x-test'), 'yes');

    const used = new Response('body');
    strictEqual(used.bodyUsed, false);
    strictEqual(await used.text(), 'body');
    strictEqual(used.bodyUsed, true);
    used.body;
    strictEqual(used.bodyUsed, true);
});

Deno.test('webapi fetch upstream: Response can use another Response as init', async () => {
    const original = new Response('original-body', {
        status: 404,
        statusText: 'Missing',
        headers: { 'x-deno': 'foo' },
    });
    const replacement = new Response('replacement-body', original);
    strictEqual(replacement.status, 404);
    strictEqual(replacement.statusText, 'Missing');
    strictEqual(replacement.headers.get('x-deno'), 'foo');
    strictEqual(await replacement.text(), 'replacement-body');
    strictEqual(await original.text(), 'original-body');
});

Deno.test('webapi fetch upstream: Response redirect accepts URL objects and empty bodies read as empty', async () => {
    const redirect = Response.redirect(new URL('https://example.com/'));
    strictEqual(redirect.status, 302);
    strictEqual(redirect.statusText, '');
    strictEqual(redirect.url, '');
    strictEqual(redirect.type, 'default');
    strictEqual(redirect.headers.get('location'), 'https://example.com/');

    deepStrictEqual(await new Response().bytes(), new Uint8Array(0));
    strictEqual((await new Response().blob()).size, 0);
    strictEqual(await new Response().text(), '');
    await rejects(() => new Response().json(), SyntaxError);
});

Deno.test('webapi fetch upstream: Response static constructors preserve status headers and error shape', async () => {
    const data = { hello: 'world' };
    const json = Response.json(data, { status: 201, headers: { 'x-test': 'yes' } });
    strictEqual(json.status, 201);
    strictEqual(json.headers.get('content-type'), 'application/json');
    strictEqual(json.headers.get('x-test'), 'yes');
    deepStrictEqual(await json.json(), data);

    const explicitType = Response.json(data, {
        headers: { 'content-type': 'application/problem+json' },
    });
    strictEqual(explicitType.headers.get('content-type'), 'application/problem+json');
    deepStrictEqual(await explicitType.json(), data);

    const error = Response.error();
    strictEqual(error.type, 'error');
    strictEqual(error.status, 0);
    strictEqual(error.statusText, '');
    strictEqual(error.ok, false);
    strictEqual(error.url, '');
    strictEqual(error.redirected, false);
    strictEqual(error.body, null);
    strictEqual(error.bodyUsed, false);
    deepStrictEqual([...error.headers], []);
});
