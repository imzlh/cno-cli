import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import {
    setFetchInterceptHook,
    type FetchInterceptInfo,
    type InterceptResult,
} from '../../cno/src/utils/network-hooks.ts';
import { decodeUtf8, encodeUtf8 } from '../_helpers/bytes.ts';

async function withIntercept(
    onRequest: (info: FetchInterceptInfo) => Promise<InterceptResult | null>,
    fn: (origin: string) => Promise<void>,
): Promise<void> {
    setFetchInterceptHook({ onRequest });
    try {
        await fn('http://xhr.test');
    } finally {
        setFetchInterceptHook(null);
    }
}

function waitForLoadEnd(xhr: XMLHttpRequest): Promise<void> {
    return new Promise((resolve) => {
        xhr.addEventListener('loadend', () => resolve(), { once: true });
    });
}

Deno.test({ name: 'XMLHttpRequest: GET text response exposes state headers and body', timeout: 10000 }, async () => {
    await withIntercept(async (info) => {
        strictEqual(info.method, 'GET');
        strictEqual(info.url, 'http://xhr.test/text');
        strictEqual(info.resourceType, 'XHR');
        return {
            action: 'fulfill',
            responseCode: 200,
            responseHeaders: [['content-type', 'text/plain; charset=utf-8'], ['x-test-header', 'yes']],
            body: encodeUtf8('hello-xhr'),
        };
    }, async (origin) => {
        const xhr = new XMLHttpRequest();
        const states: number[] = [];
        xhr.onreadystatechange = () => states.push(xhr.readyState);
        xhr.open('GET', `${origin}/text`);
        xhr.send();
        await waitForLoadEnd(xhr);

        strictEqual(xhr.status, 200);
        strictEqual(xhr.responseText, 'hello-xhr');
        strictEqual(xhr.response, 'hello-xhr');
        strictEqual(xhr.getResponseHeader('X-Test-Header'), 'yes');
        ok(xhr.getAllResponseHeaders().toLowerCase().includes('x-test-header'));
        ok(states.includes(XMLHttpRequest.OPENED));
        ok(states.includes(XMLHttpRequest.HEADERS_RECEIVED));
        ok(states.includes(XMLHttpRequest.LOADING));
        strictEqual(states.at(-1), XMLHttpRequest.DONE);
    });
});

Deno.test({ name: 'XMLHttpRequest: POST sends body and request headers', timeout: 10000 }, async () => {
    await withIntercept(async (info) => ({
        action: 'fulfill',
        responseCode: 200,
        responseHeaders: [['content-type', 'application/json']],
        body: encodeUtf8(JSON.stringify({
            method: info.method,
            header: info.headers['x-from-xhr'],
            body: decodeUtf8(info.postData ?? new Uint8Array(0)),
        })),
    }), async (origin) => {
        const xhr = new XMLHttpRequest();
        xhr.responseType = 'json';
        xhr.open('POST', `${origin}/echo`);
        xhr.setRequestHeader('x-from-xhr', 'present');
        xhr.send('payload');
        await waitForLoadEnd(xhr);

        strictEqual(xhr.status, 200);
        strictEqual(xhr.response.method, 'POST');
        strictEqual(xhr.response.header, 'present');
        strictEqual(xhr.response.body, 'payload');
    });
});

Deno.test({ name: 'XMLHttpRequest: arraybuffer responseType returns exact bytes', timeout: 10000 }, async () => {
    await withIntercept(async () => ({
        action: 'fulfill',
        responseCode: 200,
        responseHeaders: [['content-type', 'application/octet-stream']],
        body: new Uint8Array([1, 2, 3, 255]),
    }), async (origin) => {
        const xhr = new XMLHttpRequest();
        xhr.responseType = 'arraybuffer';
        xhr.open('GET', `${origin}/bytes`);
        xhr.send();
        await waitForLoadEnd(xhr);

        ok(xhr.response instanceof ArrayBuffer);
        strictEqual(Buffer.from(xhr.response).toString('hex'), '010203ff');
        throws(() => xhr.responseText, /InvalidStateError/);
    });
});

Deno.test({ name: 'XMLHttpRequest upstream: data URL uses shared local protocol loader', timeout: 10000 }, async () => {
    const textXhr = new XMLHttpRequest();
    textXhr.open('GET', 'data:text/plain;charset=utf-8,hello%20xhr');
    textXhr.send();
    await waitForLoadEnd(textXhr);
    strictEqual(textXhr.status, 200);
    strictEqual(textXhr.responseURL, 'data:text/plain;charset=utf-8,hello%20xhr');
    strictEqual(textXhr.getResponseHeader('content-type'), 'text/plain;charset=utf-8');
    strictEqual(textXhr.responseText, 'hello xhr');

    const jsonXhr = new XMLHttpRequest();
    jsonXhr.responseType = 'json';
    jsonXhr.open('GET', 'data:application/json,%7B%22ok%22%3Atrue%7D');
    jsonXhr.send();
    await waitForLoadEnd(jsonXhr);
    deepStrictEqual(jsonXhr.response, { ok: true });

    const bytesXhr = new XMLHttpRequest();
    bytesXhr.responseType = 'arraybuffer';
    bytesXhr.open('GET', 'data:application/octet-stream;base64,AQID/w==');
    bytesXhr.send();
    await waitForLoadEnd(bytesXhr);
    deepStrictEqual(new Uint8Array(bytesXhr.response as ArrayBuffer), new Uint8Array([1, 2, 3, 255]));
});

