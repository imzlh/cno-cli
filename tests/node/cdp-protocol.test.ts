import { ok, strictEqual } from 'node:assert';
import { CdpChannel, handleDevToolsConnection, type ConnectionDeps } from '../../src/inspector/worker/connection';
import { CDPDispatcher, CDPError, CdpErrorCode } from '../../src/inspector/worker/dispatcher';
import { ProtocolDomain } from '../../src/inspector/domains/protocol';
import { RuntimeDomain } from '../../src/inspector/domains/runtime';
import { TargetDomain } from '../../src/inspector/domains/target';
import { ConsoleDomain } from '../../src/inspector/domains/console';
import { InspectorProtocolClient } from '../../cno/src/node/inspector/client';
import type { DebuggerDomain } from '../../src/inspector/domains/debugger';
import { FetchDomain } from '../../src/inspector/domains/fetch';
import type { NetworkDomain } from '../../src/inspector/domains/network';
import type { WorkerEndpoint } from '../../src/inspector/transport/worker-endpoint';

/**
 * Build a full ConnectionDeps. Every domain handleDevToolsConnection touches must
 * be present: these were previously built by hand with only debugger+runtime, so
 * the tests kept passing against a ConnectionDeps shape that no longer exists.
 * Names of detached domains are appended to `detached` so a test can assert the
 * detach path actually ran, and for which domains.
 */
function newDeps(
    channel: CdpChannel,
    dispatcher: CDPDispatcher,
    detached: string[] = [],
    rpc?: WorkerEndpoint,
): ConnectionDeps {
    const stub = (name: string) => ({
        setConnected: (connected: boolean) => {
            if (!connected) detached.push(name);
        },
    });
    return {
        channel,
        dispatcher,
        // Must satisfy every WorkerEndpoint member handleDevToolsConnection touches.
        // `notify` is the fire-and-forget path: omitting it threw a TypeError from
        // inside the connection setup, which is exactly the stale-stub failure this
        // helper exists to make impossible to miss.
        rpc: rpc ?? ({ call: () => ({}), notify: () => {} } as unknown as WorkerEndpoint),
        entryUrl: 'about:blank',
        debuggerDomain: stub('debugger') as unknown as DebuggerDomain,
        runtimeDomain: stub('runtime') as unknown as RuntimeDomain,
        consoleDomain: stub('console') as unknown as ConsoleDomain,
        fetchDomain: stub('fetch') as unknown as FetchDomain,
        networkDomain: stub('network') as unknown as NetworkDomain,
    };
}

Deno.test('cdp: unknown methods use protocol method-not-found code', async () => {
    const dispatcher = new CDPDispatcher();
    let caught: unknown;
    try {
        await dispatcher.dispatch('Nope.missing', {});
    } catch (error) {
        caught = error;
    }
    // `ok()` carries no assertion signature in this project (typeRoots is empty, so
    // there are no node ambients), so narrow with a real check before reading .code.
    if (!(caught instanceof CDPError)) throw new Error(`expected a CDPError, got ${String(caught)}`);
    strictEqual(caught.code, CdpErrorCode.MethodNotFound);
});

Deno.test('cdp: protocol support domain answers common DevTools probes', async () => {
    const dispatcher = new CDPDispatcher();
    new ProtocolDomain(dispatcher, () => {});

    const schema = await dispatcher.dispatch('Schema.getDomains', {}) as { domains: Array<{ name: string }> };
    ok(schema.domains.some((domain) => domain.name === 'Runtime'));
    ok(schema.domains.some((domain) => domain.name === 'Debugger'));
    // Browser/Page/DOM identity was intentionally dropped; stay Node-shaped.
    ok(!schema.domains.some((domain) => domain.name === 'Page'));
});

