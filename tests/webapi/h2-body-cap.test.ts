/**
 * H2Stream buffered-body cap accounting (@cnojs/http/h2).
 *
 * These tests deliberately do NOT need the nghttp2 native extension: the cap lives
 * entirely in H2Stream's JS accounting (`acceptData` / `bodyChunks` / `takeBody`) and
 * the only H2Connection method it reaches for is `resetStream`. A stub connection
 * therefore exercises the real code path, which matters because this binary may be
 * built without CNO_EMBED_EXT_H2 (h2Available() === false) and every socket-level H2
 * test would then be skipped, leaving the cap with zero coverage.
 */
import { ok, strictEqual } from 'node:assert';
import { Duplex } from 'node:stream';
import { H2Stream } from '@cnojs/http/h2';

const MAX_BUFFERED_BODY_BYTES = 16 * 1024 * 1024;

type ResetLog = Array<{ id: number; code: string }>;

/** Minimal stand-in for the pieces of H2Connection that H2Stream.acceptData touches. */
function stubConn(resets: ResetLog): unknown {
    return {
        resetStream(id: number, code: string): void {
            resets.push({ id, code });
        },
    };
}

function makeStream(isServer: boolean, resets: ResetLog = []): H2Stream {
    // H2Stream's constructor stores the connection and never calls into it, so a stub
    // is sufficient. The signature is (conn, id, isServer).
    const Ctor = H2Stream as unknown as new (conn: unknown, id: number, isServer: boolean) => H2Stream;
    return new Ctor(stubConn(resets), 1, isServer);
}

function block(n: number): Uint8Array {
    return new Uint8Array(n);
}

/** Feed `total` bytes in `chunk`-sized pieces. Returns bytes actually offered. */
function feed(stream: H2Stream, total: number, chunk: number): number {
    let sent = 0;
    while (sent < total) {
        const n = Math.min(chunk, total - sent);
        stream.acceptData(block(n), false);
        sent += n;
    }
    return sent;
}

Deno.test('h2 cap: exactly MAX_BUFFERED_BODY_BYTES is accepted, one more byte resets', () => {
    const resets: ResetLog = [];
    const atLimit = makeStream(true, resets);
    atLimit.acceptHeaders([[':method', 'POST'], [':path', '/']], 0);
    // The check is `buffered > MAX`, so exactly MAX must survive.
    feed(atLimit, MAX_BUFFERED_BODY_BYTES, 1024 * 1024);
    strictEqual(resets.length, 0, 'exactly 16 MiB must not trip the cap');

    // One more byte crosses it.
    atLimit.acceptData(block(1), false);
    strictEqual(resets.length, 1, '16 MiB + 1 must trip the cap');
    strictEqual(resets[0]!.code, 'FLOW_CONTROL_ERROR');
    strictEqual(resets[0]!.id, 1);
});

Deno.test('h2 cap: client streams (isServer=false) are exempt', () => {
    const resets: ResetLog = [];
    const client = makeStream(false, resets);
    client.acceptHeaders([[':status', '200']], 0);
    feed(client, MAX_BUFFERED_BODY_BYTES + 4 * 1024 * 1024, 1024 * 1024);
    strictEqual(resets.length, 0, 'client streams must not be capped');
});

Deno.test('h2 cap: a draining handler can stream past the cap', async () => {
    const resets: ResetLog = [];
    const stream = makeStream(true, resets);
    stream.acceptHeaders([[':method', 'POST'], [':path', '/']], 0);

    const gen = stream.bodyChunks();
    let drained = 0;
    const chunk = 1024 * 1024;
    // Push 48 MiB through, draining after each chunk. If the release path were broken
    // (no decrement, or decrement of the wrong amount) this would reset.
    for (let i = 0; i < 48; i++) {
        stream.acceptData(block(chunk), false);
        const next = await gen.next();
        ok(!next.done, 'generator must yield the chunk just accepted');
        drained += next.value.byteLength;
    }
    strictEqual(resets.length, 0, 'a draining handler must never hit the cap');
    strictEqual(drained, 48 * chunk);
    stream.acceptData(block(0), true);
    strictEqual((await gen.next()).done, true);
});

