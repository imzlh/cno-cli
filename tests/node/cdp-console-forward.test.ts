/**
 * In-process tests for Runtime.consoleAPICalled forwarding.
 *
 * `Runtime.consoleAPICalled` used to be emitted straight from `event-router.ts`,
 * ungated and unbuffered. Both halves were wrong, and both are MEASURED against
 * real node v24.18.0 driving its own --inspect socket against a target that logged
 * every 300ms:
 *
 *   A) attached, Runtime.enable NEVER called, 1.5s  -> 0 consoleAPICalled
 *   B) attached, waited 1.5s, THEN Runtime.enable   -> 11 at once, "tick 1".."tick 11"
 *   C) Console.enable only                          -> 0 consoleAPICalled, 15 messageAdded
 *   D) Runtime.enable immediately                   -> 20, live
 *
 * So node gates the event on Runtime.enable AND replays what was missed. cno did
 * neither: it emitted to clients that never subscribed, and anything logged before
 * the enable (or while detached) was lost — modern DevTools reads
 * Runtime.consoleAPICalled and treats the Console domain as deprecated, so
 * ConsoleDomain's separate backlog never surfaced it.
 */

import { ok, strictEqual } from 'node:assert';
import { RuntimeDomain } from '../../src/inspector/domains/runtime';
import { ConsoleDomain } from '../../src/inspector/domains/console';
import { CDPDispatcher } from '../../src/inspector/worker/dispatcher';
import type { WorkerEndpoint } from '../../src/inspector/transport/worker-endpoint';
import type { ConsolePayload } from '../../src/inspector/shared/wire';

interface Emitted { method: string; params: Record<string, unknown> }

interface Harness {
    domain: RuntimeDomain;
    dispatcher: CDPDispatcher;
    events: Emitted[];
    consoleApi(): Emitted[];
}

function newRuntime(): Harness {
    const dispatcher = new CDPDispatcher();
    const events: Emitted[] = [];
    const rpc = {
        call: () => Promise.resolve({}),
        notify: () => {},
        isPaused: () => false,
    } as unknown as WorkerEndpoint;
    const domain = new RuntimeDomain(
        dispatcher,
        (method: string, params: unknown) => { events.push({ method, params: params as Record<string, unknown> }); },
        rpc,
    );
    return {
        domain,
        dispatcher,
        events,
        consoleApi: () => events.filter((e) => e.method === 'Runtime.consoleAPICalled'),
    };
}

function log(h: Harness, text: string): void {
    h.domain.onConsole({
        method: 'log',
        args: [{ type: 'string', value: text }],
        timestamp: 1000,
        callFrames: [],
    } as unknown as ConsolePayload);
}

/** The text of each forwarded message, in order. */
function texts(h: Harness): string[] {
    return h.consoleApi().map((e) => {
        const args = e.params.args as Array<{ value?: unknown }>;
        return String(args[0]?.value);
    });
}

Deno.test('console forward: nothing is emitted before Runtime.enable', () => {
    const h = newRuntime();
    // MEASURED case A: node sent 0 consoleAPICalled to a session that never enabled
    // Runtime. cno emitted unconditionally, so a frontend that only used the Debugger
    // domain still received console traffic it never subscribed to.
    log(h, 'before-1');
    log(h, 'before-2');
    strictEqual(h.consoleApi().length, 0, 'consoleAPICalled must be gated on Runtime.enable');
});

Deno.test('console forward: Runtime.enable replays what was missed', async () => {
    const h = newRuntime();
    // MEASURED case B: 11 messages logged before the enable all arrived at once,
    // in order, immediately after Runtime.enable.
    log(h, 'tick 1');
    log(h, 'tick 2');
    log(h, 'tick 3');
    strictEqual(h.consoleApi().length, 0);

    await h.dispatcher.dispatch('Runtime.enable', {});
    strictEqual(h.consoleApi().length, 3, 'every buffered message must be replayed');
    strictEqual(texts(h).join(','), 'tick 1,tick 2,tick 3', 'and in the original order');
});

Deno.test('console forward: messages are live once enabled', async () => {
    const h = newRuntime();
    await h.dispatcher.dispatch('Runtime.enable', {});
    log(h, 'live-1');
    log(h, 'live-2');
    strictEqual(texts(h).join(','), 'live-1,live-2', 'MEASURED case D: live forwarding');
});

Deno.test('console forward: the replay is not repeated on a second enable', async () => {
    const h = newRuntime();
    log(h, 'once');
    await h.dispatcher.dispatch('Runtime.enable', {});
    strictEqual(h.consoleApi().length, 1);
    // A redundant enable must not duplicate the console, the same way
    // Debugger.enable must not re-replay scriptParsed.
    await h.dispatcher.dispatch('Runtime.enable', {});
    strictEqual(h.consoleApi().length, 1, 'the backlog must be consumed, not re-sent');
});

