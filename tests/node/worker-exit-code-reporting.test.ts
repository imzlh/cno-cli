import { strictEqual } from 'node:assert';
import { Worker } from 'node:worker_threads';

// Regression coverage for the EXIT CODE a worker reports to its parent.
//
// The defect these pin: a worker's exit status reached the parent by exactly one
// route, the process 'exit' listener installed by createParentPort() in
// cno/src/node/worker_threads/mod.ts. That function only runs when the WORKER
// ITSELF imports node:worker_threads, so a worker that never imported it
// installed no reporter at all; the parent saw only pipe EOF and reported 0.
//
// MEASURED 2026-08-09 against node v24.18.0, eval workers, parent reading the
// 'exit' event:
//   `require('node:process').exit(42)`                    node 42, cno 0  BUG
//   `require('node:worker_threads'); process.exit(42)`     node 42, cno 42 ok
// Adding the worker_threads import to the failing script made it report 42,
// which is what isolated "no reporter installed" from "code lost in transit".
// The practical consequence is the dangerous direction: `process.exit(1)` to
// signal failure read as a clean success to any pool that checks the code.
//
// The fix installs the same reporter from node/process/mod.ts
// (installWorkerExitReporter), armed next to ensureEventBridge() because it is
// that bridge which turns the native EV_EXIT into a processEE 'exit'. It is a
// listener rather than a line inside the TS exit(): a worker does not call that
// function at all — `require('node:process').exit` stringifies as
// `function exit() { [native code] }` — so a call placed there never ran.
//
// NEGATIVE CONTROL: commenting out the installWorkerExitReporter() call in
// cno/src/node/process/mod.ts, re-running `cno setup`, turns the three
// "no worker_threads import" cases below from 42/1/7 back into 0 while the
// worker_threads-importing case keeps passing — which is exactly why that case
// is here as a discriminator rather than as duplicate coverage.

/** Runs an eval worker and resolves the code its 'exit' event carries. */
function exitCodeOf(source: string, timeoutMs = 10000): Promise<number | 'timeout'> {
    const worker = new Worker(source, { eval: true });
    return new Promise<number | 'timeout'>((resolve) => {
        let settled = false;
        const done = (v: number | 'timeout') => {
            if (settled) return;
            settled = true;
            resolve(v);
        };
        // A worker that dies before exiting must not hang the suite.
        worker.on('error', () => {});
        worker.on('exit', (code: number) => done(code));
        const timer = setTimeout(() => {
            void worker.terminate();
            done('timeout');
        }, timeoutMs);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
            (timer as { unref: () => void }).unref();
        }
    });
}

Deno.test({
    name: 'worker_threads: process.exit(code) reports the code without importing worker_threads',
    timeout: 20000,
}, async () => {
    // The exact shape that regressed: nothing but a process.exit.
    strictEqual(await exitCodeOf(`require('node:process').exit(42)`), 42);
});

Deno.test({
    name: 'worker_threads: a nonzero exit code is not flattened to a success',
    timeout: 20000,
}, async () => {
    // The direction that actually costs a caller something: failure read as
    // success. Asserted separately from 42 so a "returns some nonzero" bug
    // cannot pass by accident.
    const code = await exitCodeOf(`require('node:process').exit(1)`);
    strictEqual(code, 1);
});

Deno.test({
    name: 'worker_threads: exit code survives when the worker imports worker_threads too',
    timeout: 20000,
}, async () => {
    // Discriminator, not duplicate coverage: this path already worked through
    // createParentPort()'s own reporter, so it must keep working now that a
    // second reporter also fires. Both post an exit record and the parent
    // receives two; Worker._finish() returns early once _exited is set, so the
    // first wins. This test is what would catch that guard being removed.
    strictEqual(await exitCodeOf(`require('node:worker_threads'); require('node:process').exit(7)`), 7);
});

Deno.test({
    name: 'worker_threads: a worker that ends normally still reports 0',
    timeout: 20000,
}, async () => {
    // Guards the other direction: the new reporter must not invent a nonzero
    // code for a clean worker.
    strictEqual(await exitCodeOf(`require('node:process');`), 0);
});
