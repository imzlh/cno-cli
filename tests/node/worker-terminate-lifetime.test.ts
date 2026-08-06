import { ok, strictEqual } from 'node:assert';
import { Worker } from 'node:worker_threads';

// Regression coverage for worker termination LIFETIME, not payload semantics.
//
// The defect these pin: `Worker.terminate()` used to call the native
// stop-and-JOIN (`tjs__worker_stop_and_join` -> `uv_thread_join`), and that join
// runs on the PARENT's event loop thread. A worker that cannot reach the stop
// async — spinning in JS, parked in an untimed `Atomics.wait`, blocked in a
// syscall — never exits, so the join never returned and the whole parent
// process wedged. Measured before the fix: `terminate()` never even returned to
// JS, no timer on the parent ever fired again, and SIGKILL was required. Real
// node kills such a worker in ~15 ms.
//
// The fix asks for the stop asynchronously (native `stop()`, no join) and defers
// the join until pipe EOF proves the worker runtime is gone.
//
// Workers here park in `Atomics.wait` rather than spinning, so these tests are
// unresponsive-but-cheap and do not burn a core on a shared machine.

/** A worker that parks forever and can never observe the stop request. */
function spawnParkedWorker(): { worker: Worker; ready: Promise<boolean> } {
    const sab = new SharedArrayBuffer(8);
    const worker = new Worker(
        `const { parentPort, workerData } = require('node:worker_threads');
         parentPort.postMessage('parked');
         Atomics.wait(new Int32Array(workerData.sab), 0, 0);`,
        { eval: true, workerData: { sab } },
    );
    const ready = new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
        worker.on('message', () => done(true));
        worker.on('error', () => done(false));
        setTimeout(() => done(false), 8000);
    });
    return { worker, ready };
}

Deno.test({
    name: 'worker_threads: terminate() on an unresponsive worker does not block the parent loop',
    timeout: 20000,
}, async () => {
    const { worker, ready } = spawnParkedWorker();
    ok(await ready, 'worker must reach its parked state before we terminate it');

    // A heartbeat proves the parent's event loop still runs. Before the fix the
    // parent thread sat inside uv_thread_join and this never ticked again.
    let beats = 0;
    const heartbeat = setInterval(() => { beats++; }, 20);
    try {
        const exitCode = await worker.terminate();
        strictEqual(exitCode, 1, 'terminate() resolves with the killed-worker exit code');
        await new Promise((resolve) => setTimeout(resolve, 250));
        ok(beats > 0, `parent event loop must keep running after terminate(); beats=${beats}`);
    } finally {
        clearInterval(heartbeat);
    }
});

Deno.test({
    name: 'worker_threads: terminate() on an unresponsive worker still emits exit and is idempotent',
    timeout: 20000,
}, async () => {
    const { worker, ready } = spawnParkedWorker();
    ok(await ready, 'worker must reach its parked state before we terminate it');

    const exitCodes: number[] = [];
    worker.on('exit', (code: number) => exitCodes.push(code));

    const first = await worker.terminate();
    const second = await worker.terminate();
    strictEqual(first, 1, 'first terminate() resolves with 1');
    strictEqual(second, 1, 'second terminate() resolves with the same code, not a hang');

    await new Promise((resolve) => setTimeout(resolve, 150));
    strictEqual(exitCodes.length, 1, `exit must fire exactly once, got ${JSON.stringify(exitCodes)}`);
});

Deno.test({
    name: 'worker_threads: a responsive worker still terminates and round-trips first',
    timeout: 20000,
}, async () => {
    // Guards the other direction: the fix must not break the ordinary path,
    // where the worker is alive and answering when terminate() lands.
    const worker = new Worker(
        `const { parentPort } = require('node:worker_threads');
         parentPort.on('message', (m) => parentPort.postMessage('echo:' + m));`,
        { eval: true },
    );
    const reply = await new Promise<string>((resolve) => {
        let settled = false;
        const done = (v: string) => { if (!settled) { settled = true; resolve(v); } };
        worker.on('message', (m: unknown) => done(String(m)));
        worker.on('error', (e: Error) => done('error:' + e.message));
        setTimeout(() => done('NO_REPLY'), 10000);
        worker.postMessage('ping');
    });
    strictEqual(reply, 'echo:ping', 'responsive worker must answer before termination');
    strictEqual(await worker.terminate(), 1, 'terminate() resolves for a responsive worker too');
});

// --- natural PROCESS EXIT past a wedged worker ------------------------------
//
// The terminate() fix above kept the parent's loop responsive, but it did not
// make the process able to EXIT. Native teardown is unconditional:
// TJS_FreeRuntime (circu.js/src/vm.c:492-506) walks every entry of qrt->workers
// and calls tjs__worker_stop_and_join(), whose uv_thread_join
// (circu.js/src/mod_worker.c:671) runs on the main thread. A wedged worker never
// leaves that list -- the only unlink is list_del() in tjs_worker_finalizer
// (mod_worker.c:754), which is GC-driven and cannot run while w->self_obj still
// self-references the wrapper, and that reference is dropped only by
// worker_release_self() AFTER a successful join. So the join is reached and
// blocks forever.
//
// MEASURED before the mitigation, all with a hard 8s timeout:
//   terminate() then fall off the end : cno rc=124 (hang) | node rc=0  436ms
//   wedged worker + unref()           : cno rc=124 (hang) | node rc=0  413ms
//   wedged worker left REF'd          : cno rc=124        | node rc=124  <- parity
// In every hanging case the script printed its last line first, so all JS had
// completed and the hang was purely in native teardown.
//
// The mitigation is JS-side and lives in worker_threads/mod.ts: workers that the
// process must not wait for (join pending, or unref'd) are tracked, and an
// 'exit' listener calls os.exit() -- C exit() (circu.js/src/mod_os.c:89), which
// never returns to TJS_Run and so never reaches the join.
//
// These tests MUST use a subprocess with a hard timeout: the failure mode is a
// process that never exits, which an in-process test cannot observe.

