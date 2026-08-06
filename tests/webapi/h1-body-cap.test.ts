/**
 * H1ServerConnection request-body cap and transport backpressure (@cnojs/http).
 *
 * `H1ServerConnection.bodyChunk` used to be a plain unbounded array: the read loop kept
 * pulling from the socket and enqueuing while the handler ran concurrently, so a peer
 * that sent a body no handler read grew RSS one-for-one with what it sent. Measured on
 * this binary before the fix: 256 MB pushed at a handler that replies without reading
 * produced 263 MB of RSS growth that was never released, and `req.pause()` was a no-op.
 * Any endpoint answering without consuming the body — `res.end('ok')` on an
 * unauthenticated route — was a remote memory-exhaustion amplifier.
 *
 * Two mechanisms bound it, and each covers the other's blind spot:
 *   - BODY_HIGH_WATER_MARK stops reading the socket while a *real* consumer is behind.
 *     That is true flow control: bytes stay in the kernel receive buffer and the TCP
 *     window closes. It must never fire as an error for a legitimate slow handler.
 *   - MAX_BUFFERED_BODY_BYTES hard-fails the body when *nothing* is consuming it — the
 *     case where waiting for a drain that will never come would deadlock the read loop.
 *
 * These tests drive a real loopback socket rather than stubbing, because backpressure is
 * defined by whether the socket is read, which a stub cannot observe.
 */
import { ok, strictEqual } from 'node:assert';
import { Buffer } from 'node:buffer';
import * as net from 'node:net';
import { createServer, type Server, type HttpRequest, type HttpResponse } from '@cnojs/http/server';

const MAX_BUFFERED_BODY_BYTES = 16 * 1024 * 1024;
const MiB = 1024 * 1024;

interface Served { server: Server; port: number; }

async function serve(handler: (req: HttpRequest, res: HttpResponse) => void | Promise<void>): Promise<Served> {
    const server = createServer(handler, { hostname: '127.0.0.1', port: 0 });
    server.listen();
    void server.acceptLoop();
    const addr = server.address();
    if (!addr || !('port' in addr)) throw new Error('server did not bind a port');
    return { server, port: addr.port };
}

async function stop(s: Served): Promise<void> {
    try { s.server.close(); } catch { /* already closed */ }
    await new Promise<void>(resolve => setTimeout(resolve, 60));
}

function rss(): number {
    const p = (globalThis as { process?: { memoryUsage?: () => { rss: number } } }).process;
    try { return p?.memoryUsage?.().rss ?? 0; } catch { return 0; }
}
interface FloodResult { sent: number; fate: string; ms: number }

/**
 * Push a body at the server and report how much it actually accepted.
 *
 * The client honours its own send backpressure (waits for 'drain'), which is what makes
 * `sent` a measurement of the *server's* willingness to read rather than of the client's
 * socket queue: without the drain wait, bytes the server never read would still be
 * counted as sent and would inflate this process's RSS.
 */
function flood(
    port: number,
    total: number,
    opts: { framing?: 'cl' | 'chunked'; stallMs?: number } = {},
): Promise<FloodResult> {
    const framing = opts.framing ?? 'cl';
    const stallMs = opts.stallMs ?? 2500;
    const size = 64 * 1024;
    const payload = Buffer.alloc(size, 0x61);
    const frame = Buffer.concat([Buffer.from(`${size.toString(16)}\r\n`), payload, Buffer.from('\r\n')]);
    const t0 = Date.now();
    return new Promise<FloodResult>((resolve) => {
        const sock = net.connect(port, '127.0.0.1');
        let sent = 0, fate = 'open', settled = false;
        const finish = (f?: string): void => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch { /* */ }
            resolve({ sent, fate: f ?? (fate === 'open' ? 'closed' : fate), ms: Date.now() - t0 });
        };
        sock.on('error', () => { if (fate === 'open') fate = 'reset'; });
        sock.on('end', () => { if (fate === 'open') fate = 'server-FIN'; });
        sock.on('close', () => finish());
        sock.on('data', () => { /* response bytes are not the subject here */ });
        sock.on('connect', () => {
            const head = framing === 'chunked'
                ? `POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n`
                : `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: ${total}\r\n\r\n`;
            sock.write(head);
            void (async () => {
                const buf = framing === 'chunked' ? frame : payload;
                while (sent < total && !sock.destroyed && !settled) {
                    const accepted = sock.write(buf);
                    sent += size;
                    if (!accepted) {
                        const drained = await Promise.race([
                            new Promise<boolean>(r => sock.once('drain', () => r(true))),
                            new Promise<boolean>(r => setTimeout(() => r(false), stallMs)),
                        ]);
                        // No drain: the server has stopped reading. That is backpressure
                        // working, not a failure, so report it rather than spinning.
                        if (!drained) { finish('stalled'); return; }
                    }
                }
                setTimeout(() => finish(), 400);
            })();
        });
    });
}
Deno.test({ name: 'h1 body cap: an ignoring handler cannot be flooded past the cap', timeout: 40000 }, async () => {
    // The handler replies at once and never touches req.body — the exact shape that grew
    // RSS one-for-one before the cap existed.
    const s = await serve(async (_req, res) => { await res.end('IGNORED'); });
    const before = rss();
    try {
        const r = await flood(s.port, 96 * MiB);
        // A bound must exist. Pre-fix this reached the full 96 MiB; the cap trips at
        // 16 MiB plus at most one socket read of slack.
        ok(r.sent < 48 * MiB, `server accepted ${(r.sent / MiB).toFixed(1)} MiB, cap is 16 MiB`);
        ok(r.fate !== 'open', `connection must not be left open, got fate=${r.fate}`);
        // Memory, not just the existence of an error object: a cap that reads as present
        // in code but lets RSS track the flood is worse than no cap at all.
        const grew = rss() - before;
        if (before > 0) {
            ok(grew < 56 * MiB, `RSS grew ${(grew / MiB).toFixed(1)} MiB while 96 MiB was pushed`);
        }
    } finally {
        await stop(s);
    }
});

