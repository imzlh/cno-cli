/**
 * Regression guard for the two-implementations problem.
 *
 * `globalThis.setTimeout` (cno/src/webapi/basic.ts, class TimeoutOrInterval /
 * Immediate) and `node:timers` (cno/src/node/timers/mod.ts, class Timeout /
 * Immediate) are DIFFERENT function objects wrapping DIFFERENT handle classes.
 * In Node they are literally the same objects, so nothing upstream exercises the
 * cross-boundary path. Here it has to be tested explicitly.
 *
 * Both classes wrap ids from ONE native registry (circu.js/src/mod_timers.c, a
 * single `qrt->timers.timers` hash, where `clearTimeout` and `clearInterval` are
 * the same C function), which is WHY cross-clearing works. If a future change
 * gives either side its own bookkeeping, a handle created on one side stops being
 * cancellable from the other and the timer keeps the event loop alive — a silent
 * hang rather than a visible error. That is what these tests pin down.
 *
 * Measured against Node v24.18.0.
 */
import { ok, strictEqual } from 'node:assert';
import * as timers from 'node:timers';
import * as timersPromises from 'node:timers/promises';

const g = globalThis as unknown as {
    setTimeout: typeof timers.setTimeout;
    setInterval: typeof timers.setInterval;
    setImmediate: typeof timers.setImmediate;
    clearTimeout: typeof timers.clearTimeout;
    clearInterval: typeof timers.clearInterval;
    clearImmediate: typeof timers.clearImmediate;
};

/** Schedules via `make`, cancels via `clear`, resolves true if the callback ran. */
function firedAfterClear(
    make: (fn: () => void) => unknown,
    clear: (handle: never) => void,
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        let fired = false;
        const handle = make(() => { fired = true; });
        clear(handle as never);
        // 120ms is ~8x the 15ms delay used below and well clear of the ~15.6ms
        // Windows timer floor, so a surviving timer has ample room to fire.
        g.setTimeout(() => resolve(fired), 120);
    });
}

// --- Timeout: every creator x clearer combination, incl. the mismatched clearer

Deno.test('timers cross-impl: a global Timeout is cancelled by the module clearTimeout', async () => {
    strictEqual(await firedAfterClear((f) => g.setTimeout(f, 15), (h) => timers.clearTimeout(h)), false);
});

Deno.test('timers cross-impl: a module Timeout is cancelled by the global clearTimeout', async () => {
    strictEqual(await firedAfterClear((f) => timers.setTimeout(f, 15), (h) => g.clearTimeout(h)), false);
});

// Node accepts a Timeout at clearInterval and vice versa; both are one C call here.
Deno.test('timers cross-impl: a global Timeout is cancelled by the module clearInterval', async () => {
    strictEqual(await firedAfterClear((f) => g.setTimeout(f, 15), (h) => timers.clearInterval(h)), false);
});

Deno.test('timers cross-impl: a module Timeout is cancelled by the global clearInterval', async () => {
    strictEqual(await firedAfterClear((f) => timers.setTimeout(f, 15), (h) => g.clearInterval(h)), false);
});

// --- Interval: an uncancelled interval is the worst leak, so cover both ways

Deno.test('timers cross-impl: a global Interval is cancelled by the module clearInterval', async () => {
    strictEqual(await firedAfterClear((f) => g.setInterval(f, 15), (h) => timers.clearInterval(h)), false);
});

Deno.test('timers cross-impl: a module Interval is cancelled by the global clearInterval', async () => {
    strictEqual(await firedAfterClear((f) => timers.setInterval(f, 15), (h) => g.clearInterval(h)), false);
});

Deno.test('timers cross-impl: a global Interval is cancelled by the module clearTimeout', async () => {
    strictEqual(await firedAfterClear((f) => g.setInterval(f, 15), (h) => timers.clearTimeout(h)), false);
});

Deno.test('timers cross-impl: a module Interval is cancelled by the global clearTimeout', async () => {
    strictEqual(await firedAfterClear((f) => timers.setInterval(f, 15), (h) => g.clearTimeout(h)), false);
});

// --- Immediate. The module clearImmediate reaches a foreign handle through
// `_onImmediate` + close() (clearForeignImmediate); the global one reaches a
// module handle through Immediate.valueOf(). Both bridges are load-bearing:
// without them clearImmediate silently no-ops across the boundary.

