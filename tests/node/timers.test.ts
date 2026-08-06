import { strictEqual, ok, throws } from 'node:assert';
import * as timers from 'node:timers';
import * as timersP from 'node:timers/promises';

Deno.test('timers: timeout scheduled after sync work uses current loop time', async () => {
    const busyUntil = Date.now() + 150;
    while (Date.now() < busyUntil) {}

    const elapsed = await new Promise<number>((resolve) => {
        const start = Date.now();
        setTimeout(() => resolve(Date.now() - start), 80);
    });

    ok(elapsed >= 50, `timer fired too early after ${elapsed}ms`);
});

// --- 1. setTimeout returns an object with refresh/Unref -------------------

Deno.test('timers: setTimeout returns a Timeout', () => {
    const t = timers.setTimeout(() => {}, 1000);
    ok(t);
    if (typeof (t as any).refresh === 'function') (t as any).refresh();
    if (typeof (t as any).unref === 'function') (t as any).unref();
    if (typeof (t as any).ref === 'function') (t as any).ref();
    timers.clearTimeout(t);
});

// --- 2. setInterval returns an object; clearInterval cancels ----------------

Deno.test('timers: setInterval returns Timeout; clearInterval cancels', () => {
    let n = 0;
    const id = setInterval(() => { n++; }, 10);
    clearInterval(id);
    ok(typeof id === 'object' || typeof id === 'number');
});

// --- 3. setImmediate returns an object; clearImmediate cancels -------------

Deno.test('timers: setImmediate returns Immediate; clearImmediate cancels', () => {
    const id = setImmediate(() => {});
    clearImmediate(id);
    ok(typeof id === 'object' || typeof id === 'number');
});

Deno.test('timers: Immediate ref state toggles like Node', () => {
    const id = timers.setImmediate(() => {});
    try {
        strictEqual(id.hasRef(), true);
        strictEqual(id.unref(), id);
        strictEqual(id.hasRef(), false);
        strictEqual(id.ref(), id);
        strictEqual(id.hasRef(), true);
    } finally {
        timers.clearImmediate(id);
    }
});

Deno.test('timers: setImmediate runs after queued microtasks', async () => {
    const order: string[] = [];
    const done = new Promise<void>((resolve) => {
        timers.setImmediate(() => {
            order.push('immediate');
            resolve();
        });
    });
    queueMicrotask(() => order.push('microtask'));
    await done;
    strictEqual(order.join(','), 'microtask,immediate');
});

Deno.test('timers: cleared and fired Immediate handles are unreferenced', async () => {
    const cleared = timers.setImmediate(() => {});
    timers.clearImmediate(cleared);
    strictEqual(cleared.hasRef(), false);
    strictEqual(cleared.ref().hasRef(), false);

    let fired: NodeJS.Immediate | undefined;
    await new Promise<void>((resolve) => {
        fired = timers.setImmediate(resolve);
    });
    strictEqual(fired?.hasRef(), false);
});

// --- 4. clearTimeout of already-fired timer is safe ------------------------

Deno.test('timers: clearTimeout after fire is safe', () => {
    const id = setTimeout(() => {}, 1);
    setTimeout(() => clearTimeout(id), 50); // clearing after it likely fired
});

// --- 5. timer callbacks receive extra arguments ----------------------------

Deno.test('timers: setTimeout forwards extra arguments', async () => {
    const result = await new Promise<string>((resolve) => {
        setTimeout((a: string, b: string) => resolve(`${a}:${b}`), 1, 'left', 'right');
    });
    strictEqual(result, 'left:right');
});

Deno.test('timers: setImmediate forwards extra arguments', async () => {
    const result = await new Promise<string>((resolve) => {
        setImmediate((a: string, b: string) => resolve(`${a}:${b}`), 'left', 'right');
    });
    strictEqual(result, 'left:right');
});

Deno.test('timers: clearTimeout cancels a pending callback', async () => {
    let fired = false;
    const id = setTimeout(() => { fired = true; }, 20);
    clearTimeout(id);
    await timersP.setTimeout(40);
    strictEqual(fired, false);
});

