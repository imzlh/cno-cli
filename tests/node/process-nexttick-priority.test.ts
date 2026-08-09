// Regression: process.nextTick must OUTRANK promise microtasks.
//
// Node keeps the nextTick queue OUTSIDE the promise job queue and drains it at
// the microtask checkpoint, so a nextTick callback runs before any pending
// promise continuation REGARDLESS of registration order. cno scheduled its drain
// with queueMicrotask(), which appends to the very FIFO the promise jobs use, so
// the drain only won when it happened to be registered first:
//
//   case                            node        cno (before)
//   nextTick registered first       nt>then     nt>then     (control, matched)
//   .then registered first          nt>then     then>nt     WRONG
//   queueMicrotask first            nt>qmt      qmt>nt      WRONG
//   microtask queues both           m1>m2>nt    m1>nt>m2    WRONG
//
// Every sequence below was MEASURED on node v24.18.0 (d:\tmp\ag-nexttick\
// measure.cjs), not derived from a model. Two of them are counter-intuitive and
// are the ones a plausible-looking fix gets wrong:
//
//  * m1>m2>nt, NOT m1>nt>m2. The ticks are NOT drained between individual
//    promise jobs. The whole microtask queue runs to exhaustion first -- which
//    is why a nextTick queued from inside a microtask lands after every
//    microtask that microtask itself queued. A per-job drain would give
//    m1>nt>m2 and pass a weaker test.
//  * nt1>nt2>mt. A nextTick queued from inside the drain runs in the SAME
//    drain, ahead of a microtask the first tick queued.
//
// The fix needs a checkpoint the JS layer cannot reach (no JS primitive
// outranks queueMicrotask), so it lives in C: tjs__execute_jobs() drains ticks
// before the pending-job loop and again after it (circu.js/src/vm.c), through
// engine.setNextTickDrain()/notifyNextTick() (circu.js/src/mod_engine.c).
//
// PENDING A REBUILD: circu.js/src/** is compiled into the binary. Against a
// binary that predates the hook, process/mod.ts feature-detects and falls back
// to queueMicrotask, so the CONTROL and the nextTick-internal cases pass while
// the three ordering discriminators fail. That is the expected pre-rebuild
// result, not a bad test.
import { strictEqual } from 'node:assert';
import * as nodeProcess from 'node:process';

// Each case runs in its own macrotask: a checkpoint from a previous case must
// not be able to bleed a stray tick into the next one's log.
const nextTurn = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

Deno.test('nextTick outranks a .then registered BEFORE it', async () => {
    const log: string[] = [];
    Promise.resolve().then(() => log.push('then'));
    process.nextTick(() => log.push('nt'));
    await nextTurn();
    strictEqual(log.join('>'), 'nt>then');
});

Deno.test('nextTick outranks a queueMicrotask registered BEFORE it', async () => {
    const log: string[] = [];
    queueMicrotask(() => log.push('qmt'));
    process.nextTick(() => log.push('nt'));
    await nextTurn();
    strictEqual(log.join('>'), 'nt>qmt');
});

Deno.test('nextTick registered first still runs first (control)', async () => {
    // Matches in both runtimes. Its job is to prove the harness sound: if this
    // one ever fails, the three above are not measuring what they claim to.
    const log: string[] = [];
    process.nextTick(() => log.push('nt'));
    Promise.resolve().then(() => log.push('then'));
    await nextTurn();
    strictEqual(log.join('>'), 'nt>then');
});

Deno.test('a microtask queueing a nextTick and a microtask yields m1>m2>nt', async () => {
    // The paradoxical one. `nt` is queued BEFORE `m2` yet runs AFTER it,
    // because the promise queue drains to exhaustion before ticks are
    // re-drained. Asserting m1>nt>m2 here would enshrine the bug's shape.
    const log: string[] = [];
    Promise.resolve().then(() => {
        log.push('m1');
        process.nextTick(() => log.push('nt'));
        Promise.resolve().then(() => log.push('m2'));
    });
    await nextTurn();
    strictEqual(log.join('>'), 'm1>m2>nt');
});