Deno.test('cdp: Runtime.queryObjects returns the RPC RemoteObject shape', async () => {
    const dispatcher = new CDPDispatcher();
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = {
        isPaused: () => false,
        call: (method: string, params: unknown) => {
            calls.push({ method, params });
            return { objects: { type: 'object', subtype: 'array', description: 'Array(0)', objectId: 'obj:1' } };
        },
    } as unknown as WorkerEndpoint;
    new RuntimeDomain(dispatcher, () => {}, rpc);

    const result = await dispatcher.dispatch('Runtime.queryObjects', {
        prototypeObjectId: 'obj:proto',
        objectGroup: 'console',
    }) as { objects: { objectId?: string } };

    strictEqual(result.objects.objectId, 'obj:1');
    strictEqual(calls.length, 1);
    strictEqual(calls[0]?.method, 'queryObjects');
    strictEqual((calls[0]?.params as { prototypeObjectId?: string }).prototypeObjectId, 'obj:proto');
});

Deno.test('cdp: superseded DevTools sockets cannot dispatch commands', async () => {
    const channel = new CdpChannel();
    const dispatcher = new CDPDispatcher();
    let dispatches = 0;
    dispatcher.register('Runtime.evaluate', () => ({ value: ++dispatches }));

    const deps = newDeps(channel, dispatcher);

    const oldSocket = newFakeSocket();
    const activeSocket = newFakeSocket();
    handleDevToolsConnection(oldSocket as unknown as WebSocket, deps);
    handleDevToolsConnection(activeSocket as unknown as WebSocket, deps);

    // The displaced socket must be closed, not left half-attached: its commands
    // are ignored from here on, so a client holding it would hang forever.
    strictEqual(oldSocket.closed, true);
    strictEqual(activeSocket.closed, false);

    oldSocket.receive({ id: 1, method: 'Runtime.evaluate' });
    await tick();
    strictEqual(dispatches, 0);
    strictEqual(oldSocket.sent.length, 0);

    activeSocket.receive({ id: 2, method: 'Runtime.evaluate' });
    await tick();
    strictEqual(dispatches, 1);
    strictEqual(JSON.parse(activeSocket.sent[0]!).result.value, 1);
});

Deno.test('cdp: a socket error detaches every domain, like a close', () => {
    const channel = new CdpChannel();
    const dispatcher = new CDPDispatcher();
    const detached: string[] = [];
    const deps = newDeps(channel, dispatcher, detached);

    const socket = newFakeSocket();
    handleDevToolsConnection(socket as unknown as WebSocket, deps);
    strictEqual(detached.length, 0);

    // A transport error may never be followed by a clean close. Fetch/Debugger
    // hold the program at a paused request/safepoint until they are told to let go.
    socket.onerror?.();
    ok(detached.includes('debugger'), 'debugger must be detached');
    ok(detached.includes('runtime'), 'runtime must be detached');
    ok(detached.includes('console'), 'console must be detached');
    ok(detached.includes('fetch'), 'fetch must be detached');

    // A close arriving after the error must not double-detach.
    const seen = detached.length;
    socket.onclose?.();
    strictEqual(detached.length, seen);
});

