/**
 * End-to-end CDP over a REAL WebSocket against the working-tree inspector.
 *
 * Every other cdp-* test either stops at the 101 handshake (cdp-endpoint) or calls
 * the dispatcher/domains directly (cdp-protocol, cdp-detach). Nothing drove actual
 * CDP frames through `startServer` -> `createWebSocketFromConnection` ->
 * `handleDevToolsConnection`, so the whole wire path was untested: frame decoding,
 * the malformed-message replies in `connection.ts`, and whether a second client can
 * attach after the first one leaves.
 *
 * These import from the working tree, so they are meaningful without a rebuild.
 * Frames are hand-rolled over node:net rather than using a WebSocket client,
 * because the tests need to send deliberately malformed payloads and to split one
 * frame across two TCP segments — neither is expressible through a WS client API.
 *
 * Reference behaviour is MEASURED against real node v24.18.0 and cited per test.
 */

import { ok, strictEqual } from 'node:assert';
import { connect, type Socket } from 'node:net';
import { startServer, type ServerHandle } from '../../src/inspector/worker/server';
import { CdpChannel, handleDevToolsConnection, type ConnectionDeps } from '../../src/inspector/worker/connection';
import { CDPDispatcher } from '../../src/inspector/worker/dispatcher';
import { ProtocolDomain } from '../../src/inspector/domains/protocol';
import type { ConsoleDomain } from '../../src/inspector/domains/console';
import type { DebuggerDomain } from '../../src/inspector/domains/debugger';
import type { FetchDomain } from '../../src/inspector/domains/fetch';
import type { NetworkDomain } from '../../src/inspector/domains/network';
import type { RuntimeDomain } from '../../src/inspector/domains/runtime';
import type { WorkerEndpoint } from '../../src/inspector/transport/worker-endpoint';

const HOST = '127.0.0.1';

function randomPort(): number {
    return 40000 + Math.floor(Math.random() * 20000);
}

// ---------------------------------------------------------------- WS framing

/** RFC 6455 client frame. Client->server payloads MUST be masked. */
function encodeFrame(payload: string, opcode = 0x1): Buffer {
    const body = Buffer.from(payload, 'utf8');
    const len = body.length;
    let header: Buffer;
    if (len < 126) {
        header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        // High 4 bytes stay zero: no test payload approaches 4 GiB.
        header.writeUInt32BE(len, 6);
    }
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = body[i]! ^ mask[i % 4]!;
    return Buffer.concat([header, mask, masked]);
}

interface DecodedFrame {
    opcode: number;
    payload: string;
}

/**
 * Pull every complete server frame out of `buf`, returning the frames and the
 * unconsumed tail. Server->client frames are never masked.
 */
function decodeFrames(buf: Buffer): { frames: DecodedFrame[]; rest: Buffer } {
    const frames: DecodedFrame[] = [];
    let off = 0;
    for (;;) {
        if (buf.length - off < 2) break;
        const b0 = buf[off]!;
        const b1 = buf[off + 1]!;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let cursor = off + 2;
        if (len === 126) {
            if (buf.length - cursor < 2) break;
            len = buf.readUInt16BE(cursor);
            cursor += 2;
        } else if (len === 127) {
            if (buf.length - cursor < 8) break;
            // Node's readUInt32BE pair avoids BigInt; payloads here are far under 4 GiB.
            len = buf.readUInt32BE(cursor + 4);
            cursor += 8;
        }
        if (masked) cursor += 4;
        if (buf.length - cursor < len) break;
        frames.push({ opcode, payload: buf.slice(cursor, cursor + len).toString('utf8') });
        off = cursor + len;
    }
    return { frames, rest: buf.slice(off) };
}

// ---------------------------------------------------------------- harness

interface Harness {
    port: number;
    handle: ServerHandle;
    /** Sockets handed to handleDevToolsConnection, in arrival order. */
    connections: number;
    /** setConnected(false) receipts, so a test can prove a detach ran. */
    detached: string[];
    dispatcher: CDPDispatcher;
}

