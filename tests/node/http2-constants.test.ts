import { strictEqual, ok } from 'node:assert';
import * as http2 from 'node:http2';
import * as net from 'node:net';
import { h2Available } from '@cnojs/http/h2-native';

// http2 in this runtime is an h1/https redirect, but the *constants* contract
// must still hold: numeric NGHTTP2_* and HTTP2_HEADER_* values are part of
// the public node: surface and many libraries switch on them.

// Real Node v24 ships 240 constants; the module used to expose only 46, so
// NGHTTP2_ERR_*, DEFAULT_SETTINGS_*, MAX_*/MIN_* and PADDING_STRATEGY_* were
// all silently undefined.
Deno.test('http2 upstream: constants covers the full Node set', () => {
    strictEqual(Object.keys(http2.constants).length, 240);
    strictEqual(http2.constants.NGHTTP2_ERR_FRAME_SIZE_ERROR, -522);
    strictEqual(http2.constants.NGHTTP2_DEFAULT_WEIGHT, 16);
    strictEqual(http2.constants.DEFAULT_SETTINGS_MAX_FRAME_SIZE, 16384);
    strictEqual(http2.constants.DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE, 65535);
    strictEqual(http2.constants.DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS, 4294967295);
    strictEqual(http2.constants.MAX_INITIAL_WINDOW_SIZE, 2147483647);
    strictEqual(http2.constants.MAX_MAX_FRAME_SIZE, 16777215);
    strictEqual(http2.constants.MIN_MAX_FRAME_SIZE, 16384);
    strictEqual(http2.constants.PADDING_STRATEGY_NONE, 0);
    strictEqual(http2.constants.PADDING_STRATEGY_MAX, 2);
    strictEqual(http2.constants.NGHTTP2_STREAM_STATE_RESERVED_LOCAL, 3);
    strictEqual(http2.constants.HTTP2_METHOD_MKCALENDAR, 'MKCALENDAR');
    strictEqual(http2.constants.HTTP2_HEADER_X_FRAME_OPTIONS, 'x-frame-options');
    strictEqual(http2.constants.HTTP_STATUS_TEAPOT, 418);
});

Deno.test('http2 upstream: module exports the request/response classes and sensitiveHeaders', () => {
    strictEqual(typeof http2.Http2ServerRequest, 'function');
    strictEqual(typeof http2.Http2ServerResponse, 'function');
    strictEqual(typeof http2.performServerHandshake, 'function');
    strictEqual(typeof http2.sensitiveHeaders, 'symbol');
    // Node uses an unregistered symbol described "sensitiveHeaders".
    strictEqual(http2.sensitiveHeaders.description, 'sensitiveHeaders');
    strictEqual(Symbol.keyFor(http2.sensitiveHeaders), undefined);
});

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

// The server factories need the native nghttp2 extension. Since v1 they fail
// closed rather than handing back a server that can never speak h2, so the
// assertion depends on the build. NOTE this is a deliberate divergence from
// real Node v24, where createServer()/createSecureServer() never throw and the
// failure only surfaces on the wire (measured against node v24.18.0).
Deno.test({
    name: 'http2: server factories build a listenable server when H2 is available',
    ignore: !h2Available(),
}, () => {
    const s = http2.createServer();
    try {
        ok(s, 'createServer must return a server');
        ok(typeof s.listen === 'function');
        ok(typeof s.close === 'function');
        // Node's Http2Server is a net.Server subclass.
        ok(s instanceof net.Server, 'Http2Server must extend net.Server');
    } finally {
        s.close();
    }
});

Deno.test({
    name: 'http2: server factories fail closed when H2 is unavailable',
    ignore: h2Available(),
}, () => {
    for (const make of [
        () => http2.createServer(),
        () => http2.createSecureServer({ key: 'k', cert: 'c' }),
    ]) {
        try {
            make();
            ok(false, 'expected the factory to throw without the H2 native');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ok(/HTTP\/2|CNO_EMBED_EXT_H2|not available/i.test(msg), msg);
        }
    }
});

// ---------------------------------------------------------------------------
// Parity gaps found by diffing the whole module surface against node v24.18.0.
// Each of these was measured wrong before being fixed.
// ---------------------------------------------------------------------------

Deno.test('http2 upstream: each constant is non-writable and non-configurable', () => {
    const d = Object.getOwnPropertyDescriptor(http2.constants, 'NGHTTP2_NO_ERROR');
    strictEqual(d?.writable, false);
    strictEqual(d?.enumerable, true);
    strictEqual(d?.configurable, false);
    // Node leaves the container extensible and unfrozen.
    strictEqual(Object.isFrozen(http2.constants), false);
    strictEqual(Object.isExtensible(http2.constants), true);
    // A silent overwrite must not be possible.
    try {
        (http2.constants as unknown as Record<string, number>)['NGHTTP2_NO_ERROR'] = 123;
    } catch { /* strict-mode TypeError is fine too */ }
    strictEqual(http2.constants.NGHTTP2_NO_ERROR, 0);
});

