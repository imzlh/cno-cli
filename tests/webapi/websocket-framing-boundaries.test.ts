import { strictEqual, ok } from 'node:assert';
import type { Server as NetServer } from 'node:net';
import { isLoopbackPermissionError } from '../_helpers/network.ts';

// ============================================================================
// WebSocket framing — payload-length encoding boundaries and frame validation
//
// Audited against node v24.18.0 with an independent hand-rolled RFC 6455 server
// (node has no bundled ws server, and `ws` is not installed offline). Every case
// here was measured in both runtimes before being written down.
//
// Why these cases: RFC 6455 5.2 switches the payload-length encoding at 125
// (7-bit), 126..65535 (16-bit) and >65535 (64-bit). A mistake in a boundary arm
// yields a plausible-but-truncated body that any "did it throw?" test passes, so
// each case compares a hash of the full payload, not just its arrival.
// ============================================================================

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** FNV-1a over the payload: a truncation or a shifted byte both change this. */
function fnv1a(bytes: Uint8Array): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i]!;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16);
}

/** Deterministic non-repeating bytes, so a duplicated block is detectable. */
function genBytes(n: number, seed: number): Uint8Array {
    let s = seed >>> 0;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        out[i] = (s >>> 24) & 0xFF;
    }
    return out;
}

type LenMode = 'auto' | '16' | '64';

/**
 * Build a server->client frame. `lenMode` can force a non-minimal length
 * encoding, which a conforming receiver must reject (RFC 6455 5.2).
 * Server frames are never masked.
 */
function buildFrame(opcode: number, payload: Uint8Array, opts: { fin?: boolean; lenMode?: LenMode; rsv?: number; mask?: boolean } = {}): Buffer {
    const Buf = require('node:buffer').Buffer as typeof Buffer;
    const fin = opts.fin ?? true;
    const lenMode = opts.lenMode ?? 'auto';
    const n = payload.length;
    let lenBytes: Buffer;
    let b2base: number;
    if (lenMode === '16' || (lenMode === 'auto' && n > 125 && n <= 65535)) {
        b2base = 126;
        lenBytes = Buf.alloc(2);
        lenBytes.writeUInt16BE(n, 0);
    } else if (lenMode === '64' || (lenMode === 'auto' && n > 65535)) {
        b2base = 127;
        lenBytes = Buf.alloc(8);
        lenBytes.writeBigUInt64BE(BigInt(n), 0);
    } else {
        b2base = n;
        lenBytes = Buf.alloc(0);
    }
    const head = Buf.from([(fin ? 0x80 : 0) | ((opts.rsv ?? 0) & 0x70) | (opcode & 0x0F), (opts.mask ? 0x80 : 0) | b2base]);
    const maskKey = opts.mask ? Buf.from([0x01, 0x02, 0x03, 0x04]) : Buf.alloc(0);
    const body = Buf.from(payload);
    if (opts.mask) for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ maskKey[i & 3]!;
    return Buf.concat([head, lenBytes, maskKey, body]);
}

/** Raw TCP server that performs the upgrade then writes caller-supplied frames. */
function startServer(onOpen: (write: (b: Buffer) => void) => void): Promise<{ server: NetServer; port: number } | null> {
    return new Promise((resolve, reject) => {
        const net = require('node:net') as typeof import('node:net');
        const crypto = require('node:crypto') as typeof import('node:crypto');
        const srv = net.createServer((socket) => {
            socket.on('error', () => {});
            let buf = Buffer.alloc(0);
            let upgraded = false;
            socket.on('data', (chunk: Buffer) => {
                if (upgraded) return;
                buf = Buffer.concat([buf, chunk]);
                if (!buf.includes(Buffer.from('\r\n\r\n'))) return;
                upgraded = true;
                const key = buf.toString().match(/sec-websocket-key: (.+)\r\n/i)?.[1];
                if (!key) { socket.destroy(); return; }
                const accept = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
                socket.write(
                    'HTTP/1.1 101 Switching Protocols\r\n'
                    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
                    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
                );
                onOpen((b) => { try { socket.write(b); } catch { /* peer gone */ } });
            });
        });
        srv.on('error', (err) => {
            if (isLoopbackPermissionError(err)) resolve(null); else reject(err);
        });
        srv.listen(0, '127.0.0.1', () => {
            resolve({ server: srv, port: (srv.address() as { port: number }).port });
        });
    });
}

