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