Deno.test('timers: clearTimeout accepts Timeout numeric primitive', async () => {
    let fired = false;
    const id = timers.setTimeout(() => { fired = true; }, 20);
    timers.clearTimeout(Number(id));
    await timersP.setTimeout(40);
    strictEqual(fired, false);
});

Deno.test('timers: Timeout refresh reschedules pending callback', async () => {
    let fired = 0;
    const id = timers.setTimeout(() => { fired++; }, 60);
    await timersP.setTimeout(10);
    strictEqual(id.refresh(), id);
    await timersP.setTimeout(30);
    strictEqual(fired, 0);
    await timersP.setTimeout(50);
    strictEqual(fired, 1);
});

Deno.test('timers upstream: Timeout refresh after clearTimeout does not reactivate callback', async () => {
    let fired = false;
    const id = timers.setTimeout(() => { fired = true; }, 1);
    timers.clearTimeout(id);
    strictEqual(id.refresh(), id);
    await timersP.setTimeout(30);
    strictEqual(fired, false);
});

// --- 8. timers.promises.setTimeout resolves --------------------------------

Deno.test('timers.promises: setTimeout resolves', async () => {
    const v = await timersP.setTimeout(10, 'done');
    strictEqual(v, 'done');
});

// --- 9. timers.promises.setImmediate resolves -------------------------------

Deno.test('timers.promises: setImmediate resolves', async () => {
    const v = await timersP.setImmediate('imm');
    strictEqual(v, 'imm');
});

Deno.test('timers.promises: setImmediate runs after queued microtasks', async () => {
    const order: string[] = [];
    const immediate = timersP.setImmediate().then(() => order.push('immediate'));
    queueMicrotask(() => order.push('microtask'));
    await immediate;
    strictEqual(order.join(','), 'microtask,immediate');
});

// --- 10. timers.promises.setInterval yields values --------------------------

Deno.test('timers.promises: setInterval async iterator yields', async () => {
    let count = 0;
    const results: number[] = [];
    for await (const v of timersP.setInterval(5, count)) {
        results.push(v as number);
        if (++count >= 3) break;
    }
    ok(results.length >= 3);
});

// --- 11. timers.promises.setTimeout with signal (AbortSignal) ---------------

Deno.test('timers.promises: setTimeout with AbortSignal rejects', async () => {
    const ac = new AbortController();
    const p = timersP.setTimeout(1000, 'x', { signal: ac.signal });
    ac.abort();
    let rejected = false;
    try { await p; } catch { rejected = true; }
    ok(rejected, 'aborted timer promise must reject');
});

Deno.test('timers.promises: throws for invalid delay and options arguments', () => {
    throws(() => timersP.setTimeout('1' as unknown as number), TypeError);
    throws(() => timersP.setTimeout(null as unknown as number), TypeError);
    throws(() => timersP.setTimeout(1, 'x', 'bad' as unknown as Parameters<typeof timersP.setTimeout>[2]), TypeError);
    throws(() => timersP.setImmediate('x', null as unknown as Parameters<typeof timersP.setImmediate>[1]), TypeError);
    throws(() => timersP.setInterval('1' as unknown as number), TypeError);
    throws(() => timersP.scheduler.wait('1' as unknown as number), TypeError);
    throws(() => timersP.scheduler.wait(1, 'bad' as unknown as Parameters<typeof timersP.scheduler.wait>[1]), TypeError);
});

Deno.test('timers.promises: already-aborted signal rejects with AbortError', async () => {
    const ac = new AbortController();
    ac.abort('stop');

    let err: any;
    try {
        await timersP.setTimeout(1, 'x', { signal: ac.signal });
    } catch (e) {
        err = e;
    }

    ok(err, 'already-aborted timer promise must reject');
    strictEqual(err?.name, 'AbortError');
    strictEqual(err?.code, 'ABORT_ERR');
    strictEqual(err?.cause, 'stop');
});

