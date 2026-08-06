/**
 * Engine-event multiplexer.
 *
 * Regression cover for the single-slot `engine.onEvent()` defect: the native
 * setter (circu.js/src/mod_engine.c:871) frees the previous receiver, so the
 * cts diagnostics receiver silently displaced the webapi 'load'/'unload' bridge
 * and addEventListener('unload'|'load'|'unhandledrejection') never fired.
 *
 * These load the mux from DISK by relative path, so they exercise the current
 * source rather than the copy baked into cno.exe.
 */
import { notStrictEqual, ok, strictEqual } from 'node:assert';
import {
    EV,
    getEventMux,
    installEventReceiver,
    installWebApiCompatBridge,
    dispatchLoadEvent,
    dispatchUnloadEvent,
    loadEventFired,
    unloadEventFired,
    resetLifecycleFlagsForTest,
    WEBAPI_ROLE,
    WEBAPI_COMPAT_ROLE,
    PRIORITY_WEBAPI,
    PRIORITY_DIAGNOSTICS,
    PRIORITY_FALLBACK,
    type EventContext,
} from '../../cts/src/runtime/event-mux.ts';

/** Remove every receiver so each test starts from a known bus. */
function resetMux(): void {
    const mux = getEventMux();
    for (const role of mux.roles()) {
        // install-then-uninstall is the only public removal path
        installEventReceiver(role, () => undefined)();
    }
    strictEqual(mux.roles().length, 0, 'bus drained');
}

Deno.test('mux: two receivers both fire — neither displaces the other', () => {
    resetMux();
    const seen: string[] = [];
    const offA = installEventReceiver('a', () => { seen.push('a'); return undefined; });
    const offB = installEventReceiver('b', () => { seen.push('b'); return undefined; });

    getEventMux().dispatch(EV.EXIT, 0);
    strictEqual(seen.join(','), 'a,b', 'both receivers ran');

    offA(); offB();
});

Deno.test('mux: registration order does not matter — priority decides', () => {
    resetMux();
    const seen: string[] = [];
    // Register diagnostics FIRST, webapi second: webapi must still run first.
    const off1 = installEventReceiver('diag', () => { seen.push('diag'); return undefined; }, PRIORITY_DIAGNOSTICS);
    const off2 = installEventReceiver('web', () => { seen.push('web'); return undefined; }, PRIORITY_WEBAPI);

    getEventMux().dispatch(EV.UNHANDLED_REJECTION, [null, new Error('x')]);
    strictEqual(seen.join(','), 'web,diag', 'higher priority ran first');

    // And the reverse registration order gives the same dispatch order.
    off1(); off2();
    const seen2: string[] = [];
    const off3 = installEventReceiver('web', () => { seen2.push('web'); return undefined; }, PRIORITY_WEBAPI);
    const off4 = installEventReceiver('diag', () => { seen2.push('diag'); return undefined; }, PRIORITY_DIAGNOSTICS);
    getEventMux().dispatch(EV.UNHANDLED_REJECTION, [null, new Error('x')]);
    strictEqual(seen2.join(','), 'web,diag', 'order-independent');
    off3(); off4();
});

Deno.test('mux: ctx.handled carries preventDefault across receivers', () => {
    resetMux();
    let warned = false;
    const offWeb = installEventReceiver('web', (_n, _d, ctx: EventContext) => {
        ctx.handled = true; // stand-in for a listener calling preventDefault()
        return undefined;
    }, PRIORITY_WEBAPI);
    const offDiag = installEventReceiver('diag', (_n, _d, ctx: EventContext) => {
        if (!ctx.handled) warned = true;
        return false;
    }, PRIORITY_DIAGNOSTICS);

    getEventMux().dispatch(EV.UNHANDLED_REJECTION, [null, new Error('handled')]);
    strictEqual(warned, false, 'diagnostic suppressed when handled');

    offWeb();
    warned = false;
    getEventMux().dispatch(EV.UNHANDLED_REJECTION, [null, new Error('unhandled')]);
    strictEqual(warned, true, 'diagnostic still prints when nothing handled it');
    offDiag();
});

Deno.test('mux: native return polarity preserved per event', () => {
    resetMux();
    const mux = getEventMux();
    // No receivers with an opinion -> per-event defaults.
    const off = installEventReceiver('quiet', () => undefined);
    // vm.c:242 — any non-false aborts, so a rejection must yield false.
    strictEqual(mux.dispatch(EV.UNHANDLED_REJECTION, [null, 1]), false, 'rejection: false');
    // utils.c:180 — false calls TJS_Stop, so a job exception must yield true.
    strictEqual(mux.dispatch(EV.JOB_EXCEPTION, new Error('j')), true, 'job exception: true');
    off();
});

