import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';
import type { Server as NetServer } from 'node:net';
import { isLoopbackPermissionError } from '../_helpers/network.ts';

// ============================================================================
// WebSocket — state machine + echo over a real local server
// ============================================================================

function startWSServer(
    initialFrame?: Uint8Array,
    handshake: { connection?: string; upgrade?: string; extraHeaders?: string[]; echoClose?: boolean } = {},
): Promise<{ server: NetServer; port: number } | null> {
    return new Promise((resolve, reject) => {
        // Use a minimal WS handshake via Node's built-in? We don't have 'ws'.
        // Instead, drive the WebSocket client against a raw TCP server that
        // performs the HTTP upgrade handshake manually.
        const net = require('node:net') as typeof import('node:net');
        const crypto = require('node:crypto') as typeof import('node:crypto');
        const srv = net.createServer((socket) => {
            socket.on('error', () => {});
            let buf = Buffer.alloc(0);
            let upgraded = false;
            socket.on('data', (chunk: Buffer) => {
                buf = Buffer.concat([buf, chunk]);
                if (!upgraded && buf.includes(Buffer.from('\r\n\r\n'))) {
                    upgraded = true;
                    const key = buf.toString().match(/sec-websocket-key: (.+)\r\n/i)?.[1];
                    if (!key) { socket.destroy(); return; }
                    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
                    socket.write(
                        'HTTP/1.1 101 Switching Protocols\r\n' +
                        `Upgrade: ${handshake.upgrade ?? 'websocket'}\r\n` +
                        `Connection: ${handshake.connection ?? 'Upgrade'}\r\n` +
                        `Sec-WebSocket-Accept: ${accept}\r\n` +
                        (handshake.extraHeaders?.map((header) => `${header}\r\n`).join('') ?? '') +
                        '\r\n'
                    );
                    if (initialFrame) socket.write(initialFrame);
                    // Echo server: parse frames and echo them back
                    let fbuf = Buffer.alloc(0);
                    socket.on('data', (d: Buffer) => {
                        fbuf = Buffer.concat([fbuf, d]);
                        // parse one frame
                        while (fbuf.length >= 2) {
                            const opcode = fbuf[0] & 0x0f;
                            const masked = (fbuf[1] & 0x80) !== 0;
                            let len = fbuf[1] & 0x7f;
                            let offset = 2;
                            if (len === 126) { len = fbuf.readUInt16BE(2); offset = 4; }
                            else if (len === 127) { len = Number(fbuf.readBigUInt64BE(2)); offset = 10; }
                            const maskBytes = masked ? 4 : 0;
                            if (fbuf.length < offset + maskBytes + len) break;
                            const mask = masked ? fbuf.slice(offset, offset + 4) : null;
                            offset += maskBytes;
                            const payload = Buffer.from(fbuf.slice(offset, offset + len));
                            if (mask) {
                                for (let i = 0; i < payload.length; i++) {
                                    payload[i] ^= mask[i % 4]!;
                                }
                            }
                            fbuf = fbuf.slice(offset + len);
                            if (opcode === 0x8 && handshake.echoClose === false) continue;
                            // send echo frame with the original opcode (text or binary), unmasked from server.
                            const resp = Buffer.alloc(2 + len);
                            resp[0] = 0x80 | opcode; resp[1] = len;
                            payload.copy(resp, 2);
                            socket.write(resp);
                        }
                    });
                }
            });
        });
        const onError = (error: Error) => {
            srv.removeListener('listening', onListening);
            if (isLoopbackPermissionError(error)) resolve(null);
            else reject(error);
        };
        const onListening = () => {
            srv.removeListener('error', onError);
            const addr = srv.address();
            resolve({ server: srv, port: typeof addr === 'object' && addr ? addr.port : 0 });
        };
        srv.once('error', onError);
        try {
            srv.listen(0, '127.0.0.1', onListening);
        } catch (error) {
            srv.removeListener('error', onError);
            if (isLoopbackPermissionError(error)) resolve(null);
            else reject(error);
        }
    });
}

async function expectHandshakeFailure(
    handshake: { connection?: string; upgrade?: string; extraHeaders?: string[] },
    protocols?: string[],
): Promise<void> {
    const started = await startWSServer(undefined, handshake);
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, protocols);
        const events: string[] = [];
        ws.onerror = () => { events.push('error'); };
        const close = await new Promise<CloseEvent>((resolve) => { ws.onclose = resolve; });
        strictEqual(close.code, 1006);
        strictEqual(close.wasClean, false);
        deepStrictEqual(events, ['error']);
    } finally {
        server.close();
    }
}

