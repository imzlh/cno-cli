/**
 * Native engine-event -> `process` bridges: 'exit' and 'uncaughtException'.
 *
 * Neither bridge existed. `processEE.emit('exit')` appeared in exactly one
 * place, inside `process.exit()` (cno/src/node/process/mod.ts), so every other
 * termination path fired nothing; and `handleUncaughtException()` was reached
 * only from the nextTick drain, so a throw from a timer or an I/O callback
 * produced no 'uncaughtException' at all.
 *
 * WHAT THESE TESTS CAN AND CANNOT PROVE
 *
 * `cno/src/node/**` is refreshed by `cno setup`, so the bridge under test is
 * current source. The multiplexer it registers with, however, lives in cts and
 * is BAKED into cno.exe — and the staged binary predates it, so at runtime the
 * `Symbol.for('cno.engine.eventMux.v1')` slot does not exist (OBSERVED: a probe
 * script reports `mux slot present: false`). The bridge then deliberately stays
 * off the bus rather than calling engine.onEvent() and displacing whatever
 * receiver *is* installed, which is the very defect being fixed.
 *
 * So these tests import the mux from DISK, which creates the slot, and then
 * register a process listener — the retry hook installs the bridge at that
 * point. That verifies the bridge's wiring, its dispatch, and both directions of
 * its return-value polarity. It does NOT verify the native path from a real
 * EV_EXIT / EV_JOB_EXCEPTION, which needs a rebuild.
 *
 * NAMESPACE IMPORT, NOT THE DEFAULT EXPORT — this is load-bearing.
 * process/mod.ts publishes its default object on a
 * `Symbol.for('cno.node.process.default')` singleton and reuses whatever is
 * already there. Under `cno test` the harness bootstraps the BAKED copy first,
 * so the default export is the baked object and OBSERVED
 * `process.on !== procNS.on`: the default's `on` belongs to the stale copy, has
 * no retry hook, and delegates to a different EventEmitter instance than the one
 * this bridge emits on. The namespace import reaches the refreshed module, whose
 * receiver and emitter are the same instance. After a rebuild there is only one
 * copy and both forms coincide.
 */
import { ok, strictEqual } from 'node:assert';
import * as process from 'node:process';
import {
    EV,
    getEventMux,
    installEventReceiver,
    installNodeProcessRejectionBridge,
    PRIORITY_DIAGNOSTICS,
    PRIORITY_WEBAPI,
    WEBAPI_ROLE,
    type EventContext,
} from '../../cts/src/runtime/event-mux.ts';

/**
 * Registering a listener runs the bridge's retry hook. The eager install at
 * module-evaluation time was a no-op (no mux existed yet), so this is the path
 * that actually attaches it — the same path a user's `process.on('exit')` takes.
 */
function armBridge(): void {
    // getEventMux() FIRST. A bare import of the mux module does not create the
    // registry — nothing has called getEventMux() yet, so the Symbol slot is
    // still empty and the retry below would find no bus and (correctly) decline
    // to install rather than displace. This ordering is exactly the real-world
    // hazard the retry hook exists for.
    getEventMux();
    const noop = () => {};
    process.on('exit', noop);
    process.off('exit', noop);
}

function bridgeInstalled(): boolean {
    return getEventMux().roles().includes('node-process');
}

