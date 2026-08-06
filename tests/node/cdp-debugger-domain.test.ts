/**
 * In-process tests for `src/inspector/domains/debugger.ts`.
 *
 * DebuggerDomain is imported by relative path, so these exercise the working-tree
 * TypeScript with no rebuild. That matters: debugger.ts carries the largest
 * behavioural diff of the changed inspector files and had ZERO direct coverage —
 * the only two existing Debugger tests spawn `cno.exe` and assert param
 * validation, so every behaviour below was unverified.
 *
 * The oracle for each expectation is real node v24.18.0 driven over its own
 * `--inspect` socket; the measured value is quoted at each assertion.
 */

import { ok, strictEqual } from 'node:assert';
import { DebuggerDomain } from '../../src/inspector/domains/debugger';
import { CDPDispatcher, CDPError, CdpErrorCode } from '../../src/inspector/worker/dispatcher';
import type { WorkerEndpoint } from '../../src/inspector/transport/worker-endpoint';

interface Emitted { method: string; params: Record<string, unknown> }

interface Harness {
    domain: DebuggerDomain;
    dispatcher: CDPDispatcher;
    events: Emitted[];
    /** Every rpc.call made, in order, as `method` strings. */
    calls: string[];
    /** Every rpc.notify made, in order. */
    notifies: string[];
    /** Every rpc.beginResume, counted. */
    resumes: number;
    /** Every rpc.setPaused argument, in order — the transport-mode flips. */
    pausedFlips: boolean[];
    scriptParsed(): Emitted[];
}

/**
 * Must track UNENABLED_PAUSE_GRACE_MS in src/inspector/domains/debugger.ts. Kept as a
 * literal rather than exported from the module so a silent widening of the real
 * constant shows up as a failing test rather than a test that quietly waits longer.
 */
const GRACE_MS = 2000;

function newDomain(opts: { failCalls?: Set<string> } = {}): Harness {
    const dispatcher = new CDPDispatcher();
    const events: Emitted[] = [];
    const calls: string[] = [];
    const notifies: string[] = [];
    const harness = {
        dispatcher,
        events,
        calls,
        notifies,
        resumes: 0,
        pausedFlips: [] as boolean[],
    };
    const rpc = {
        call: (method: string) => {
            calls.push(method);
            if (opts.failCalls?.has(method)) return Promise.reject(new Error(`rpc ${method} failed`));
            return Promise.resolve({});
        },
        notify: (method: string) => { notifies.push(method); },
        setPaused: (v: boolean) => { harness.pausedFlips.push(v); },
        beginResume: () => { harness.resumes++; },
        signalInterrupt: () => {},
        isPaused: () => false,
    } as unknown as WorkerEndpoint;
    const domain = new DebuggerDomain(
        dispatcher,
        (method: string, params: unknown) => { events.push({ method, params: params as Record<string, unknown> }); },
        rpc,
    );
    return Object.assign(harness, {
        domain,
        scriptParsed: () => events.filter((e) => e.method === 'Debugger.scriptParsed'),
    });
}

function addScript(h: Harness, scriptId: string, url: string): void {
    h.domain.onScriptParsed({ scriptId, url, length: 10, endLine: 5 } as Parameters<DebuggerDomain['onScriptParsed']>[0]);
}

Deno.test('debugger: Debugger.enable replays scripts exactly once per session', async () => {
    const h = newDomain();
    addScript(h, '/app/a.ts', 'file:///app/a.ts');
    addScript(h, '/app/b.ts', 'file:///app/b.ts');

    await h.dispatcher.dispatch('Debugger.enable', {});
    strictEqual(h.scriptParsed().length, 2, 'the first enable must replay every known script');

    // MEASURED against node v24.18: a second Debugger.enable on the same session
    // emits 0 scriptParsed (83 then 0) and returns the same debuggerId. Replaying
    // unconditionally hands DevTools a duplicate scriptParsed for a scriptId it
    // already has, which makes it show the same file twice in the sources tree.
    h.events.length = 0;
    await h.dispatcher.dispatch('Debugger.enable', {});
    strictEqual(h.scriptParsed().length, 0, 'a redundant enable must not re-replay scripts');
});

Deno.test('debugger: disable then enable does replay, so breakpoints still resolve', async () => {
    const h = newDomain();
    addScript(h, '/app/a.ts', 'file:///app/a.ts');
    await h.dispatcher.dispatch('Debugger.enable', {});
    strictEqual(h.scriptParsed().length, 1);

    await h.dispatcher.dispatch('Debugger.disable', {});
    h.events.length = 0;
    await h.dispatcher.dispatch('Debugger.enable', {});
    // MEASURED against node v24.18: 83 scriptParsed after the 1st enable and 83
    // again after disable+enable. This is the case the removed `pendingScriptEvents`
    // list got wrong — it was emptied by the first enable, so the second replayed
    // nothing and no breakpoint in an already-loaded file could ever resolve.
    strictEqual(h.scriptParsed().length, 1, 'enable after disable must replay the full script tree');
});

