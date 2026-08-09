import { strictEqual } from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * AsyncLocalStorage must give each concurrent `run()` its own store. The existing
 * coverage in `async-hooks.test.ts` is entirely *sequential*, which is why the
 * defect below survived: every single-task case passes.
 *
 * Measured against node v24.18.0 with two concurrent tasks doing two awaits each
 * (/d/tmp/ag-diag/p-min-als2.mjs):
 *   node -> A sees A,A   B sees B,B
 *   cno  -> A sees B,A   B sees B,B      <-- A reads B's store
 * and after both settle, `als.getStore()` at the top level returns B's store in
 * cno where node returns undefined.
 *
 * ROOT CAUSE (measured, not inferred): `cno/src/node/async_hooks/mod.ts` keeps one
 * module-global `_currentStores`. `run()` sets it and `_handleAsyncResult` restores
 * it only when the returned promise *settles*, so the last `run()` to start owns the
 * global slot. `await` does not route through `Promise.prototype.then` in either
 * engine (verified: 0 patched-`then` hits for pending/resolved/non-promise/thenable
 * in BOTH node and cno), so the TS-layer `then` patch cannot restore context on
 * await-resumption.
 *
 * WHY NO TS FIX EXISTS (measured): restoring `_currentStores` synchronously when
 * `run()` returns its promise was tried. It removes the top-level leak but breaks
 * `await-after-null`, `await-after-timeout`, `fs.promises-after` and
 * `nested-timeout`, which all regress to `undefined`. The leak *is* the propagation
 * mechanism -- sequential cases pass only because of it. Reverted.
 *
 * ACTION: needs C work, then drop `ignore: true`. `JS_SetPromiseHook` is already
 * exposed as `engine.promiseHook` (circu.js/src/mod_engine.c:935) but its dispatch
 * goes through `JS_EnqueueJob` (mod_engine.c:88), i.e. it runs as a *later*
 * microtask, so it structurally cannot set context *before* a continuation resumes.
 * A synchronous promise hook, or a per-async-context slot the engine swaps on
 * resume, is required. Do not "fix" this by asserting cno's current output.
 * ---------------------------------------------------------------------------
 */
Deno.test({
    name: 'async_hooks: concurrent AsyncLocalStorage runs keep separate stores (needs C work)',
    ignore: true,
    fn: async () => {
        const als = new AsyncLocalStorage<{ id: string }>();

        const task = (id: string, delay: number) =>
            als.run({ id }, async () => {
                const seen: (string | undefined)[] = [];
                for (let i = 0; i < 2; i++) {
                    await sleep(delay);
                    seen.push(als.getStore()?.id);
                }
                return seen;
            });

        // Interleaved delays force B to resume between A's two awaits.
        const [a, b] = await Promise.all([task('A', 6), task('B', 2)]);
        strictEqual(a.join(','), 'A,A', 'task A must only ever see its own store');
        strictEqual(b.join(','), 'B,B', 'task B must only ever see its own store');
    },
});

/**
 * Same defect, second symptom: the store must not survive the `run()` that created
 * it. Needs three interleaved tasks to surface -- with a single `await als.run()`,
 * or two tasks of one await each, cno also returns undefined and looks correct.
 * Measured with the three-task shape below (/d/tmp/ag-diag/p-leak2.mjs):
 *   node -> undefined, undefined, undefined (immediately / +2ms / +50ms)
 *   cno  -> T2, T2, T2  (permanently stuck on the second task's store)
 * ACTION: as above -- unskip together with the test above.
 */
Deno.test({
    name: 'async_hooks: concurrent async runs do not leak a store to the top level (needs C work)',
    ignore: true,
    fn: async () => {
        const als = new AsyncLocalStorage<{ id: string }>();
        const task = (id: string, delays: number[]) =>
            als.run({ id }, async () => {
                for (const d of delays) await sleep(d);
            });
        await Promise.all([
            task('T1', [5, 5, 5]),
            task('T2', [1, 12, 1]),
            task('T3', [3, 3, 20]),
        ]);
        strictEqual(als.getStore(), undefined, 'no store may outlive its run()');
        await sleep(50);
        strictEqual(als.getStore(), undefined, 'and it must not come back later');
    },
});

