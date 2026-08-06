/**
 * TcpSocket's per-socket write() serialization queue (@cnojs/http/socket).
 *
 * The queue exists because the TLS path interleaves `sslPipe.write` and `flushOutput`
 * across awaits: two concurrent writers would emit each other's records out of order and
 * the peer would fail to decrypt. Ordering held, but the stall path underneath it did not.
 *
 * `CHECK_SSL_ERR` (circu.js/src/mod_ssl.c) reports SSL_ERROR_WANT_READ/WANT_WRITE by
 * returning **null**, not 0. The original loop tested `written < 0` (false for null) then
 * `written === 0` (also false, so the stall branch and MAX_WRITE_STALLS were dead code)
 * and then did `offset += null`, which leaves offset unchanged. That is an await-free
 * infinite loop, and because writeLocked runs in a microtask it wedged the entire event
 * loop at 100% CPU — one socket killed every other connection in the process.
 *
 * Measured before the fix: `write()` during a real TLS handshake exited 124 under a hard
 * timeout with a 250ms setInterval beacon that never fired once. That is why these tests
 * assert on a **liveness counter** rather than racing a timeout: when the loop is wedged,
 * timers do not run, so a timeout-based test cannot distinguish "slow" from "dead" and
 * would hang the runner instead of failing.
 *
 * A second defect interlocked with the first: the stall path called `socket.read()`, but
 * every server connection is in streaming-read mode via onReadable() and the C layer
 * rejects a concurrent read ("startRead already in progress"). So mapping null onto the
 * stall branch *alone* would have converted the hang into a guaranteed write failure on
 * every server socket. Both halves are pinned here.
 */
import { strictEqual, ok } from 'node:assert';
import { TcpSocket, type SocketTransport } from '@cnojs/http/socket';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const streams = import.meta.use('streams');

/** Records every socket.write in call order, with a controllable delay. */
class StubTransport implements SocketTransport {
    onread: unknown = null;
    wire: Uint8Array[] = [];
    delay = 0;
    closed = false;
    failNext: Error | null = null;
    /** when true, read() never settles — models a peer that sends nothing */
    silent = true;
    startRead(): void { /* no-op */ }
    stopRead(): void { /* no-op */ }
    read(_buf: unknown): Promise<number> {
        if (this.silent) return new Promise(() => { /* never settles */ });
        return Promise.resolve(0);
    }
    async write(buffer: { byteLength?: number; length?: number }): Promise<number> {
        const u8 = buffer as unknown as Uint8Array;
        const copy = new Uint8Array(u8);      // snapshot at call time, before any await
        if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
        if (this.delay) await new Promise(r => setTimeout(r, this.delay));
        else await Promise.resolve();
        if (this.closed) throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
        this.wire.push(copy);
        return copy.length;
    }
    close(): void { this.closed = true; }
    text(): string { return this.wire.map(dec).join(''); }
}

/** Fake SSL pipe. "Encrypts" by wrapping each plaintext chunk in <...>. */
function stubPipe(over: Record<string, unknown> = {}): unknown {
    const out: Uint8Array[] = [];
    return {
        handshakeComplete: true,
        alpnProtocol: 'http/1.1',
        write(data: Uint8Array): number { out.push(enc('<' + dec(data) + '>')); return data.length; },
        getOutput(): ArrayBuffer | null {
            if (!out.length) return null;
            const total = out.reduce((n, c) => n + c.length, 0);
            const joined = new Uint8Array(total);
            let o = 0; for (const c of out) { joined.set(c, o); o += c.length; }
            out.length = 0;
            return joined.buffer as ArrayBuffer;
        },
        read: () => null,
        handshake: () => true,
        feed: (d: Uint8Array) => d.length,
        shutdown: () => { /* no-op */ },
        ...over,
    };
}

function mk(tls: boolean, pipeOver?: Record<string, unknown>): { s: TcpSocket; t: StubTransport } {
    const t = new StubTransport();
    const s = new TcpSocket(t as unknown as SocketTransport);
    if (tls) s.sslPipe = stubPipe(pipeOver) as never;
    return { s, t };
}

/* ── ordering: the queue's entire reason for existing ──────────── */