Deno.test({ name: 'XMLHttpRequest upstream: blob and invalid json response shapes', timeout: 10000 }, async () => {
    await withIntercept(async (info) => {
        if (info.url.endsWith('/blob')) {
            return {
                action: 'fulfill',
                responseCode: 200,
                responseHeaders: [['content-type', 'text/plain']],
                body: encodeUtf8('blob-body'),
            };
        }
        return {
            action: 'fulfill',
            responseCode: 200,
            responseHeaders: [['content-type', 'application/json']],
            body: encodeUtf8('{ broken json'),
        };
    }, async (origin) => {
        const blobXhr = new XMLHttpRequest();
        blobXhr.responseType = 'blob';
        blobXhr.open('GET', `${origin}/blob`);
        blobXhr.send();
        await waitForLoadEnd(blobXhr);
        ok(blobXhr.response instanceof Blob);
        strictEqual((blobXhr.response as Blob).type, 'text/plain');
        strictEqual(await (blobXhr.response as Blob).text(), 'blob-body');
        throws(() => blobXhr.responseText, /InvalidStateError/);

        const jsonXhr = new XMLHttpRequest();
        jsonXhr.responseType = 'json';
        jsonXhr.open('GET', `${origin}/bad-json`);
        jsonXhr.send();
        await waitForLoadEnd(jsonXhr);
        strictEqual(jsonXhr.response, null);
    });
});

Deno.test({ name: 'XMLHttpRequest upstream: overrideMimeType controls text decoding', timeout: 10000 }, async () => {
    await withIntercept(async () => ({
        action: 'fulfill',
        responseCode: 200,
        responseHeaders: [['content-type', 'text/plain; charset=utf-8']],
        body: new Uint8Array([0xe9]),
    }), async (origin) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `${origin}/latin1`);
        xhr.overrideMimeType('text/plain; charset=windows-1252');
        xhr.send();
        await waitForLoadEnd(xhr);
        strictEqual(xhr.responseText, '\u00e9');
    });
});

Deno.test({ name: 'XMLHttpRequest upstream: responseType cannot change while loading', timeout: 10000 }, async () => {
    let release!: (result: InterceptResult) => void;
    setFetchInterceptHook({
        onRequest: () => new Promise<InterceptResult>((resolve) => { release = resolve; }),
    });
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'http://xhr.test/pending');
        xhr.send();
        throws(() => { xhr.responseType = 'json'; }, /InvalidStateError/);
        release({
            action: 'fulfill',
            responseCode: 200,
            responseHeaders: [['content-type', 'text/plain']],
            body: encodeUtf8('done'),
        });
        await waitForLoadEnd(xhr);
    } finally {
        setFetchInterceptHook(null);
    }
});

Deno.test('XMLHttpRequest: setRequestHeader requires an opened request', () => {
    const xhr = new XMLHttpRequest();
    let err: any;
    try { xhr.setRequestHeader('x-test', 'value'); } catch (e) { err = e; }
    strictEqual(err?.name, 'InvalidStateError');
});

Deno.test('XMLHttpRequest: validates method and responseType synchronously', () => {
    const xhr = new XMLHttpRequest();
    throws(() => xhr.open('', 'http://xhr.test/'), /SyntaxError/);
    throws(() => xhr.open('bad method', 'http://xhr.test/'), /SyntaxError/);
    throws(() => xhr.open('TRACE', 'http://xhr.test/'), /SecurityError/);

    strictEqual(xhr.responseType, '');
    xhr.responseType = 'json';
    strictEqual(xhr.responseType, 'json');
    throws(() => { xhr.responseType = 'bad' as XMLHttpRequestResponseType; }, TypeError);
});

Deno.test({ name: 'XMLHttpRequest: abort emits abort and loadend without load', timeout: 10000 }, async () => {
    let fulfill!: (result: InterceptResult) => void;
    setFetchInterceptHook({
        onRequest: () => new Promise<InterceptResult>((resolve) => { fulfill = resolve; }),
    });
    try {
        const xhr = new XMLHttpRequest();
        let aborts = 0;
        let loads = 0;
        let loadends = 0;
        xhr.onabort = () => { aborts++; };
        xhr.onload = () => { loads++; };
        xhr.onloadend = () => { loadends++; };
        xhr.open('GET', 'http://xhr.test/slow');
        xhr.send();
        xhr.abort();
        fulfill({
            action: 'fulfill',
            responseCode: 200,
            responseHeaders: [['content-type', 'text/plain']],
            body: encodeUtf8('late'),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        strictEqual(xhr.readyState, XMLHttpRequest.DONE);
        strictEqual(aborts, 1);
        strictEqual(loads, 0);
        strictEqual(loadends, 1);
    } finally {
        setFetchInterceptHook(null);
    }
});
