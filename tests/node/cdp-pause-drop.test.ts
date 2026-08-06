/**
 * A dropped `Paused` notify must not freeze the process.
 *
 * The C ring is 64 slots (RING_CAP, circu.js/src/mod_debug.c:102) and `ring_push`
 * returns false when full (mod_debug.c:151); `dc.notify` surfaces that as a
 * boolean (mod_debug.c:934, `JS_NewBool(ctx, ok)`). Previously `notifyQuietly`
 * discarded it and `emit` returned void, so pause-controller could not tell a
 * delivered Paused from a dropped one — and then blocked in serviceWhilePaused()
 * for a resume the worker would never send.
 *
 * This exercises the contract at the transport seam by direct import; the full
 * onBreak path is native and needs a rebuild to observe end-to-end.
 */

import { strictEqual } from 'node:assert';
import { ChannelServer } from '../../src/inspector/transport/channel-rpc';
import { WorkerEvent } from '../../src/inspector/shared/wire';
import { PauseController } from '../../src/inspector/main/pause-controller';
import { BreakReason } from '../../src/inspector/shared/native';

/** Stand-in for the C DebugChannelMain handle. */
function fakeDc(notifyResult: unknown) {
    return {
        notify: () => notifyResult,
        reply: () => true,
        waitRequest: () => null,
        setActive: () => {},
    };
}

Deno.test('pause: ChannelServer.emit reports a dropped notify as false', () => {
    // ring_push returned false (ring full) -> dc.notify returns false.
    const server = new ChannelServer(fakeDc(false) as never);
    strictEqual(server.emit(WorkerEvent.Paused, { reason: 'other' }), false,
        'a dropped Paused must be reported as false, not swallowed');
});

Deno.test('pause: ChannelServer.emit reports a delivered notify as true', () => {
    const server = new ChannelServer(fakeDc(true) as never);
    strictEqual(server.emit(WorkerEvent.Paused, { reason: 'other' }), true);
});

Deno.test('pause: a throwing notify is reported as dropped, not as success', () => {
    const dc = {
        notify: () => { throw new Error('channel gone'); },
        reply: () => true,
        waitRequest: () => null,
        setActive: () => {},
    };
    const server = new ChannelServer(dc as never);
    strictEqual(server.emit(WorkerEvent.Paused, {}), false,
        'a throwing notify must not be treated as delivered');
});

Deno.test('pause: a legacy undefined-returning notify is treated as delivered', () => {
    // Back-compat: an older C binding that returns undefined must not be read as a
    // drop, which would make every breakpoint silently fail to stop.
    const server = new ChannelServer(fakeDc(undefined) as never);
    strictEqual(server.emit(WorkerEvent.Paused, {}), true,
        'only an explicit false counts as a drop');
});

/**
 * Drives the REAL PauseController.onBreak guard (pause-controller.ts:92-96)
 * rather than re-implementing its shape. Only the transport endpoint and the
 * serializer are doubled — those are the seam; the branch under test is the
 * product's own.
 *
 * The previous version of this test built both endpoints AND repeated the
 * `if (delivered !== false)` decision inline, so it asserted its own
 * if-statement and could not fail if pause-controller's guard were deleted.
 * OBSERVED with the 22:44 binary: native.getStackDepth() returns a real depth
 * in-process, so onBreak reaches the guard without a rebuild.
 */
function drivePause(emitResult: boolean): { emitCalls: number; serviceCalls: number; rc: number } {
    let emitCalls = 0;
    let serviceCalls = 0;
    const endpoint = {
        emit: () => { emitCalls++; return emitResult; },
        serviceWhilePaused: () => { serviceCalls++; return 0; },
    } as never;
    const serializer = {
        releaseGroup: () => {},
        serialize: () => ({ type: 'undefined' }),
    } as never;
    const pc = new PauseController(
        endpoint,
        serializer,
        () => true,
        () => ({ scriptId: '1', url: 'file:///pause-drop.ts' }),
    );
    const rc = pc.onBreak(BreakReason.Breakpoint, 'file:///pause-drop.ts', 'fn', 10, 1);
    return { emitCalls, serviceCalls, rc };
}

Deno.test('pause: the controller resumes instead of blocking when Paused is dropped', () => {
    const dropped = drivePause(false);
    strictEqual(dropped.emitCalls, 1, 'onBreak must reach the emit guard (else this test proves nothing)');
    strictEqual(dropped.serviceCalls, 0, 'must not block on a resume that cannot arrive');
    strictEqual(dropped.rc, 0, 'a dropped Paused must continue execution');

    // Positive control: without this, a guard that never blocks would also pass.
    const delivered = drivePause(true);
    strictEqual(delivered.emitCalls, 1);
    strictEqual(delivered.serviceCalls, 1, 'a delivered Paused must still block for the resume');
});