const NATURAL_EXIT_TIMEOUT_MS = 12000;

async function runScript(source: string): Promise<{ code: number; stdout: string; timedOut: boolean }> {
    const dir = Deno.makeTempDirSync({ prefix: 'cno-wexit-' });
    const file = `${dir}/m.mjs`;
    Deno.writeTextFileSync(file, source);
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const child = new Deno.Command(execPath, {
        args: ['run', file],
        stdout: 'piped',
        stderr: 'piped',
        env: { CTS_SILENT: 'true' },
    }).spawn();

    let timedOut = false;
    const killer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* already gone */ }
    }, NATURAL_EXIT_TIMEOUT_MS);

    let output;
    try {
        output = await child.output();
    } finally {
        clearTimeout(killer);
    }
    return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        timedOut,
    };
}

/** Wedge shape used below: parks forever, so it can never observe the stop. */
const PARKED_WORKER = `
    const sab = new SharedArrayBuffer(8);
    const w = new Worker(
        \`const { workerData } = require('node:worker_threads');
          Atomics.wait(new Int32Array(workerData.sab), 0, 0);\`,
        { eval: true, workerData: { sab } },
    );
`;

Deno.test({
    name: 'worker_threads: process exits after terminate() on a wedged worker',
    timeout: 40000,
}, async () => {
    const r = await runScript(`
        import { Worker } from 'node:worker_threads';
        ${PARKED_WORKER}
        setTimeout(async () => {
            await w.terminate();
            console.log('REACHED END');
        }, 300);
    `);
    ok(!r.timedOut, 'process must exit on its own, not be killed by the test timeout');
    ok(r.stdout.includes('REACHED END'),
        `script must run to completion; stdout: ${JSON.stringify(r.stdout)}`);
    strictEqual(r.code, 0, `expected a clean exit, got ${r.code}`);
});

Deno.test({
    name: 'worker_threads: process exits with a wedged worker that was unref()d',
    timeout: 40000,
}, async () => {
    const r = await runScript(`
        import { Worker } from 'node:worker_threads';
        ${PARKED_WORKER}
        w.unref();
        setTimeout(() => { console.log('REACHED END'); }, 300);
    `);
    ok(!r.timedOut, 'an unref\'d worker must never hold the process open');
    ok(r.stdout.includes('REACHED END'),
        `script must run to completion; stdout: ${JSON.stringify(r.stdout)}`);
    strictEqual(r.code, 0, `expected a clean exit, got ${r.code}`);
});

Deno.test({
    name: 'worker_threads: the forced exit preserves process.exitCode',
    timeout: 40000,
}, async () => {
    // The mitigation must not change the observable status -- otherwise it
    // turns a failing run into a passing one, which is worse than the hang.
    const r = await runScript(`
        import { Worker } from 'node:worker_threads';
        ${PARKED_WORKER}
        process.exitCode = 7;
        setTimeout(async () => {
            await w.terminate();
            console.log('REACHED END');
        }, 300);
    `);
    ok(!r.timedOut, 'process must exit on its own');
    ok(r.stdout.includes('REACHED END'), `stdout: ${JSON.stringify(r.stdout)}`);
    strictEqual(r.code, 7, `exit code must survive the forced exit, got ${r.code}`);
});

Deno.test({
    name: 'worker_threads: a responsive worker still gets full teardown, not a forced exit',
    timeout: 40000,
}, async () => {
    // The other direction: when nothing is abandoned the hook must not fire, so
    // an ordinary run keeps its normal teardown path.
    const r = await runScript(`
        import { Worker } from 'node:worker_threads';
        const w = new Worker(
            \`require('node:worker_threads').parentPort.postMessage('hi')\`,
            { eval: true },
        );
        w.on('message', (m) => console.log('MSG ' + m));
        w.on('exit', (c) => console.log('EXIT ' + c + '\\nREACHED END'));
    `);
    ok(!r.timedOut, 'ordinary worker run must exit promptly');
    ok(r.stdout.includes('MSG hi'), `worker must round-trip; stdout: ${JSON.stringify(r.stdout)}`);
    ok(r.stdout.includes('EXIT 0'), `worker must report exit 0; stdout: ${JSON.stringify(r.stdout)}`);
    ok(r.stdout.includes('REACHED END'), `stdout: ${JSON.stringify(r.stdout)}`);
    strictEqual(r.code, 0, `expected a clean exit, got ${r.code}`);
});