/** Bounded: never let a framing bug hang the suite. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}

async function asBytes(data: unknown): Promise<Uint8Array> {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && typeof (data as Blob).arrayBuffer === 'function') {
        return new Uint8Array(await (data as Blob).arrayBuffer());
    }
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Receive one message and return its bytes; resolves null on an early close. */
function receiveOne(port: number): Promise<{ bytes: Uint8Array | null; code: number; reason: string }> {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
        let settled = false;
        ws.addEventListener('message', (ev) => {
            if (settled) return;
            settled = true;
            void asBytes((ev as MessageEvent).data).then((bytes) => {
                try { ws.close(1000, ''); } catch { /* already closing */ }
                resolve({ bytes, code: 0, reason: '' });
            });
        });
        ws.addEventListener('close', (ev) => {
            if (settled) return;
            settled = true;
            const e = ev as CloseEvent;
            resolve({ bytes: null, code: e.code, reason: e.reason });
        });
    });
}

// The 7-bit / 16-bit / 64-bit length-encoding transitions, hash-compared.
// 126 and 65536 are the first values needing a wider encoder; 125 and 65535 are
// the last values of the narrower one. An off-by-one in either arm shows up here.
for (const size of [0, 1, 125, 126, 127, 65535, 65536]) {
    Deno.test(`WebSocket: binary payload of ${size} bytes round-trips with an exact hash`, async () => {
        const payload = genBytes(size, size + 3);
        const expected = fnv1a(payload);
        const started = await startServer((write) => write(buildFrame(0x2, payload)));
        if (!started) return; // loopback blocked by sandbox policy
        try {
            const got = await withTimeout(receiveOne(started.port), 5000, `binary ${size}`);
            ok(got.bytes !== null, `expected a message, got close ${got.code}`);
            strictEqual(got.bytes!.length, size, `payload length for ${size}`);
            strictEqual(fnv1a(got.bytes!), expected, `payload hash for ${size}`);
        } finally {
            started.server.close();
        }
    });
}

// RFC 6455 5.2: the payload length MUST use the minimal number of bytes.
// cno rejects these; node v24.18.0 accepts them (measured). Keeping the strict
// behaviour locked down: a regression here would silently accept smuggled framing.
Deno.test('WebSocket: non-minimal 16-bit payload length fails the connection', async () => {
    const started = await startServer((write) => write(buildFrame(0x2, genBytes(100, 5), { lenMode: '16' })));
    if (!started) return;
    try {
        const got = await withTimeout(receiveOne(started.port), 5000, 'non-minimal 16');
        strictEqual(got.bytes, null, 'a non-minimally encoded frame must not be delivered');
        strictEqual(got.code, 1006, 'client observes an abnormal close');
    } finally {
        started.server.close();
    }
});

Deno.test('WebSocket: non-minimal 64-bit payload length fails the connection', async () => {
    const started = await startServer((write) => write(buildFrame(0x2, genBytes(100, 5), { lenMode: '64' })));
    if (!started) return;
    try {
        const got = await withTimeout(receiveOne(started.port), 5000, 'non-minimal 64');
        strictEqual(got.bytes, null, 'a 64-bit length below 65536 must be rejected');
        strictEqual(got.code, 1006, 'client observes an abnormal close');
    } finally {
        started.server.close();
    }
});

// RFC 6455 5.1: a server MUST NOT mask. A masked server frame is a protocol error.
Deno.test('WebSocket: a masked server frame fails the connection', async () => {
    const started = await startServer((write) => write(buildFrame(0x1, new TextEncoder().encode('masked'), { mask: true })));
    if (!started) return;
    try {
        const got = await withTimeout(receiveOne(started.port), 5000, 'masked server frame');
        strictEqual(got.bytes, null, 'a masked server frame must not be delivered');
        strictEqual(got.code, 1006, 'client observes an abnormal close');
    } finally {
        started.server.close();
    }
});

// RSV bits are reserved with no extension negotiated (RFC 6455 5.2).
Deno.test('WebSocket: a frame with RSV1 set fails the connection', async () => {
    const started = await startServer((write) => write(buildFrame(0x1, new TextEncoder().encode('rsv'), { rsv: 0x40 })));
    if (!started) return;
    try {
        const got = await withTimeout(receiveOne(started.port), 5000, 'rsv1');
        strictEqual(got.bytes, null, 'a frame with RSV1 set must not be delivered');
        strictEqual(got.code, 1006, 'client observes an abnormal close');
    } finally {
        started.server.close();
    }
});

