/**
 * CONNECT-tunnel pushback.
 *
 * `readHttpHead` reads in 4096-byte chunks, so the read that finds `\r\n\r\n`
 * routinely also pulls in bytes that belong to the tunnelled stream. Those bytes
 * used to be concatenated into the returned head text and dropped, which is silent
 * data loss on the tunnel: anything the proxy pipelined behind
 * `200 Connection Established` never reached the caller.
 *
 * The fixtures here emit the 2xx head and the payload in a SINGLE write, which is
 * what makes the loss observable. The pre-existing proxy fixtures in
 * proxy-transport.test.ts deliberately `socket.pause()` before writing the 200 so a
 * TLS ClientHello cannot race them — correct for those tests, and the reason they
 * never exercised this path.
 *
 * N = 0 / 16 / 4095 covers: nothing pipelined, a short pipeline, and a pipeline that
 * fills the rest of the 4096-byte read window.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import { openTcp } from '../../cno/src/utils/http.ts';
import { prependTunnelBytes, readHttpHead } from '../../cno/src/utils/proxy.ts';

const CONNECT_HEAD = 'HTTP/1.1 200 Connection Established\r\n\r\n';

interface ListeningServer { server: Server; port: number; }

async function listen(handler: (socket: Socket) => void): Promise<ListeningServer | null> {
    const server = createServer(handler);
    try {
        await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    } catch (error) {
        // Sandboxes that forbid listening must not turn into a false failure.
        if (String(error).includes('EPERM') || String(error).includes('operation not permitted')) return null;
        throw error;
    }
    return { server, port: (server.address() as { port: number }).port };
}

function closeServer(server: Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

/** Deterministic payload: byte i is (i % 251), so any truncation or reorder shows up. */
function payloadOf(size: number): Buffer {
    const bytes = Buffer.alloc(size);
    for (let index = 0; index < size; index++) bytes[index] = index % 251;
    return bytes;
}

/**
 * A proxy that answers CONNECT with the 2xx head and `size` payload bytes in one
 * write, so head and payload land in the same TCP segment and the same read.
 */
async function startPipeliningProxy(size: number): Promise<ListeningServer | null> {
    return listen(socket => {
        let request = '';
        const onData = (chunk: Buffer) => {
            request += chunk.toString('latin1');
            if (!request.includes('\r\n\r\n')) return;
            socket.removeListener('data', onData);
            if (!/^CONNECT /.test(request)) { socket.destroy(); return; }
            socket.write(Buffer.concat([Buffer.from(CONNECT_HEAD, 'latin1'), payloadOf(size)]));
        };
        socket.on('data', onData);
        socket.on('error', () => socket.destroy());
    });
}

async function connectAndRequest(port: number): Promise<Awaited<ReturnType<typeof openTcp>>> {
    const socket = await openTcp('127.0.0.1', port);
    await socket.write(new TextEncoder().encode('CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n'));
    return socket;
}