Deno.test('mux: a throwing receiver does not stop the others or change the return', () => {
    resetMux();
    let reached = false;
    const offBad = installEventReceiver('bad', () => { throw new Error('boom'); }, PRIORITY_WEBAPI);
    const offGood = installEventReceiver('good', () => { reached = true; return undefined; }, PRIORITY_DIAGNOSTICS);

    const ret = getEventMux().dispatch(EV.JOB_EXCEPTION, new Error('x'));
    strictEqual(reached, true, 'later receiver still ran');
    strictEqual(ret, true, 'return value unaffected by the thrower');
    offBad(); offGood();
});

Deno.test('mux: same-role reinstall replaces, so no double dispatch', () => {
    resetMux();
    let count = 0;
    const off1 = installEventReceiver('dup', () => { count++; return undefined; });
    const off2 = installEventReceiver('dup', () => { count++; return undefined; });
    getEventMux().dispatch(EV.EXIT, 0);
    strictEqual(count, 1, 'role registered once');
    strictEqual(getEventMux().roles().filter((r) => r === 'dup').length, 1, 'single entry');
    off1(); off2();
});

Deno.test('compat bridge: dispatches unload/exit to the global EventTarget on EXIT', () => {
    resetMux();
    const fired: string[] = [];
    const onUnload = () => fired.push('unload');
    const onExit = () => fired.push('exit');
    addEventListener('unload', onUnload);
    addEventListener('exit', onExit);

    const off = installWebApiCompatBridge();
    getEventMux().dispatch(EV.EXIT, 0);

    strictEqual(fired.join(','), 'unload,exit', 'unload then exit');

    off();
    removeEventListener('unload', onUnload);
    removeEventListener('exit', onExit);
});

Deno.test('compat bridge: unhandledrejection fires and preventDefault sets ctx.handled', () => {
    resetMux();
    let got: unknown;
    const onRej = (e: Event) => {
        got = (e as unknown as { reason?: unknown }).reason;
        e.preventDefault();
    };
    addEventListener('unhandledrejection', onRej as EventListener);

    let handledSeen: boolean | null = null;
    const offBridge = installWebApiCompatBridge();
    const offProbe = installEventReceiver('probe', (_n, _d, ctx: EventContext) => {
        handledSeen = ctx.handled;
        return false;
    }, PRIORITY_DIAGNOSTICS);

    const err = new Error('rej-payload');
    const p = Promise.reject(err);
    p.catch(() => {}); // keep this test's own promise from becoming a real rejection
    getEventMux().dispatch(EV.UNHANDLED_REJECTION, [p, err]);

    strictEqual(got, err, 'listener received the reason');
    strictEqual(handledSeen, true, 'preventDefault propagated as ctx.handled');

    offBridge(); offProbe();
    removeEventListener('unhandledrejection', onRej as EventListener);
});

Deno.test('compat bridge: stands down once webapi registers (no double dispatch)', () => {
    resetMux();
    let count = 0;
    const onUnload = () => count++;
    addEventListener('unload', onUnload);

    const offCompat = installWebApiCompatBridge();
    // webapi joining the bus is what makes the two order-independent.
    const offWeb = installEventReceiver(WEBAPI_ROLE, (_n, _d, ctx: EventContext) => {
        dispatchEvent(new Event('unload'));
        ctx.dispatched = true;
        return undefined;
    }, PRIORITY_WEBAPI);

    getEventMux().dispatch(EV.EXIT, 0);
    strictEqual(count, 1, 'exactly one unload dispatch');

    offCompat(); offWeb();
    removeEventListener('unload', onUnload);
});

Deno.test('mux: identity is shared via the global symbol slot', async () => {
    // A second import of the same source must find the same bus, which is what
    // makes the baked copy and a disk-loaded copy cooperate.
    const again = await import('../../cts/src/runtime/event-mux.ts');
    strictEqual(again.getEventMux(), getEventMux(), 'same mux object');
});

Deno.test('mux: EV ids match the native engine enum', () => {
    const ET = (import.meta as unknown as { use(m: string): { EventType: Record<string, number> } })
        .use('engine').EventType;
    strictEqual(EV.UNHANDLED_REJECTION, ET.UNHANDLED_REJECTION, 'UNHANDLED_REJECTION');
    strictEqual(EV.JOB_EXCEPTION, ET.JOB_EXCEPTION, 'JOB_EXCEPTION');
    strictEqual(EV.EXIT, ET.EXIT, 'EXIT');
    strictEqual(EV.LOAD, ET.LOAD, 'LOAD');
    // Guard the assumption the polarity comments rest on.
    notStrictEqual(EV.EXIT, EV.LOAD, 'EXIT and LOAD are distinct');
});

