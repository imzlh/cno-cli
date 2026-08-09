import { ok, strictEqual } from 'node:assert';
import { Duplex, Readable, Writable, finished as finishedCb } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';

// `finished()` used to register 'close'/'end'/'finish'/'error' listeners and then
// wait, with no synchronous already-closed check. Attached to a stream that had
// already closed, every one of those events had fired before the listener
// existed, so it never settled — an unconditional hang for anything awaiting
// finished()/pipeline() on a stream that may already be done.
//
// Every await here is bounded so a re-introduced hang fails as a definite
// failure instead of stalling the suite. Expectations are node v24.18.0's
// measured answers.

const BOUND_MS = 3000;

type Outcome = 'RESOLVED' | 'TIMED_OUT' | { code: string };

async function settle(p: Promise<unknown>): Promise<Outcome> {
    let timer: number | undefined;
    const timeout = new Promise<Outcome>((resolve) => {
        timer = setTimeout(() => resolve('TIMED_OUT'), BOUND_MS) as unknown as number;
    });
    try {
        return await Promise.race([
            p.then<Outcome, Outcome>(
                () => 'RESOLVED',
                (e) => ({ code: String((e as { code?: string })?.code ?? (e as Error)?.message) }),
            ),
            timeout,
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

function assertRejects(outcome: Outcome, code: string, label: string) {
    ok(outcome !== 'TIMED_OUT', `${label}: never settled (the already-closed hang)`);
    ok(outcome !== 'RESOLVED', `${label}: resolved but node rejects ${code}`);
    strictEqual((outcome as { code: string }).code, code, `${label}: wrong rejection`);
}

function assertResolves(outcome: Outcome, label: string) {
    ok(outcome !== 'TIMED_OUT', `${label}: never settled (the already-closed hang)`);
    strictEqual(outcome, 'RESOLVED', `${label}: expected resolve, got ${JSON.stringify(outcome)}`);
}

const mkW = () => new Writable({ write(_c, _e, cb) { cb(); } });
const mkR = () => new Readable({ read() {} });

// ── must REJECT ───────────────────────────────────────────────────────────────

Deno.test('finished: already-destroyed writable rejects ERR_STREAM_PREMATURE_CLOSE', async () => {
    const w = mkW();
    w.destroy();
    await tick();
    assertRejects(await settle(finished(w)), 'ERR_STREAM_PREMATURE_CLOSE', 'destroyed writable');
});

Deno.test('finished: already-destroyed readable rejects ERR_STREAM_PREMATURE_CLOSE', async () => {
    const r = mkR();
    r.destroy();
    await tick();
    assertRejects(await settle(finished(r)), 'ERR_STREAM_PREMATURE_CLOSE', 'destroyed readable');
});

Deno.test('finished: already-destroyed duplex rejects ERR_STREAM_PREMATURE_CLOSE', async () => {
    const d = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    d.destroy();
    await tick();
    assertRejects(await settle(finished(d)), 'ERR_STREAM_PREMATURE_CLOSE', 'destroyed duplex');
});

Deno.test('finished: destroyed with an error rejects that error, not premature-close', async () => {
    const w = mkW();
    w.on('error', () => {});
    w.destroy(new Error('boom'));
    await tick();
    assertRejects(await settle(finished(w)), 'boom', 'destroyed with error');
});

Deno.test('finished: emitClose:false still settles once closed', async () => {
    // 'close' never fires in this shape, so a fix that only listened for 'close'
    // would still hang here. `closed` is set regardless, which is why it is the gate.
    const w = new Writable({ write(_c, _e, cb) { cb(); }, emitClose: false });
    w.destroy();
    await tick();
    assertRejects(await settle(finished(w)), 'ERR_STREAM_PREMATURE_CLOSE', 'emitClose:false');
});

Deno.test('finished: { error: false } still rejects premature-close when already closed', async () => {
    // Matches node: `error:false` suppresses the 'error' *listener*, it does not
    // turn a premature close into a resolve.
    const w = mkW();
    w.destroy();
    await tick();
    assertRejects(
        await settle(finished(w, { error: false })),
        'ERR_STREAM_PREMATURE_CLOSE',
        '{error:false} destroyed',
    );
});

Deno.test('finished: callback form settles on an already-closed stream', async () => {
    const w = mkW();
    w.destroy();
    await tick();
    const outcome = await settle(new Promise<void>((resolve, reject) => {
        finishedCb(w, (err) => (err ? reject(err) : resolve()));
    }));
    assertRejects(outcome, 'ERR_STREAM_PREMATURE_CLOSE', 'callback form');
});

// ── must RESOLVE (getting these backwards turns a hang into a wrong answer) ────

Deno.test('finished: cleanly ended writable resolves', async () => {
    const w = mkW();
    w.end('x');
    await new Promise<void>((r) => w.on('close', () => r()));
    await tick();
    assertResolves(await settle(finished(w)), 'cleanly ended writable');
});

Deno.test('finished: readable consumed to EOF resolves', async () => {
    const r = Readable.from(['a', 'b']);
    for await (const _chunk of r) { /* drain */ }
    await tick();
    assertResolves(await settle(finished(r)), 'EOF readable');
});

Deno.test('finished: destroyed writable with { writable: false } resolves', async () => {
    // Opting out of the only side the stream has leaves nothing to wait for.
    const w = mkW();
    w.destroy();
    await tick();
    assertResolves(await settle(finished(w, { writable: false })), '{writable:false}');
});

// ── must NOT settle: an open stream still has to wait ─────────────────────────

Deno.test('finished: open idle stream does not settle early', async () => {
    const w = mkW();
    const outcome = await Promise.race([
        finished(w).then<Outcome, Outcome>(() => 'RESOLVED', () => ({ code: 'rejected' })),
        tick(300).then<Outcome>(() => 'TIMED_OUT'),
    ]);
    strictEqual(outcome, 'TIMED_OUT', 'an open stream must keep waiting, not settle');
    w.destroy();
});

// ── pipeline() shares the machinery ───────────────────────────────────────────

Deno.test('pipeline: already-destroyed destination rejects ERR_STREAM_UNABLE_TO_PIPE', async () => {
    const src = Readable.from(['a']);
    const dst = mkW();
    dst.on('error', () => {});
    dst.destroy();
    await tick();
    assertRejects(await settle(pipeline(src, dst)), 'ERR_STREAM_UNABLE_TO_PIPE', 'destroyed dest');
});

Deno.test('pipeline: already-destroyed source rejects ERR_STREAM_PREMATURE_CLOSE', async () => {
    const src = mkR();
    src.on('error', () => {});
    src.destroy();
    await tick();
    assertRejects(await settle(pipeline(src, mkW())), 'ERR_STREAM_PREMATURE_CLOSE', 'destroyed src');
});

Deno.test('pipeline: source already consumed to EOF resolves', async () => {
    // A cleanly EOF-consumed source is not an error: node ends the destination,
    // so the pipeline completes. pipe() has to end a destination whose source
    // already emitted 'end' before the pipe existed.
    const src = Readable.from(['a']);
    for await (const _chunk of src) { /* drain */ }
    await tick();
    assertResolves(await settle(pipeline(src, mkW())), 'EOF-consumed source');
});

Deno.test('pipeline: fresh streams still resolve (control)', async () => {
    let out = '';
    const outcome = await settle(pipeline(
        Readable.from(['a', 'b']),
        new Writable({ write(c, _e, cb) { out += String(c); cb(); } }),
    ));
    assertResolves(outcome, 'fresh control');
    strictEqual(out, 'ab');
});
