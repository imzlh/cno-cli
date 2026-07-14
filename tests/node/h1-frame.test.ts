/**
 * Direct coverage of pure H1 framing/policy helpers (@cnojs/http/h1-frame).
 * Asserts real helper outputs — not a reimplemented encoder.
 */
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import {
    connectionTokens,
    encodeChunkedFrame,
    encodeChunkedTrailer,
    encodeRequestHead,
    encodeResponseHead,
    formatHead,
    formatRequestHead,
    shouldCloseAfterResponse,
    wantsKeepAlive,
} from '@cnojs/http/h1-frame';

const engine = import.meta.use('engine');

function dec(u8: Uint8Array): string {
    return engine.decodeString(u8);
}

function enc(s: string): Uint8Array {
    return engine.encodeString(s);
}

Deno.test('h1-frame: encodeResponseHead matches status + headers wire form', () => {
    const wire = dec(encodeResponseHead('1.1', 200, 'OK', [
        ['Content-Type', 'text/plain'],
        ['Connection', 'keep-alive'],
    ]));
    strictEqual(wire, 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: keep-alive\r\n\r\n');
});

Deno.test('h1-frame: encodeRequestHead matches method-target-version wire form', () => {
    const wire = dec(encodeRequestHead('POST', '/api', '1.1', [
        ['host', 'example.test'],
        ['content-length', '0'],
    ]));
    strictEqual(wire, 'POST /api HTTP/1.1\r\nhost: example.test\r\ncontent-length: 0\r\n\r\n');
});

Deno.test('h1-frame: formatRequestHead and formatHead share blank-line rules', () => {
    const block = 'Host: a\r\n';
    strictEqual(
        formatRequestHead('GET', '/', '1.1', block),
        formatHead('GET / HTTP/1.1', block),
    );
    strictEqual(
        formatRequestHead('GET', '/', '1.0', 'Connection: close'),
        'GET / HTTP/1.0\r\nConnection: close\r\n\r\n',
    );
});

Deno.test('h1-frame: encodeChunkedFrame prefixes hex size and CRLF trailer', () => {
    const body = enc('hi');
    const frame = encodeChunkedFrame(body);
    strictEqual(dec(frame), '2\r\nhi\r\n');
    // Empty chunk still has size line + empty payload + CRLF
    strictEqual(dec(encodeChunkedFrame(enc(''))), '0\r\n\r\n');
});

Deno.test('h1-frame: encodeChunkedTrailer is final 0-chunk', () => {
    strictEqual(dec(encodeChunkedTrailer()), '0\r\n\r\n');
});

Deno.test('h1-frame: response head + chunked body bytes compose a valid message prefix', () => {
    const head = encodeResponseHead('1.1', 200, 'OK', [['Transfer-Encoding', 'chunked']]);
    const part = encodeChunkedFrame(enc('xy'));
    const end = encodeChunkedTrailer();
    const msg = new Uint8Array(head.length + part.length + end.length);
    msg.set(head, 0);
    msg.set(part, head.length);
    msg.set(end, head.length + part.length);
    strictEqual(
        dec(msg),
        'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nxy\r\n0\r\n\r\n',
    );
});

Deno.test('h1-frame: connectionTokens lowercases and splits', () => {
    deepStrictEqual(connectionTokens('Keep-Alive, Upgrade'), ['keep-alive', 'upgrade']);
    deepStrictEqual(connectionTokens('  close  '), ['close']);
    deepStrictEqual(connectionTokens(null), []);
    deepStrictEqual(connectionTokens(undefined), []);
    deepStrictEqual(connectionTokens(''), []);
});

Deno.test('h1-frame: wantsKeepAlive / shouldCloseAfterResponse policy', () => {
    // HTTP/1.1 default open
    ok(wantsKeepAlive('1.1', null));
    ok(wantsKeepAlive('1.1', ''));
    ok(wantsKeepAlive('1.1', 'keep-alive'));
    ok(!wantsKeepAlive('1.1', 'close'));
    ok(!wantsKeepAlive('1.1', 'Keep-Alive, close'));
    // HTTP/1.0 needs explicit keep-alive
    ok(!wantsKeepAlive('1.0', null));
    ok(!wantsKeepAlive('1.0', ''));
    ok(wantsKeepAlive('1.0', 'keep-alive'));
    ok(!wantsKeepAlive('1.0', 'close'));
    // close wins on multi-token
    ok(!wantsKeepAlive('1.1', 'upgrade, close'));
    // inverse
    ok(shouldCloseAfterResponse('1.1', 'close'));
    ok(!shouldCloseAfterResponse('1.1', null));
    ok(shouldCloseAfterResponse('1.0', null));
    ok(!shouldCloseAfterResponse('1.0', 'keep-alive'));
});