Deno.test('console forward: detach buffers again so a reattach sees output', async () => {
    const h = newRuntime();
    await h.dispatcher.dispatch('Runtime.enable', {});
    log(h, 'session-1');
    strictEqual(h.consoleApi().length, 1);

    // DevTools leaves. `enabled` is per-session state in V8, so it must reset —
    // otherwise these two messages are emitted into a dead sink and lost for good.
    h.domain.setConnected(false);
    log(h, 'while-detached-1');
    log(h, 'while-detached-2');
    strictEqual(h.consoleApi().length, 1, 'nothing may be emitted while detached');

    // Reattach.
    h.domain.setConnected(true);
    await h.dispatcher.dispatch('Runtime.enable', {});
    strictEqual(texts(h).join(','), 'session-1,while-detached-1,while-detached-2',
        'a reattaching frontend must receive what it missed');
});

Deno.test('console forward: Runtime.disable stops forwarding', async () => {
    const h = newRuntime();
    await h.dispatcher.dispatch('Runtime.enable', {});
    log(h, 'a');
    await h.dispatcher.dispatch('Runtime.disable', {});
    log(h, 'b');
    strictEqual(texts(h).join(','), 'a', 'a disabled Runtime must not forward');
});

Deno.test('console forward: the backlog is bounded', () => {
    const h = newRuntime();
    // A process that logs in a loop while nothing is attached must not grow the
    // buffer forever. Bound matches ConsoleDomain's MAX_BACKLOG (300 at the normal
    // memory tier), oldest-first.
    for (let i = 0; i < 2000; i++) log(h, `m${i}`);
    void h.dispatcher.dispatch('Runtime.enable', {});
    const count = h.consoleApi().length;
    ok(count > 0, 'some messages must survive');
    ok(count <= 500, `the backlog must be bounded, replayed ${count}`);
    // Oldest dropped, newest kept: the last message logged must be present.
    ok(texts(h).includes('m1999'), 'the most recent message must be retained');
});

Deno.test('console forward: the level mapping is preserved', async () => {
    const h = newRuntime();
    await h.dispatcher.dispatch('Runtime.enable', {});
    for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
        h.domain.onConsole({
            method, args: [{ type: 'string', value: method }], timestamp: 1, callFrames: [],
        } as unknown as ConsolePayload);
    }
    const types = h.consoleApi().map((e) => String(e.params.type));
    // consoleAPICalledType maps the raw console method to a CDP type; `warn`
    // becomes `warning` in CDP.
    strictEqual(types.length, 5);
    ok(types.includes('warning'), `warn must map to the CDP warning type, got ${JSON.stringify(types)}`);
    ok(types.includes('error'), 'error must be preserved');
});

Deno.test('console forward: Console and Runtime domains buffer independently', async () => {
    // Both domains keep their own backlog and their own enable flag, exactly as CDP
    // defines them. MEASURED case C: Console.enable alone yielded 15
    // Console.messageAdded and 0 Runtime.consoleAPICalled, so the two are genuinely
    // separate subscriptions and neither may be driven off the other's flag.
    const dispatcher = new CDPDispatcher();
    const events: Emitted[] = [];
    const emit = (method: string, params: unknown): void => {
        events.push({ method, params: params as Record<string, unknown> });
    };
    const rpc = { call: () => Promise.resolve({}), notify: () => {}, isPaused: () => false } as unknown as WorkerEndpoint;
    const runtime = new RuntimeDomain(dispatcher, emit, rpc);
    const consoleDomain = new ConsoleDomain(dispatcher, emit);

    const payload = {
        method: 'log', args: [{ type: 'string', value: 'x' }], timestamp: 1, callFrames: [],
    } as unknown as ConsolePayload;
    consoleDomain.onConsole(payload.method, payload.args, payload.timestamp, payload.callFrames);
    runtime.onConsole(payload);

    // Console.enable only: messageAdded flows, consoleAPICalled does not.
    await dispatcher.dispatch('Console.enable', {});
    strictEqual(events.filter((e) => e.method === 'Console.messageAdded').length, 1);
    strictEqual(events.filter((e) => e.method === 'Runtime.consoleAPICalled').length, 0,
        'Console.enable must not turn on Runtime forwarding');

    await dispatcher.dispatch('Runtime.enable', {});
    strictEqual(events.filter((e) => e.method === 'Runtime.consoleAPICalled').length, 1,
        'Runtime.enable must replay its own backlog');
});