for (const n of [2, 8, 64]) {
    for (const tls of [false, true]) {
        Deno.test({ name: `write queue: ${n} concurrent writes stay in call order (${tls ? 'TLS' : 'TCP'})`, timeout: 20000 }, async () => {
            const { s, t } = mk(tls);
            t.delay = 1;   // force every write to span an await, so a broken queue interleaves
            const payloads = Array.from({ length: n }, (_, i) => `<${String(i).padStart(4, '0')}>`);
            // fire all writes in one tick, with no await between the calls
            await Promise.all(payloads.map(p => s.write(enc(p))));
            const want = tls ? payloads.map(p => `<${p}>`).join('') : payloads.join('');
            strictEqual(t.text(), want, 'bytes must arrive in call order with no interleaving');
            strictEqual(t.wire.length, n, 'each write must reach the transport exactly once');
        });
    }
}

Deno.test({ name: 'write queue: a zero-length write does not disturb the order', timeout: 20000 }, async () => {
    const { s, t } = mk(true);
    t.delay = 1;
    await Promise.all([s.write(enc('A')), s.write(new Uint8Array(0)), s.write(enc('B'))]);
    strictEqual(t.text(), '<A><B>');
});

/* ── failure isolation ─────────────────────────────────────────── */

for (const tls of [false, true]) {
    Deno.test({ name: `write queue: one write's rejection does not poison the chain (${tls ? 'TLS' : 'TCP'})`, timeout: 20000 }, async () => {
        const { s, t } = mk(tls);
        t.delay = 1;
        t.failNext = new Error('boom');
        const settled = await Promise.all([
            s.write(enc('A')).then(() => 'ok', (e: Error) => 'err:' + e.message),
            s.write(enc('B')).then(() => 'ok', (e: Error) => 'err:' + e.message),
            s.write(enc('C')).then(() => 'ok', (e: Error) => 'err:' + e.message),
        ]);
        strictEqual(settled[0], 'err:boom', 'the failing write must report its own error');
        strictEqual(settled[1], 'ok', 'a later write must not inherit the failure');
        strictEqual(settled[2], 'ok');
        strictEqual(t.text(), tls ? '<B><C>' : 'BC', 'survivors must still be ordered');
    });
}

/* ── the hang: null from SSL_write must not spin the event loop ── */

Deno.test({
    name: 'write queue: sslPipe.write() returning null must not wedge the event loop',
    timeout: 20000,
}, async () => {
    // A permanent WANT_READ. Before the fix this span forever with no await.
    const { s } = mk(true, { write: () => null, getOutput: () => null });
    s.onReadable(() => { /* streaming reader: the real server shape */ }, () => { /* */ });

    // Liveness beacon. A wedged microtask loop starves timers, so a non-zero tick count
    // is the only trustworthy proof the loop still turns. Do NOT replace this with a
    // timeout race: under the original bug the timeout callback never fires at all.
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 50);
    try {
        const w = s.write(enc('X')).then(() => 'resolved', (e: Error & { code?: string }) => 'rejected:' + e.code);
        // close() can only take effect if the event loop is actually turning.
        setTimeout(() => s.close(), 300);
        const verdict = await w;
        ok(ticks > 0, `event loop must keep turning during an SSL_write stall (ticks=${ticks})`);
        strictEqual(verdict, 'rejected:ECONNRESET', 'close() must settle a parked write promptly');
    } finally {
        clearInterval(iv);
    }
});

Deno.test({
    name: 'write queue: a stalled SSL_write is bounded, not parked forever',
    timeout: 30000,
}, async () => {
    // Nothing ever moves cipher, so the write must hit its deadline and reject rather
    // than hang a request slot for the life of the connection.
    const { s } = mk(true, { write: () => null, getOutput: () => null });
    s.onReadable(() => { /* */ }, () => { /* */ });
    const t0 = Date.now();
    const err = await s.write(enc('X')).then(
        () => null,
        (e: Error & { code?: string }) => e,
    );
    ok(err, 'a permanently stalled write must reject');
    strictEqual(err.code, 'ETIMEDOUT');
    const elapsed = Date.now() - t0;
    ok(elapsed >= 9000 && elapsed < 20000, `must reject at its deadline, took ${elapsed}ms`);
});

/* ── the stall path must not fight the streaming reader ─────────── */