/**
 * Start a real endpoint whose onConnect runs the real `handleDevToolsConnection`
 * over a real dispatcher. Domains are stubs (the point is the wire, not the
 * domains), but ProtocolDomain is real so there is a command with a known reply.
 */
async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        const port = randomPort();
        const dispatcher = new CDPDispatcher();
        const channel = new CdpChannel();
        const h: Harness = { port, handle: null as unknown as ServerHandle, connections: 0, detached: [], dispatcher };
        new ProtocolDomain(dispatcher, (method, params) => channel.emit(method, params));

        const stub = (name: string) => ({
            setConnected: (connected: boolean) => { if (!connected) h.detached.push(name); },
        });
        const deps: ConnectionDeps = {
            channel,
            dispatcher,
            rpc: { call: () => ({}), notify: () => {}, isPaused: () => false } as unknown as WorkerEndpoint,
            entryUrl: 'about:blank',
            debuggerDomain: stub('debugger') as unknown as DebuggerDomain,
            runtimeDomain: stub('runtime') as unknown as RuntimeDomain,
            consoleDomain: stub('console') as unknown as ConsoleDomain,
            fetchDomain: stub('fetch') as unknown as FetchDomain,
            networkDomain: stub('network') as unknown as NetworkDomain,
        };

        let handle: ServerHandle;
        try {
            handle = await startServer({
                port,
                host: HOST,
                entryUrl: 'file:///test/entry.ts',
                onConnect: (ws) => { h.connections++; handleDevToolsConnection(ws, deps); },
            });
        } catch (e) {
            lastError = e;
            continue;
        }
        h.handle = handle;
        try {
            await fn(h);
            return;
        } finally {
            try { handle.close(); } catch { /* already down */ }
        }
    }
    throw new Error(`could not bind an inspector endpoint: ${lastError}`);
}

/** A live CDP socket: raw TCP, upgraded, with frames decoded as they arrive. */
class WireClient {
    private socket: Socket;
    private buf = Buffer.alloc(0);
    private upgraded = false;
    private frames: DecodedFrame[] = [];
    closed = false;

    private constructor(socket: Socket) {
        this.socket = socket;
    }

    static async open(port: number, wsUrl: string): Promise<WireClient> {
        const url = new URL(wsUrl);
        const socket = connect({ host: HOST, port });
        const client = new WireClient(socket);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('upgrade timed out')), 8000);
            socket.on('error', (e) => { clearTimeout(timer); reject(e); });
            socket.on('close', () => { client.closed = true; });
            socket.on('data', (chunk: Buffer) => {
                client.buf = Buffer.concat([client.buf, chunk]);
                if (!client.upgraded) {
                    const split = client.buf.indexOf('\r\n\r\n');
                    if (split === -1) return;
                    const head = client.buf.slice(0, split).toString();
                    if (!head.startsWith('HTTP/1.1 101')) {
                        clearTimeout(timer);
                        reject(new Error(`upgrade refused: ${head.split('\r\n')[0]}`));
                        return;
                    }
                    client.upgraded = true;
                    client.buf = client.buf.slice(split + 4);
                    clearTimeout(timer);
                    resolve();
                }
                const { frames, rest } = decodeFrames(client.buf);
                client.buf = rest;
                client.frames.push(...frames);
            });
            socket.on('connect', () => {
                socket.write([
                    `GET ${url.pathname}${url.search} HTTP/1.1`,
                    `Host: ${HOST}:${port}`,
                    'Upgrade: websocket',
                    'Connection: Upgrade',
                    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
                    'Sec-WebSocket-Version: 13',
                ].join('\r\n') + '\r\n\r\n');
            });
        });
        return client;
    }

    send(text: string): void {
        this.socket.write(encodeFrame(text));
    }

    /** Send one frame as two TCP segments, splitting mid-payload. */
    sendSplit(text: string, firstBytes: number): void {
        const frame = encodeFrame(text);
        this.socket.write(frame.slice(0, firstBytes));
        // A real network split is not instantaneous; make the two reads distinct.
        return void setTimeout(() => this.socket.write(frame.slice(firstBytes)), 60);
    }

    sendRaw(bytes: Buffer): void {
        this.socket.write(bytes);
    }

    /** Wait until `count` text frames have arrived, or time out. */
    async expect(count: number, ms = 6000): Promise<Array<Record<string, unknown>>> {
        const deadline = Date.now() + ms;
        while (this.textFrames().length < count && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
        }
        return this.messages();
    }

    /** Settle time for asserting that something did NOT arrive. */
    async quiet(ms = 700): Promise<void> {
        await new Promise((r) => setTimeout(r, ms));
    }

    private textFrames(): DecodedFrame[] {
        return this.frames.filter((f) => f.opcode === 0x1);
    }

    messages(): Array<Record<string, unknown>> {
        return this.textFrames().map((f) => JSON.parse(f.payload) as Record<string, unknown>);
    }

    byId(id: number): Record<string, unknown> | undefined {
        return this.messages().find((m) => m.id === id);
    }

    close(): void {
        this.socket.destroy();
    }
}