/* ------------------------------------------------------------------ *
 * Why every in-process JOB_EXCEPTION dispatch needs a local webapi arm
 * ------------------------------------------------------------------ *
 *
 * The BAKED webapi receiver (cno/src/webapi/index.ts:189-206) turns every
 * EV_JOB_EXCEPTION into an ErrorEvent and dispatches it on `globalEvent` — which
 * IS `globalThis.dispatchEvent` (webapi/index.ts:63-66, the same EventTarget).
 * `cno test`'s own harness registers `onSuiteError` on `globalThis` 'error'
 * (cno/src/deno/index.ts:743). So an in-process dispatch lands in the harness:
 * it latches `suiteUncaught` (index.ts:737-740), overrides the already-passing
 * result to `fail` (index.ts:828-831) and sets `stopTests` (index.ts:853-856),
 * which ABORTS THE REST OF THE FILE.
 *
 * OBSERVED, this file on the 2026-08-03 00:20 binary: 2 ok, then
 * `fail bridge: EV_JOB_EXCEPTION emits uncaughtException with the error
 * Error: from-a-timer`, then `FAIL` — with the remaining 15 tests never run.
 * The test body's own assertions PASSED; the harness rewrote the verdict.
 *
 * This is NOT a runtime bug and nothing here works around one. Until the
 * 2026-08-03 binary, webapi's JOB_EXCEPTION arm called `preventDefault()`
 * unconditionally, so `onSuiteError`'s deferred `ev.defaultPrevented` check bailed
 * and the suite survived. Removing that pre-cancel is the CORRECT fix (it is what
 * made `ctx.handled` mean "user code cancelled" again, and what restored the
 * diagnostic and rc=1 — see the block above `withWebapiArm`). It merely exposed
 * that these tests were relying on it.
 *
 * WHY NOT the other two obvious repairs:
 *
 *  - A `try`/`catch` around the dispatch does nothing: the error never propagates
 *    out of `dispatch()` (the mux contains receiver throws, event-mux.ts:190).
 *    There is nothing to catch — the harness is informed out-of-band.
 *
 *  - Installing a `process.on('uncaughtException')` handler does not help either,
 *    and this file already proves it: the failing test installs one at :106. The
 *    node-process bridge sets `ctx.handled` at PRIORITY_NODE_PROCESS (50), but
 *    webapi has ALREADY dispatched the global ErrorEvent at PRIORITY_WEBAPI (100).
 *    `ctx.handled` and `ev.defaultPrevented` are different objects; setting the
 *    former cannot retro-cancel an event that has already been delivered.
 *
 * And a global 'error' listener calling `preventDefault()` would silence the
 * harness but POISON the property under test: webapi sets `ctx.handled = true`
 * from `ev.defaultPrevented` (webapi/index.ts:209-218). OBSERVED with a probe:
 * a global canceller yields `ctx.handled === true` even with NO
 * 'uncaughtException' handler — which would invert the negative controls in
 * 'silences the runtime diagnostic' and 'the bridge abstains'.
 *
 * So the arm below reproduces webapi's JOB_EXCEPTION behaviour FAITHFULLY onto a
 * LOCAL EventTarget: the whole receiver chain still runs (node-process bridge and
 * cts-diagnostics included — OBSERVED, the "unhandled job exception" warning
 * still prints), `ctx.handled` is still driven only by a real cancel, and only the
 * hop into the harness's listener is removed. Same-role install REPLACES rather
 * than stacks (event-mux.ts:140-141), which is what displaces the baked receiver.
 */
const webapiLocalTarget = new EventTarget();

/**
 * (Re)install the local-target webapi stand-in. Idempotent: the install is
 * role-keyed, so repeat calls replace rather than stack.
 *
 * Called per-test rather than once at module scope on purpose — `cno test
 * --filter` can run any single test alone, and each JOB_EXCEPTION test must be
 * self-sufficient rather than depending on an earlier test having armed it.
 *
 * Registering under WEBAPI_ROLE (not a private role) is also what keeps
 * `installWebApiCompatBridge`'s receiver dormant: it stands down while
 * `has(WEBAPI_ROLE)` is true (event-mux.ts:344). Simply *removing* the baked
 * receiver would wake the compat bridge instead.
 */
function armWebapiLocal(): void {
    installEventReceiver(WEBAPI_ROLE, (name, data, ctx) => {
        if (name !== EV.JOB_EXCEPTION) return undefined;
        const ev = new ErrorEvent('error', {
            message: (data as Error)?.message ?? 'x',
            error: data,
            cancelable: true,
        });
        webapiLocalTarget.dispatchEvent(ev);
        ctx.dispatched = true;
        // Only a real listener cancel may claim the error — the same rule the
        // fixed webapi now follows.
        if (ev.defaultPrevented) ctx.handled = true;
        return undefined;
    }, PRIORITY_WEBAPI);
}

Deno.test('bridge: registering a process listener installs the receiver', () => {
    armBridge();
    ok(bridgeInstalled(), "'node-process' is on the bus");
});