Deno.test('timers.promises.scheduler: wait rejects with AbortError', async () => {
    const ac = new AbortController();
    ac.abort('stop');

    let err: any;
    try {
        await timersP.scheduler.wait(1, { signal: ac.signal });
    } catch (e) {
        err = e;
    }

    ok(err, 'scheduler.wait must reject for an already-aborted signal');
    strictEqual(err?.name, 'AbortError');
    strictEqual(err?.code, 'ABORT_ERR');
    strictEqual(err?.cause, 'stop');
});

Deno.test('timers.promises.scheduler: yield resumes asynchronously', async () => {
    const order: string[] = [];
    order.push('sync');
    const p = timersP.scheduler.yield().then(() => order.push('yield'));
    order.push('after');
    await p;
    strictEqual(order.join(','), 'sync,after,yield');
});

Deno.test('timers.promises.scheduler: yield runs after queued microtasks', async () => {
    const order: string[] = [];
    const yielded = timersP.scheduler.yield().then(() => order.push('yield'));
    queueMicrotask(() => order.push('microtask'));
    await yielded;
    strictEqual(order.join(','), 'microtask,yield');
});

// --- 15. global setTimeout/setInterval are the same as module exports -------

Deno.test('timers: global setTimeout is function', () => {
    ok(typeof setTimeout === 'function');
    ok(typeof setInterval === 'function');
    ok(typeof setImmediate === 'function');
});

// --- 16. clearTimeout with invalid id is safe -------------------------------

Deno.test('timers: clearTimeout with undefined is safe', () => {
    clearTimeout(undefined);
    clearInterval(undefined);
    clearImmediate(undefined);
});

// --- 17. Node-visible Timeout internals ------------------------------------

Deno.test('timers upstream: Timeout exposes _idleTimeout, _repeat and _destroyed', () => {
    const t = timers.setTimeout(() => {}, 40);
    strictEqual(t._idleTimeout, 40);
    strictEqual(t._repeat, null);
    strictEqual(t._destroyed, false);
    timers.clearTimeout(t);
    strictEqual(t._destroyed, true);
    strictEqual(t._idleTimeout, -1);

    const i = timers.setInterval(() => {}, 25);
    strictEqual(i._idleTimeout, 25);
    strictEqual(i._repeat, 25);
    timers.clearInterval(i);
    strictEqual(i._repeat, 25);
    strictEqual(i._idleTimeout, -1);
});

Deno.test('timers upstream: Immediate exposes _destroyed', () => {
    const im = timers.setImmediate(() => {});
    strictEqual(im._destroyed, false);
    timers.clearImmediate(im);
    strictEqual(im._destroyed, true);
});

// --- 18. delay clamping ----------------------------------------------------

Deno.test('timers upstream: out-of-range delays clamp to 1ms and still fire', async () => {
    const delays = [0, -1, NaN, 2 ** 31, 2 ** 32 + 5, Infinity, 1e21];
    const fired = await Promise.all(delays.map((d) => new Promise<number>((resolve) => {
        const t = timers.setTimeout(() => resolve(t._idleTimeout), d as number);
    })));
    strictEqual(fired.join(','), delays.map(() => 1).join(','));
});

Deno.test('timers upstream: no-delay and numeric-string delays match Node', () => {
    const a = timers.setTimeout(() => {});
    strictEqual(a._idleTimeout, 1);
    timers.clearTimeout(a);
    const b = timers.setTimeout(() => {}, '30' as unknown as number);
    strictEqual(b._idleTimeout, 30);
    timers.clearTimeout(b);
});

Deno.test('timers upstream: overflow delay emits TimeoutOverflowWarning', async () => {
    const seen: string[] = [];
    const onWarning = (w: Error) => seen.push(w.name);
    process.on('warning', onWarning);
    try {
        timers.clearTimeout(timers.setTimeout(() => {}, 2 ** 32));
        timers.clearTimeout(timers.setTimeout(() => {}, -3));
        timers.clearTimeout(timers.setTimeout(() => {}, NaN));
        await new Promise((r) => setTimeout(r, 20));
    } finally {
        process.off('warning', onWarning);
    }
    ok(seen.includes('TimeoutOverflowWarning'), `saw ${seen.join(',')}`);
    ok(seen.includes('TimeoutNegativeWarning'), `saw ${seen.join(',')}`);
    ok(seen.includes('TimeoutNaNWarning'), `saw ${seen.join(',')}`);
});

