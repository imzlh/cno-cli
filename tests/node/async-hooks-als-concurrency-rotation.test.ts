import { ok, strictEqual } from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as http from 'node:http';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * ===========================================================================
 * CRITICAL: AsyncLocalStorage does not isolate concurrent contexts.
 *
 * THESE TESTS FAIL TODAY AND WILL KEEP FAILING UNTIL THE C FIX LANDS. They are
 * `ignore: true` for that reason, exactly as the fs-errno and module-hooks suites
 * do for their own rebuild-dependent rows. Do NOT "fix" them by asserting cno's
 * current output -- the assertions below are node v24.18.0's behaviour, which is
 * correct by definition.
 *
 * WHAT IS WRONG
 * Under concurrency the stores are not merely leaked, they are ROTATED: each task
 * reads a *different* task's store after its first await. Measured, three tasks
 * with interleaved delays:
 *   node: A before=A after=A | B before=B after=B | C before=C after=C
 *   cno : A before=A after=B | B before=B after=C | C before=C after=A
 * And in the realistic shape -- a plain http.createServer handler, three
 * concurrent requests, each awaiting once before reading the store back where a
 * logger would:
 *   node: R1->R1, R2->R2, R3->R3   (correct attribution)
 *   cno : R1->R2, R2->R3, R3->R1   (3 of 3 misattributed)
 *
 * WHY IT MATTERS
 * Nothing throws. Every log line and trace span carries the wrong request's
 * identity: OpenTelemetry, pino request context, and every APM agent read ALS.
 * A multi-tenant authorization check that reads tenant-id from ALS reads another
 * tenant's id, so this is a security consequence and not only an observability
 * one. Sequential code passes -- all 30 single-task hops are byte-identical to
 * node -- which is why an ordinary suite never catches it.
 *
 * MECHANISM (measured, not inferred)
 * `cno/src/node/async_hooks/mod.ts` keeps ONE module-global `_currentStores`.
 * `run()` sets it; `_handleAsyncResult` restores it only when the returned promise
 * *settles*, so the last `run()` to start owns the global slot and settle order
 * decides who gets whose store. `await` does not route through the patched
 * `Promise.prototype.then` in EITHER engine (measured: 0 patched-then hits for
 * pending, resolved, non-promise and thenable in both node and cno), so the
 * TS-layer `then` patch has no hook on await-resumption.
 *
 * WHY THERE IS NO COMPLETE TS FIX
 * Restoring `_currentStores` synchronously when `run()` returns its promise was
 * tried and measured: it removes the top-level leak but regresses
 * `await-after-null`, `await-after-timeout`, `fs.promises-after` and
 * `nested-timeout` to `undefined`. The leak IS the propagation mechanism today.
 * Reverted byte-exact.
 *
 * THE FIX -- CORRECTED 2026-08-09, the earlier note here was wrong
 * This previously said a synchronous `engine.promiseHook` would be enough. It is
 * NOT, and the reason is measured, not reasoned. QuickJS's BEFORE/AFTER events
 * do not bracket a continuation the way V8's PromiseHook does. All four hook
 * call sites in circu.js/deps/quickjs/quickjs.c are:
 *   55949 RESOLVE -- fulfill_or_reject_promise, FULFILLED path only
 *   55997 BEFORE  -- js_promise_resolve_thenable_job, around JS_Call(then,...)
 *   56002 AFTER   -- same function
 *   56213 INIT    -- js_promise_new
 * BEFORE/AFTER fire ONLY on thenable adoption. Neither `promise_reaction_job`
 * (55880) nor `js_async_function_resume` (22137) -- the code that actually
 * resumes an await -- emits any event at all. Measured on the 08-08 binary with
 * two concurrent async tasks doing two awaits each: BEFORE fired 0 times, AFTER
 * 0 times. Positive control, forcing thenable adoption, fired BEFORE once, so
 * the zero is real and not a broken registration.
 * Two further reasons a hook cannot carry this: `await p` on a native promise
 * does not create a promise at all (js_promise_resolve returns js_dup(argv[0]),
 * 56341), so there is no INIT to hang a context off; and the await continuation
 * is registered via `perform_promise_then` directly rather than
 * `js_promise_then`, so `rt->parent_promise` is never pushed and there is no
 * parentage signal either.
 *
 * So the fix needs a resume-time seam that does not exist yet: either
 * BEFORE/AFTER emitted around `promise_reaction_job` and `async_func_resume`,
 * or a host slot on JSPromiseReactionData captured at `perform_promise_then`
 * time and installed when the reaction runs. Both are in deps/quickjs, which is
 * upstream. Note `promise_reaction_job` receives only the resolving funcs, the
 * handler, is_reject and the value -- NOT the promise -- so this is not a
 * one-line "add a hook call"; the reaction has to start carrying context.
 *
 * The C hook WAS made synchronous (mod_engine.c tjs__promise_hook, inline with a
 * reentrancy guard) because the enqueue was independently wrong -- it misreports
 * INIT's context and could deliver an event after its hook was removed. That is
 * necessary groundwork but NOT sufficient, so these three stay ignored.
 *
 * ACTION: drop `ignore: true` on all three tests once a resume-time seam lands.
 * ===========================================================================
 */