Deno.test('timers cross-impl: a global Immediate is cancelled by the module clearImmediate', async () => {
    strictEqual(await firedAfterClear((f) => g.setImmediate(f), (h) => timers.clearImmediate(h)), false);
});

Deno.test('timers cross-impl: a module Immediate is cancelled by the global clearImmediate', async () => {
    strictEqual(await firedAfterClear((f) => timers.setImmediate(f), (h) => g.clearImmediate(h)), false);
});

// --- The module Timeout tolerates ref/unref/hasRef after its timer is gone.
// The native refTimer/unrefTimer/hasRef throw TypeError("timer not found") once
// the id has left the registry (mod_timers.c tjs_timer_ref), so the wrapper's
// liveness guard is the only thing keeping this from throwing. Node treats all
// three as no-ops on an expired or cleared Timeout.

Deno.test('timers cross-impl: module Timeout ref/unref/hasRef are safe after clear', () => {
    const t = timers.setTimeout(() => {}, 5000);
    timers.clearTimeout(t);
    // Must not throw.
    t.hasRef();
    strictEqual(t.unref(), t, 'unref() returns this');
    strictEqual(t.ref(), t, 'ref() returns this');
});

Deno.test('timers cross-impl: module Timeout ref/unref/hasRef are safe after it fires', async () => {
    const t = await new Promise<ReturnType<typeof timers.setTimeout>>((resolve) => {
        const h = timers.setTimeout(() => resolve(h), 15);
    });
    // The one-shot has already been destroyed natively by now.
    t.hasRef();
    strictEqual(t.unref(), t, 'unref() returns this');
    strictEqual(t.ref(), t, 'ref() returns this');
});

// --- An unref'd handle must not hold the loop open. Verified out-of-process in
// /d/tmp/ag-timers/p7-results.txt (16/16 exit-timing cases match Node); in-process
// we can still pin that unref/hasRef agree about the ref state, which is what the
// loop consults.

Deno.test('timers cross-impl: unref/ref move hasRef on both implementations', () => {
    const m = timers.setTimeout(() => {}, 5000);
    strictEqual(m.hasRef(), true, 'module: ref by default');
    m.unref();
    strictEqual(m.hasRef(), false, 'module: false after unref');
    m.ref();
    strictEqual(m.hasRef(), true, 'module: true again after ref');
    timers.clearTimeout(m);

    const gt = g.setTimeout(() => {}, 5000) as unknown as {
        hasRef(): boolean; unref(): unknown; ref(): unknown;
    };
    strictEqual(gt.hasRef(), true, 'global: ref by default');
    gt.unref();
    strictEqual(gt.hasRef(), false, 'global: false after unref');
    gt.ref();
    strictEqual(gt.hasRef(), true, 'global: true again after ref');
    g.clearTimeout(gt as never);
});

// --- timers/promises shares neither handle class: it schedules through the
// native binding directly and hands back no handle at all, so `ref: false` is
// the only cancellation-adjacent control. Pin that it is honoured and that the
// promise still settles.

// --- timers/promises shares neither handle class: it schedules through the
// native binding directly and hands back no handle at all, so `ref: false` is
// the only cancellation-adjacent control.
//
// Note `ref: false` as the ONLY pending work never resolves — the unref'd timer
// cannot hold the loop open, so the process exits first. Measured identical in
// Node v24.18.0 and cno (/d/tmp/ag-timers/p14-reffalse.cjs: both print only
// "EXIT"). A ref'd timer therefore has to keep the loop alive across the wait.

Deno.test('timers cross-impl: timers/promises setTimeout honours ref:false while the loop is held open', async () => {
    const keepAlive = timers.setInterval(() => {}, 20);
    try {
        strictEqual(await timersPromises.setTimeout(15, 'v', { ref: false }), 'v');
    } finally {
        timers.clearInterval(keepAlive);
    }
});

Deno.test('timers cross-impl: timers/promises setTimeout resolves with its value', async () => {
    strictEqual(await timersPromises.setTimeout(15, 'plain'), 'plain');
});

Deno.test('timers cross-impl: node:timers promises namespace is the same object as the submodule', () => {
    ok(timers.promises, 'node:timers exposes a promises namespace');
    strictEqual(
        timersPromises.setTimeout,
        (timers.promises as { setTimeout: unknown }).setTimeout,
        'timers/promises.setTimeout === timers.promises.setTimeout',
    );
});
