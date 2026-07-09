import { strictEqual } from 'node:assert';
import { NetworkDomain } from '../../src/inspector/domains/network.ts';
import { CDPDispatcher } from '../../src/inspector/worker/dispatcher.ts';
import type { WorkerEndpoint } from '../../src/inspector/transport/worker-endpoint.ts';
import { NetFetchKind, NetServeKind, type ConsoleCallFrame } from '../../src/inspector/shared/wire.ts';

Deno.test('inspector network: fetch and serve requests expose initiator stacks', async () => {
    const dispatcher = new CDPDispatcher();
    const events: Array<{ method: string; params: unknown }> = [];
    const rpc = { call: () => ({ body: '', base64Encoded: false }) } as unknown as WorkerEndpoint;
    const network = new NetworkDomain(dispatcher, (method, params) => events.push({ method, params }), rpc);
    const callFrames: ConsoleCallFrame[] = [{
        functionName: 'loadData',
        scriptId: 'file:///tmp/app.ts',
        url: 'file:///tmp/app.ts',
        lineNumber: 4,
        columnNumber: 8,
    }];

    await dispatcher.dispatch('Network.enable', {});
    network.onFetchEvent({
        ev: NetFetchKind.Req,
        source: 'fetch',
        requestId: 'fetch-1',
        timestamp: 1,
        url: 'https://example.test/data',
        method: 'GET',
        headers: {},
        callFrames,
        resourceType: 'Fetch',
    });
    network.onServeEvent({
        ev: NetServeKind.Req,
        source: 'serve',
        requestId: 'serve-1',
        timestamp: 2,
        url: 'http://127.0.0.1:8000/api',
        method: 'POST',
        headers: {},
        callFrames,
    });

    const requestEvents = events.filter((event) => event.method === 'Network.requestWillBeSent');
    strictEqual(requestEvents.length, 2);
    const [fetchEvent, serveEvent] = requestEvents.map((event) => event.params as {
        requestId: string;
        initiator: {
            type?: string;
            url?: string;
            lineNumber?: number;
            columnNumber?: number;
            stack?: { callFrames?: ConsoleCallFrame[] };
        };
    });
    strictEqual(fetchEvent?.requestId, 'fetch-1');
    strictEqual(fetchEvent?.initiator.type, 'script');
    strictEqual(fetchEvent?.initiator.url, 'file:///tmp/app.ts');
    strictEqual(fetchEvent?.initiator.lineNumber, 4);
    strictEqual(fetchEvent?.initiator.columnNumber, 8);
    strictEqual(fetchEvent?.initiator.stack?.callFrames?.[0]?.functionName, 'loadData');
    strictEqual(serveEvent?.requestId, 'serve-1');
    strictEqual(serveEvent?.initiator.type, 'script');
    strictEqual(serveEvent?.initiator.url, 'file:///tmp/app.ts');
    strictEqual(serveEvent?.initiator.stack?.callFrames?.[0]?.url, 'file:///tmp/app.ts');
});