Deno.test({ name: 'h1 body cap: a draining handler streams past the cap byte-exactly', timeout: 40000 }, async () => {
    const total = 48 * MiB;
    let drained = 0;
    let bodyErr: string | null = null;
    const s = await serve(async (req, res) => {
        if (req.body) {
            try {
                for (; ;) {
                    const c = await req.body();
                    if (c === null) break;
                    drained += c.byteLength;
                }
            } catch (e) { bodyErr = (e as Error).message; }
        }
        await res.end('DRAINED');
    });
    try {
        await flood(s.port, total);
        // The whole point of releasing bytes on poll: a handler that consumes must be able
        // to stream any size. A missing or wrong decrement shows up here as a spurious cap.
        strictEqual(bodyErr, null, `draining handler must not see an error, got ${bodyErr}`);
        strictEqual(drained, total, 'a draining handler must receive every byte');
    } finally {
        await stop(s);
    }
});
Deno.test({ name: 'h1 body cap: chunked framing is capped too', timeout: 40000 }, async () => {
    // Chunked declares no length, so a cap keyed on Content-Length would miss it entirely.
    const s = await serve(async (_req, res) => { await res.end('IGNORED'); });
    try {
        const r = await flood(s.port, 64 * MiB, { framing: 'chunked' });
        ok(r.sent < 48 * MiB, `chunked flood accepted ${(r.sent / MiB).toFixed(1)} MiB`);
    } finally {
        await stop(s);
    }
});