Deno.test('debugger: a reattaching frontend gets the full script tree again', async () => {
    const h = newDomain();
    addScript(h, '/app/a.ts', 'file:///app/a.ts');
    h.domain.setConnected(true);
    await h.dispatcher.dispatch('Debugger.enable', {});
    strictEqual(h.scriptParsed().length, 1);

    // DevTools closes the socket without sending Debugger.disable. The domain must
    // return to a state where the next frontend's enable replays everything;
    // ConsoleDomain.setConnected already does exactly this for `enabled`.
    h.domain.setConnected(false);
    h.events.length = 0;
    h.domain.setConnected(true);
    await h.dispatcher.dispatch('Debugger.enable', {});
    strictEqual(h.scriptParsed().length, 1, 'a reattached frontend must see the scripts again');
});

Deno.test('debugger: evaluateOnCallFrame while not paused is a protocol error', async () => {
    const h = newDomain();
    let caught: unknown;
    try {
        await h.dispatcher.dispatch('Debugger.evaluateOnCallFrame', { callFrameId: '0', expression: '1+1' });
    } catch (e) {
        caught = e;
    }
    // MEASURED against node v24.18:
    //   {"error":{"code":-32000,"message":"Can only perform operation while paused."}}
    // Returning a *successful* result with a fabricated exceptionDetails instead
    // tells DevTools the expression ran and threw, so the console prints a bogus
    // "Not paused" error object rather than the command failing.
    if (!(caught instanceof CDPError)) throw new Error(`expected a CDPError, got ${String(caught)}`);
    strictEqual(caught.code, CdpErrorCode.ServerError);
    ok(/paused/i.test(caught.message), `message should mention paused, got ${caught.message}`);
});

Deno.test('debugger: a failed native breakpoint install cannot become an unhandled rejection', async () => {
    // The worker installs an `unhandledrejection` listener that reports to the main
    // thread as a worker crash, and the main thread now REJECTS the ready promise on
    // a worker error. So an orphan rejection here aborts attach entirely. pipe-rpc's
    // new failAllPending makes this reachable: a pipe fault rejects every pending
    // rpc.call at once, including the fire-and-forget breakpoint installs.
    const h = newDomain({ failCalls: new Set(['addBreakpoint']) });

    // Detect *structurally* whether a rejection handler is attached: `void p` never
    // calls p.then, while `p.catch(...)` does. The unhandledrejection event itself is
    // swallowed by the test runner (MEASURED: a listener saw 0 for a known orphan
    // rejection), so it cannot be observed directly here.
    const proto = DebuggerDomain.prototype as unknown as Record<string, unknown>;
    const original = proto.installNativeBreakpoint as (bp: unknown) => Promise<void>;
    let thenCalls = 0;
    proto.installNativeBreakpoint = function (bp: unknown): Promise<void> {
        const p = original.call(this, bp);
        return {
            then: (...args: unknown[]) => {
                thenCalls++;
                return (p.then as (...a: unknown[]) => unknown).apply(p, args);
            },
            catch: (...args: unknown[]) => {
                thenCalls++;
                return (p.catch as (...a: unknown[]) => unknown).apply(p, args);
            },
        } as unknown as Promise<void>;
    } as unknown as typeof original;

    try {
        const res = await h.dispatcher.dispatch('Debugger.setBreakpointByUrl', {
            url: 'file:///app/a.ts',
            lineNumber: 3,
        }) as { breakpointId: string };
        ok(res.breakpointId, 'the breakpoint id is still returned to DevTools');
        ok(h.calls.includes('addBreakpoint'), 'the install was actually attempted');
        ok(thenCalls > 0, 'the fire-and-forget install must have a rejection handler attached');
    } finally {
        proto.installNativeBreakpoint = original as unknown as typeof original;
    }
    await new Promise((r) => setTimeout(r, 50));
});

Deno.test('debugger: setConnected(false) while paused cannot orphan the resume rejection', async () => {
    // Same hazard on the other fire-and-forget site: setConnected(false) resumes a
    // paused program, and doResume awaits releaseObjectGroup over the pipe. If the
    // pipe just died, that rejects — and this path runs precisely when the socket is
    // going away, i.e. exactly when the pipe is most likely to be gone.
    const h = newDomain({ failCalls: new Set(['releaseObjectGroup', 'setExceptionBreakpoint']) });
    h.domain.setConnected(true);
    await h.dispatcher.dispatch('Debugger.enable', {});
    h.domain.onPaused({ reason: 'other', hitFilename: '/app/a.ts', hitLine: 1, callFrames: [] } as Parameters<DebuggerDomain['onPaused']>[0]);

    // doResume swallows releaseObjectGroup failures via releaseBacktraceQuietly, so
    // this must complete without an orphan rejection escaping.
    h.domain.setConnected(false);
    await new Promise((r) => setTimeout(r, 80));
    ok(h.calls.includes('releaseObjectGroup'), 'resume must have attempted the group release');
});