/**
 * The sequential guarantees that DO hold today, pinned so a future concurrency fix
 * cannot regress them. All 30 cases of the full sweep were byte-identical to node
 * v24.18.0; these are the load-bearing ones for request tracing.
 */
Deno.test('async_hooks: AsyncLocalStorage propagates across sequential async primitives', async () => {
    const als = new AsyncLocalStorage<{ id: string }>();

    await als.run({ id: 'S' }, async () => {
        strictEqual(als.getStore()?.id, 'S', 'sync inside run');
        await null;
        strictEqual(als.getStore()?.id, 'S', 'after await null');
        await sleep(1);
        strictEqual(als.getStore()?.id, 'S', 'after await a timer');
        for (let i = 0; i < 50; i++) await null;
        strictEqual(als.getStore()?.id, 'S', 'after 50 awaits');
    });

    // Callback-scheduled work started inside run() sees the store.
    const viaCallback = (schedule: (cb: () => void) => void) =>
        new Promise<string | undefined>((res) => {
            als.run({ id: 'C' }, () => schedule(() => res(als.getStore()?.id)));
        });

    strictEqual(await viaCallback((cb) => setTimeout(cb, 1)), 'C', 'setTimeout');
    strictEqual(await viaCallback((cb) => setImmediate(cb)), 'C', 'setImmediate');
    strictEqual(await viaCallback((cb) => process.nextTick(cb)), 'C', 'process.nextTick');
    strictEqual(await viaCallback((cb) => queueMicrotask(cb)), 'C', 'queueMicrotask');
    strictEqual(await viaCallback((cb) => void Promise.resolve().then(cb)), 'C', 'promise then');
});

Deno.test('async_hooks: nested run shadows then restores, and exit clears', () => {
    const als = new AsyncLocalStorage<{ id: string }>();
    als.run({ id: 'outer' }, () => {
        als.run({ id: 'inner' }, () => {
            strictEqual(als.getStore()?.id, 'inner');
        });
        strictEqual(als.getStore()?.id, 'outer', 'outer store restored after inner run');
        als.exit(() => {
            strictEqual(als.getStore(), undefined, 'exit clears the store');
        });
        strictEqual(als.getStore()?.id, 'outer', 'store restored after exit');
    });
    strictEqual(als.getStore(), undefined, 'sync run does not leak');
});

Deno.test('async_hooks: a throw inside run restores the previous store', () => {
    const als = new AsyncLocalStorage<{ id: string }>();
    let caught = '';
    als.run({ id: 'keep' }, () => {
        try {
            als.run({ id: 'doomed' }, () => {
                throw new Error('boom');
            });
        } catch (error) {
            caught = (error as Error).message;
        }
        strictEqual(als.getStore()?.id, 'keep', 'store restored after an inner throw');
    });
    strictEqual(caught, 'boom');
    strictEqual(als.getStore(), undefined);
});

Deno.test('async_hooks: two AsyncLocalStorage instances do not observe each other', async () => {
    const a = new AsyncLocalStorage<{ id: string }>();
    const b = new AsyncLocalStorage<{ id: string }>();
    await a.run({ id: 'A' }, async () => {
        await b.run({ id: 'B' }, async () => {
            await sleep(1);
            strictEqual(a.getStore()?.id, 'A', 'outer instance visible inside inner run');
            strictEqual(b.getStore()?.id, 'B', 'inner instance visible');
        });
        strictEqual(b.getStore(), undefined, 'inner instance cleared after its run');
        strictEqual(a.getStore()?.id, 'A', 'outer instance still set');
    });
});