/** Read exactly `size` bytes off a socket, or fewer on EOF. */
async function readAtMost(socket: Awaited<ReturnType<typeof openTcp>>, size: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    while (total < size) {
        const chunk = await socket.read(size - total);
        if (!chunk || chunk.length === 0) break;
        parts.push(chunk);
        total += chunk.length;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { joined.set(part, offset); offset += part.length; }
    return joined;
}

for (const size of [0, 16, 4095]) {
    Deno.test({ name: `CONNECT pushback: head is exact and ${size} pipelined bytes survive`, timeout: 15000 }, async () => {
        const proxy = await startPipeliningProxy(size);
        if (!proxy) return;
        const socket = await connectAndRequest(proxy.port);
        try {
            const head = await readHttpHead(socket);

            // The head must stop AT the terminator. Before the fix this carried the
            // payload too, so for size > 0 the text was longer than CONNECT_HEAD.
            strictEqual(head.text, CONNECT_HEAD, 'head text must end at \\r\\n\\r\\n');

            // Leftover is what the read that found the terminator over-read: capped by
            // the 4096-byte read window minus the head, never more than the payload.
            // (Anything beyond that is still queued in the socket, not lost.)
            const leftoverLength = head.leftover?.length ?? 0;
            const windowLimit = 4096 - CONNECT_HEAD.length;
            strictEqual(leftoverLength, Math.min(size, windowLimit), 'over-read bytes must all be reported as leftover');

            // And they must reach a normal reader through the socket, not just be
            // reported. This is the part that was silent data loss.
            prependTunnelBytes(socket, head.leftover);
            if (size > 0) {
                const received = await readAtMost(socket, size);
                deepStrictEqual(Array.from(received), Array.from(payloadOf(size)), 'pipelined payload must arrive intact and in order');
            }
        } finally {
            socket.close();
            await closeServer(proxy.server);
        }
    });
}

/**
 * The callback read path (`onReadable`) is a different code path from `read()` —
 * websocket.ts and sse.ts use it — so the pushback has to cover it too.
 */
Deno.test({ name: 'CONNECT pushback: pipelined bytes reach the onReadable path first', timeout: 15000 }, async () => {
    const size = 16;
    const proxy = await startPipeliningProxy(size);
    if (!proxy) return;
    const socket = await connectAndRequest(proxy.port);
    try {
        const head = await readHttpHead(socket);
        strictEqual(head.text, CONNECT_HEAD);
        prependTunnelBytes(socket, head.leftover);

        const received = await new Promise<Uint8Array>((resolve, reject) => {
            const parts: number[] = [];
            const timer = setTimeout(() => reject(new Error(`onReadable delivered only ${parts.length}/${size} bytes`)), 8000);
            socket.onReadable(
                data => {
                    if (data === null) { clearTimeout(timer); resolve(new Uint8Array(parts)); return; }
                    parts.push(...data);
                    if (parts.length >= size) { clearTimeout(timer); resolve(new Uint8Array(parts)); }
                },
                error => { clearTimeout(timer); reject(error); },
            );
        });
        deepStrictEqual(Array.from(received), Array.from(payloadOf(size)), 'onReadable must see the pipelined bytes, in order, before later bytes');
    } finally {
        socket.close();
        await closeServer(proxy.server);
    }
});

/**
 * End-to-end through a tunnel: the proxy pipelines a complete HTTP response behind
 * the 200. Before the fix the response body vanished and the caller hung or saw a
 * truncated stream; the guard here is that the whole response arrives.
 */
Deno.test({ name: 'CONNECT pushback: a response pipelined behind the 200 is fully readable', timeout: 15000 }, async () => {
    const body = 'tunnelled-payload';
    const response = `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
    const proxy = await listen(socket => {
        let request = '';
        const onData = (chunk: Buffer) => {
            request += chunk.toString('latin1');
            if (!request.includes('\r\n\r\n')) return;
            socket.removeListener('data', onData);
            // Head + tunnelled response in ONE write.
            socket.write(Buffer.from(CONNECT_HEAD + response, 'latin1'));
        };
        socket.on('data', onData);
        socket.on('error', () => socket.destroy());
    });
    if (!proxy) return;
    const socket = await connectAndRequest(proxy.port);
    try {
        const head = await readHttpHead(socket);
        strictEqual(head.text, CONNECT_HEAD);
        prependTunnelBytes(socket, head.leftover);
        const received = new TextDecoder().decode(await readAtMost(socket, response.length));
        strictEqual(received, response, 'the entire pipelined response must survive the tunnel');
        ok(received.endsWith(body), 'body must not be truncated');
    } finally {
        socket.close();
        await closeServer(proxy.server);
    }
});

/** A head split across reads must still be assembled, and the split must not shift. */
Deno.test({ name: 'CONNECT pushback: head split across writes still splits correctly', timeout: 15000 }, async () => {
    const size = 32;
    const proxy = await listen(socket => {
        let request = '';
        const onData = (chunk: Buffer) => {
            request += chunk.toString('latin1');
            if (!request.includes('\r\n\r\n')) return;
            socket.removeListener('data', onData);
            // Terminator straddles two writes: '...\r\n' then '\r\n' + payload.
            socket.write(Buffer.from('HTTP/1.1 200 Connection Established\r\n', 'latin1'));
            setTimeout(() => socket.write(Buffer.concat([Buffer.from('\r\n', 'latin1'), payloadOf(size)])), 20);
        };
        socket.on('data', onData);
        socket.on('error', () => socket.destroy());
    });
    if (!proxy) return;
    const socket = await connectAndRequest(proxy.port);
    try {
        const head = await readHttpHead(socket);
        strictEqual(head.text, CONNECT_HEAD, 'head assembled across reads must still end at the terminator');
        strictEqual(head.leftover?.length ?? 0, size);
        prependTunnelBytes(socket, head.leftover);
        const received = await readAtMost(socket, size);
        deepStrictEqual(Array.from(received), Array.from(payloadOf(size)));
    } finally {
        socket.close();
        await closeServer(proxy.server);
    }
});

/** A payload containing `\r\n\r\n` must not move the split. */
Deno.test({ name: 'CONNECT pushback: a second CRLFCRLF in the payload does not move the split', timeout: 15000 }, async () => {
    const payload = Buffer.from('POST / HTTP/1.1\r\nX: 1\r\n\r\nbody-after-second-terminator', 'latin1');
    const proxy = await listen(socket => {
        let request = '';
        const onData = (chunk: Buffer) => {
            request += chunk.toString('latin1');
            if (!request.includes('\r\n\r\n')) return;
            socket.removeListener('data', onData);
            socket.write(Buffer.concat([Buffer.from(CONNECT_HEAD, 'latin1'), payload]));
        };
        socket.on('data', onData);
        socket.on('error', () => socket.destroy());
    });
    if (!proxy) return;
    const socket = await connectAndRequest(proxy.port);
    try {
        const head = await readHttpHead(socket);
        strictEqual(head.text, CONNECT_HEAD, 'split must be the FIRST terminator');
        prependTunnelBytes(socket, head.leftover);
        const received = new TextDecoder().decode(await readAtMost(socket, payload.length));
        strictEqual(received, payload.toString('latin1'));
    } finally {
        socket.close();
        await closeServer(proxy.server);
    }
});

console.log('REACHED END');
