import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import { encodeUtf8 } from '../_helpers/bytes.ts';

Deno.test('ipc_channel: module exports MessageDecoder and IPCChannel constructors', () => {
    const ipc = require('node:ipc_channel');
    ok(typeof ipc === 'object');
    ok(typeof ipc.MessageDecoder === 'function');
    ok(typeof ipc.IPCChannel === 'function');
});

Deno.test('ipc_channel: MessageDecoder parses newline-delimited JSON messages', () => {
    const { MessageDecoder } = require('node:ipc_channel');
    const decoder = new MessageDecoder();
    const seen: unknown[] = [];
    decoder.on('message', (value: unknown) => seen.push(value));
    decoder.feed(encodeUtf8('{"a":1}\n[2,3]\n'));
    deepStrictEqual(seen, [{ a: 1 }, [2, 3]]);
});

Deno.test('ipc_channel: MessageDecoder reassembles fragmented input', () => {
    const { MessageDecoder } = require('node:ipc_channel');
    const decoder = new MessageDecoder();
    const seen: unknown[] = [];
    decoder.on('message', (value: unknown) => seen.push(value));
    decoder.feed(encodeUtf8('{"hel'));
    decoder.feed(encodeUtf8('lo":"world"}\n'));
    deepStrictEqual(seen, [{ hello: 'world' }]);
});

Deno.test('ipc_channel: MessageDecoder emits error for invalid JSON frame', () => {
    const { MessageDecoder } = require('node:ipc_channel');
    const decoder = new MessageDecoder();
    let err: Error | null = null;
    decoder.on('error', (error: Error) => { err = error; });
    decoder.feed(encodeUtf8('{bad}\n'));
    ok(err instanceof Error);
    strictEqual(err?.message, 'Invalid IPC message');
});

Deno.test('ipc_channel: MessageDecoder ignores empty frames between delimiters', () => {
    const { MessageDecoder } = require('node:ipc_channel');
    const decoder = new MessageDecoder();
    const seen: unknown[] = [];
    decoder.on('message', (value: unknown) => seen.push(value));
    decoder.feed(encodeUtf8('\n1\n\ntrue\n'));
    deepStrictEqual(seen, [1, true]);
});

Deno.test('ipc_channel: MessageDecoder reset drops buffered partial message', () => {
    const { MessageDecoder } = require('node:ipc_channel');
    const decoder = new MessageDecoder();
    const seen: unknown[] = [];
    decoder.on('message', (value: unknown) => seen.push(value));
    decoder.feed(encodeUtf8('{"a":'));
    decoder.reset();
    decoder.feed(encodeUtf8('1}\n'));
    deepStrictEqual(seen, []);
});

Deno.test('ipc_channel: MessageDecoder preserves escaped newlines inside JSON strings', () => {
    const { MessageDecoder } = require('node:ipc_channel');
    const decoder = new MessageDecoder();
    const seen: unknown[] = [];
    decoder.on('message', (value: unknown) => seen.push(value));
    decoder.feed(encodeUtf8('"line1\\nline2"\n'));
    deepStrictEqual(seen, ['line1\nline2']);
});
