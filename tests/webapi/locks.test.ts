import { strictEqual, ok, rejects } from 'node:assert';
import process from 'node:process';

// ============================================================================
// Web API — Lock API (navigator.locks)
// ============================================================================

Deno.test('webapi: navigator.locks exists', () => {
    ok(typeof navigator === 'object');
    ok(typeof navigator.locks === 'object');
    ok(typeof navigator.locks.request === 'function');
    ok(typeof navigator.locks.query === 'function');
});

Deno.test('webapi: locks.request exclusive', async () => {
    let acquired = false;
    await navigator.locks.request('test-lock-1', (lock) => {
        acquired = lock !== null;
        ok(lock !== null);
        strictEqual(lock.name, 'test-lock-1');
        strictEqual(lock.mode, 'exclusive');
    });
    ok(acquired);
});

Deno.test('webapi: locks.request shared', async () => {
    await navigator.locks.request('test-lock-2', { mode: 'shared' }, (lock) => {
        ok(lock !== null);
        strictEqual(lock.mode, 'shared');
    });
});

Deno.test('webapi: locks.request returns value from callback', async () => {
    const result = await navigator.locks.request('test-lock-3', () => {
        return 42;
    });
    strictEqual(result, 42);
});

Deno.test('webapi: locks.request rejects on callback error', async () => {
    try {
        await navigator.locks.request('test-lock-4', () => {
            throw new Error('lock error');
        });
        ok(false, 'should have thrown');
    } catch (e: any) {
        ok(e.message.includes('lock error'));
    }
});

Deno.test('webapi: locks.request with an already-aborted signal rejects and never runs the callback', async () => {
    // abort() happens strictly BEFORE the request, so there is no timing race
    // and the outcome is deterministic. OBSERVED 2026-08-03:
    //   cno   REJECTED AbortError "This operation was aborted"  callbackRan=false
    //   deno  REJECTED AbortError "The signal has been aborted" callbackRan=false
    //   node  REJECTED AbortError "This operation was aborted"  callbackRan=false
    // The previous shape awaited the request and then asserted ok(true) on the
    // resolve path, commented "may or may not throw depending on timing". That
    // made the test unfalsifiable: it passed whether the signal was honoured or
    // ignored outright. Only the message text varies between runtimes, so match
    // on the name, not the message.
    const ac = new AbortController();
    ac.abort();
    let callbackRan = false;
    await rejects(
        () => navigator.locks.request('test-lock-5', { signal: ac.signal }, () => { callbackRan = true; }),
        (e: Error) => e.name === 'AbortError',
        'an already-aborted signal must reject the request with AbortError',
    );
    strictEqual(callbackRan, false, 'the callback must never run for an aborted request');
});

Deno.test('webapi: locks.query returns object', async () => {
    const query = await navigator.locks.query();
    ok(typeof query === 'object');
    ok(Array.isArray(query.held));
    ok(Array.isArray(query.pending));
});

// ---------------------------------------------------------------------------
// Rejection hygiene and release-on-every-exit-path.
//
// `ifAvailable` gives a non-blocking peek at whether a name is currently held:
// the callback receives null when the lock is unavailable, and a real Lock when
// it is free. A lock that is never released is a deadlock, so every exit path
// below asserts the lock is FREE afterwards.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isHeld(name: string): Promise<boolean> {
    return navigator.locks.request(name, { ifAvailable: true }, (lock) => lock === null) as Promise<boolean>;
}

/** Counts unhandled rejections WITHOUT cancelling them. */
async function countLeaks(body: () => Promise<void>): Promise<number> {
    let leaks = 0;
    const onLeak = () => { leaks++; };
    // A handler that calls preventDefault() suppresses the duplicate report and
    // cannot observe the leak, so this counts and does not cancel. The
    // process-level listener is what keeps a leak from being fatal.
    process.on('unhandledRejection', onLeak);
    try {
        await body();
        await sleep(100); // the unhandled-rejection probe runs in a later job
    } finally {
        process.removeListener('unhandledRejection', onLeak);
    }
    return leaks;
}

Deno.test('webapi: a throwing lock callback rejects the caller WITHOUT leaking an unhandled rejection', async () => {
    // REGRESSION: navigator.locks.request() double-reported a throwing callback.
    // The caller's await rejected correctly *and* the same error escaped to both
    // `unhandledrejection` and process.on('unhandledRejection').
    //
    // Root cause: `request()` is async and `return`ed a promise that
    // `processQueue()` had ALREADY rejected synchronously inside its own
    // executor. Adopting an already-rejected promise via a bare `return` only
    // attaches the reaction in a later job, by which time the runtime's
    // unhandled-rejection probe (circu.js/src/vm.c:283) has already run and
    // seen no handler. `return await` attaches it in the same turn.
    //
    // OBSERVED 2026-08-03: cno leaked 1, deno 2.9.3 leaked 0; both rejected the
    // caller with the original error. Both halves are asserted here: silencing
    // the report by swallowing the error would be a worse bug than the leak.
    let caught: Error | undefined;
    const leaks = await countLeaks(async () => {
        try {
            await navigator.locks.request('test-lock-leak', () => { throw new Error('leak probe'); });
        } catch (e) {
            caught = e as Error;
        }
    });
    strictEqual(caught?.message, 'leak probe', 'the caller must still reject with the original error');
    strictEqual(leaks, 0, 'a rejection the caller handles must not be reported as unhandled');
    strictEqual(await isHeld('test-lock-leak'), false, 'the lock must be released after the callback throws');
});

