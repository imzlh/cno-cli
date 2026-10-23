import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { ProtocolDomain } from '../../src/inspector/domains/protocol';
import { Evaluator } from '../../src/inspector/main/evaluator';
import { Hooks } from '../../src/inspector/main/hooks';
import { PauseController } from '../../src/inspector/main/pause-controller';
import { Serializer } from '../../src/inspector/main/remote-object';
import { registerRpcHandlers } from '../../src/inspector/main/rpc-handlers';
import { transportOf } from '../../src/inspector/shared/rpc-contract';
import type { MainEndpoint, RpcHandlerTable } from '../../src/inspector/transport/main-endpoint';
import type { WorkerEndpoint } from '../../src/inspector/transport/worker-endpoint';
import { CDPDispatcher, CDPError, CdpErrorCode } from '../../src/inspector/worker/dispatcher';

const engine = import.meta.use('engine');
const os = import.meta.use('os');

function mainHandlers(): { handlers: RpcHandlerTable; serializer: Serializer; hooks: Hooks } {
    let handlers: RpcHandlerTable = {};
    const endpoint = {
        registerMany: (table: RpcHandlerTable) => { handlers = table; },
    } as unknown as MainEndpoint;
    const serializer = new Serializer();
    const hooks = new Hooks(endpoint, serializer);
    registerRpcHandlers(endpoint, {
        serializer,
        hooks,
        evaluator: new Evaluator(serializer),
        pauseController: new PauseController(endpoint, serializer, () => false, () => ({ scriptId: '', url: '' })),
        onReady: () => {},
        onConnectedChange: () => {},
        onRuntimeReady: () => {},
        onWorkerError: () => {},
    });
    return { handlers, serializer, hooks };
}

Deno.test('cdp memory: counters and collection route to the inspected runtime', async () => {
    const dispatcher = new CDPDispatcher();
    const calls: string[] = [];
    const sample = { runtime: 'QuickJS', memory: { 'vm.used': 1234, 'os.rss': 5678 } };
    const rpc = {
        call: async (method: string) => {
            calls.push(method);
            return method === 'getMemoryUsage' ? sample : {};
        },
    } as unknown as WorkerEndpoint;
    new ProtocolDomain(dispatcher, () => {}, rpc);

    strictEqual(await dispatcher.dispatch('CNO.getMemoryUsage', {}), sample);
    deepStrictEqual(await dispatcher.dispatch('HeapProfiler.collectGarbage', {}), {});
    deepStrictEqual(calls, ['getMemoryUsage', 'collectGarbage']);
    strictEqual(transportOf('getMemoryUsage'), 'inspect');
    strictEqual(transportOf('collectGarbage'), 'inspect');
});

Deno.test('cdp memory: unsupported heap snapshots and tracking return an explicit error', async () => {
    const dispatcher = new CDPDispatcher();
    new ProtocolDomain(dispatcher, () => {}, { call: () => ({}) } as unknown as WorkerEndpoint);
    for (const method of ['takeHeapSnapshot', 'startTrackingHeapObjects', 'stopTrackingHeapObjects']) {
        await rejects(() => dispatcher.dispatch(`HeapProfiler.${method}`, {}), (error: unknown) =>
            error instanceof CDPError && error.code === CdpErrorCode.ServerError && /not supported by QuickJS/.test(error.message));
    }
});

Deno.test('cdp memory: collection really reclaims unreachable cycles', () => {
    const { handlers } = mainHandlers();
    const threshold = engine.gc.getThreshold();
    engine.gc.run();
    engine.gc.setThreshold(1_000_000_000);
    try {
        function discardCycle(): void {
            const cycle: { payload: Uint8Array; self?: unknown } = { payload: new Uint8Array(64 * 1024) };
            cycle.self = cycle;
        }
        const before = os.memoryUsage()['vm.used'];
        for (let i = 0; i < 64; i++) discardCycle();
        const allocated = os.memoryUsage()['vm.used'];
        ok(allocated - before > 3 * 1024 * 1024, 'the unreclaimed cycles must retain their payloads');
        deepStrictEqual(handlers.collectGarbage!({}), {});
        const collected = os.memoryUsage()['vm.used'];
        ok(allocated - collected > 3 * 1024 * 1024, 'CDP collection must release cycles in the main runtime');
    } finally {
        engine.gc.setThreshold(threshold);
        engine.gc.run();
    }
});

Deno.test('cdp memory: counters include observer references and retained stream previews', () => {
    const { handlers, serializer, hooks } = mainHandlers();
    serializer.add({ retained: true }, 'memory-test');
    hooks.enableStreamingForRequest('live-fetch', 'fetch');
    hooks.enableStreamingForRequest('live-serve', 'serve');
    const bodies = Reflect.get(hooks, 'completedFetchBodies') as Map<string, { data: Uint8Array; createdAt: number }>;
    bodies.set('preview', { data: new Uint8Array(321), createdAt: Date.now() });
    const sample = handlers.getMemoryUsage!({}) as {
        runtime: string;
        scope: string;
        timestamp: number;
        memory: CModuleOS.MemoryUsage;
        referencedHandleCount: number;
        inspector: Record<string, number>;
    };
    strictEqual(sample.runtime, 'QuickJS');
    strictEqual(sample.scope, 'main');
    ok(sample.timestamp > 0);
    ok(sample.memory['vm.used'] > 0);
    ok(sample.memory['os.rss'] > 0);
    strictEqual(sample.referencedHandleCount, os.refHandleCount());
    strictEqual(sample.inspector.objectCount, 1);
    strictEqual(sample.inspector.objectGroupCount, 1);
    strictEqual(sample.inspector.completedFetchBodyCount, 1);
    strictEqual(sample.inspector.completedFetchBodyBytes, 321);
    strictEqual(sample.inspector.liveFetchStreamCount, 1);
    strictEqual(sample.inspector.liveServeStreamCount, 1);

    serializer.releaseGroup('memory-test');
    hooks.teardown();
    const after = handlers.getMemoryUsage!({}) as { inspector: Record<string, number> };
    for (const [name, value] of Object.entries(after.inspector)) strictEqual(value, 0, `${name} must clear after teardown`);
});

Deno.test('cdp memory: heap total reports allocated memory instead of an unlimited heap limit', () => {
    const { handlers } = mainHandlers();
    const heap = handlers.getHeapUsage!({}) as { usedSize: number; totalSize: number };
    ok(heap.usedSize > 0);
    ok(heap.totalSize >= heap.usedSize);
    ok(Number.isFinite(heap.totalSize));
    const memory = os.memoryUsage();
    ok(Math.abs(heap.usedSize - memory['vm.used']) < 64 * 1024);
    ok(Math.abs(heap.totalSize - Math.max(memory.used, memory['vm.used'])) < 64 * 1024);
});