Deno.test('cdp: superseding a socket releases the displaced session, not just the socket', async () => {
    // The existing supersede test proves the old SOCKET is closed. Nothing proved the
    // old SESSION is released, and it was not: detach() early-returns on
    // `!channel.isActive(thisSend)`, which is already false by the time the displaced
    // socket's onclose runs (and FakeSocket.close, like a real close handshake, does
    // not fire onclose synchronously at all). So a reconnect left every paused Fetch
    // request from the previous client held forever with nobody able to continue it.
    const channel = new CdpChannel();
    const dispatcher = new CDPDispatcher();
    const settled: Array<{ requestId: string; result: unknown }> = [];
    const record = (method: string, params: unknown): void => {
        if (method === 'fetchInterceptResult') settled.push(params as { requestId: string; result: unknown });
    };
    const rpc = {
        call: (method: string, params: unknown) => { record(method, params); return Promise.resolve({}); },
        notify: (method: string, params: unknown) => { record(method, params); },
        isPaused: () => false,
        setPaused: () => {},
        beginResume: () => {},
        signalInterrupt: () => {},
    } as unknown as WorkerEndpoint;

    const fetchDomain = new FetchDomain(dispatcher, channel.emit, rpc);
    const deps: ConnectionDeps = {
        ...newDeps(channel, dispatcher, [], rpc),
        fetchDomain,
    };

    const first = newFakeSocket();
    handleDevToolsConnection(first as unknown as WebSocket, deps);
    await dispatcher.dispatch('Fetch.enable', {});
    fetchDomain.onInterceptRequest({ requestId: 'held', url: 'http://example.test/x', method: 'GET', headers: {} } as unknown as Parameters<FetchDomain['onInterceptRequest']>[0]);
    strictEqual(settled.length, 0, 'the request must be held while the first client is attached');

    // A second DevTools attaches. The first client is gone; its held request must be
    // let go, or the program waits on that fetch for the rest of its life.
    const second = newFakeSocket();
    handleDevToolsConnection(second as unknown as WebSocket, deps);
    strictEqual(first.closed, true);
    strictEqual(settled.length, 1, 'the displaced session\'s paused request must be released');
    strictEqual(settled[0]?.requestId, 'held');
    strictEqual(settled[0]?.result, null, 'a released request must proceed unchanged');
});

Deno.test('cdp: a new session does not inherit the previous session\'s Fetch interception', async () => {
    // Fetch.enable is per-session state in CDP. If it survives a supersede, the new
    // client starts pausing requests it never asked to intercept and never continues
    // them, because it has no idea they exist.
    const channel = new CdpChannel();
    const dispatcher = new CDPDispatcher();
    const settled: Array<{ requestId: string; result: unknown }> = [];
    const record = (method: string, params: unknown): void => {
        if (method === 'fetchInterceptResult') settled.push(params as { requestId: string; result: unknown });
    };
    const rpc = {
        call: (method: string, params: unknown) => { record(method, params); return Promise.resolve({}); },
        notify: (method: string, params: unknown) => { record(method, params); },
        isPaused: () => false,
        setPaused: () => {},
        beginResume: () => {},
        signalInterrupt: () => {},
    } as unknown as WorkerEndpoint;

    const fetchDomain = new FetchDomain(dispatcher, channel.emit, rpc);
    const deps: ConnectionDeps = { ...newDeps(channel, dispatcher, [], rpc), fetchDomain };

    handleDevToolsConnection(newFakeSocket() as unknown as WebSocket, deps);
    await dispatcher.dispatch('Fetch.enable', {});

    handleDevToolsConnection(newFakeSocket() as unknown as WebSocket, deps);
    settled.length = 0;
    // The new client has sent no Fetch.enable, so this must pass straight through.
    fetchDomain.onInterceptRequest({ requestId: 'after', url: 'http://example.test/y', method: 'GET', headers: {} } as unknown as Parameters<FetchDomain['onInterceptRequest']>[0]);
    strictEqual(settled.length, 1);
    strictEqual(settled[0]?.result, null, 'interception must not carry over into a new session');
});

Deno.test('cdp: malformed params return InvalidParams instead of dispatching with empty params', async () => {
    const channel = new CdpChannel();
    const dispatcher = new CDPDispatcher();
    let dispatches = 0;
    dispatcher.register('Runtime.evaluate', () => {
        dispatches++;
        return {};
    });

    const socket = newFakeSocket();
    handleDevToolsConnection(socket as unknown as WebSocket, newDeps(channel, dispatcher));

    socket.receive({ id: 1, method: 'Runtime.evaluate', params: ['not-object'] });
    await tick();

    strictEqual(dispatches, 0);
    strictEqual(JSON.parse(socket.sent[0]!).error.code, CdpErrorCode.InvalidParams);
});