Deno.test("bridge: native EV_EXIT emits process 'exit' once, with the status code", () => {
    // Exactly-once and code-forwarding in ONE test, deliberately. Asserting
    // "at most one" in a separate test after another test already consumed the
    // once-flag passes at zero too, so it cannot tell a working guard apart
    // from a bridge that never fired. The flag is intentionally irreversible
    // (Node guarantees a single 'exit'), so there is no reset to lean on.
    armBridge();
    const seen: number[] = [];
    const onExit = (c?: unknown) => { seen.push(Number(c)); };
    process.on('exit', onExit);

    // EV_EXIT carries the status as an int (mod_os.c:87, vm.c:282).
    getEventMux().dispatch(EV.EXIT, 7);
    strictEqual(seen.length, 1, "exactly one 'exit' from the first dispatch");
    strictEqual(seen[0], 7, 'status code forwarded');

    // Two more native dispatches must add nothing. Both process.exit()'s own
    // emit and this bridge can produce 'exit', and process.exit() calls
    // os.exit() which dispatches EV_EXIT — without a shared once-flag the user
    // would see it twice.
    getEventMux().dispatch(EV.EXIT, 7);
    getEventMux().dispatch(EV.EXIT, 9);
    strictEqual(seen.length, 1, "still exactly one 'exit' after re-dispatch");

    process.off('exit', onExit);
});

Deno.test('bridge: EV_JOB_EXCEPTION emits uncaughtException with the error', () => {
    armBridge();
    armWebapiLocal();
    const seen: unknown[] = [];
    const onErr = (e?: unknown) => { seen.push(e); };
    process.on('uncaughtException', onErr);

    const err = new Error('from-a-timer');
    getEventMux().dispatch(EV.JOB_EXCEPTION, err);
    strictEqual(seen.length, 1, 'handler ran once');
    strictEqual(seen[0], err, 'the original error object, not a copy');

    process.off('uncaughtException', onErr);
});

Deno.test('bridge: uncaughtExceptionMonitor fires even with no handler', () => {
    // Node's monitor is observe-only: it runs whether or not an
    // 'uncaughtException' handler exists, and never suppresses the default.
    armBridge();
    armWebapiLocal();
    const seen: unknown[] = [];
    const onMon = (e?: unknown) => { seen.push(e); };
    process.on('uncaughtExceptionMonitor', onMon);

    const err = new Error('monitored');
    getEventMux().dispatch(EV.JOB_EXCEPTION, err);
    strictEqual(seen.length, 1, 'monitor ran with no uncaughtException handler');
    strictEqual(seen[0], err, 'same error');

    process.off('uncaughtExceptionMonitor', onMon);
});

/* ------------------------------------------------------------------ *
 * Return-value polarity, with a negative control on each direction
 * ------------------------------------------------------------------ *
 *
 * EV_JOB_EXCEPTION (utils.c:180): `ret === false` -> TJS_Stop, i.e. FATAL.
 * So "handled, keep running" is TRUE here. That is the OPPOSITE constant from
 * EV_UNHANDLED_REJECTION (vm.c:242), where any non-false return raises
 * JS_EXCEPTION and "handled" is FALSE. Getting this backwards kills the process
 * on exactly the errors the program handled.
 */

Deno.test('polarity: a handled job exception returns true (never TJS_Stop)', () => {
    armBridge();
    armWebapiLocal();
    const onErr = () => {};
    process.on('uncaughtException', onErr);

    const ret = getEventMux().dispatch(EV.JOB_EXCEPTION, new Error('handled'));
    // NEGATIVE CONTROL: `false` is the value utils.c:180 converts into
    // TJS_Stop. If this assertion ever reads false, a program with a working
    // uncaughtException handler is being killed by its own handler.
    strictEqual(ret, true, 'true = continue');

    process.off('uncaughtException', onErr);
});

Deno.test('polarity: a handled job exception silences the runtime diagnostic', () => {
    // Node prints nothing when a handler exists. ctx.handled is how that
    // crosses into the cts diagnostics receiver, which lives in another module.
    armBridge();
    armWebapiLocal();
    let warned = false;
    const offDiag = installEventReceiver('diag-probe', (name, _d, ctx: EventContext) => {
        if (name === EV.JOB_EXCEPTION && !ctx.handled) warned = true;
        return undefined;
    }, PRIORITY_DIAGNOSTICS);

    const onErr = () => {};
    process.on('uncaughtException', onErr);
    getEventMux().dispatch(EV.JOB_EXCEPTION, new Error('handled'));
    ok(!warned, 'diagnostic suppressed while a handler is installed');

    // NEGATIVE CONTROL: remove the handler and the diagnostic must come back.
    // Otherwise a real error with no listener would vanish silently.
    process.off('uncaughtException', onErr);
    warned = false;
    getEventMux().dispatch(EV.JOB_EXCEPTION, new Error('unhandled'));
    ok(warned, 'diagnostic restored once the handler is gone');

    offDiag();
});