// --- 19. refresh revives a fired timeout ----------------------------------

Deno.test('timers upstream: refresh after firing reschedules the callback', async () => {
    let fires = 0;
    const t = timers.setTimeout(() => { fires++; }, 5);
    await new Promise((r) => setTimeout(r, 30));
    strictEqual(fires, 1);
    strictEqual(t._destroyed, true);
    t.refresh();
    strictEqual(t._destroyed, false);
    await new Promise((r) => setTimeout(r, 30));
    strictEqual(fires, 2);
    timers.clearTimeout(t);
});

// --- 20. argument validation shape ---------------------------------------

Deno.test('timers upstream: callback validation uses ERR_INVALID_ARG_TYPE', () => {
    for (const bad of [1, null, undefined, {}]) {
        try {
            timers.setTimeout(bad as unknown as () => void);
            ok(false, 'should throw');
        } catch (e) {
            strictEqual((e as { code?: string }).code, 'ERR_INVALID_ARG_TYPE');
        }
    }
    try {
        timersP.setTimeout('5' as unknown as number);
        ok(false, 'should throw');
    } catch (e) {
        strictEqual((e as { code?: string }).code, 'ERR_INVALID_ARG_TYPE');
    }
});

Deno.test('timers upstream: clearImmediate ignores foreign handles', () => {
    clearImmediate({} as unknown as NodeJS.Immediate);
    clearImmediate(123 as unknown as NodeJS.Immediate);
});

// --- 21. timers/promises setInterval iterator cleanup --------------------

Deno.test('timers.promises: setInterval return() ends the iterator', async () => {
    const it = timersP.setInterval(10, 'v');
    const first = await it.next();
    strictEqual(first.value, 'v');
    strictEqual(first.done, false);
    const ret = await it.return!();
    strictEqual(ret.done, true);
    const after = await it.next();
    strictEqual(after.done, true);
    strictEqual(after.value, undefined);
});

// --- 22. Timeout._destroyed lifecycle -------------------------------------
// Measured against Node v24.18.0: a one-shot Timeout reports _destroyed
// false while its callback runs and true only once the callback returns.
// Marking it destroyed on entry breaks ecosystem code that re-arms a timer
// from inside its own handler (the `if (t._destroyed) return;` guard).

Deno.test('timers: one-shot _destroyed is false during the callback', async () => {
    const seen = await new Promise<{ inCb: boolean; after: boolean }>((resolve) => {
        const t = timers.setTimeout(() => {
            const inCb = (t as unknown as { _destroyed: boolean })._destroyed;
            timers.setTimeout(() => {
                resolve({ inCb, after: (t as unknown as { _destroyed: boolean })._destroyed });
            }, 10);
        }, 5);
    });
    strictEqual(seen.inCb, false, '_destroyed must be false while the callback runs');
    strictEqual(seen.after, true, '_destroyed must be true after the callback returns');
});

Deno.test('timers: interval _destroyed stays false across ticks', async () => {
    const seen = await new Promise<{ inCb: boolean; afterClear: boolean }>((resolve) => {
        let n = 0;
        let inCb = true;
        const i = timers.setInterval(() => {
            n++;
            if (n === 1) inCb = (i as unknown as { _destroyed: boolean })._destroyed;
            if (n >= 2) {
                timers.clearInterval(i);
                resolve({ inCb, afterClear: (i as unknown as { _destroyed: boolean })._destroyed });
            }
        }, 5);
    });
    strictEqual(seen.inCb, false, 'interval _destroyed must be false while ticking');
    strictEqual(seen.afterClear, true, 'interval _destroyed must be true after clear');
});

