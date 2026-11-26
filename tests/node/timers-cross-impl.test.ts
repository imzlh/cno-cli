/**
 * Regression guard for the two-implementations problem.
 *
 * `globalThis.setTimeout` (cno/src/webapi/basic.ts, class TimeoutOrInterval /
 * Immediate) and `node:timers` (cno/src/node/timers/mod.ts, class Timeout /
 * Immediate) are DIFFERENT function objects wrapping DIFFERENT handle classes.
 * In Node they are literally the same objects, so nothing upstream exercises the
 * cross-boundary path. Here it has to be tested explicitly.
 *
 * Both classes wrap ids from one native handle-id namespace (circu.js/src/
 * mod_timers.c; timeout and immediate queues remain separate), which is WHY
 * cross-clearing works without confusing async_hooks. If a future change gives
 * either side its own bookkeeping, a handle created on one side stops being
 * cancellable from the other and the timer keeps the event loop alive — a
 * silent hang rather than a visible error. That is what these tests pin down.
 *
 * Measured against Node v24.18.0.
 */
import { ok, strictEqual, throws } from 'node:assert';
import * as timers from 'node:timers';
import * as timersPromises from 'node:timers/promises';

const nativeTimers = import.meta.use('timers');

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

Deno.test('timers cross-impl: global clear functions accept raw native timer ids', () => {
    for (const schedule of [nativeTimers.setTimeout, nativeTimers.setInterval]) {
        for (const clear of [g.clearTimeout, g.clearInterval]) {
            for (const asString of [false, true]) {
                const id = schedule(() => {}, 60_000);
                try {
                    strictEqual(nativeTimers.hasRef(id), true);
                    clear(asString ? String(id) as never : id);
                    throws(() => nativeTimers.hasRef(id), /timer not found/);
                } finally {
                    nativeTimers.clearTimeout(id);
                }
            }
        }
    }
});

Deno.test('timers cross-impl: module clear functions accept raw native timer ids', () => {
    const clears: Array<(id: number) => void> = [
        id => timers.clearTimeout(id),
        id => timers.clearInterval(id),
    ];
    for (const schedule of [nativeTimers.setTimeout, nativeTimers.setInterval]) {
        for (const clear of clears) {
            const id = schedule(() => {}, 60_000);
            try {
                strictEqual(nativeTimers.hasRef(id), true);
                clear(id);
                throws(() => nativeTimers.hasRef(id), /timer not found/);
            } finally {
                nativeTimers.clearTimeout(id);
            }
        }
    }
});

Deno.test('timers cross-impl: clearImmediate cancels an untracked native immediate id', async () => {
    let fired = false;
    const id = nativeTimers.setImmediate(() => { fired = true; });
    g.clearImmediate(id);
    await new Promise<void>(resolve => g.setTimeout(resolve, 20));
    strictEqual(fired, false);
});

Deno.test('timers cross-impl: a global Immediate is cancelled by the module clearImmediate', async () => {
    strictEqual(await firedAfterClear((f) => g.setImmediate(f), (h) => timers.clearImmediate(h)), false);
});

Deno.test('timers cross-impl: a module Immediate is cancelled by the global clearImmediate', async () => {
    strictEqual(await firedAfterClear((f) => timers.setImmediate(f), (h) => g.clearImmediate(h)), false);
});

Deno.test('timers cross-impl: clearTimeout does not cancel an Immediate handle', async () => {
    let fired = false;
    const immediate = timers.setImmediate(() => { fired = true; });
    timers.clearTimeout(immediate as never);
    await new Promise<void>(resolve => g.setTimeout(resolve, 20));
    strictEqual(fired, true);
});

Deno.test('timers cross-impl: clearImmediate does not cancel a Timeout handle', async () => {
    let fired = false;
    const timeout = timers.setTimeout(() => { fired = true; }, 15);
    timers.clearImmediate(timeout as never);
    await new Promise<void>(resolve => g.setTimeout(resolve, 40));
    strictEqual(fired, true);
});