Deno.test('cdp: Target.sendMessageToTarget dispatches nested commands', async () => {
    const dispatcher = new CDPDispatcher();
    const events: Array<{ method: string; params: unknown }> = [];
    new TargetDomain(dispatcher, (method, params) => events.push({ method, params }));
    dispatcher.register('Runtime.evaluate', () => ({ result: { type: 'number', value: 42 } }));

    await dispatcher.dispatch('Target.sendMessageToTarget', {
        sessionId: 'session-1',
        message: JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { expression: '40 + 2' } }),
    });

    strictEqual(events.length, 1);
    strictEqual(events[0]?.method, 'Target.receivedMessageFromTarget');
    const eventParams = events[0]?.params as { sessionId?: string; message?: string };
    strictEqual(eventParams.sessionId, 'session-1');
    const nested = JSON.parse(eventParams.message ?? '{}');
    strictEqual(nested.id, 7);
    strictEqual(nested.result.result.value, 42);
});

Deno.test('cdp: Target.sendMessageToTarget preserves nested InvalidParams errors', async () => {
    const dispatcher = new CDPDispatcher();
    const events: Array<{ method: string; params: unknown }> = [];
    new TargetDomain(dispatcher, (method, params) => events.push({ method, params }));
    dispatcher.register('Runtime.evaluate', () => ({ result: { type: 'undefined' } }));

    await dispatcher.dispatch('Target.sendMessageToTarget', {
        sessionId: 'session-1',
        message: JSON.stringify({ id: 8, method: 'Runtime.evaluate', params: 'not-object' }),
    });

    strictEqual(events.length, 1);
    const eventParams = events[0]?.params as { message?: string };
    const nested = JSON.parse(eventParams.message ?? '{}');
    strictEqual(nested.id, 8);
    strictEqual(nested.error.code, CdpErrorCode.InvalidParams);
});

Deno.test('cdp: Target domain reports the same target type as discovery', async () => {
    const dispatcher = new CDPDispatcher();
    new TargetDomain(dispatcher, () => {});

    const targets = await dispatcher.dispatch('Target.getTargets', {}) as {
        targetInfos: Array<{ type: string }>
    };
    // discovery listEntry.type is "node" (Node-shaped inspector surface)
    strictEqual(targets.targetInfos[0]?.type, 'node');
});

Deno.test('cdp: node inspector client preserves protocol error codes', async () => {
    const client = new InspectorProtocolClient();
    let caught: (Error & { code?: number }) | null = null;
    try {
        await client.post('Nope.missing');
    } catch (error) {
        caught = error as Error & { code?: number };
    }
    ok(caught instanceof Error);
    strictEqual(caught?.code, -32601);
});

Deno.test('cdp: Console.enable does not replay already emitted live messages', async () => {
    const dispatcher = new CDPDispatcher();
    const events: Array<{ method: string; params: unknown }> = [];
    const domain = new ConsoleDomain(dispatcher, (method, params) => events.push({ method, params }));

    await dispatcher.dispatch('Console.enable', {});
    domain.onConsole('log', [{ type: 'string', value: 'live' }], 1);
    await dispatcher.dispatch('Console.disable', {});
    await dispatcher.dispatch('Console.enable', {});

    const messages = events.filter((event) => event.method === 'Console.messageAdded');
    strictEqual(messages.length, 1);
});

class FakeSocket {
    sent: string[] = [];
    closed = false;
    onmessage?: (ev: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;

    send(data: string): void {
        this.sent.push(data);
    }

    /** handleDevToolsConnection closes the socket it displaces. */
    close(): void {
        this.closed = true;
    }

    receive(message: Record<string, unknown>): void {
        this.onmessage?.({ data: JSON.stringify(message) });
    }
}

function newFakeSocket(): FakeSocket {
    return new FakeSocket();
}

async function tick(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}