Deno.test('h2 cap: buffered is released exactly once per chunk', async () => {
    const resets: ResetLog = [];
    const stream = makeStream(true, resets);
    stream.acceptHeaders([[':method', 'POST'], [':path', '/']], 0);

    // Fill to exactly the limit, drain half, then refill by that same half.
    // Off-by-one or double-release in the decrement shows up as either a spurious
    // reset (under-release) or an accepted overshoot (over-release).
    const chunk = 1024 * 1024;
    feed(stream, MAX_BUFFERED_BODY_BYTES, chunk);
    strictEqual(resets.length, 0);

    const gen = stream.bodyChunks();
    let released = 0;
    for (let i = 0; i < 8; i++) {
        const next = await gen.next();
        ok(!next.done);
        released += next.value.byteLength;
    }
    strictEqual(released, 8 * chunk, 'eight 1 MiB chunks must come back byte-exact');

    // Exactly `released` more bytes must fit (buffered is back to MAX - released).
    feed(stream, released, chunk);
    strictEqual(resets.length, 0, 'released bytes must free exactly that much budget');

    // And one byte beyond must trip it — proving nothing was over-released.
    stream.acceptData(block(1), false);
    strictEqual(resets.length, 1, 'over-release would let this byte through');
});

Deno.test('h2 cap: a reset stream drops its buffer and fails the body read', async () => {
    const resets: ResetLog = [];
    const stream = makeStream(true, resets);
    stream.acceptHeaders([[':method', 'POST'], [':path', '/']], 0);
    feed(stream, MAX_BUFFERED_BODY_BYTES + 1, 1024 * 1024);
    strictEqual(resets.length, 1);

    // The handler must observe an error, not a silently truncated body: a truncated
    // body would be indistinguishable from a complete upload.
    let err: unknown = null;
    try {
        for await (const _ of stream.bodyChunks()) { /* drain */ }
    } catch (e) {
        err = e;
    }
    ok(err instanceof Error, 'bodyChunks() must throw after a cap reset');
    ok(
        /buffered body exceeds/.test((err as Error).message),
        `message should name the cap, got: ${(err as Error).message}`,
    );
    strictEqual((err as { code?: string }).code, 'ERR_HTTP2_STREAM_ERROR');

    // Further data on the dead stream must not re-arm the cap or re-reset.
    stream.acceptData(block(1024 * 1024), false);
    strictEqual(resets.length, 1, 'a dead stream must not RST repeatedly');
});

Deno.test('h2 cap: repeated resets cannot be triggered by a peer that keeps sending', () => {
    const resets: ResetLog = [];
    const stream = makeStream(true, resets);
    stream.acceptHeaders([[':method', 'POST'], [':path', '/']], 0);
    feed(stream, MAX_BUFFERED_BODY_BYTES + 1, 4 * 1024 * 1024);
    strictEqual(resets.length, 1);
    // A peer that ignores RST_STREAM keeps sending; every further MiB must be dropped
    // without buffering and without another RST.
    for (let i = 0; i < 32; i++) stream.acceptData(block(1024 * 1024), false);
    strictEqual(resets.length, 1, 'exactly one RST per capped stream');
});

Deno.test('h2 cap: takeBody() releases the whole budget', () => {
    const resets: ResetLog = [];
    const stream = makeStream(true, resets);
    stream.acceptHeaders([[':method', 'POST'], [':path', '/']], 0);
    feed(stream, MAX_BUFFERED_BODY_BYTES, 1024 * 1024);
    const body = stream.takeBody();
    ok(body !== null);
    strictEqual(body.byteLength, MAX_BUFFERED_BODY_BYTES);
    // Budget is free again: a full second 16 MiB must fit.
    feed(stream, MAX_BUFFERED_BODY_BYTES, 1024 * 1024);
    strictEqual(resets.length, 0, 'takeBody() must release the full budget');
});

Deno.test('h2 cap: takeBody() is idempotent and does not double-release', () => {
    const resets: ResetLog = [];
    const stream = makeStream(true, resets);
    stream.acceptHeaders([[':method', 'POST'], [':path', '/']], 0);
    feed(stream, 4 * 1024 * 1024, 1024 * 1024);
    const first = stream.takeBody();
    const second = stream.takeBody();
    strictEqual(first, second, 'takeBody() must return the same buffer');
    strictEqual(first!.byteLength, 4 * 1024 * 1024);
    // buffered is 0 after the first call; a second discard must not make it negative
    // (a negative counter would raise the effective cap).
    feed(stream, MAX_BUFFERED_BODY_BYTES, 1024 * 1024);
    strictEqual(resets.length, 0);
    stream.acceptData(block(1), false);
    strictEqual(resets.length, 1, 'cap must still fire at exactly MAX+1 after takeBody()');
});