Deno.test('timers cross-impl: global Immediate lifecycle is safe after it fires', async () => {
    const immediate = await new Promise<ReturnType<typeof g.setImmediate>>((resolve) => {
        const handle = g.setImmediate(() => resolve(handle));
    });
    strictEqual(immediate.hasRef(), false);
    strictEqual(immediate.ref(), immediate);
    strictEqual(immediate.unref(), immediate);
    strictEqual(immediate.close(), immediate);
});

Deno.test('timers cross-impl: global clearImmediate updates a module Immediate wrapper', () => {
    const immediate = timers.setImmediate(() => {});
    g.clearImmediate(immediate as never);
    strictEqual(immediate.hasRef(), false);
    strictEqual(immediate.ref(), immediate);
    strictEqual(immediate.unref(), immediate);
    strictEqual(immediate.close(), immediate);
});

Deno.test('timers cross-impl: module clearImmediate updates a global Immediate wrapper', () => {
    const immediate = g.setImmediate(() => {}) as unknown as {
        hasRef(): boolean;
        ref(): unknown;
        unref(): unknown;
        close(): unknown;
    };
    timers.clearImmediate(immediate as never);
    strictEqual(immediate.hasRef(), false);
    strictEqual(immediate.ref(), immediate);
    strictEqual(immediate.unref(), immediate);
    strictEqual(immediate.close(), immediate);
});

Deno.test('timers cross-impl: module clearImmediate accepts a numeric native id', () => {
    const immediate = timers.setImmediate(() => {});
    timers.clearImmediate(Number(immediate));
    strictEqual(immediate.hasRef(), false);
    strictEqual(immediate.ref(), immediate);
    strictEqual(immediate.unref(), immediate);
    strictEqual(immediate.close(), immediate);
});

Deno.test('timers cross-impl: Immediate ref state toggles on both wrappers', () => {
    const globalImmediate = g.setImmediate(() => {}) as unknown as {
        hasRef(): boolean;
        ref(): unknown;
        unref(): unknown;
    };
    strictEqual(globalImmediate.hasRef(), true);
    globalImmediate.unref();
    strictEqual(globalImmediate.hasRef(), false);
    globalImmediate.ref();
    strictEqual(globalImmediate.hasRef(), true);
    timers.clearImmediate(globalImmediate as never);
    strictEqual(globalImmediate.hasRef(), false);

    const moduleImmediate = timers.setImmediate(() => {});
    strictEqual(moduleImmediate.hasRef(), true);
    moduleImmediate.unref();
    strictEqual(moduleImmediate.hasRef(), false);
    moduleImmediate.ref();
    strictEqual(moduleImmediate.hasRef(), true);
    g.clearImmediate(moduleImmediate as never);
    strictEqual(moduleImmediate.hasRef(), false);
});

Deno.test('timers cross-impl: Timeout and Immediate handles have distinct ids', () => {
    const timeout = timers.setTimeout(() => {}, 5000);
    const immediate = timers.setImmediate(() => {});
    try {
        ok(Number(timeout) !== Number(immediate), 'timer handle ids must share one collision-free namespace');
    } finally {
        timers.clearTimeout(timeout);
        timers.clearImmediate(immediate);
    }
});

// --- Timeout methods remain safe after the native timer leaves its registry.
// Ref preference remains observable and mutable even when the timer is gone.

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