Deno.test({
    name: 'write queue: an SSL_write stall does not collide with onReadable()\'s startRead',
    timeout: 20000,
}, async () => {
    // Uses a REAL native socket: "read already in progress" is enforced in C, not in JS,
    // so a stub transport cannot observe this. The stall path used to call socket.read()
    // unconditionally and every server connection therefore failed its write.
    const listener = new streams.TCP();
    listener.bind({ ip: '127.0.0.1', port: 0 });
    const accepted = new Promise<unknown>((res, rej) => {
        listener.onconnection = (e: unknown, c: unknown) => { if (e) rej(e); else if (c) res(c); };
    });
    listener.listen(1);
    const { port } = listener.sockname;
    const cliRaw = new streams.TCP();
    const connectP = cliRaw.connect({ ip: '127.0.0.1', port });
    const srvRaw = await accepted;
    await connectP;

    const s = new TcpSocket(srvRaw as never);
    try {
        s.onReadable(() => { /* */ }, () => { /* */ });   // native startRead() is now active
        s.sslPipe = stubPipe({ write: () => 0, getOutput: () => null }) as never;
        void cliRaw.write(enc('PEER-BYTES'));

        const verdict = await Promise.race([
            s.write(enc('APP-DATA')).then(() => 'resolved', (e: Error & { code?: string }) => 'rejected:' + (e.code ?? e.message)),
            new Promise<string>(r => setTimeout(() => r('pending'), 3000)),
        ]);
        ok(
            !String(verdict).includes('startRead already in progress'),
            `the stall path must not race the streaming reader, got: ${verdict}`,
        );
    } finally {
        try { s.close(); } catch { /* */ }
        try { cliRaw.close(); } catch { /* */ }
        try { listener.close(); } catch { /* */ }
    }
});

/* ── lifetime: a socket dying mid-chain ─────────────────────────── */

for (const tls of [false, true]) {
    Deno.test({ name: `write queue: close() with writes queued rejects them, flushing nothing (${tls ? 'TLS' : 'TCP'})`, timeout: 20000 }, async () => {
        const { s, t } = mk(tls);
        t.delay = 5;
        const p1 = s.write(enc('AAA')).then(() => 'ok', (e: Error & { code?: string }) => 'err:' + e.code);
        const p2 = s.write(enc('BBB')).then(() => 'ok', (e: Error & { code?: string }) => 'err:' + e.code);
        s.close();
        strictEqual((await Promise.all([p1, p2])).join(','), 'err:ECONNRESET,err:ECONNRESET');
        strictEqual(t.text(), '', 'a closed socket must not emit queued bytes');
    });
}

Deno.test({
    name: 'write queue: a TLS write resuming after close() must not leak plaintext',
    timeout: 20000,
}, async () => {
    // close() nulls sslPipe. A queued write that resumed afterwards would fall through
    // to the plaintext branch and put cleartext on the wire.
    const { s, t } = mk(true);
    t.delay = 5;
    const queued = s.write(enc('SECRET')).then(() => 'ok', (e: Error & { code?: string }) => 'err:' + e.code);
    s.close();
    await queued;
    const after = await s.write(enc('SECRET-AFTER')).then(() => 'ok', (e: Error & { code?: string }) => 'err:' + e.code);
    strictEqual(after, 'err:ECONNRESET');
    ok(!t.text().includes('SECRET'), `plaintext must never reach the wire, saw: ${JSON.stringify(t.text())}`);
});

/* ── backpressure is not hidden by the queue ────────────────────── */

Deno.test({
    name: 'write queue: promises track the transport rather than resolving eagerly',
    timeout: 30000,
}, async () => {
    // A queue that resolved immediately would hide backpressure from callers: the Node
    // adapter derives write()->false and 'drain' from exactly these promises. Because the
    // queue serializes, at most one write is ever outstanding in the transport, so a
    // resolution really does mean "handed off" — unlike net's writableLength, which reads
    // 0 while bytes still sit in native buffers.
    const { s, t } = mk(false);
    t.delay = 40;
    let resolved = 0;
    const ps = Array.from({ length: 8 }, () => s.write(enc('chunk')).then(() => { resolved++; }));
    await new Promise(r => setTimeout(r, 60));
    ok(resolved < 8, `writes must not all resolve before the transport accepts them (resolved=${resolved})`);
    await Promise.all(ps);
    strictEqual(resolved, 8);
    strictEqual(t.wire.length, 8);
});