Deno.test('roles: compat bridge registers under its own role', () => {
    resetMux();
    const off = installWebApiCompatBridge();
    ok(getEventMux().has(WEBAPI_COMPAT_ROLE), 'compat role present');
    off();
    ok(!getEventMux().has(WEBAPI_COMPAT_ROLE), 'uninstall removes it');
});

/* ------------------------------------------------------------------ *
 * Lifecycle: 'load' / 'unload'
 * ------------------------------------------------------------------ *
 *
 * The mux made webapi's receiver reachable again, but that was necessary and
 * not sufficient: 'load' was UNREACHABLE, not merely displaced. Native EV_LOAD
 * is dispatched by TJS_EvalModuleContent (circu.js/src/utils.c:469) for the
 * C-level main module — cno's own bootstrap — before any user entry exists, so
 * no user listener can ever observe it. Hence an explicit dispatch at the user
 * entry-eval sites, which these cover.
 */

/** Collect global events by name, returning a detach function. */
function record(type: string, into: string[]): () => void {
    const fn = () => { into.push(type); };
    addEventListener(type, fn);
    return () => removeEventListener(type, fn);
}

Deno.test('lifecycle: dispatchLoadEvent fires the global load event', () => {
    resetMux();
    resetLifecycleFlagsForTest();
    const seen: string[] = [];
    const off = record('load', seen);

    ok(!loadEventFired(), 'not yet fired');
    dispatchLoadEvent();
    strictEqual(seen.join(','), 'load', 'listener ran');
    ok(loadEventFired(), 'flag set');

    off();
});

Deno.test('lifecycle: load fires at most once across both wiring sites', () => {
    // `cno test` reaches BOTH src/commands/run.ts (after entry eval) and
    // startTest, so a non-idempotent helper would show the user two 'load's.
    resetMux();
    resetLifecycleFlagsForTest();
    const seen: string[] = [];
    const off = record('load', seen);

    dispatchLoadEvent();
    dispatchLoadEvent();
    dispatchLoadEvent();
    strictEqual(seen.length, 1, 'exactly one load event');

    off();
});

Deno.test('lifecycle: unload fires once, and is idempotent', () => {
    resetMux();
    resetLifecycleFlagsForTest();
    const seen: string[] = [];
    const off = record('unload', seen);

    dispatchUnloadEvent();
    dispatchUnloadEvent();
    strictEqual(seen.length, 1, 'exactly one unload event');
    ok(unloadEventFired(), 'flag set');

    off();
});

Deno.test('lifecycle: a native EV_EXIT suppresses a later explicit unload', () => {
    // webapi's bridge fires 'unload' on EV_EXIT unconditionally and cannot
    // consult a flag. So the guard records the native event instead: a suite
    // that called Deno.exit() must not then get a second 'unload' from
    // startTest's post-suite dispatch.
    resetMux();
    resetLifecycleFlagsForTest();
    const seen: string[] = [];
    const off = record('unload', seen);

    // Arm the guard, then simulate the native exit.
    dispatchLoadEvent();
    getEventMux().dispatch(EV.EXIT, 0);
    ok(unloadEventFired(), 'guard observed EV_EXIT');

    strictEqual(dispatchUnloadEvent(), false, 'explicit dispatch stood down');
    strictEqual(seen.length, 0, 'no unload from the explicit path');

    off();
});

Deno.test('lifecycle: native EV_LOAD does NOT satisfy the load guard', () => {
    // The bootstrap EV_LOAD must not be mistaken for the user-visible one, or
    // the only dispatch a user can observe would be suppressed. This is the
    // asymmetry with EV_EXIT above, and it is deliberate.
    resetMux();
    resetLifecycleFlagsForTest();
    const seen: string[] = [];
    const off = record('load', seen);

    dispatchUnloadEvent();          // arms the guard without touching loadFired
    getEventMux().dispatch(EV.LOAD, undefined);
    ok(!loadEventFired(), 'bootstrap EV_LOAD left the flag clear');

    dispatchLoadEvent();
    strictEqual(seen.length, 1, 'user-visible load still fires');

    off();
});

/* ------------------------------------------------------------------ *
 * Return-value polarity
 * ------------------------------------------------------------------ *
 *
 * The native polarity is NOT uniform. Getting a bridge backwards either aborts
 * on handled errors or silently swallows real ones, so each direction gets an
 * explicit negative control.
 *   EV_UNHANDLED_REJECTION  vm.c:242     ret !== false -> JS_EXCEPTION (abort)
 *   EV_JOB_EXCEPTION        utils.c:180  ret === false -> TJS_Stop (fatal)
 */