function errorOf(msg: Record<string, unknown> | undefined): { code: number; message: string } {
    if (!msg) throw new Error('expected a reply, got none');
    const err = msg.error as { code: number; message: string } | undefined;
    if (!err) throw new Error(`expected an error reply, got ${JSON.stringify(msg).slice(0, 200)}`);
    return err;
}

// ---------------------------------------------------------------- tests

Deno.test({ name: 'cdp wire: a real CDP command round-trips over the socket', timeout: 25_000 }, async () => {
    await withHarness(async (h) => {
        const client = await WireClient.open(h.port, h.handle.wsUrl);
        strictEqual(h.connections, 1, 'the upgrade must reach handleDevToolsConnection');
        client.send(JSON.stringify({ id: 1, method: 'Schema.getDomains' }));
        await client.expect(1);
        const reply = client.byId(1);
        if (!reply) throw new Error('no reply to Schema.getDomains');
        const result = reply.result as { domains: Array<{ name: string }> };
        ok(result.domains.some((d) => d.name === 'Runtime'), 'the real dispatcher must answer');
        client.close();
    });
});

Deno.test({ name: 'cdp wire: malformed JSON gets a parse error, not a dropped socket', timeout: 25_000 }, async () => {
    await withHarness(async (h) => {
        const client = await WireClient.open(h.port, h.handle.wsUrl);
        client.send('{not json');
        await client.expect(1);
        const err = errorOf(client.messages()[0]);
        // cno answers JSON-RPC ParseError (-32700) with id:null. Real node instead
        // answers {"id":0,"error":{"code":-32601,"message":"'' wasn't found"}}
        // (MEASURED, node v24.18) because it parses into a struct that defaults both
        // id and method. cno's shape is the more correct JSON-RPC one; what matters
        // for parity is that SOMETHING comes back and the socket stays up.
        strictEqual(err.code, -32700);
        strictEqual(client.messages()[0]!.id, null);

        // The socket must remain usable after a parse error.
        client.send(JSON.stringify({ id: 2, method: 'Schema.getDomains' }));
        await client.expect(2);
        ok(client.byId(2)?.result, 'the socket must survive a malformed frame');
        ok(!client.closed, 'a parse error must not close the connection');
        client.close();
    });
});

Deno.test({ name: 'cdp wire: unknown methods and bad params answer per-id', timeout: 25_000 }, async () => {
    await withHarness(async (h) => {
        const client = await WireClient.open(h.port, h.handle.wsUrl);
        client.send(JSON.stringify({ id: 1, method: 'Nope.missing' }));
        client.send(JSON.stringify({ id: 2, method: 'Schema.getDomains', params: 'not-an-object' }));
        client.send(JSON.stringify({ id: 3 })); // id but no method
        await client.expect(3);

        strictEqual(errorOf(client.byId(1)).code, -32601, 'MethodNotFound, same as node');
        // node answers -32600 "Message may have object 'params' property" here
        // (MEASURED); cno answers -32602 InvalidParams. Both reject, code differs.
        strictEqual(errorOf(client.byId(2)).code, -32602);
        // node: {"id":7,"error":{"code":-32601,"message":"'' wasn't found"}} (MEASURED)
        strictEqual(errorOf(client.byId(3)).code, -32600);
        ok(!client.closed);
        client.close();
    });
});