Deno.test('timers cross-impl: global Timeout ref state is safe after clear and fire', async () => {
    const cleared = g.setTimeout(() => {}, 5000) as unknown as {
        hasRef(): boolean; ref(): unknown; unref(): unknown;
    };
    g.clearTimeout(cleared as never);
    strictEqual(cleared.hasRef(), true);
    strictEqual(cleared.unref(), cleared);
    strictEqual(cleared.hasRef(), false);
    strictEqual(cleared.ref(), cleared);
    strictEqual(cleared.hasRef(), true);

    let callbackRefState = false;
    let callbackUnrefState = true;
    let callbackRerefState = false;
    const fired = await new Promise<typeof cleared>(resolve => {
        const handle = g.setTimeout(() => {
            callbackRefState = handle.hasRef();
            handle.unref();
            callbackUnrefState = handle.hasRef();
            handle.ref();
            callbackRerefState = handle.hasRef();
            resolve(handle);
        }, 1) as unknown as typeof cleared;
    });
    strictEqual(callbackRefState, true);
    strictEqual(callbackUnrefState, false);
    strictEqual(callbackRerefState, true);
    strictEqual(fired.hasRef(), true);
    strictEqual(fired.ref(), fired);
    strictEqual(fired.unref(), fired);
    strictEqual(fired.hasRef(), false);
});

Deno.test('timers cross-impl: clearing a completed handle prevents refresh across facades', async () => {
    for (const [makeName, make] of [['global', g.setTimeout], ['module', timers.setTimeout]] as const) {
        for (const [clearName, clear] of [
            ['global object timeout', (handle: unknown) => g.clearTimeout(handle as never)],
            ['module object timeout', (handle: unknown) => timers.clearTimeout(handle as never)],
            ['global numeric timeout', (handle: unknown) => g.clearTimeout(Number(handle))],
            ['module numeric timeout', (handle: unknown) => timers.clearTimeout(Number(handle))],
            ['global object interval', (handle: unknown) => g.clearInterval(handle as never)],
            ['module object interval', (handle: unknown) => timers.clearInterval(handle as never)],
            ['global numeric interval', (handle: unknown) => g.clearInterval(Number(handle))],
            ['module numeric interval', (handle: unknown) => timers.clearInterval(Number(handle))],
        ] as const) {
            let runs = 0;
            const handle = await new Promise<ReturnType<typeof timers.setTimeout>>(resolve => {
                const timeout = make(() => { runs++; resolve(timeout); }, 1);
            });
            try {
                clear(handle);
                handle.refresh();
                await new Promise<void>(resolve => g.setTimeout(resolve, 10));
                strictEqual(runs, 1, `${makeName} handle must observe ${clearName} cancellation after completion`);
            } finally {
                clear(handle);
            }
        }
    }
});

Deno.test('timers cross-impl: completed numeric ids cancel without crossing a refreshed generation', async () => {
    for (const make of [g.setTimeout, timers.setTimeout]) {
        let runs = 0;
        const timeout = await new Promise<ReturnType<typeof timers.setTimeout>>(resolve => {
            const handle = make(() => { runs++; resolve(handle); }, 1);
        });
        const completedId = Number(timeout);
        timeout.refresh();
        const refreshedId = Number(timeout);
        strictEqual(refreshedId === completedId, false);
        g.clearTimeout(completedId);
        await new Promise<void>(resolve => g.setTimeout(resolve, 10));
        strictEqual(runs, 2, 'the stale completed id must not cancel a newer refresh');
        timers.clearTimeout(timeout);
    }
});

Deno.test('timers cross-impl: completed refresh preserves the timer ref preference', async () => {
    for (const make of [g.setTimeout, timers.setTimeout]) {
        for (const refed of [false, true]) {
            let timeout!: ReturnType<typeof timers.setTimeout>;
            const keepAlive = timers.setTimeout(() => {}, 1000);
            try {
                await new Promise<void>(resolve => {
                    timeout = make(resolve, 1);
                    if (!refed) timeout.unref();
                });
                timeout.refresh();
                strictEqual(timeout.hasRef(), refed);
                await new Promise<void>(resolve => timers.setTimeout(resolve, 10));
                if (refed) timeout.unref();
                else timeout.ref();
                timeout.refresh();
                strictEqual(timeout.hasRef(), !refed);
            } finally {
                timers.clearTimeout(timeout);
                timers.clearTimeout(keepAlive);
            }
        }
    }
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