Deno.test('polarity: with no handler the bridge abstains, leaving the default', () => {
    // The bridge must not claim an error it cannot deliver. It returns
    // undefined, so the mux applies the per-event default rather than the
    // bridge's opinion — and crucially it does NOT rethrow, because the mux
    // swallows receiver exceptions and the error would disappear entirely.
    armBridge();
    armWebapiLocal();
    // Clear rather than assert zero: the harness installs its own handlers, so
    // a bare count assertion would be testing the harness, not the bridge.
    process.removeAllListeners('uncaughtException');
    strictEqual(process.listenerCount('uncaughtException'), 0, 'no handler');
    strictEqual(
        getEventMux().dispatch(EV.JOB_EXCEPTION, new Error('unclaimed')),
        true,
        'per-event default, not a fatal false',
    );
});

Deno.test('polarity: the exit bridge never influences the native return', () => {
    // EV_EXIT's return value is freed and ignored by the C, so the bridge must
    // abstain. Returning a boolean here would be meaningless at best, and would
    // stomp a value another receiver cared about at worst.
    armBridge();
    const onExit = () => {};
    process.on('exit', onExit);
    const withBridge = getEventMux().dispatch(EV.EXIT, 0);
    process.off('exit', onExit);

    const off = installEventReceiver('opinion', () => true, PRIORITY_DIAGNOSTICS);
    strictEqual(getEventMux().dispatch(EV.EXIT, 0), true, "another receiver's value survives");
    off();
    strictEqual(withBridge, false, 'default EXIT return unchanged by the bridge');
});

Deno.test('bridge: a throwing exit listener does not break teardown', () => {
    armBridge();
    let second = false;
    const bad = () => { throw new Error('listener blew up'); };
    const good = () => { second = true; };
    process.on('exit', bad);
    process.on('exit', good);

    // EventEmitter.emit is not try/catch'd per listener, so the throw stops the
    // chain — but it must not escape the bridge and become a native abort.
    getEventMux().dispatch(EV.EXIT, 0);
    ok(true, 'dispatch returned instead of aborting');
    void second;

    process.off('exit', bad);
    process.off('exit', good);
});

/* ------------------------------------------------------------------ *
 * The diagnostic must SURVIVE when nothing handled the error
 * ------------------------------------------------------------------ *
 *
 * The suppression side is covered above. This is the other polarity, and it
 * regressed: `cno/src/webapi/index.ts` called `event.preventDefault()`
 * unconditionally on the JOB_EXCEPTION ErrorEvent, which set `ctx.handled` on
 * EVERY async throw, and the cts diagnostics receiver skips its `log.warn` on
 * `ctx.handled` (cts/src/runtime/index.ts:423). Net effect: an uncaught throw
 * from a timer produced NO output at all and rc=0.
 *
 * MEASURED, same script against both staged binaries:
 *   Node v24.18.0                    "Error: BOOM_FROM_TIMER" + stack, rc=1
 *   cno.exe.parked-0802-2150 (before) "[runtime] ✖ Uncaught (in unhandled job
 *                                     exception)" + later timers still ran, rc=0
 *   cno.exe (after the mux landed)     NOTHING — error vanished, rc=0
 *
 * `ctx.handled` means "user code cancelled the default action". A bridge
 * dispatching its own ErrorEvent and pre-cancelling it is not that.
 */

