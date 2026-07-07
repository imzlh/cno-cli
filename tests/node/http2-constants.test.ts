import { strictEqual, ok } from 'node:assert';
import * as http2 from 'node:http2';

// http2 in this runtime is an h1/https redirect, but the *constants* contract
// must still hold: numeric NGHTTP2_* and HTTP2_HEADER_* values are part of
// the public node: surface and many libraries switch on them.

Deno.test('http2: error code constants are the real nghttp2 values', () => {
    strictEqual(http2.constants.NGHTTP2_NO_ERROR, 0x0);
    strictEqual(http2.constants.NGHTTP2_PROTOCOL_ERROR, 0x1);
    strictEqual(http2.constants.NGHTTP2_INTERNAL_ERROR, 0x2);
    strictEqual(http2.constants.NGHTTP2_FLOW_CONTROL_ERROR, 0x3);
    strictEqual(http2.constants.NGHTTP2_SETTINGS_TIMEOUT, 0x4);
    strictEqual(http2.constants.NGHTTP2_STREAM_CLOSED, 0x5);
    strictEqual(http2.constants.NGHTTP2_FRAME_SIZE_ERROR, 0x6);
    strictEqual(http2.constants.NGHTTP2_REFUSED_STREAM, 0x7);
    strictEqual(http2.constants.NGHTTP2_CANCEL, 0x8);
    strictEqual(http2.constants.NGHTTP2_COMPRESSION_ERROR, 0x9);
    strictEqual(http2.constants.NGHTTP2_CONNECT_ERROR, 0xa);
    strictEqual(http2.constants.NGHTTP2_ENHANCE_YOUR_CALM, 0xb);
    strictEqual(http2.constants.NGHTTP2_INADEQUATE_SECURITY, 0xc);
    strictEqual(http2.constants.NGHTTP2_HTTP_1_1_REQUIRED, 0xd);
});

Deno.test('http2: SETTINGS identifier constants match nghttp2', () => {
    strictEqual(http2.constants.NGHTTP2_SETTINGS_HEADER_TABLE_SIZE, 0x1);
    strictEqual(http2.constants.NGHTTP2_SETTINGS_ENABLE_PUSH, 0x2);
    strictEqual(http2.constants.NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS, 0x3);
    strictEqual(http2.constants.NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE, 0x4);
    strictEqual(http2.constants.NGHTTP2_SETTINGS_MAX_FRAME_SIZE, 0x5);
    strictEqual(http2.constants.NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE, 0x6);
});

Deno.test('http2: HTTP2_HEADER_* pseudo-header constants are strings', () => {
    strictEqual(http2.constants.HTTP2_HEADER_STATUS, ':status');
    strictEqual(http2.constants.HTTP2_HEADER_METHOD, ':method');
    strictEqual(http2.constants.HTTP2_HEADER_AUTHORITY, ':authority');
    strictEqual(http2.constants.HTTP2_HEADER_SCHEME, ':scheme');
    strictEqual(http2.constants.HTTP2_HEADER_PATH, ':path');
});

Deno.test('http2: common HTTP2_HEADER_* field-name constants are strings', () => {
    strictEqual(http2.constants.HTTP2_HEADER_CONTENT_TYPE, 'content-type');
    strictEqual(http2.constants.HTTP2_HEADER_CONTENT_LENGTH, 'content-length');
});

Deno.test('http2: HTTP2_METHOD_* constants expose common verbs', () => {
    strictEqual(http2.constants.HTTP2_METHOD_GET, 'GET');
    strictEqual(http2.constants.HTTP2_METHOD_POST, 'POST');
});

Deno.test('http2: HTTP_STATUS_* constants expose common status codes', () => {
    strictEqual(http2.constants.HTTP_STATUS_OK, 200);
    strictEqual(http2.constants.HTTP_STATUS_NOT_FOUND, 404);
});

Deno.test('http2: DEFAULT_SETTINGS_* constants match Node defaults', () => {
    strictEqual(http2.constants.DEFAULT_SETTINGS_HEADER_TABLE_SIZE, 4096);
    strictEqual(http2.constants.DEFAULT_SETTINGS_ENABLE_PUSH, 1);
    strictEqual(http2.constants.DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE, 65535);
});

Deno.test('http2: session role constants match nghttp2', () => {
    strictEqual(http2.constants.NGHTTP2_SESSION_SERVER, 0);
    strictEqual(http2.constants.NGHTTP2_SESSION_CLIENT, 1);
});

Deno.test('http2: stream state constants match nghttp2', () => {
    strictEqual(http2.constants.NGHTTP2_STREAM_STATE_IDLE, 1);
    strictEqual(http2.constants.NGHTTP2_STREAM_STATE_OPEN, 2);
    strictEqual(http2.constants.NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE, 6);
    strictEqual(http2.constants.NGHTTP2_STREAM_STATE_CLOSED, 7);
});

Deno.test('http2: createServer returns an http.Server', () => {
    const s = http2.createServer();
    ok(s, 'createServer must return a server');
    ok(typeof s.listen === 'function');
    ok(typeof s.close === 'function');
});

Deno.test('http2: createSecureServer returns an https.Server', () => {
    const s = http2.createSecureServer();
    ok(s, 'createSecureServer must return a server');
});