Deno.test('ticks are not drained between individual promise jobs', async () => {
    // Same rule, two INDEPENDENT top-level microtasks rather than a nested one.
    const log: string[] = [];
    Promise.resolve().then(() => {
        log.push('m1');
        process.nextTick(() => log.push('nt'));
    });
    Promise.resolve().then(() => log.push('m2'));
    await nextTurn();
    strictEqual(log.join('>'), 'm1>m2>nt');
});

Deno.test('a whole .then chain runs before a nextTick queued at its head', async () => {
    const log: string[] = [];
    Promise.resolve()
        .then(() => {
            log.push('a');
            process.nextTick(() => log.push('nt'));
        })
        .then(() => log.push('b'));
    await nextTurn();
    strictEqual(log.join('>'), 'a>b>nt');
});

Deno.test('nextTick precedes an await resumption queued before it', async () => {
    const log: string[] = [];
    void (async () => {
        log.push('sync');
        await null;
        log.push('after-await');
    })();
    process.nextTick(() => log.push('nt'));
    await nextTurn();
    strictEqual(log.join('>'), 'sync>nt>after-await');
});

Deno.test('a nextTick queued during the drain runs in the SAME drain', async () => {
    // nt2 is queued while nt1 is executing and must still beat the microtask
    // nt1 queued -- the drain loops until its own queue is empty.
    const log: string[] = [];
    process.nextTick(() => {
        log.push('nt1');
        process.nextTick(() => log.push('nt2'));
        Promise.resolve().then(() => log.push('mt'));
    });
    await nextTurn();
    strictEqual(log.join('>'), 'nt1>nt2>mt');
});

Deno.test('a pending microtask does not interleave into the tick drain', async () => {
    const log: string[] = [];
    Promise.resolve().then(() => log.push('mt'));
    process.nextTick(() => {
        log.push('nt1');
        process.nextTick(() => log.push('nt2'));
    });
    await nextTurn();
    strictEqual(log.join('>'), 'nt1>nt2>mt');
});

Deno.test('nextTick still precedes timers and setImmediate', async () => {
    // Requirement 3, asserted WITHOUT pinning the relative order of setImmediate
    // and setTimeout(0) to each other. node gives immediate>timeout; cno gives
    // timeout>immediate (both MEASURED). That is a SEPARATE, pre-existing defect
    // in the timer/check phase, not part of the nextTick ordering fix -- pinning
    // node's full sequence here would make this test permanently red for a
    // reason that has nothing to do with the checkpoint, and would silently
    // couple two unrelated fixes together.
    //
    // What this test owns: nextTick and the promise microtask must BOTH run
    // before EITHER timer-phase callback, and nt must precede mt.
    const log: string[] = [];
    setTimeout(() => log.push('timeout'), 0);
    setImmediate(() => log.push('immediate'));
    process.nextTick(() => log.push('nt'));
    Promise.resolve().then(() => log.push('mt'));
    await new Promise((r) => setTimeout(r, 20));

    strictEqual(log.length, 4, 'all four callbacks must run: ' + log.join('>'));
    strictEqual(log[0], 'nt', 'nextTick must run first, got: ' + log.join('>'));
    strictEqual(log[1], 'mt', 'microtask must precede the timer phase, got: ' + log.join('>'));
    // Positions 2 and 3 are immediate/timeout in some order -- deliberately unpinned.
    strictEqual(
        [log[2], log[3]].sort().join(','),
        'immediate,timeout',
        'the timer phase must contribute exactly these two: ' + log.join('>'),
    );
});

Deno.test('deep recursive nextTick drains to completion without yielding', async () => {
    // DEPTH only -- deliberately separated from ordering. cno already drains
    // 20 000 deep correctly; the pre-rebuild run confirmed the chain reaches
    // 1000 ("nt-done-1000"), so this property is intact TODAY and this
    // assertion guards it against the checkpoint rework.
    const log: string[] = [];
    let n = 0;
    const tick = (): void => {
        if (++n < 1000) process.nextTick(tick);
        else log.push('nt-done-' + String(n));
    };
    process.nextTick(tick);
    await new Promise((r) => setTimeout(r, 20));
    strictEqual(log.join('>'), 'nt-done-1000');
});