function wsConnect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.onopen = () => resolve(ws);
        ws.onerror = (e) => reject(new Error('ws error'));
    });
}

Deno.test({ name: 'WebSocket: static readyState constants', timeout: 10000 }, () => {
    strictEqual(WebSocket.CONNECTING, 0);
    strictEqual(WebSocket.OPEN, 1);
    strictEqual(WebSocket.CLOSING, 2);
    strictEqual(WebSocket.CLOSED, 3);
});

Deno.test('WebSocket upstream: constructor rejects invalid URLs and duplicate protocols', () => {
    throws(() => new WebSocket('foo://localhost:4242'), DOMException);
    throws(() => new WebSocket('ws://localhost:4242/#'), DOMException);
    throws(() => new WebSocket('ws://localhost:4242/#foo'), DOMException);
    throws(() => new WebSocket('ws://localhost:4242', ['foo', 'foo']), DOMException);
});

Deno.test('WebSocket upstream: constructor converts iterable protocol sequences', () => {
    const fromSet = new WebSocket(
        'ws://127.0.0.1:1',
        new Set(['alpha', 2]) as unknown as string[],
    );
    fromSet.onerror = () => {};
    fromSet.close();

    const invalidIterable = { *[Symbol.iterator]() { yield 'has space'; } };
    throws(
        () => new WebSocket('ws://127.0.0.1:1', invalidIterable as unknown as string[]),
        DOMException,
    );
    const symbolIterable = { *[Symbol.iterator]() { yield Symbol('x'); } };
    throws(
        () => new WebSocket('ws://127.0.0.1:1', symbolIterable as unknown as string[]),
        TypeError,
    );
});

Deno.test('WebSocket upstream: constructor accepts URL objects', () => {
    const ws = new WebSocket(new URL('ws://127.0.0.1:1/path'));
    try {
        strictEqual(ws.url, 'ws://127.0.0.1:1/path');
    } finally {
        ws.close();
    }
});

Deno.test({ name: 'WebSocket: connection failure emits error then abnormal close', timeout: 10000 }, async () => {
    const ws = new WebSocket('ws://127.0.0.1:1/');
    const events: string[] = [];
    ws.onerror = () => { events.push(`error:${ws.readyState}`); };
    const close = await new Promise<CloseEvent>((resolve) => {
        ws.onclose = (event) => {
            events.push(`close:${event.code}:${event.wasClean}:${ws.readyState}`);
            resolve(event);
        };
    });
    strictEqual(close.code, 1006);
    strictEqual(close.wasClean, false);
    deepStrictEqual(events, ['error:3', 'close:1006:false:3']);
});

Deno.test({ name: 'WebSocket: close while connecting cannot leave CLOSING or reopen', timeout: 10000 }, async () => {
    const ws = new WebSocket('ws://127.0.0.1:1/');
    ws.onerror = () => {};
    const closed = new Promise<CloseEvent>((resolve) => { ws.onclose = resolve; });
    ws.close();
    strictEqual(ws.readyState, WebSocket.CLOSING);
    const event = await closed;
    strictEqual(ws.readyState, WebSocket.CLOSED);
    strictEqual(event.code, 1006);
    strictEqual(event.wasClean, false);
});

Deno.test('WebSocket upstream: close validates custom code and reason before sending', () => {
    const ws = new WebSocket('ws://127.0.0.1:1/');
    try {
        throws(() => ws.close(1001), DOMException);
        throws(() => ws.close(1000, ''.padEnd(124, 'o')), DOMException);
    } finally {
        ws.close();
    }
});

Deno.test('WebSocket upstream: close applies WebIDL coercion before validation', () => {
    const numericString = new WebSocket('ws://127.0.0.1:1/');
    numericString.onerror = () => {};
    numericString.close('1000' as unknown as number, null as unknown as string);
    strictEqual(numericString.readyState, WebSocket.CLOSING);

    const fractional = new WebSocket('ws://127.0.0.1:1/');
    fractional.onerror = () => {};
    fractional.close(3000.9);
    strictEqual(fractional.readyState, WebSocket.CLOSING);

    const outOfRange = new WebSocket('ws://127.0.0.1:1/');
    outOfRange.onerror = () => {};
    throws(() => outOfRange.close(0x1_0000_03e8), DOMException);
    outOfRange.close();
});