Deno.test('debugger: hitBreakpoints matches on the frame scriptId, not just hitFilename', async () => {
    const h = newDomain();
    // A non-file module: the devtools url and the engine scriptId differ, which is
    // the case the diff's `hitFiles` set exists to handle.
    addScript(h, 'npm:left-pad@1.3.0/index.js', 'https://esm.example/left-pad/index.js');
    h.domain.setConnected(true);
    await h.dispatcher.dispatch('Debugger.enable', {});

    const bp = await h.dispatcher.dispatch('Debugger.setBreakpointByUrl', {
        url: 'https://esm.example/left-pad/index.js',
        lineNumber: 6,
    }) as { breakpointId: string };
    ok(bp.breakpointId);

    h.events.length = 0;
    h.domain.onPaused({
        reason: 'other',
        // hitFilename is empty/unrelated; only the top frame's scriptId identifies
        // the script. Before the fix hitBreakpoints was always [] here, so DevTools
        // highlighted no breakpoint even though it had stopped at one.
        hitFilename: '',
        hitLine: 7,
        callFrames: [{ location: { scriptId: 'npm:left-pad@1.3.0/index.js', lineNumber: 6 } }],
    } as unknown as Parameters<DebuggerDomain['onPaused']>[0]);

    await new Promise((r) => setTimeout(r, 120));
    const paused = h.events.find((e) => e.method === 'Debugger.paused');
    if (!paused) throw new Error(`no Debugger.paused emitted; saw ${h.events.map((e) => e.method).join(',') || '(none)'}`);
    strictEqual(
        JSON.stringify(paused.params.hitBreakpoints),
        JSON.stringify([bp.breakpointId]),
        'the breakpoint must be reported as hit',
    );
});

Deno.test('debugger: an unconnected pause resumes instead of stranding the main thread', () => {
    const h = newDomain();
    // Not connected: onPaused must resume immediately, or the main thread sits at a
    // safepoint forever with no frontend to release it.
    let resumed = 0;
    const rpc = h.domain as unknown as { rpc: { beginResume: () => void } };
    const originalResume = rpc.rpc.beginResume;
    rpc.rpc.beginResume = (): void => { resumed++; };
    try {
        h.domain.onPaused({ reason: 'other', hitFilename: '/a.ts', hitLine: 1, callFrames: [] } as Parameters<DebuggerDomain['onPaused']>[0]);
        strictEqual(resumed, 1, 'an unconnected pause must resume the program');
    } finally {
        rpc.rpc.beginResume = originalResume;
    }
});

/**
 * `Debugger.setVariableValue` is paused-only in CDP, exactly like its sibling
 * `Debugger.evaluateOnCallFrame` (which also guards, see the test above). Without a
 * guard the RPC reaches `native.setVariable` at `FrameOffset.PausedSetVariable`,
 * an offset only valid while `serviceWhilePaused` is blocked, and
 * `PauseController.normalizeScope` cannot correct the scope number because
 * `scopeChainLengths` is empty until a pause happens — so `scopeNumber:2` lands on
 * the real global scope of a RUNNING program.
 *
 * MEASURED, node v24.18.0, this command while running:
 *   {"error":{"code":-32000,"message":"Invalid call frame id"}}
 * MEASURED, cno BEFORE the guard, over a real WebSocket (never paused, no breakpoint):
 *   setVariableValue{scopeNumber:2,variableName:"SENTINEL"} -> {"result":{}} and a
 *   following Runtime.evaluate showed globalThis.SENTINEL had actually changed.
 *   Clobbering `setTimeout` the same way wedged the runtime: the next
 *   Runtime.evaluate never answered (8s), while a control run that skipped only
 *   that one write answered normally and kept ticking.
 *
 * This test was authored EXPECTED-RED and documented that defect; the guard in
 * debugger.ts now satisfies it. The three assertions below are unchanged from the
 * red version — do not weaken them.
 */