Deno.test('a recursive nextTick chain finishes before a pending microtask', async () => {
    // ORDERING, the half that is currently WRONG. Pre-rebuild cno yields
    // 'mt-at-0>nt-done-1000': the microtask registered first wins the FIFO slot
    // and runs before the chain even starts. node drains the whole tick chain
    // first, so the microtask observes n === 1000.
    const log: string[] = [];
    let n = 0;
    Promise.resolve().then(() => log.push('mt-at-' + String(n)));
    const tick = (): void => {
        if (++n < 1000) process.nextTick(tick);
        else log.push('nt-done-' + String(n));
    };
    process.nextTick(tick);
    await new Promise((r) => setTimeout(r, 20));
    strictEqual(log.join('>'), 'nt-done-1000>mt-at-1000');
});

Deno.test('a throwing nextTick reports and the drain continues', async () => {
    // Node: n1 throws, the 'uncaughtException' listener fires, n3 STILL runs,
    // and the queued microtask runs after the drain -- n1>uncaught>n3>mt, rc=0.
    // cno already matched this; the checkpoint move must not change it.
    const log: string[] = [];
    const onErr = (e: Error): void => { log.push('uncaught:' + e.message); };
    process.on('uncaughtException', onErr);
    try {
        process.nextTick(() => {
            log.push('n1');
            throw new Error('boom');
        });
        process.nextTick(() => log.push('n3'));
        Promise.resolve().then(() => log.push('mt'));
        await new Promise((r) => setTimeout(r, 20));
        strictEqual(log.join('>'), 'n1>uncaught:boom>n3>mt');
    } finally {
        process.off('uncaughtException', onErr);
    }
});

Deno.test('ordering is identical through node:process and the global facade', async () => {
    // Requirement 4 is about ORDERING parity, which is what this asserts.
    //
    // It deliberately does NOT assert `nodeProcess.nextTick === process.nextTick`.
    // That holds in node v24.18 but is FALSE in cno (MEASURED), because two
    // copies of process/mod.ts are live at once and the namespace import reaches
    // a different one than the default import. That identity divergence is a
    // separate, pre-existing parity gap -- but it is exactly why this test
    // matters: the two facades must feed ONE queue, so a tick registered through
    // either runs in registration order rather than in per-copy batches. That is
    // what the Symbol.for() shared queue in process/mod.ts guarantees, and what
    // would silently break if a second copy ever evicted the first copy's drain.
    const log: string[] = [];
    Promise.resolve().then(() => log.push('then'));
    nodeProcess.nextTick(() => log.push('nt-mod'));
    process.nextTick(() => log.push('nt-global'));
    await nextTurn();
    strictEqual(log.join('>'), 'nt-mod>nt-global>then');
});

Deno.test('both facades share ONE queue, so no callback is orphaned', async () => {
    // The regression guard for the single-slot trap: engine.setNextTickDrain()
    // frees the previous drain, so if each module copy registered its own, the
    // second would orphan the first copy's queue and its callbacks would NEVER
    // run -- silently, with no error and no crash. Counting is the assertion.
    const log: string[] = [];
    nodeProcess.nextTick(() => log.push('a'));
    process.nextTick(() => log.push('b'));
    nodeProcess.nextTick(() => log.push('c'));
    await nextTurn();
    strictEqual(log.length, 3, 'a callback was orphaned: ' + log.join('>'));
    strictEqual(log.join('>'), 'a>b>c');
});

Deno.test('nextTick forwards its extra arguments', async () => {
    const log: string[] = [];
    process.nextTick((a: number, b: number) => log.push('args:' + String(a) + ',' + String(b)), 1, 2);
    await nextTurn();
    strictEqual(log.join('>'), 'args:1,2');
});