Deno.test({ name: 'WebSocket: connects and reaches OPEN state', timeout: 10000 }, async () => {
    const started = await startWSServer();
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        strictEqual(ws.readyState, WebSocket.OPEN);
        strictEqual(ws.url, `ws://127.0.0.1:${port}/`);
        ws.close();
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: rejects invalid or unsolicited handshake headers', timeout: 10000 }, async () => {
    await expectHandshakeFailure({ connection: 'notupgrade' });
    await expectHandshakeFailure({ extraHeaders: ['Sec-WebSocket-Accept: duplicate'] });
    await expectHandshakeFailure(
        { extraHeaders: ['Sec-WebSocket-Protocol: alpha, beta'] },
        ['alpha', 'beta'],
    );
    await expectHandshakeFailure({ extraHeaders: ['Sec-WebSocket-Extensions: permessage-deflate'] });
});

Deno.test({ name: 'WebSocket: send/receive echo', timeout: 10000 }, async () => {
    const started = await startWSServer();
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        const reply = await new Promise<any>((resolve) => {
            ws.onmessage = (ev) => resolve(ev.data);
            ws.send('hello-ws');
        });
        strictEqual(reply, 'hello-ws');
        ws.close();
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: send converts non-BufferSource values to text', timeout: 10000 }, async () => {
    const started = await startWSServer();
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        for (const [input, expected] of [[123, '123'], [null, 'null'], [{ a: 1 }, '[object Object]']] as const) {
            const reply = new Promise<string>((resolve) => { ws.onmessage = (event) => resolve(String(event.data)); });
            ws.send(input as unknown as string);
            strictEqual(await reply, expected);
        }
        throws(() => ws.send(Symbol('x') as unknown as string), TypeError);
        ws.close();
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: Blob bytes count synchronously in bufferedAmount', timeout: 10000 }, async () => {
    const started = await startWSServer();
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        const reply = new Promise<void>((resolve) => { ws.onmessage = () => resolve(); });
        const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
        ws.send(blob);
        strictEqual(ws.bufferedAmount, blob.size);
        await reply;
        strictEqual(ws.bufferedAmount, 0);
        ws.close();
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: invalid UTF-8 text fails the connection with 1007', timeout: 10000 }, async () => {
    const started = await startWSServer(new Uint8Array([0x81, 0x02, 0xc3, 0x28]));
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
        let messageSeen = false;
        ws.onmessage = () => { messageSeen = true; };
        const events: string[] = [];
        const close = await new Promise<CloseEvent>((resolve) => {
            ws.onclose = resolve;
            ws.onerror = () => { events.push(`error:${ws.readyState}`); };
        });
        strictEqual(messageSeen, false);
        strictEqual(close.code, 1006);
        strictEqual(close.wasClean, false);
        deepStrictEqual(events, ['error:3']);
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: data coalesced after CLOSE is discarded', timeout: 10000 }, async () => {
    const closeThenText = new Uint8Array([
        0x88, 0x02, 0x03, 0xe8,
        0x81, 0x04, 0x6c, 0x61, 0x74, 0x65,
    ]);
    const started = await startWSServer(closeThenText);
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
        let messageSeen = false;
        ws.onmessage = () => { messageSeen = true; };
        const close = await new Promise<CloseEvent>((resolve) => { ws.onclose = resolve; });
        strictEqual(close.code, 1000);
        strictEqual(close.wasClean, true);
        strictEqual(messageSeen, false);
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: close fires onclose event', timeout: 10000 }, async () => {
    const started = await startWSServer();
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        const closeEv = await new Promise<any>((resolve) => {
            ws.onclose = (ev) => resolve(ev);
            ws.close(1000, 'normal');
        });
        strictEqual(ws.readyState, WebSocket.CLOSED);
        strictEqual(closeEv.code, 1000);
        strictEqual(closeEv.reason, 'normal');
        strictEqual(closeEv.wasClean, true);
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: bufferedAmount is a number', timeout: 10000 }, async () => {
    const started = await startWSServer();
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        ok(typeof ws.bufferedAmount === 'number');
        const echoed = new Promise<void>((resolve) => { ws.onmessage = () => resolve(); });
        ws.send('x');
        strictEqual(ws.bufferedAmount, 1, 'frame header and mask must not count');
        await echoed;
        strictEqual(ws.bufferedAmount, 0);
        ws.close();
        strictEqual(ws.bufferedAmount, 0, 'CLOSE control frame must not count');
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: binaryType get/set', timeout: 10000 }, async () => {
    const started = await startWSServer();
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        ws.binaryType = 'arraybuffer';
        strictEqual(ws.binaryType, 'arraybuffer');
        ws.binaryType = 'blob';
        strictEqual(ws.binaryType, 'blob');
        ws.close();
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: addEventListener message works', timeout: 10000 }, async () => {
    const started = await startWSServer();
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        const reply = await new Promise<any>((resolve) => {
            ws.addEventListener('message', (ev: MessageEvent) => resolve(ev.data));
            ws.send('via-add');
        });
        strictEqual(reply, 'via-add');
        ws.close();
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket upstream: echoes Uint8Array as Blob by default', timeout: 10000 }, async () => {
    const started = await startWSServer();
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        strictEqual(ws.binaryType, 'blob');
        const reply = await new Promise<Blob>((resolve) => {
            ws.onmessage = (ev) => resolve(ev.data as Blob);
            ws.send(new Uint8Array([102, 111, 111]));
        });
        ok(reply instanceof Blob);
        strictEqual(await reply.text(), 'foo');
        ws.close();
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket upstream: echoes Blob and ArrayBuffer as ArrayBuffer when requested', timeout: 10000 }, async () => {
    const started = await startWSServer();
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        ws.binaryType = 'arraybuffer';

        const blobReply = await new Promise<ArrayBuffer>((resolve) => {
            ws.onmessage = (ev) => resolve(ev.data as ArrayBuffer);
            ws.send(new Blob(['foo']));
        });
        deepStrictEqual(new Uint8Array(blobReply), new Uint8Array([102, 111, 111]));

        const arrayBufferReply = await new Promise<ArrayBuffer>((resolve) => {
            ws.onmessage = (ev) => resolve(ev.data as ArrayBuffer);
            ws.send(new Uint8Array([98, 97, 114]).buffer);
        });
        deepStrictEqual(new Uint8Array(arrayBufferReply), new Uint8Array([98, 97, 114]));
        ws.close();
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: preserves Blob send order and flushes accepted data before CLOSE', timeout: 10000 }, async () => {
    const started = await startWSServer();
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        ws.binaryType = 'arraybuffer';
        const messages: string[] = [];
        const received = new Promise<void>((resolve) => {
            ws.onmessage = (event) => {
                const value = typeof event.data === 'string'
                    ? event.data
                    : String.fromCharCode(...new Uint8Array(event.data as ArrayBuffer));
                messages.push(value);
                if (messages.length === 2) resolve();
            };
        });
        const closed = new Promise<CloseEvent>((resolve) => { ws.onclose = resolve; });
        ws.send(new Blob(['first']));
        ws.send('second');
        ws.close(1000, 'done');
        await received;
        const close = await closed;
        deepStrictEqual(messages, ['first', 'second']);
        strictEqual(close.code, 1000);
        strictEqual(close.wasClean, true);
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: missing CLOSE response becomes an abnormal empty-reason close', timeout: 10000 }, async () => {
    const started = await startWSServer(undefined, { echoClose: false });
    if (!started) return;
    const { server, port } = started;
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        const events: string[] = [];
        ws.onerror = () => { events.push('error'); };
        const closed = new Promise<CloseEvent>((resolve) => {
            ws.onclose = (event) => { events.push('close'); resolve(event); };
        });
        ws.close(1000, 'local reason');
        const close = await closed;
        deepStrictEqual(events, ['error', 'close']);
        strictEqual(close.code, 1006);
        strictEqual(close.reason, '');
        strictEqual(close.wasClean, false);
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocketStream: abnormal connection rejects opened and closed', timeout: 10000 }, async () => {
    const stream = new WebSocketStream('ws://127.0.0.1:1/');
    const [opened, closed] = await Promise.allSettled([stream.opened, stream.closed]);
    strictEqual(opened.status, 'rejected');
    strictEqual(closed.status, 'rejected');
});
