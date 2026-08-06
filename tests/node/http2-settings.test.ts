/**
 * Real SETTINGS pack/unpack (not empty-buffer stub).
 */
import { strictEqual, ok, throws, deepStrictEqual } from 'node:assert';
import * as http2 from 'node:http2';

Deno.test('http2: getPackedSettings encodes 6-byte SETTINGS entries', () => {
    const packed = http2.getPackedSettings({
        headerTableSize: 4096,
        enablePush: true,
        maxConcurrentStreams: 100,
        initialWindowSize: 65535,
        maxFrameSize: 16384,
        maxHeaderListSize: 65535,
    });
    ok(Buffer.isBuffer(packed));
    strictEqual(packed.length, 36);
    // id 1 value 4096
    strictEqual(packed.readUInt16BE(0), 1);
    strictEqual(packed.readUInt32BE(2), 4096);
    // id 2 enablePush=1
    strictEqual(packed.readUInt16BE(6), 2);
    strictEqual(packed.readUInt32BE(8), 1);
    // id 3 maxConcurrentStreams=100
    strictEqual(packed.readUInt16BE(12), 3);
    strictEqual(packed.readUInt32BE(14), 100);
});

Deno.test('http2: getPackedSettings / getUnpackedSettings round-trip', () => {
    const input = {
        enablePush: false,
        maxConcurrentStreams: 50,
        maxFrameSize: 32768,
    };
    const packed = http2.getPackedSettings(input);
    strictEqual(packed.length, 18);
    const out = http2.getUnpackedSettings(packed);
    strictEqual(out.enablePush, false);
    strictEqual(out.maxConcurrentStreams, 50);
    strictEqual(out.maxFrameSize, 32768);
});

Deno.test('http2: getPackedSettings({}) is empty buffer', () => {
    const packed = http2.getPackedSettings({});
    strictEqual(packed.length, 0);
    deepStrictEqual(http2.getUnpackedSettings(packed), {});
});

Deno.test('http2: getUnpackedSettings rejects non-multiple-of-6 length', () => {
    // Real Node: ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH, "…must be a multiple of six".
    throws(() => http2.getUnpackedSettings(Buffer.from([1, 2, 3])), {
        code: 'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH',
    });
});

Deno.test('http2: getPackedSettings rejects invalid enablePush', () => {
    throws(() => http2.getPackedSettings({ enablePush: 2 as unknown as boolean }), /Invalid value/i);
});

Deno.test('http2: getDefaultSettings exposes Node-like defaults', () => {
    const d = http2.getDefaultSettings();
    strictEqual(d.headerTableSize, 4096);
    strictEqual(d.enablePush, true);
    strictEqual(d.initialWindowSize, 65535);
    strictEqual(d.maxFrameSize, 16384);
    strictEqual(d.maxConcurrentStreams, 4294967295);
    strictEqual(d.maxHeaderListSize, 65535);
    strictEqual(d.enableConnectProtocol, false);
});

Deno.test('http2: getPackedSettings still fail-closed when H2 missing is N/A for pure settings', () => {
    // Settings helpers are pure JS and must work even if session path is gated.
    const packed = http2.getPackedSettings({ headerTableSize: 1 });
    strictEqual(packed.readUInt32BE(2), 1);
});

// Real Node tags these; libraries branch on the code, not the message.
Deno.test('http2 upstream: settings errors carry Node error codes', () => {
    throws(() => http2.getPackedSettings({ enablePush: 3 as unknown as boolean }), {
        code: 'ERR_HTTP2_INVALID_SETTING_VALUE',
        message: 'Invalid value for setting "enablePush": 3',
    });
    throws(() => http2.getPackedSettings({ initialWindowSize: 2 ** 32 }), {
        code: 'ERR_HTTP2_INVALID_SETTING_VALUE',
    });
    throws(() => http2.getPackedSettings({ maxFrameSize: 1 }), {
        code: 'ERR_HTTP2_INVALID_SETTING_VALUE',
        message: 'Invalid value for setting "maxFrameSize": 1',
    });
    throws(() => http2.getUnpackedSettings('abcdef' as unknown as Buffer), {
        code: 'ERR_INVALID_ARG_TYPE',
    });
});

// maxHeaderSize is an alias emitted before maxHeaderListSize in Node.
Deno.test('http2 upstream: getUnpackedSettings key order matches Node', () => {
    const packed = http2.getPackedSettings({ maxHeaderListSize: 1000 });
    strictEqual(
        JSON.stringify(http2.getUnpackedSettings(packed)),
        '{"maxHeaderSize":1000,"maxHeaderListSize":1000}',
    );
});