/**
 * Take over the webapi band for one test.
 *
 * Two hazards these tests hit the hard way:
 *  1. The BAKED `webapi` receiver is on the bus and (pre-fix) pre-cancels every
 *     JOB_EXCEPTION, so a probe installed under a DIFFERENT role can never
 *     observe `ctx.handled === false` no matter what it does — OBSERVED as
 *     `true !== false`.
 *  2. Dispatching a global 'error' Event inside `cno test` trips the harness's
 *     own global error listener, which rethrows and ABORTS THE WHOLE SUITE
 *     (OBSERVED: "(uncaught error) Error: observed at onSuiteError ... at
 *     dispatchEvent", and the run stopped mid-file). So these tests use a LOCAL
 *     EventTarget and never touch globalThis.dispatchEvent.
 *
 * Same-role install replaces, so this evicts the baked receiver for the rest of
 * the process. Nothing later in this file depends on it, and the tests that do
 * (the polarity pair above) run earlier.
 *
 * The `finally` restores the local stand-in rather than leaving WEBAPI_ROLE
 * VACANT. Leaving it empty would have two effects, both unwanted: it wakes
 * `installWebApiCompatBridge`'s receiver (dormant only while `has(WEBAPI_ROLE)`,
 * event-mux.ts:344), and it makes the later JOB_EXCEPTION tests
 * ('the known events keep their polarity') harness-safe only ACCIDENTALLY — by
 * the fact that no receiver is left to dispatch a global ErrorEvent. Those tests
 * arm the stand-in themselves; this keeps the two consistent either way.
 */
function withWebapiArm(preFix: boolean, body: (target: EventTarget) => void): void {
    const target = new EventTarget();
    installEventReceiver('webapi', (name, data, ctx) => {
        if (name !== EV.JOB_EXCEPTION) return undefined;
        const ev = new ErrorEvent('error', {
            message: (data as Error)?.message ?? 'x',
            error: data,
            cancelable: true,
        });
        if (preFix) ev.preventDefault(); // <-- the regression, for the control
        target.dispatchEvent(ev);
        ctx.dispatched = true;
        if (ev.defaultPrevented) ctx.handled = true;
        return undefined;
    }, PRIORITY_WEBAPI);
    try {
        body(target);
    } finally {
        armWebapiLocal();
    }
}

/** Observe the final `ctx.handled` for one JOB_EXCEPTION dispatch. */
function handledFor(err: Error): boolean | null {
    let seen: boolean | null = null;
    const off = installEventReceiver('diag-probe-observe', (name, _d, ctx: EventContext) => {
        if (name === EV.JOB_EXCEPTION) seen = ctx.handled;
        return undefined;
    }, PRIORITY_DIAGNOSTICS);
    try {
        getEventMux().dispatch(EV.JOB_EXCEPTION, err);
    } finally {
        off();
    }
    return seen;
}

/**
 * Clear 'uncaughtException' on BOTH live copies of the process emitter.
 *
 * There are two: the namespace import above and the singleton on
 * Symbol.for('cno.node.process.default') (OBSERVED `ns.on !== singleton.on`,
 * with listeners added via one invisible to the other). The node-process bridge
 * consults whichever copy registered the 'node-process' role, so clearing only
 * one can leave a handler that silently sets ctx.handled and inverts the
 * assertion under test.
 */
function clearUncaughtOnBothCopies(): void {
    process.removeAllListeners('uncaughtException');
    try {
        const p = Reflect.get(globalThis, 'process') as
            { removeAllListeners?(e: string): void } | undefined;
        p?.removeAllListeners?.('uncaughtException');
    } catch { /* absent; the namespace clear above stands */ }
}

Deno.test('diagnostic: webapi must NOT pre-cancel its own JOB_EXCEPTION event', () => {
    armBridge();
    clearUncaughtOnBothCopies();

    // NEGATIVE CONTROL: the pre-fix arm marks every error handled — the bug.
    withWebapiArm(true, () => {
        strictEqual(handledFor(new Error('pre-fix')), true, 'pre-cancelling sets handled (the regression)');
    });

    // POST-FIX: nothing cancelled, so the diagnostic must not be suppressed.
    withWebapiArm(false, () => {
        strictEqual(handledFor(new Error('post-fix')), false, 'no cancel, so the diagnostic survives');
    });
});

Deno.test('diagnostic: a listener that does NOT preventDefault leaves it printing', () => {
    // Web semantics: only a cancel suppresses the default action. A bare
    // error observer must not blind the process — otherwise any library that
    // adds one silences every async throw.
    armBridge();
    clearUncaughtOnBothCopies();

    withWebapiArm(false, (target) => {
        let ran = 0;
        const observer = () => { ran++; };
        target.addEventListener('error', observer);
        strictEqual(handledFor(new Error('observed')), false, 'observing is not cancelling');
        strictEqual(ran, 1, 'the observer did run');
        target.removeEventListener('error', observer);
    });
});