Deno.test('h2 cap: zero-length DATA frames cannot be used to grow the buffer', () => {
    const resets: ResetLog = [];
    const stream = makeStream(true, resets);
    stream.acceptHeaders([[':method', 'POST'], [':path', '/']], 0);
    for (let i = 0; i < 100000; i++) stream.acceptData(block(0), false);
    strictEqual(resets.length, 0);
    // ...and they must not be retained as array entries either: fill to the limit and
    // confirm the accounting still matches byte-for-byte.
    feed(stream, MAX_BUFFERED_BODY_BYTES, 1024 * 1024);
    strictEqual(resets.length, 0);
    stream.acceptData(block(1), false);
    strictEqual(resets.length, 1);
});

/* ── the coupling that makes the cap load-bearing rather than decorative ──────
 *
 * The cap only bounds anything while unread bytes stay in H2Stream.chunks. The
 * consumer above it is ServerHttp2Stream.pumpBody (cno/src/node/http2/mod.ts), which
 * parks on `push() === false` instead of draining unconditionally. If Readable.push()
 * ever stopped reporting backpressure, pumpBody would drain every chunk the instant it
 * arrived, `buffered` would sit near zero, the cap would never fire, and the unbounded
 * growth would simply relocate into the Readable's own queue where nothing caps it.
 * These tests pin that dependency down so the change is caught here rather than as a
 * memory-exhaustion report.
 */

class PumpProbe extends Duplex {
    readCalls = 0;
    constructor() { super({ allowHalfOpen: true }); }
    _read(): void { this.readCalls++; }
    _write(_c: unknown, _e: unknown, cb: (e?: Error | null) => void): void { cb(); }
}

Deno.test('h2 cap coupling: Readable.push() reports backpressure at the highWaterMark', () => {
    const probe = new PumpProbe();
    // ServerHttp2Stream passes no explicit highWaterMark, so it inherits the default.
    strictEqual(probe.readableHighWaterMark, 16384, 'default highWaterMark assumption');

    let firstFalseAt: number | null = null;
    let total = 0;
    for (let i = 0; i < 8; i++) {
        const accepted = probe.push(new Uint8Array(16 * 1024));
        total += 16 * 1024;
        if (!accepted && firstFalseAt === null) firstFalseAt = total;
    }
    // Without this, pumpBody never parks and the 16 MiB cap is decorative.
    strictEqual(firstFalseAt, 16384, 'push() must report backpressure at the mark');
    // The park must also be durable: a single false followed by trues would let
    // pumpBody resume draining and defeat the cap just as thoroughly.
    strictEqual(probe.push(new Uint8Array(16 * 1024)), false, 'backpressure must persist');
    probe.destroy();
});

Deno.test('h2 cap coupling: _read() fires after a consumer drains, releasing the park', async () => {
    const probe = new PumpProbe();
    while (probe.push(new Uint8Array(16 * 1024)) !== false) { /* reach the mark */ }
    const before = probe.readCalls;
    // pumpBody's park is released from _read(); if _read() never fires again a
    // legitimate streaming upload would hang instead of being backpressured.
    probe.resume();
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    ok(probe.readCalls > before, `_read() must fire after drain (${before} -> ${probe.readCalls})`);
    probe.destroy();
});

Deno.test('h2 cap coupling: push() on a destroyed stream discards rather than retains', async () => {
    // pumpBody guards its park with `&& !this.destroyed`, so on a destroyed stream it
    // keeps pulling from bodyChunks(). That is only acceptable because the bytes are
    // dropped: if a destroyed Readable still queued them this would be a memory leak
    // that the h2 cap cannot see, since draining keeps `buffered` at zero.
    const probe = new PumpProbe();
    probe.destroy();
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    strictEqual(probe.push(new Uint8Array(64 * 1024)), false);
    strictEqual(probe.readableLength, 0, 'a destroyed Readable must not retain pushed bytes');
});