// RFC 6455 5.5: control frames may be injected between the fragments of a
// message and MUST NOT break reassembly. Mishandling this drops or corrupts the
// surrounding data message rather than erroring, so assert the reassembled hash.
Deno.test('WebSocket: a ping interleaved inside a fragmented message preserves reassembly', async () => {
    const head = new TextEncoder().encode('inter');
    const tail = new TextEncoder().encode('leaved');
    const whole = new TextEncoder().encode('interleaved');
    const started = await startServer((write) => {
        write(buildFrame(0x1, head, { fin: false }));
        write(buildFrame(0x9, new TextEncoder().encode('mid')));   // PING mid-message
        write(buildFrame(0x0, tail, { fin: true }));                // CONTINUATION
    });
    if (!started) return;
    try {
        const got = await withTimeout(receiveOne(started.port), 5000, 'interleaved ping');
        ok(got.bytes !== null, `expected the reassembled message, got close ${got.code}`);
        strictEqual(new TextDecoder().decode(got.bytes!), 'interleaved');
        strictEqual(fnv1a(got.bytes!), fnv1a(whole), 'reassembled payload hash');
    } finally {
        started.server.close();
    }
});

// A fragmented message must be finished before a new data frame begins.
Deno.test('WebSocket: a new data frame while a fragment is open fails the connection', async () => {
    const started = await startServer((write) => {
        write(buildFrame(0x1, new TextEncoder().encode('one'), { fin: false }));
        write(buildFrame(0x1, new TextEncoder().encode('two'), { fin: true }));
    });
    if (!started) return;
    try {
        const got = await withTimeout(receiveOne(started.port), 5000, 'nested fragment');
        strictEqual(got.bytes, null, 'an interrupted fragment must not be delivered');
        strictEqual(got.code, 1006, 'client observes an abnormal close');
    } finally {
        started.server.close();
    }
});

// A CONTINUATION with no message open has nothing to continue.
Deno.test('WebSocket: an orphan continuation frame fails the connection', async () => {
    const started = await startServer((write) => write(buildFrame(0x0, new TextEncoder().encode('orphan'), { fin: true })));
    if (!started) return;
    try {
        const got = await withTimeout(receiveOne(started.port), 5000, 'orphan continuation');
        strictEqual(got.bytes, null, 'an orphan continuation must not be delivered');
        strictEqual(got.code, 1006, 'client observes an abnormal close');
    } finally {
        started.server.close();
    }
});

// A control frame carries at most 125 bytes and is never fragmented (RFC 6455 5.5).
Deno.test('WebSocket: an oversized control frame fails the connection', async () => {
    const started = await startServer((write) => write(buildFrame(0x9, genBytes(126, 9))));
    if (!started) return;
    try {
        const got = await withTimeout(receiveOne(started.port), 5000, 'oversized control');
        strictEqual(got.bytes, null, 'a 126-byte control frame must be rejected');
        strictEqual(got.code, 1006, 'client observes an abnormal close');
    } finally {
        started.server.close();
    }
});

Deno.test('WebSocket: a fragmented control frame fails the connection', async () => {
    const started = await startServer((write) => write(buildFrame(0x9, new TextEncoder().encode('f'), { fin: false })));
    if (!started) return;
    try {
        const got = await withTimeout(receiveOne(started.port), 5000, 'fragmented control');
        strictEqual(got.bytes, null, 'a fragmented control frame must be rejected');
        strictEqual(got.code, 1006, 'client observes an abnormal close');
    } finally {
        started.server.close();
    }
});

// Valid multi-byte UTF-8 split mid-codepoint across fragments must still decode:
// the decoder has to hold the partial sequence across the frame boundary rather
// than validate each fragment on its own.
Deno.test('WebSocket: valid UTF-8 split mid-codepoint across fragments decodes', async () => {
    const full = new TextEncoder().encode('héllo→wörld');
    const started = await startServer((write) => {
        write(buildFrame(0x1, full.subarray(0, 2), { fin: false })); // splits inside 'é'
        write(buildFrame(0x0, full.subarray(2), { fin: true }));
    });
    if (!started) return;
    try {
        const got = await withTimeout(receiveOne(started.port), 5000, 'utf8 split');
        ok(got.bytes !== null, `expected the decoded message, got close ${got.code}`);
        strictEqual(new TextDecoder().decode(got.bytes!), 'héllo→wörld');
    } finally {
        started.server.close();
    }
});