Deno.test('webapi: locks are released on every exit path', async () => {
    // normal return
    strictEqual(await navigator.locks.request('test-rel-return', () => 'v'), 'v');
    strictEqual(await isHeld('test-rel-return'), false, 'released after a normal return');

    // synchronous throw
    await rejects(() => navigator.locks.request('test-rel-throw', () => { throw new Error('x'); }));
    strictEqual(await isHeld('test-rel-throw'), false, 'released after a sync throw');

    // async callback that rejects
    await rejects(() => navigator.locks.request('test-rel-async', async () => { await sleep(5); throw new Error('y'); }));
    strictEqual(await isHeld('test-rel-async'), false, 'released after an async rejection');

    // abort while queued behind a holder: the holder still finishes and releases
    let releaseHolder!: () => void;
    const gate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = navigator.locks.request('test-rel-abort', async () => { await gate; return 'h'; });
    await sleep(10);
    const ac = new AbortController();
    let queuedRan = false;
    const queued = navigator.locks.request('test-rel-abort', { signal: ac.signal }, () => { queuedRan = true; });
    const queuedOutcome = queued.then(() => 'resolved', (e: Error) => e.name);
    await sleep(10);
    ac.abort();
    strictEqual(await queuedOutcome, 'AbortError', 'an aborted queued request rejects with AbortError');
    strictEqual(queuedRan, false, 'an aborted queued request never runs its callback');
    releaseHolder();
    strictEqual(await holder, 'h', 'aborting a queued request must not disturb the holder');
    strictEqual(await isHeld('test-rel-abort'), false, 'released after an abort');
});

Deno.test('webapi: aborting after the lock is granted is ignored', async () => {
    // Per spec a signal only aborts a request that is still QUEUED; once the
    // lock is held the callback's result stands. OBSERVED 2026-08-03: deno
    // 2.9.3 resolves with 'cb-done'; cno rejected with AbortError AND leaked an
    // unhandled rejection, because that rejection also landed inside the
    // executor and hit the same adoption path.
    const ac = new AbortController();
    let cbFinished = false;
    const leaks = await countLeaks(async () => {
        const value = await navigator.locks.request('test-lock-abort-late', { signal: ac.signal }, async () => {
            ac.abort();
            await sleep(20);
            cbFinished = true;
            return 'cb-done';
        });
        strictEqual(value, 'cb-done', 'abort after the grant must not pre-empt the callback result');
    });
    ok(cbFinished, 'the callback must run to completion');
    strictEqual(leaks, 0, 'an ignored abort must not leak a rejection');
    strictEqual(await isHeld('test-lock-abort-late'), false, 'the lock must be released');
});

Deno.test('webapi: steal breaks the held lock, jumps the queue, and releases', async () => {
    // OBSERVED deno 2.9.3: the victim rejects with AbortError 'The lock was
    // broken', its callback still runs to completion, and the thief is granted
    // ahead of an already-queued waiter. cno previously ignored `steal`
    // entirely: the thief simply queued and the victim resolved normally.
    const order: string[] = [];
    const victim = navigator.locks.request('test-lock-steal', async () => { await sleep(60); return 'v'; })
        .then((v) => 'res:' + v, (e: Error) => 'rej:' + e.name);
    await sleep(15);
    const waiter = navigator.locks.request('test-lock-steal', () => { order.push('waiter'); }).catch(() => {});
    await sleep(10);

    let thiefRunning = false;
    const thief = await navigator.locks.request('test-lock-steal', { steal: true }, (lock) => {
        thiefRunning = true;
        order.push('thief');
        strictEqual(lock?.mode, 'exclusive');
        return 'stolen';
    });
    strictEqual(thief, 'stolen');
    ok(thiefRunning, 'steal must grant the lock immediately, not queue behind the holder');
    strictEqual(await victim, 'rej:AbortError', 'the stolen holder must reject with AbortError');

    await waiter;
    await sleep(80); // let the victim's callback finish settling
    strictEqual(order.join(','), 'thief,waiter', 'the thief must jump ahead of the queued waiter');
    strictEqual(await isHeld('test-lock-steal'), false, 'the lock must be free once the thief returns');
});

Deno.test('webapi: steal rejects unsupported option combinations', async () => {
    // OBSERVED deno 2.9.3: both are NotSupportedError. (The ifAvailable+steal
    // pair stays a TypeError -- tests/webapi/locks-broadcast.test.ts pins it.)
    await rejects(
        () => navigator.locks.request('test-lock-steal-shared', { steal: true, mode: 'shared' }, () => 1),
        (e: Error) => e.name === 'NotSupportedError',
    );
    await rejects(
        () => navigator.locks.request('test-lock-steal-signal', { steal: true, signal: new AbortController().signal }, () => 1),
        (e: Error) => e.name === 'NotSupportedError',
    );
});
