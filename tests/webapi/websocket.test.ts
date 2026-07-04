import { strictEqual, ok, match } from 'node:assert';
import * as http from 'node:http';

// ============================================================================
// WebSocket — state machine + echo over a real local server
// ============================================================================

function startWSServer(): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve) => {
        const server = http.createServer();
        const sockServer = new (require('node:net').Server)();
        // Use a minimal WS handshake via Node's built-in? We don't have 'ws'.
        // Instead, drive the WebSocket client against a raw TCP server that
        // performs the HTTP upgrade handshake manually.
        const net = require('node:net') as typeof import('node:net');
        const crypto = require('node:crypto') as typeof import('node:crypto');
        const srv = net.createServer((socket) => {
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
                        'Upgrade: websocket\r\n' +
                        'Connection: Upgrade\r\n' +
                        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
                    );
                    // Echo server: parse frames and echo them back
                    let fbuf = Buffer.alloc(0);
                    socket.on('data', (d: Buffer) => {
                        fbuf = Buffer.concat([fbuf, d]);
                        // parse one frame
                        while (fbuf.length >= 2) {
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
                            // send echo frame (text, unmasked from server)
                            const resp = Buffer.alloc(2 + len);
                            resp[0] = 0x81; resp[1] = len;
                            payload.copy(resp, 2);
                            socket.write(resp);
                        }
                    });
                }
            });
        });
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            resolve({ server: srv, port: typeof addr === 'object' && addr ? addr.port : 0 });
        });
    });
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

Deno.test({ name: 'WebSocket: connects and reaches OPEN state', timeout: 10000 }, async () => {
    const { server, port } = await startWSServer();
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        strictEqual(ws.readyState, WebSocket.OPEN);
        strictEqual(ws.url, `ws://127.0.0.1:${port}/`);
        ws.close();
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: send/receive echo', timeout: 10000 }, async () => {
    const { server, port } = await startWSServer();
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

Deno.test({ name: 'WebSocket: close fires onclose event', timeout: 10000 }, async () => {
    const { server, port } = await startWSServer();
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        const closeEv = await new Promise<any>((resolve) => {
            ws.onclose = (ev) => resolve(ev);
            ws.close(1000, 'normal');
        });
        strictEqual(ws.readyState, WebSocket.CLOSED);
        strictEqual(closeEv.code, 1000);
        strictEqual(closeEv.reason, 'normal');
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: bufferedAmount is a number', timeout: 10000 }, async () => {
    const { server, port } = await startWSServer();
    try {
        const ws = await wsConnect(`ws://127.0.0.1:${port}/`);
        ok(typeof ws.bufferedAmount === 'number');
        ws.close();
    } finally {
        server.close();
    }
});

Deno.test({ name: 'WebSocket: binaryType get/set', timeout: 10000 }, async () => {
    const { server, port } = await startWSServer();
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
    const { server, port } = await startWSServer();
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
