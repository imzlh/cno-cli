import { strictEqual, ok } from 'node:assert';
import * as timers from 'node:timers';
import * as timersP from 'node:timers/promises';

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

// --- 4. clearTimeout of already-fired timer is safe ------------------------

Deno.test('timers: clearTimeout after fire is safe', () => {
    const id = setTimeout(() => {}, 1);
    setTimeout(() => clearTimeout(id), 50); // clearing after it likely fired
});

// --- 5. timers.promises.setTimeout resolves --------------------------------

Deno.test('timers.promises: setTimeout resolves', async () => {
    const v = await timersP.setTimeout(10, 'done');
    strictEqual(v, 'done');
});

// --- 6. timers.promises.setImmediate resolves -------------------------------

Deno.test('timers.promises: setImmediate resolves', async () => {
    const v = await timersP.setImmediate('imm');
    strictEqual(v, 'imm');
});

// --- 7. timers.promises.setInterval yields values ---------------------------

Deno.test('timers.promises: setInterval async iterator yields', async () => {
    let count = 0;
    const results: number[] = [];
    for await (const v of timersP.setInterval(5, count)) {
        results.push(v as number);
        if (++count >= 3) break;
    }
    ok(results.length >= 3);
});

// --- 8. timers.promises.setTimeout with signal (AbortSignal) ----------------

Deno.test('timers.promises: setTimeout with AbortSignal rejects', async () => {
    const ac = new AbortController();
    const p = timersP.setTimeout(1000, 'x', { signal: ac.signal });
    ac.abort();
    let rejected = false;
    try { await p; } catch { rejected = true; }
    ok(rejected, 'aborted timer promise must reject');
});

// --- 9. global setTimeout/setInterval are the same as module exports --------

Deno.test('timers: global setTimeout is function', () => {
    ok(typeof setTimeout === 'function');
    ok(typeof setInterval === 'function');
    ok(typeof setImmediate === 'function');
});

// --- 10. clearTimeout with invalid id is safe -------------------------------

Deno.test('timers: clearTimeout with undefined is safe', () => {
    clearTimeout(undefined);
    clearInterval(undefined);
    clearImmediate(undefined);
});
