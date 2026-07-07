import { ok, strictEqual } from 'node:assert';
import { CdpChannel, handleDevToolsConnection } from '../../src/inspector/worker/connection';
import { CDPDispatcher, CDPError, CdpErrorCode } from '../../src/inspector/worker/dispatcher';
import { ProtocolDomain } from '../../src/inspector/domains/protocol';
import { RuntimeDomain } from '../../src/inspector/domains/runtime';
import { TargetDomain } from '../../src/inspector/domains/target';
import { PageDomain } from '../../src/inspector/domains/page';
import { ConsoleDomain } from '../../src/inspector/domains/console';
import { InspectorProtocolClient } from '../../cno/src/node/inspector/client';
import type { WorkerEndpoint } from '../../src/inspector/transport/worker-endpoint';

Deno.test('cdp: unknown methods use protocol method-not-found code', async () => {
    const dispatcher = new CDPDispatcher();
    let caught: unknown;
    try {
        await dispatcher.dispatch('Nope.missing', {});
    } catch (error) {
        caught = error;
    }
    ok(caught instanceof CDPError);
    strictEqual(caught.code, CdpErrorCode.MethodNotFound);
});

Deno.test('cdp: protocol support domain answers common DevTools probes', async () => {
    const dispatcher = new CDPDispatcher();
    new ProtocolDomain(dispatcher, () => {});

    const schema = await dispatcher.dispatch('Schema.getDomains', {}) as { domains: Array<{ name: string }> };
    ok(schema.domains.some((domain) => domain.name === 'Runtime'));

    const version = await dispatcher.dispatch('Browser.getVersion', {}) as { product: string; protocolVersion: string };
    strictEqual(version.protocolVersion, '1.3');
    ok(version.product.startsWith('cno/'));

    const document = await dispatcher.dispatch('DOM.getDocument', {}) as { root: { nodeName: string; nodeId: number } };
    strictEqual(document.root.nodeName, '#document');
    strictEqual(document.root.nodeId, 1);
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

    const rpc = { call: () => ({}) } as unknown as WorkerEndpoint;
    const debuggerDomain = { setConnected: () => {} } as unknown as DebuggerDomain;
    const runtimeDomain = { setConnected: () => {} } as unknown as RuntimeDomain;
    const pageDomain = { setConnected: () => {}, onConnected: () => {} } as unknown as PageDomain;
    const deps = { channel, dispatcher, rpc, entryUrl: 'about:blank', debuggerDomain, runtimeDomain, pageDomain };

    const oldSocket = newFakeSocket();
    const activeSocket = newFakeSocket();
    handleDevToolsConnection(oldSocket as unknown as WebSocket, deps);
    handleDevToolsConnection(activeSocket as unknown as WebSocket, deps);

    oldSocket.receive({ id: 1, method: 'Runtime.evaluate' });
    await tick();
    strictEqual(dispatches, 0);
    strictEqual(oldSocket.sent.length, 0);

    activeSocket.receive({ id: 2, method: 'Runtime.evaluate' });
    await tick();
    strictEqual(dispatches, 1);
    strictEqual(JSON.parse(activeSocket.sent[0]!).result.value, 1);
});

Deno.test('cdp: malformed params return InvalidParams instead of dispatching with empty params', async () => {
    const channel = new CdpChannel();
    const dispatcher = new CDPDispatcher();
    let dispatches = 0;
    dispatcher.register('Runtime.evaluate', () => {
        dispatches++;
        return {};
    });

    const rpc = { call: () => ({}) } as unknown as WorkerEndpoint;
    const debuggerDomain = { setConnected: () => {} } as unknown as DebuggerDomain;
    const runtimeDomain = { setConnected: () => {} } as unknown as RuntimeDomain;
    const pageDomain = { setConnected: () => {}, onConnected: () => {} } as unknown as PageDomain;
    const socket = newFakeSocket();
    handleDevToolsConnection(socket as unknown as WebSocket, {
        channel,
        dispatcher,
        rpc,
        entryUrl: 'about:blank',
        debuggerDomain,
        runtimeDomain,
        pageDomain,
    });

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
    strictEqual(targets.targetInfos[0]?.type, 'page');
});

Deno.test('cdp: Page.disable does not forget parsed script resources', async () => {
    const dispatcher = new CDPDispatcher();
    const rpc = { call: () => ({ content: '', base64Encoded: false }) } as unknown as WorkerEndpoint;
    const page = new PageDomain(dispatcher, () => {}, rpc);

    page.onScriptParsed('file:///tmp/main.ts');
    await dispatcher.dispatch('Page.enable', {});
    await dispatcher.dispatch('Page.disable', {});
    await dispatcher.dispatch('Page.enable', {});

    const tree = await dispatcher.dispatch('Page.getResourceTree', {}) as {
        frameTree: { resources: Array<{ url: string }> }
    };
    ok(tree.frameTree.resources.some((resource) => resource.url === 'file:///tmp/main.ts'));
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
    onmessage?: (ev: { data: string }) => void;
    onclose?: () => void;

    send(data: string): void {
        this.sent.push(data);
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