Deno.test({ name: 'cdp wire: a message with no id is still answered', timeout: 25_000 }, async () => {
    await withHarness(async (h) => {
        const client = await WireClient.open(h.port, h.handle.wsUrl);
        // MEASURED, node v24.18: {"method":"Runtime.enable"} with no id answers
        // {"error":{"code":-32600,"message":"Message must have integer 'id' property"}}.
        // cno used to `return` silently, so a client that omitted the id — or sent a
        // string/float id, which parseCDPMessage discards — waited forever with no
        // indication anything was wrong.
        client.send(JSON.stringify({ method: 'Schema.getDomains' }));
        await client.expect(1);
        const err = errorOf(client.messages()[0]);
        strictEqual(err.code, -32600);
        ok(err.message.toLowerCase().includes('id'), `message should name the id: ${err.message}`);
        client.close();
    });
});

Deno.test({ name: 'cdp wire: a non-integer id is reported, not silently dropped', timeout: 25_000 }, async () => {
    await withHarness(async (h) => {
        const client = await WireClient.open(h.port, h.handle.wsUrl);
        // parseCDPMessage only keeps `id` when it is a number or null, so a string id
        // arrives as absent. Node also refuses these (MEASURED: id:"1" and id:1.5 both
        // answer an error). Either way the client must not be left hanging.
        client.send(JSON.stringify({ id: '7', method: 'Schema.getDomains' }));
        client.send(JSON.stringify({ id: null, method: 'Schema.getDomains' }));
        await client.expect(2);
        const msgs = client.messages();
        strictEqual(msgs.length, 2, 'both malformed ids must be answered');
        for (const m of msgs) strictEqual(errorOf(m).code, -32600);
        client.close();
    });
});

Deno.test({ name: 'cdp wire: a duplicate id gets two replies, like node', timeout: 25_000 }, async () => {
    await withHarness(async (h) => {
        const client = await WireClient.open(h.port, h.handle.wsUrl);
        // MEASURED, node v24.18: two Runtime.evaluate commands both sent as id 2 get
        // two separate id-2 replies. CDP has no duplicate-id detection; the client owns
        // its id space. Pinning this so nobody "fixes" it into a dropped reply.
        client.send(JSON.stringify({ id: 5, method: 'Schema.getDomains' }));
        client.send(JSON.stringify({ id: 5, method: 'Schema.getDomains' }));
        await client.expect(2);
        const both = client.messages().filter((m) => m.id === 5);
        strictEqual(both.length, 2, 'both duplicate-id commands must be answered');
        client.close();
    });
});

Deno.test({ name: 'cdp wire: a frame split across two TCP segments is reassembled', timeout: 25_000 }, async () => {
    await withHarness(async (h) => {
        const client = await WireClient.open(h.port, h.handle.wsUrl);
        // The wire is a byte stream: a CDP frame arriving as two reads is normal, not
        // exceptional. Nothing tested this, and a naive parser that treats one read as
        // one frame would answer a parse error here (or hang).
        const payload = JSON.stringify({ id: 9, method: 'Schema.getDomains' });
        client.sendSplit(payload, 8); // mid-payload, after the header and mask
        await client.expect(1, 8000);
        const reply = client.byId(9);
        if (!reply) throw new Error(`split frame was not reassembled; got ${JSON.stringify(client.messages())}`);
        ok(reply.result, 'a split frame must dispatch normally');
        client.close();
    });
});