Deno.test('http2 upstream: getDefaultSettings returns a null-prototype object', () => {
    const d = http2.getDefaultSettings();
    strictEqual(Object.getPrototypeOf(d), null);
    // Distinct object each call, so mutations cannot leak into the defaults.
    const other = http2.getDefaultSettings();
    strictEqual(d === other, false);
    (d as Record<string, number>)['headerTableSize'] = 999;
    strictEqual(http2.getDefaultSettings().headerTableSize, 4096);
});

Deno.test('http2 upstream: getPackedSettings treats a missing argument as {}', () => {
    // Node returns an empty buffer for undefined but throws for null.
    strictEqual(http2.getPackedSettings().length, 0);
    strictEqual(http2.getPackedSettings(undefined).length, 0);
    try {
        http2.getPackedSettings(null as unknown as undefined);
        ok(false, 'null must throw');
    } catch (e) {
        strictEqual((e as { code?: string }).code, 'ERR_INVALID_ARG_TYPE');
    }
});

Deno.test('http2 upstream: enablePush/enableConnectProtocol accept only booleans', () => {
    for (const key of ['enablePush', 'enableConnectProtocol']) {
        for (const bad of [0, 1, 2, '1', null]) {
            try {
                http2.getPackedSettings({ [key]: bad } as unknown as undefined);
                ok(false, `${key}=${JSON.stringify(bad)} must throw`);
            } catch (e) {
                strictEqual(
                    (e as { code?: string }).code,
                    'ERR_HTTP2_INVALID_SETTING_VALUE',
                    `${key}=${JSON.stringify(bad)}`,
                );
            }
        }
    }
    strictEqual(http2.getPackedSettings({ enablePush: true }).toString('hex'), '000200000001');
    strictEqual(http2.getPackedSettings({ enablePush: false }).toString('hex'), '000200000000');
});

Deno.test('http2 upstream: unknown SETTINGS ids surface as customSettings', () => {
    // Unknown ids are collected, keyed by numeric id, last-one-wins.
    const u = http2.getUnpackedSettings(Buffer.from('009900000001', 'hex'));
    ok(u.customSettings, 'customSettings must be present for unknown ids');
    strictEqual((u.customSettings as Record<string, number>)['153'], 1);
    const dup = http2.getUnpackedSettings(Buffer.from('009900000001009900000002', 'hex'));
    strictEqual((dup.customSettings as Record<string, number>)['153'], 2);
    // Known ids stay named; the custom bucket is created lazily in scan order.
    const mixed = http2.getUnpackedSettings(Buffer.from('000100001000009900000003', 'hex'));
    strictEqual(mixed.headerTableSize, 4096);
    strictEqual((mixed.customSettings as Record<string, number>)['153'], 3);
    // A buffer with only known ids has no customSettings key at all.
    ok(!('customSettings' in http2.getUnpackedSettings(Buffer.from('000100001000', 'hex'))));
});

Deno.test('http2 upstream: customSettings is packed back onto the wire', () => {
    strictEqual(
        http2.getPackedSettings({ customSettings: { 0x99: 7 } } as unknown as undefined).toString('hex'),
        '009900000007',
    );
    // Sorted by id alongside named settings.
    strictEqual(
        http2.getPackedSettings(
            { customSettings: { 0x99: 7 }, headerTableSize: 4096 } as unknown as undefined,
        ).toString('hex'),
        '000100001000009900000007',
    );
    // >10 custom entries is Node's MAX_ADDITIONAL_SETTINGS ceiling.
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [200 + i, 1]));
    try {
        http2.getPackedSettings({ customSettings: many } as unknown as undefined);
        ok(false, '11 custom settings must throw');
    } catch (e) {
        strictEqual((e as { code?: string }).code, 'ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS');
    }
    strictEqual(
        http2.getPackedSettings(
            { customSettings: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [200 + i, 1])) } as unknown as undefined,
        ).length,
        60,
    );
    // Out-of-range id / value.
    for (const bad of [{ 65536: 1 }, { '-1': 1 }, { foo: 1 }, { 0x99: -1 }, { 0x99: 2 ** 32 }]) {
        try {
            http2.getPackedSettings({ customSettings: bad } as unknown as undefined);
            ok(false, `${JSON.stringify(bad)} must throw`);
        } catch (e) {
            strictEqual(
                (e as { code?: string }).code,
                'ERR_HTTP2_INVALID_SETTING_VALUE',
                JSON.stringify(bad),
            );
        }
    }
});

// DELIBERATE DIVERGENCE from node v24.18.0. Node cannot repack its own
// getUnpackedSettings output when a custom id or value is 0: it raises
// ERR_HTTP2_INVALID_SETTING_VALUE with the literal string "Range Error" where
// the setting name belongs, which is an upstream message-formatting defect.
// cno keeps pack(unpack(x)) === x instead. Do NOT "fix" this to match Node.
Deno.test('http2: customSettings survives a pack/unpack round-trip (diverges from Node)', () => {
    for (const hex of ['009900000000', '000000000000', '009900000007']) {
        const un = http2.getUnpackedSettings(Buffer.from(hex, 'hex'));
        const re = http2.getPackedSettings(un as unknown as undefined);
        strictEqual(re.toString('hex'), hex, `round-trip of ${hex}`);
    }
});