Deno.test('debugger: setVariableValue while running is a protocol error', async () => {
    const h = newDomain();
    await h.dispatcher.dispatch('Debugger.enable', {});
    h.domain.setConnected(true);
    // Never paused. A wrong-state command must be refused, not applied to whatever
    // frame happens to sit at the paused-only offset.
    let thrown: unknown = null;
    try {
        await h.dispatcher.dispatch('Debugger.setVariableValue', {
            scopeNumber: 2,
            variableName: 'SENTINEL',
            newValue: { value: 'CORRUPTED_WHILE_RUNNING' },
            callFrameId: '0',
        });
    } catch (e) {
        thrown = e;
    }
    ok(thrown instanceof CDPError, `setVariableValue while running must be a CDPError, got ${JSON.stringify(thrown)}`);
    strictEqual(
        (thrown as CDPError).code,
        CdpErrorCode.ServerError,
        'a wrong-state command must use the -32000 family, as node does',
    );
    // The RPC must never be issued: reaching the main thread at all is the defect.
    ok(
        !h.calls.includes('setVariableValue'),
        `the setVariableValue RPC must not be sent while running, calls=${JSON.stringify(h.calls)}`,
    );
});

/**
 * A pause that arrives while the socket is attached but `Debugger.enable` has not
 * been sent must NOT be held forever.
 *
 * `connected` and `enabled` are independent: `setConnected(true)` fires on socket
 * attach (worker/connection.ts), `enabled` only on `Debugger.enable`. Two ways to
 * land in `connected && !enabled` with a pause in hand:
 *   1. the --inspect-brk startup race — main/inspector.ts awaits waitForConnection()
 *      (the SOCKET), then arms a breakpoint on entry line 1, so the pause can beat
 *      the frontend's Debugger.enable;
 *   2. a session that never enables Debugger (a console-only frontend) hitting a
 *      `debugger` statement, or a breakpoint/exception breakpoint a PREVIOUS session
 *      left armed — detach clears `enabled` but only Debugger.disable disarms
 *      native breakpoints.
 *
 * MEASURED before the bounded hold, over two sequential real sockets: the debuggee
 * froze indefinitely (tick count pinned at 15 across three round trips) while
 * Runtime.evaluate kept answering over the pause channel, so nothing in the protocol
 * traffic revealed the program had stopped, and no Debugger.paused was ever emitted
 * for anyone to resume from.
 */
Deno.test('debugger: a pause held with Debugger not enabled resumes itself', async () => {
    const h = newDomain();
    h.domain.setConnected(true);          // socket attached; no Debugger.enable
    h.domain.onPaused({ reason: 'other', hitFilename: '/a.ts', hitLine: 1, callFrames: [] } as Parameters<DebuggerDomain['onPaused']>[0]);

    // Case 1 above is why this is a HELD pause and not an immediate resume: an
    // unconditional resume here would make --inspect-brk a coin flip.
    strictEqual(h.pausedFlips.at(-1), true, 'the pause must be held, not resumed on arrival');
    strictEqual(h.resumes, 0, 'no resume while the frontend still might be coming');

    await new Promise((r) => setTimeout(r, GRACE_MS + 400));

    // Case 2 is why the hold is BOUNDED. Without this the main thread stays parked in
    // serviceWhilePaused() with no Debugger.paused ever emitted.
    strictEqual(h.resumes, 1, 'the held pause must release itself once no debugger arrives');
    strictEqual(h.pausedFlips.at(-1), false, 'rpc.setPaused must be returned to false');
    strictEqual(
        h.events.filter((e) => e.method === 'Debugger.paused').length,
        0,
        'a frontend that never enabled Debugger must not receive Debugger.paused',
    );
});

Deno.test('debugger: Debugger.enable inside the grace window still gets the pause', async () => {
    const h = newDomain();
    h.domain.setConnected(true);
    h.domain.onPaused({ reason: 'other', hitFilename: '/a.ts', hitLine: 1, callFrames: [] } as Parameters<DebuggerDomain['onPaused']>[0]);

    // This is the --inspect-brk race: the frontend enables slightly after the pause.
    await new Promise((r) => setTimeout(r, 200));
    await h.dispatcher.dispatch('Debugger.enable', {});
    await new Promise((r) => setTimeout(r, 150));   // INITIAL_PAUSE_SETTLE_MS is 50
    strictEqual(
        h.events.filter((e) => e.method === 'Debugger.paused').length,
        1,
        'the held pause must be delivered to a late-enabling frontend, not dropped',
    );
    strictEqual(h.resumes, 0, 'delivering the held pause must not also resume it');

    // Past where the grace WOULD have fired: enable must have cancelled the timer, or
    // break-on-start would resume itself out from under a frontend that is now
    // sitting at the breakpoint.
    await new Promise((r) => setTimeout(r, GRACE_MS + 400));
    strictEqual(h.resumes, 0, 'the grace timer must be cancelled once Debugger is enabled');
    strictEqual(h.pausedFlips.at(-1), true, 'the program must still be paused for the frontend');
});