Deno.test({ name: 'cdp wire: two commands in one TCP segment both dispatch', timeout: 25_000 }, async () => {
    await withHarness(async (h) => {
        const client = await WireClient.open(h.port, h.handle.wsUrl);
        // The mirror of the split case: coalesced writes must not lose the second frame.
        const a = encodeFrame(JSON.stringify({ id: 11, method: 'Schema.getDomains' }));
        const b = encodeFrame(JSON.stringify({ id: 12, method: 'Schema.getDomains' }));
        client.sendRaw(Buffer.concat([a, b]));
        await client.expect(2, 8000);
        ok(client.byId(11), 'first coalesced frame must dispatch');
        ok(client.byId(12), 'second coalesced frame must dispatch');
        client.close();
    });
});

Deno.test({ name: 'cdp wire: an oversized payload does not kill the session', timeout: 30_000 }, async () => {
    await withHarness(async (h) => {
        const client = await WireClient.open(h.port, h.handle.wsUrl);
        // 2 MiB of expression, i.e. a 64-bit-length frame. MEASURED: node v24.18
        // accepts a 2 MiB Runtime.evaluate and replies normally. The failure mode to
        // catch is the worker wedging or the socket dropping with no reply.
        const huge = 'x'.repeat(2 * 1024 * 1024);
        client.send(JSON.stringify({ id: 21, method: 'Schema.getDomains', params: { pad: huge } }));
        await client.expect(1, 20_000);
        const reply = client.byId(21);
        if (!reply) throw new Error('a 2 MiB frame produced no reply at all');
        ok(reply.result ?? reply.error, 'a huge frame must get either a result or an error');

        client.send(JSON.stringify({ id: 22, method: 'Schema.getDomains' }));
        await client.expect(2, 8000);
        ok(client.byId(22), 'the session must still work after a huge frame');
        client.close();
    });
});

Deno.test({ name: 'cdp wire: a second client can attach after the first leaves', timeout: 30_000 }, async () => {
    await withHarness(async (h) => {
        const first = await WireClient.open(h.port, h.handle.wsUrl);
        first.send(JSON.stringify({ id: 1, method: 'Schema.getDomains' }));
        await first.expect(1);
        ok(first.byId(1), 'first session must work');

        // Hard close: no WS close handshake, exactly like a crashed frontend. This is
        // the case the `ws.onerror = detach` change exists for.
        first.close();
        await new Promise((r) => setTimeout(r, 900));
        ok(h.detached.length > 0, `the first session must be released, got ${JSON.stringify(h.detached)}`);

        const second = await WireClient.open(h.port, h.handle.wsUrl);
        strictEqual(h.connections, 2, 'a second upgrade must be accepted');
        second.send(JSON.stringify({ id: 1, method: 'Schema.getDomains' }));
        await second.expect(1);
        ok(second.byId(1), 'the second session must be able to dispatch commands');
        second.close();
    });
});

Deno.test({ name: 'cdp wire: a superseding client takes over and the old socket goes quiet', timeout: 30_000 }, async () => {
    await withHarness(async (h) => {
        const first = await WireClient.open(h.port, h.handle.wsUrl);
        first.send(JSON.stringify({ id: 1, method: 'Schema.getDomains' }));
        await first.expect(1);

        // Second client attaches while the first is still open.
        const second = await WireClient.open(h.port, h.handle.wsUrl);
        strictEqual(h.connections, 2);
        await new Promise((r) => setTimeout(r, 500));
        // takeSocket/dropSink must have released the displaced session.
        ok(h.detached.length > 0, 'the displaced session must be released');

        const before = first.messages().length;
        first.send(JSON.stringify({ id: 99, method: 'Schema.getDomains' }));
        await first.quiet(900);
        strictEqual(first.messages().length, before, 'a superseded socket must not be served');

        second.send(JSON.stringify({ id: 2, method: 'Schema.getDomains' }));
        await second.expect(1);
        ok(second.byId(2), 'the new owner must be served');
        first.close();
        second.close();
    });
});