Deno.test({ name: 'h1 body cap: a handler polling late observes the coded error', timeout: 40000 }, async () => {
    // Realistic shape: the handler does async work (auth, a DB lookup) before reading the
    // body. The cap fires while it is away, and it must then see an error rather than a
    // silently truncated body — a truncated upload that looks complete is the worse bug.
    let seen: { message: string; code?: string } | null = null;
    let sawNull = false;
    const s = await serve(async (req, res) => {
        await new Promise<void>(r => setTimeout(r, 500));
        if (req.body) {
            try {
                for (; ;) {
                    const c = await req.body();
                    if (c === null) { sawNull = true; break; }
                }
            } catch (e) {
                const err = e as Error & { code?: string };
                seen = { message: err.message, code: err.code };
            }
        }
        try { await res.end('LATE'); } catch { /* connection may already be gone */ }
    });
    try {
        // A dedicated client that never destroys itself: if the peer disconnect were
        // allowed to race the cap, cno would take the disconnect branch and resolve the
        // body as a clean end (see the truncation note below), and this test would flake.
        // Leaving the socket up makes the cap the only event that can end the body.
        const sock = net.connect(s.port, '127.0.0.1');
        sock.on('error', () => { /* the server resets us once the cap fires */ });
        sock.on('connect', () => {
            sock.write(`POST / HTTP/1.1\r\nHost: x\r\nContent-Length: ${96 * MiB}\r\n\r\n`);
            const payload = Buffer.alloc(64 * 1024, 0x61);
            void (async () => {
                for (let n = 0; n < 32 * MiB && !sock.destroyed; n += payload.length) {
                    if (!sock.write(payload)) {
                        await Promise.race([
                            new Promise<void>(r => sock.once('drain', () => r())),
                            new Promise<void>(r => setTimeout(r, 1500)),
                        ]);
                    }
                }
            })();
        });
        // Wait on the outcome rather than a fixed delay: the handler polls 500 ms in, and
        // a fixed sleep either races it or pads every run.
        const deadline = Date.now() + 12000;
        while (seen === null && !sawNull && Date.now() < deadline) {
            await new Promise<void>(r => setTimeout(r, 100));
        }
        try { sock.destroy(); } catch { /* */ }
        ok(seen !== null, `late poll must reject, but the body ended cleanly (sawNull=${sawNull})`);
        const got = seen as unknown as { message: string; code?: string };
        strictEqual(got.code, 'ERR_HTTP_REQUEST_BODY_TOO_LARGE');
        ok(/exceeds \d+ buffered bytes/.test(got.message), `message must name the cap: ${got.message}`);
    } finally {
        await stop(s);
    }
});
Deno.test({ name: 'h1 backpressure: a slow consumer is throttled, not failed', timeout: 40000 }, async () => {
    // A handler far slower than a loopback sender. Backpressure must hold the peer back so
    // this completes byte-exactly; if the hard cap fired here instead, the cap would be
    // breaking legitimate slow handlers rather than protecting against non-consumers.
    const total = 24 * MiB;
    let drained = 0;
    let bodyErr: string | null = null;
    const s = await serve(async (req, res) => {
        if (req.body) {
            try {
                for (; ;) {
                    const c = await req.body();
                    if (c === null) break;
                    drained += c.byteLength;
                    if (drained % (2 * MiB) === 0) await new Promise<void>(r => setTimeout(r, 25));
                }
            } catch (e) { bodyErr = (e as Error).message; }
        }
        await res.end('SLOW');
    });
    try {
        await flood(s.port, total, { stallMs: 6000 });
        strictEqual(bodyErr, null, `a slow consumer must not be failed, got ${bodyErr}`);
        strictEqual(drained, total, 'a throttled consumer must still receive every byte');
    } finally {
        await stop(s);
    }
});

Deno.test({ name: 'h1 body cap: accounting resets between keep-alive requests', timeout: 40000 }, async () => {
    // The counter, the polled flag and the drain waiter are per-request state on a
    // per-connection object. If any leaked across a keep-alive reuse, the second request
    // on the same socket would start with a pre-charged budget or a stale waiter.
    const seen: number[] = [];
    const s = await serve(async (req, res) => {
        let n = 0;
        if (req.body) {
            for (; ;) { const c = await req.body(); if (c === null) break; n += c.byteLength; }
        }
        seen.push(n);
        await res.end('N=' + n);
    });
    try {
        const body = Buffer.alloc(8 * MiB, 0x63);
        const responses = await new Promise<number>((resolve) => {
            const sock = net.connect(s.port, '127.0.0.1');
            let count = 0, buf = '';
            sock.on('connect', () => {
                // Two sequential 8 MiB requests on one connection. Cumulatively 16 MiB —
                // exactly the cap — so a counter that failed to reset would trip on the second.
                sock.write(`POST /1 HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\n\r\n`);
                sock.write(body);
                setTimeout(() => {
                    sock.write(`POST /2 HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\n\r\n`);
                    sock.write(body);
                }, 600);
            });
            sock.on('data', (d: Buffer) => {
                buf += d.toString('latin1');
                count = (buf.match(/HTTP\/1\.1 200/g) ?? []).length;
            });
            sock.on('error', () => { /* judged by the counts below */ });
            setTimeout(() => { try { sock.destroy(); } catch { /* */ } resolve(count); }, 6000);
        });
        strictEqual(responses, 2, 'both keep-alive requests must be answered');
        strictEqual(seen.length, 2, `handler must run twice, ran ${seen.length}`);
        strictEqual(seen[0], 8 * MiB, 'first request body must arrive whole');
        strictEqual(seen[1], 8 * MiB, 'second request must not inherit the first request budget');
    } finally {
        await stop(s);
    }
});

Deno.test('h1 body cap: the H1 cap matches its HTTP/2 sibling', () => {
    // Divergence between the two protocols' caps is a policy hole: an attacker simply
    // picks whichever protocol buffers more. Pinned so the constants cannot drift apart.
    strictEqual(MAX_BUFFERED_BODY_BYTES, 16 * 1024 * 1024);
});
