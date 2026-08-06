import { ok, strictEqual } from 'node:assert';
import * as timers from 'node:timers';

// ============================================================================
// Web API — timer receiver ("this") binding
//
// Node applies NO brand check to any timer entry point. Measured against Node
// v24.18.0, every one of these receivers is accepted for setTimeout,
// clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate and
// queueMicrotask, for both the globals and the `node:timers` exports:
//
//   bare/destructured call, method call on a plain object, .call(null),
//   .call(undefined), .call(globalThis), .call(arbitraryObject),
//   .call(timersModule), Reflect.apply(fn, arbitraryObject, args), .call(42)
//
// The reason it cannot be otherwise: in Node the globals and the module exports
// are the *same function objects* (`globalThis.setTimeout ===
// require('node:timers').setTimeout` is true), so `timers.setTimeout(...)` is
// itself a method call whose receiver is the module namespace. Any receiver
// validation would reject Node's own documented calling convention.
//
// This matters in practice because copying the timer functions onto a table and
// calling them as methods is exactly how sinon, @sinonjs/fake-timers and jest's
// useFakeTimers install and restore timers.
// ============================================================================

type AnyFn = (...args: unknown[]) => unknown;

const ARBITRARY = { marker: 'not-the-global' };

/** Every receiver Node accepts, as [name, thisArg] pairs. */
function receivers(): Array<[string, unknown]> {
    return [
        ['null', null],
        ['undefined', undefined],
        ['globalThis', globalThis],
        ['arbitrary object', ARBITRARY],
        ['node:timers namespace', timers],
        ['number 42', 42],
    ];
}

/**
 * Call `fn` with each receiver via .call and via Reflect.apply, collecting the
 * receivers that threw. Returns [] when the contract is met.
 */
function rejectedReceivers(fn: AnyFn, args: unknown[]): string[] {
    const failures: string[] = [];
    for (const [name, thisArg] of receivers()) {
        try {
            fn.call(thisArg, ...args);
        } catch (e) {
            failures.push(`.call(${name}) -> ${(e as Error).message}`);
        }
        try {
            Reflect.apply(fn, thisArg, args);
        } catch (e) {
            failures.push(`Reflect.apply(${name}) -> ${(e as Error).message}`);
        }
    }
    return failures;
}

// --- 1. The fake-timer installer pattern, verbatim -------------------------

Deno.test('timers this-binding: method call on a plain object is accepted (fake-timer pattern)', () => {
    // This is what sinon/@sinonjs/fake-timers/jest do: save the timer functions
    // onto a table, then call them as methods of that table.
    const saved = {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
        setImmediate: globalThis.setImmediate,
        clearImmediate: globalThis.clearImmediate,
    };

    const t = saved.setTimeout(() => {}, 10_000);
    ok(t !== undefined, 'saved.setTimeout must return a handle');
    saved.clearTimeout(t);

    const i = saved.setInterval(() => {}, 10_000);
    ok(i !== undefined, 'saved.setInterval must return a handle');
    saved.clearInterval(i);

    const im = saved.setImmediate(() => {});
    ok(im !== undefined, 'saved.setImmediate must return a handle');
    saved.clearImmediate(im);
});

// --- 2. Full receiver matrix for the globals -------------------------------

Deno.test('timers this-binding: global setTimeout/clearTimeout accept every receiver', () => {
    const created: unknown[] = [];
    const setFailures = rejectedReceivers(
        globalThis.setTimeout as unknown as AnyFn,
        [() => {}, 10_000],
    );
    // clean up whatever the matrix scheduled so the loop can drain
    for (const h of created) globalThis.clearTimeout(h as number);
    strictEqual(setFailures.length, 0, `setTimeout rejected receivers: ${setFailures.join('; ')}`);

    const clearFailures = rejectedReceivers(globalThis.clearTimeout as unknown as AnyFn, [undefined]);
    strictEqual(clearFailures.length, 0, `clearTimeout rejected receivers: ${clearFailures.join('; ')}`);
});

Deno.test('timers this-binding: global setInterval/clearInterval accept every receiver', () => {
    const setFailures = rejectedReceivers(globalThis.setInterval as unknown as AnyFn, [() => {}, 10_000]);
    strictEqual(setFailures.length, 0, `setInterval rejected receivers: ${setFailures.join('; ')}`);

    const clearFailures = rejectedReceivers(globalThis.clearInterval as unknown as AnyFn, [undefined]);
    strictEqual(clearFailures.length, 0, `clearInterval rejected receivers: ${clearFailures.join('; ')}`);
});

Deno.test('timers this-binding: global setImmediate/clearImmediate/queueMicrotask accept every receiver', () => {
    const setFailures = rejectedReceivers(globalThis.setImmediate as unknown as AnyFn, [() => {}]);
    strictEqual(setFailures.length, 0, `setImmediate rejected receivers: ${setFailures.join('; ')}`);

    const clearFailures = rejectedReceivers(globalThis.clearImmediate as unknown as AnyFn, [undefined]);
    strictEqual(clearFailures.length, 0, `clearImmediate rejected receivers: ${clearFailures.join('; ')}`);

    const qmFailures = rejectedReceivers(globalThis.queueMicrotask as unknown as AnyFn, [() => {}]);
    strictEqual(qmFailures.length, 0, `queueMicrotask rejected receivers: ${qmFailures.join('; ')}`);
});

// --- 3. Same matrix for the node:timers exports ----------------------------

Deno.test('timers this-binding: node:timers exports accept every receiver', () => {
    const cases: Array<[string, AnyFn, unknown[]]> = [
        ['setTimeout', timers.setTimeout as unknown as AnyFn, [() => {}, 10_000]],
        ['clearTimeout', timers.clearTimeout as unknown as AnyFn, [undefined]],
        ['setInterval', timers.setInterval as unknown as AnyFn, [() => {}, 10_000]],
        ['clearInterval', timers.clearInterval as unknown as AnyFn, [undefined]],
        ['setImmediate', timers.setImmediate as unknown as AnyFn, [() => {}]],
        ['clearImmediate', timers.clearImmediate as unknown as AnyFn, [undefined]],
    ];
    const allFailures: string[] = [];
    for (const [name, fn, args] of cases) {
        for (const f of rejectedReceivers(fn, args)) allFailures.push(`${name}${f}`);
    }
    strictEqual(allFailures.length, 0, `node:timers rejected receivers: ${allFailures.join('; ')}`);
});

// --- 4. Destructuring keeps working ---------------------------------------

Deno.test('timers this-binding: destructured globals work with an undefined receiver', () => {
    const { setTimeout: st, clearTimeout: ct, setInterval: si, clearInterval: ci } = globalThis;
    const t = st(() => {}, 10_000);
    ct(t);
    const i = si(() => {}, 10_000);
    ci(i);
    ok(true);
});

// --- 5. A scheduled timer still actually fires when called off a table -----

Deno.test('timers this-binding: a timer scheduled via a method call still fires', async () => {
    const tbl = { setTimeout: globalThis.setTimeout };
    const fired = await new Promise<boolean>((resolve) => {
        const bail = globalThis.setTimeout(() => resolve(false), 2000);
        tbl.setTimeout(() => {
            globalThis.clearTimeout(bail);
            resolve(true);
        }, 1);
    });
    strictEqual(fired, true, 'timer scheduled through a method call never fired');
});