Deno.test('diagnostic: preventDefault() from a real listener DOES suppress it', () => {
    // The positive half of the pair, so the two together pin both polarities of
    // `handled` for the web path.
    armBridge();
    clearUncaughtOnBothCopies();

    withWebapiArm(false, (target) => {
        let ran = 0;
        const canceller = (ev: Event) => { ran++; ev.preventDefault(); };
        target.addEventListener('error', canceller);
        strictEqual(handledFor(new Error('cancelled')), true, 'a real preventDefault() suppresses it');
        strictEqual(ran, 1, 'the canceller did run');
        target.removeEventListener('error', canceller);
    });
});

/* ------------------------------------------------------------------ *
 * EV_UNHANDLED_REJECTION -> process 'unhandledRejection'
 * ------------------------------------------------------------------ *
 *
 * Not bridged at all before: the cts diagnostic printed and nothing emitted on
 * `process`, so a registered handler never fired. Node fires it (OBSERVED
 * v24.18.0: handler runs with (reason, promise), rc=0).
 *
 * These use the SINGLETON `process` (globalThis.process ===
 * Symbol.for('cno.node.process.default') === the default export — all three
 * OBSERVED identical), not the namespace import. The bridge emits on the
 * singleton because that is what user code reaches. The namespace import is a
 * SECOND live copy with its own emitter (OBSERVED: `ns.on !== singleton.on`, and
 * a listener added via one is invisible to the other) — that two-copies defect
 * is separately owned and is why these tests do not use `process.on` from the
 * module-level namespace import above.
 */

function singletonProcess(): {
    on(e: string, f: (...a: unknown[]) => void): unknown;
    off(e: string, f: (...a: unknown[]) => void): unknown;
    listenerCount(e: string): number;
    removeAllListeners(e?: string): unknown;
} {
    const p = Reflect.get(globalThis, 'process');
    ok(p && typeof p === 'object', 'globalThis.process is present');
    return p as never;
}

Deno.test('rejection: EV_UNHANDLED_REJECTION emits unhandledRejection (reason, promise)', () => {
    const off = installNodeProcessRejectionBridge();
    const P = singletonProcess();
    const seen: unknown[][] = [];
    const onRej = (...args: unknown[]) => { seen.push(args); };
    P.on('unhandledRejection', onRej);

    const reason = new Error('rejected-with-handler');
    const promise = Promise.resolve();
    getEventMux().dispatch(EV.UNHANDLED_REJECTION, [promise, reason]);

    strictEqual(seen.length, 1, 'handler ran once');
    strictEqual(seen[0]?.[0], reason, "Node's first arg is the reason");
    strictEqual(seen[0]?.[1], promise, "Node's second arg is the promise");

    P.off('unhandledRejection', onRej);
    off();
});

Deno.test('rejection: a delivered rejection returns FALSE (vm.c:242 aborts on non-false)', () => {
    // POLARITY, and it is INVERTED relative to EV_JOB_EXCEPTION:
    //   vm.c:242    `!JS_IsEqual(ret, JS_FALSE)` -> JS_EXCEPTION   (false = handled)
    //   utils.c:180 ` JS_IsEqual(ret, JS_FALSE)` -> TJS_Stop       (true  = handled)
    // NEGATIVE CONTROL: if this ever reads true, the bridge is asking the C to
    // abort the process on exactly the rejections the program handled. That
    // inversion already shipped once, in webapi's 'unhandledrejection' arm.
    const off = installNodeProcessRejectionBridge();
    const P = singletonProcess();
    const onRej = () => {};
    P.on('unhandledRejection', onRej);

    strictEqual(
        getEventMux().dispatch(EV.UNHANDLED_REJECTION, [Promise.resolve(), new Error('p')]),
        false,
        'false = do not abort',
    );

    P.off('unhandledRejection', onRej);
    off();
});