Deno.test('polarity: rejection defaults to false (do not abort)', () => {
    resetMux();
    // With no receiver expressing an opinion, the default must be the
    // non-aborting value. NEGATIVE CONTROL: `true` here would mean vm.c:242
    // raises JS_EXCEPTION on every unhandled rejection.
    strictEqual(getEventMux().dispatch(EV.UNHANDLED_REJECTION, [null, new Error('x')]), false);
});

Deno.test('polarity: job exception defaults to true (do not TJS_Stop)', () => {
    resetMux();
    // NEGATIVE CONTROL: `false` here is the value utils.c:180 turns into
    // TJS_Stop, i.e. it would kill the process on any job exception.
    strictEqual(getEventMux().dispatch(EV.JOB_EXCEPTION, new Error('x')), true);
});

Deno.test('polarity: the REPL fallback band overrides a fatal return', () => {
    // src/commands/repl/index.ts was a raw `onEvent(() => false)`. For
    // EV_JOB_EXCEPTION that flat `false` is the FATAL value — a throw from a
    // timer would have torn down the REPL, the opposite of its purpose. The
    // migrated receiver sits in PRIORITY_FALLBACK, below everything, and the
    // last explicit boolean wins, so it can always restore the safe value.
    resetMux();
    const offBad = installEventReceiver('hostile', () => false, PRIORITY_DIAGNOSTICS);
    strictEqual(getEventMux().dispatch(EV.JOB_EXCEPTION, new Error('x')), false, 'hostile wins alone');

    const offRepl = installEventReceiver(
        'repl',
        (name) => (name === EV.JOB_EXCEPTION ? true : false),
        PRIORITY_FALLBACK,
    );
    strictEqual(getEventMux().dispatch(EV.JOB_EXCEPTION, new Error('x')), true, 'repl restored non-fatal');
    // And it keeps the non-aborting value for a rejection, where the safe
    // constant is the opposite one.
    strictEqual(getEventMux().dispatch(EV.UNHANDLED_REJECTION, [null, new Error('x')]), false, 'repl non-aborting');

    offBad(); offRepl();
});

Deno.test('polarity: a throwing receiver cannot change the native return', () => {
    resetMux();
    const off = installEventReceiver('throws', () => { throw new Error('broken receiver'); });
    // Must fall back to the per-event default, not to a fatal value.
    strictEqual(getEventMux().dispatch(EV.JOB_EXCEPTION, new Error('x')), true);
    strictEqual(getEventMux().dispatch(EV.UNHANDLED_REJECTION, [null, new Error('x')]), false);
    off();
});

Deno.test('lifecycle: load brackets before the suite, unload after', async () => {
    // The ordering contract cno/src/deno/index.ts startTest implements:
    // dispatchLoadEvent() before the beforeAll hooks and the test loop,
    // dispatchUnloadEvent() in the finally. Deno's measured order is
    // load -> test bodies -> unload, and the guard test
    // tests/deno/test-harness.test.ts 'load before suite and unload after'
    // asserts exactly those relative positions.
    //
    // Reproduced here against the real dispatch helpers rather than by importing
    // startTest: cno/src/deno/index.ts redefines the `Deno` global on import,
    // including Deno.test itself, so a disk-loaded import would corrupt the
    // running harness.
    resetMux();
    resetLifecycleFlagsForTest();
    const order: string[] = [];
    const offLoad = record('load', order);
    const offUnload = record('unload', order);

    // --- the startTest shape ---
    dispatchLoadEvent();
    try {
        order.push('beforeAll');
        await Promise.resolve();
        order.push('test-body');
    } finally {
        dispatchUnloadEvent();
    }

    strictEqual(order.join(','), 'load,beforeAll,test-body,unload', 'Deno bracket order');

    offLoad(); offUnload();
});

Deno.test('lifecycle: unload still fires when the suite throws', () => {
    // dispatchUnloadEvent() sits in a finally. A suite that threw must still
    // release what its 'load' listener armed — otherwise a setInterval keeps the
    // loop alive and the run hangs instead of reporting the failure.
    resetMux();
    resetLifecycleFlagsForTest();
    const order: string[] = [];
    const offUnload = record('unload', order);

    try {
        try {
            throw new Error('suite blew up');
        } finally {
            dispatchUnloadEvent();
        }
    } catch { /* expected */ }

    strictEqual(order.join(','), 'unload', 'unload fired despite the throw');
    offUnload();
});