Deno.test({
    name: 'ALS CRITICAL: concurrent runs do not rotate stores (fails until C fix)',
    ignore: true,
    fn: async () => {
        const als = new AsyncLocalStorage<{ id: string }>();

        const task = (id: string, delay: number) =>
            als.run({ id }, async () => {
                const before = als.getStore()?.id;
                await sleep(delay); // another task runs here
                const after = als.getStore()?.id;
                return { id, before, after };
            });

        // Interleaved so A is still suspended while B and C start and finish.
        const results = await Promise.all([task('A', 40), task('B', 10), task('C', 25)]);

        for (const r of results) {
            strictEqual(r.before, r.id, `task ${r.id} must see its own store before awaiting`);
            strictEqual(r.after, r.id, `task ${r.id} must see its OWN store after awaiting, saw ${r.after}`);
        }
    },
});

Deno.test({
    name: 'ALS CRITICAL: concurrent HTTP requests attribute to the right store (fails until C fix)',
    ignore: true,
    fn: async () => {
        const als = new AsyncLocalStorage<{ reqId: string }>();
        const observed: Record<string, string | undefined> = {};

        const server = http.createServer((req, res) => {
            const reqId = String(req.headers['x-req-id']);
            als.run({ reqId }, async () => {
                // Stagger so the three handlers interleave across their awaits.
                await sleep(reqId === 'R1' ? 30 : reqId === 'R2' ? 10 : 20);
                // Where a logger or tracer would read the request context:
                observed[reqId] = als.getStore()?.reqId;
                res.end('ok');
            });
        });

        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const { port } = server.address() as { port: number };

        try {
            await Promise.all(['R1', 'R2', 'R3'].map((id) =>
                new Promise<void>((resolve, reject) => {
                    const req = http.request(
                        { host: '127.0.0.1', port, path: '/', headers: { 'x-req-id': id } },
                        (res) => {
                            res.on('data', () => {});
                            res.on('end', () => resolve());
                        },
                    );
                    req.on('error', reject);
                    req.end();
                })
            ));

            for (const id of ['R1', 'R2', 'R3']) {
                strictEqual(observed[id], id, `request ${id} logged store ${observed[id]} instead of its own`);
            }
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    },
});

Deno.test({
    name: 'ALS CRITICAL: many concurrent runs all keep their own store (fails until C fix)',
    ignore: true,
    fn: async () => {
        // Scale past three: with N tasks and pseudo-random delays, a rotating global
        // slot misattributes most of them. Asserts a relationship (every task sees
        // itself), never an exact interleaving, which is inherently variable.
        const als = new AsyncLocalStorage<{ id: number }>();
        const N = 12;
        const results = await Promise.all(
            Array.from({ length: N }, (_, i) =>
                als.run({ id: i }, async () => {
                    await sleep((i * 7) % 23 + 1);
                    await sleep((i * 5) % 11 + 1); // a second hop
                    return { id: i, seen: als.getStore()?.id };
                })
            ),
        );
        const wrong = results.filter((r) => r.seen !== r.id);
        strictEqual(
            wrong.length,
            0,
            `${wrong.length} of ${N} tasks saw another task's store: ` +
                wrong.map((r) => `${r.id}->${r.seen}`).join(', '),
        );
    },
});

/**
 * Companion guard, NOT skipped: the sequential guarantees that hold today. A future
 * concurrency fix must not regress these -- the measured trap is that the obvious
 * TS fix (synchronous restore) makes all four of these return `undefined`.
 */
Deno.test('ALS: sequential propagation still holds (regression guard for the eventual fix)', async () => {
    const als = new AsyncLocalStorage<{ id: string }>();
    await als.run({ id: 'S' }, async () => {
        await null;
        strictEqual(als.getStore()?.id, 'S', 'after await null');
        await sleep(1);
        strictEqual(als.getStore()?.id, 'S', 'after await a timer');
        await Promise.resolve();
        strictEqual(als.getStore()?.id, 'S', 'after await Promise.resolve');
        await new Promise<void>((r) => setTimeout(() => setTimeout(() => r(), 1), 1));
        strictEqual(als.getStore()?.id, 'S', 'after a nested timer');
    });
    strictEqual(als.getStore(), undefined, 'no leak after a sequential async run');
});

Deno.test('ALS: nested run inside an await restores the outer store', async () => {
    const als = new AsyncLocalStorage<{ id: string }>();
    const out = await als.run({ id: 'OUT' }, async () => {
        await sleep(5);
        const inner = await als.run({ id: 'IN' }, async () => {
            await sleep(5);
            return als.getStore()?.id;
        });
        return { inner, backToOuter: als.getStore()?.id };
    });
    strictEqual(out.inner, 'IN', 'inner run must see the inner store');
    ok(out.backToOuter === 'OUT', `outer store must be restored, saw ${out.backToOuter}`);
});
