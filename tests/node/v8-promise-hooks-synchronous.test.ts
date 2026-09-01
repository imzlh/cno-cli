import { strictEqual } from 'node:assert';
import v8 from 'node:v8';

/**
 * Pins the promise hook being dispatched SYNCHRONOUSLY.
 *
 * `tjs__promise_hook` (circu.js/src/mod_engine.c) used to hand every event to
 * JS_EnqueueJob, so the hook body ran as a later microtask. Two consequences,
 * both measured on the 2026-08-08 binary:
 *
 *  1. INIT reported whatever context was current when the queued job ran rather
 *     than the one that created the promise. With two concurrent async tasks,
 *     every INIT was attributed to the second one.
 *  2. An event could outlive the hook set it was raised for: an AFTER from one
 *     test was delivered to a hook registered by the next test, after the
 *     original's stop() had already run.
 *
 * V8 fires PromiseHook synchronously; these events describe a moment, so
 * reporting them later reports the wrong moment.
 *
 * These assertions require the native promise-hook fix to be present in the
 * staged binary and guard against regressions to deferred dispatch.
 *
 * NOTE this does NOT fix AsyncLocalStorage under concurrency. QuickJS emits no
 * event when an await continuation resumes, so there is nothing to hook there at
 * any timing -- see async-hooks-als-concurrency-rotation.test.ts.
 */

Deno.test({
    name: 'v8.promiseHooks: init fires synchronously with promise creation',
    fn: () => {
        let seen = 0;
        const stop = v8.promiseHooks.onInit(() => { seen++; });
        try {
            // Synchronous dispatch means the count moves before the next
            // statement. Enqueued dispatch leaves it at 0 until a microtask.
            const p = Promise.resolve(1);
            strictEqual(seen, 1, `init must fire before the next statement, saw ${seen}`);
            void p;
        } finally {
            stop();
        }
    },
});

Deno.test({
    name: 'v8.promiseHooks: no event is delivered after its hook was removed',
    fn: async () => {
        // Force thenable adoption, the one shape that emits BEFORE/AFTER in this
        // engine, then tear the hook down and confirm nothing arrives late.
        let first = 0;
        const stopFirst = v8.promiseHooks.onAfter(() => { first++; });
        await new Promise((res) => res({ then(r: (v: unknown) => void) { r(42); } } as never));
        stopFirst();

        let second = 0;
        const stopSecond = v8.promiseHooks.onAfter(() => { second++; });
        try {
            // Drain anything that might still be queued from the first phase.
            await new Promise<void>((r) => setTimeout(r, 5));
            strictEqual(second, 0, `a stale event reached the second hook (${second})`);
        } finally {
            stopSecond();
        }
    },
});

/**
 * Companion guard, NOT skipped: inline dispatch must not recurse. A hook body
 * that creates a promise re-enters the hook, so the C side keeps a reentrancy
 * flag; without it this test overflows the stack instead of failing.
 */
Deno.test('v8.promiseHooks: a hook that creates promises does not recurse', () => {
    let depth = 0;
    let maxDepth = 0;
    const stop = v8.promiseHooks.onInit(() => {
        depth++;
        if (depth > maxDepth) maxDepth = depth;
        if (depth < 5) Promise.resolve(depth); // re-entry attempt
        depth--;
    });
    try {
        void Promise.resolve('outer');
    } finally {
        stop();
    }
    strictEqual(maxDepth <= 1, true, `hook re-entered itself, depth reached ${maxDepth}`);
});