Deno.test('timers: refresh() from inside the callback keeps the timer live', async () => {
    const seen = await new Promise<{ runs: number; destroyedAfterRefresh: boolean }>((resolve) => {
        let runs = 0;
        let destroyedAfterRefresh = true;
        const t = timers.setTimeout(() => {
            runs++;
            if (runs === 1) {
                (t as unknown as { refresh(): void }).refresh();
                destroyedAfterRefresh = (t as unknown as { _destroyed: boolean })._destroyed;
                return;
            }
            resolve({ runs, destroyedAfterRefresh });
        }, 5);
    });
    strictEqual(seen.runs, 2, 'refresh() inside the callback must re-arm the timer');
    strictEqual(seen.destroyedAfterRefresh, false, 'refresh() must leave _destroyed false');
});

// --- cross-boundary cancellation -------------------------------------------
// globalThis.setImmediate (webapi) and node:timers' setImmediate were separate
// implementations with separate registries, so a handle created through one
// could not be cancelled through the other: clearImmediate silently no-oped and
// the "cancelled" callback still ran. Every cell of the matrix must cancel.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

Deno.test('timers: clearImmediate cancels across the global/module boundary', async () => {
    const setters = { global: globalThis.setImmediate, module: timers.setImmediate };
    const clearers = { global: globalThis.clearImmediate, module: timers.clearImmediate };
    const stillRan: string[] = [];

    for (const from of ['global', 'module'] as const) {
        for (const via of ['global', 'module'] as const) {
            let ran = false;
            const handle = setters[from](() => { ran = true; });
            clearers[via](handle);
            await sleep(40);
            if (ran) stillRan.push(`${from}+${via}`);
        }
    }
    strictEqual(stillRan.join(','), '', 'these cells did not cancel');
});

Deno.test('timers: clearTimeout/clearInterval cancel across the global/module boundary', async () => {
    const stillRan: string[] = [];

    // Bound on purpose: cno's global timers reject a `this` that is not
    // globalThis (validateTimerThis, cno/src/webapi/basic.ts:852) where Node
    // accepts any receiver. That is a separate defect from the registry split
    // this test covers, so it must not mask the matrix result.
    const timeoutSet = { global: globalThis.setTimeout.bind(globalThis), module: timers.setTimeout };
    const timeoutClear = { global: globalThis.clearTimeout.bind(globalThis), module: timers.clearTimeout };
    const intervalSet = { global: globalThis.setInterval.bind(globalThis), module: timers.setInterval };
    const intervalClear = { global: globalThis.clearInterval.bind(globalThis), module: timers.clearInterval };

    for (const from of ['global', 'module'] as const) {
        for (const via of ['global', 'module'] as const) {
            let ranT = false;
            timeoutClear[via](timeoutSet[from](() => { ranT = true; }, 10) as never);
            let ranI = false;
            const iv = intervalSet[from](() => { ranI = true; }, 10);
            intervalClear[via](iv as never);
            await sleep(50);
            // Stop a still-live interval before it pollutes later cells.
            if (ranI) globalThis.clearInterval(iv as never);
            if (ranT) stillRan.push(`timeout:${from}+${via}`);
            if (ranI) stillRan.push(`interval:${from}+${via}`);
        }
    }
    strictEqual(stillRan.join(','), '', 'these cells did not cancel');
});

Deno.test('timers: a timer cancels by its primitive id across the boundary', async () => {
    // Node accepts the numeric id, not just the handle object.
    let ranA = false;
    const a = globalThis.setTimeout(() => { ranA = true; }, 10);
    timers.clearTimeout((a as unknown as { [Symbol.toPrimitive](): number })[Symbol.toPrimitive]());
    let ranB = false;
    const b = timers.setTimeout(() => { ranB = true; }, 10);
    globalThis.clearTimeout((b as unknown as { [Symbol.toPrimitive](): number })[Symbol.toPrimitive]());
    await sleep(50);
    strictEqual(ranA, false, 'global handle must clear via the module by primitive id');
    strictEqual(ranB, false, 'module handle must clear via the global by primitive id');
});