Deno.test('rejection: a throwing handler must not become a native abort', () => {
    const off = installNodeProcessRejectionBridge();
    const P = singletonProcess();
    const bad = () => { throw new Error('handler blew up'); };
    P.on('unhandledRejection', bad);

    // Must still be the non-fatal `false`. If the throw escaped, mux.dispatch
    // would discard this receiver's return value and `defaultReturn` would
    // stand — also false here, so assert the survival separately below.
    strictEqual(
        getEventMux().dispatch(EV.UNHANDLED_REJECTION, [Promise.resolve(), new Error('p')]),
        false,
        'still non-fatal after a throwing handler',
    );
    ok(true, 'dispatch returned instead of propagating');

    P.off('unhandledRejection', bad);
    off();
});

Deno.test('rejection: with no handler the bridge abstains and the diagnostic stays', () => {
    const off = installNodeProcessRejectionBridge();
    const P = singletonProcess();
    P.removeAllListeners('unhandledRejection');
    strictEqual(P.listenerCount('unhandledRejection'), 0, 'no handler');

    let handledSeen: boolean | null = null;
    const offProbe = installEventReceiver('diag-probe-5', (name, _d, ctx: EventContext) => {
        if (name === EV.UNHANDLED_REJECTION) handledSeen = ctx.handled;
        return undefined;
    }, PRIORITY_DIAGNOSTICS);

    getEventMux().dispatch(EV.UNHANDLED_REJECTION, [Promise.resolve(), new Error('unclaimed')]);
    strictEqual(handledSeen, false, 'nothing handled it, so the diagnostic must print');

    offProbe();
    off();
});

/* ------------------------------------------------------------------ *
 * The diagnostics receiver must not claim events it does not handle
 * ------------------------------------------------------------------ */

Deno.test('dispatch: an unrecognised event must not be claimed by diagnostics', () => {
    // MECHANISM (read from event-mux.ts:150-162): entries are dispatched
    // highest-priority-first and `ret` is overwritten by every explicit boolean,
    // so the LAST explicit boolean — i.e. the LOWEST-priority receiver that
    // returns one — decides the native value. cts-diagnostics sits at
    // PRIORITY_DIAGNOSTICS (0) with only PRIORITY_FALLBACK (-100) below it, so
    // its trailing `return false` overwrote every higher-priority opinion.
    //
    // Reachable in production, not hypothetical: EV_BEFORE_UNLOAD (id 4,
    // private.h:172) is dispatched by vm.c:851 and is absent from the mux's EV
    // map, so it falls through to that tail. vm.c:863 treats ONLY an explicit
    // `true` as "cancelled, keep running" — so the trap silently converts a
    // beforeunload cancel into a proceed.
    //
    // MEASURED against the current staged binary: `true` from a PRIORITY_WEBAPI
    // receiver came back as `false`. With the tail returning `undefined` it came
    // back as `true`, and the native loop then re-dispatched beforeunload forever
    // (rc=124 at a 60s timeout) — which is vm.c:869-874's documented behaviour
    // and proves the return value really does reach the C.
    const BEFORE_UNLOAD = 4;
    const offCancel = installEventReceiver(
        'beforeunload-cancel-probe',
        (name) => (name === BEFORE_UNLOAD ? true : undefined),
        PRIORITY_WEBAPI,
    );
    try {
        strictEqual(
            getEventMux().dispatch(BEFORE_UNLOAD, undefined),
            true,
            "a higher-priority receiver's cancel must survive the diagnostics tail",
        );
    } finally {
        // MUST be removed: an always-cancelling beforeunload receiver left on the
        // bus makes the native drain spin forever (vm.c:869-874 has no cap, by
        // design, matching Deno) and would hang the suite at exit.
        offCancel();
    }
});

Deno.test('dispatch: the known events keep their polarity', () => {
    // Guards the change above from over-reaching: making the tail `undefined`
    // must not disturb the two events the receiver does claim.
    armBridge();
    armWebapiLocal();
    process.removeAllListeners('uncaughtException');
    strictEqual(getEventMux().dispatch(EV.JOB_EXCEPTION, new Error('x')), true, 'JOB_EXCEPTION: true');
    strictEqual(
        getEventMux().dispatch(EV.UNHANDLED_REJECTION, [Promise.resolve(), new Error('y')]),
        false,
        'UNHANDLED_REJECTION: false',
    );
});
