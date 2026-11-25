import { doesNotThrow, ok, rejects, strictEqual } from 'node:assert';
import { Hooks } from '../../src/inspector/main/hooks';
import { Inspector } from '../../src/inspector/main/inspector';
import { Serializer } from '../../src/inspector/main/remote-object';
import { Evaluator } from '../../src/inspector/main/evaluator';
import { WorkerEndpoint } from '../../src/inspector/transport/worker-endpoint';
import { PipeKind } from '../../src/inspector/shared/wire';
import {
    getFetchHook, getFetchInterceptHook, getServeHook, getWebSocketHook,
} from '../../cno/src/utils/network-hooks';

function newHooks(): Hooks {
    return new Hooks({ emit: () => true } as never, new Serializer());
}

for (const failingResource of ['load listener', 'console']) {
    Deno.test(`inspector cleanup: a throwing ${failingResource} cannot retain other hooks`, () => {
        const hooks = newHooks();
        const originalConsole = Object.getOwnPropertyDescriptor(globalThis.console, 'log')!;
        const originalRemove = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener')!;
        const originals = new Map<PropertyKey, PropertyDescriptor>();
        for (const key of Reflect.ownKeys(globalThis.console)) {
            originals.set(key, Object.getOwnPropertyDescriptor(globalThis.console, key)!);
        }
        hooks.installAll();
        const loadListener = Reflect.get(hooks, 'loadListener');
        let failure: unknown;
        try {
            if (failingResource === 'load listener') {
                Object.defineProperty(globalThis, 'removeEventListener', {
                    configurable: true,
                    value: () => { throw new Error('listener removal failed'); },
                });
            } else {
                Object.defineProperty(globalThis.console, 'log', {
                    configurable: true,
                    get: () => originalConsole.value,
                    set: () => { throw new Error('console restoration failed'); },
                });
            }
            try { hooks.teardown(); } catch (error) { failure = error; }
            ok(failure, 'cleanup failures must remain observable');
            strictEqual(getFetchHook(), null);
            strictEqual(getServeHook(), null);
            strictEqual(getWebSocketHook(), null);
            strictEqual(getFetchInterceptHook(), null);
            strictEqual(import.meta.use('evbus').get('cno.inspector', 'networkHooks'), undefined);
            for (const count of Object.values(hooks.memoryUsage())) strictEqual(count, 0);
        } finally {
            Object.defineProperty(globalThis, 'removeEventListener', originalRemove);
            Reflect.apply(originalRemove.value, globalThis, ['load', loadListener]);
            for (const key of Reflect.ownKeys(globalThis.console)) {
                if (!originals.has(key)) Reflect.deleteProperty(globalThis.console, key);
            }
            for (const [key, descriptor] of originals) Object.defineProperty(globalThis.console, key, descriptor);
            hooks.teardown();
        }
    });
}

Deno.test('inspector cleanup: a hook failure still stops the worker and rejects lifecycle waiters', async () => {
    const inspector = new Inspector({ port: 0, entryFile: 'cleanup.ts' });
    let stops = 0;
    let joins = 0;
    const debugWorker = {
        messagePipe: { unref() {} },
        stop: () => { stops++; },
        terminate: () => { joins++; },
    };
    Reflect.set(inspector, 'state', 'active');
    Reflect.set(inspector, 'worker', debugWorker);
    Reflect.set(inspector, 'hooks', { teardown: () => { throw new Error('hook teardown failed'); } });
    const connection = rejects(inspector.waitForConnection(), /force-stopped/);
    const debuggerReady = rejects(inspector.waitForDebugger(), /force-stopped/);
    doesNotThrow(() => inspector.forceStop());
    strictEqual(stops, 1);
    strictEqual(joins, 1);
    strictEqual(Reflect.get(inspector, 'state'), 'idle');
    await Promise.all([connection, debuggerReady]);
});

Deno.test('inspector bindings: only successfully installed globals may be removed', () => {
    const hooks = newHooks();
    const name = '__inspectorReadonlyBindingTest';
    Object.defineProperty(globalThis, name, { value: 42, writable: false, configurable: true });
    try {
        hooks.removeBinding(name);
        strictEqual(Reflect.get(globalThis, name), 42, 'an unregistered name is not owned by the inspector');
        let failure: unknown;
        try { hooks.installBinding(name); } catch (error) { failure = error; }
        ok(failure, 'a rejected Reflect.set must not be reported as a successful binding');
        hooks.removeBinding(name);
        strictEqual(Reflect.get(globalThis, name), 42);
        hooks.teardown();
        strictEqual(Reflect.get(globalThis, name), 42);
        Reflect.deleteProperty(globalThis, name);
        hooks.installBinding(name);
        strictEqual(typeof Reflect.get(globalThis, name), 'function', 'a later installation may retry');
        hooks.removeBinding(name);
        strictEqual(Object.hasOwn(globalThis, name), false);
    } finally {
        hooks.teardown();
        Reflect.deleteProperty(globalThis, name);
    }
});

Deno.test('inspector transport: a stopped native channel cannot retain event listeners or pending RPCs', async () => {
    const pipe = { postMessage() {}, onclose: undefined as (() => void) | undefined };
    const endpoint = new WorkerEndpoint(pipe as never, {
        send: () => true,
        stop: () => { throw new Error('channel already gone'); },
    } as never);
    endpoint.onEvent = () => {};
    const running = rejects(endpoint.call('evaluate', { expression: '1' }), /pipe closed/);
    endpoint.setPaused(true);
    const paused = rejects(endpoint.call('evaluate', { expression: '2' }), /pipe closed/);
    doesNotThrow(() => pipe.onclose!());
    strictEqual(endpoint.onEvent, null);
    await Promise.all([running, paused]);
    await rejects(endpoint.call('evaluate', { expression: '3' }), /pipe closed/);
    doesNotThrow(() => endpoint.dispose());
});

Deno.test('inspector transport: resume settles queued replies before rejecting paused requests', async () => {
    const replies: unknown[] = [];
    const sent: Array<{ id: number; method: string }> = [];
    const pipe = { postMessage() {}, onmessage: undefined as ((message: unknown) => void) | undefined };
    const endpoint = new WorkerEndpoint(pipe as never, {
        send: (id: number, method: string) => { sent.push({ id, method }); return true; },
        recv: () => replies.shift() ?? null,
        waitRecv() {},
        stop() {},
    } as never);
    const native = import.meta.use('debug');
    try {
        endpoint.setPaused(true);
        const released = endpoint.call('releaseObjectGroup', { objectGroup: 'backtrace' });
        const interrupted = rejects(endpoint.call('evaluate', { expression: '1' }), /Execution resumed/);
        replies.push({ kind: native.RES_REPLY, id: sent[0].id, payload: { result: 'released' } });
        endpoint.setPaused(false);
        strictEqual(await released, 'released');
        await interrupted;
        const running = endpoint.call('evaluate', { expression: '2' });
        pipe.onmessage!({ kind: PipeKind.RpcRes, id: 1, result: 2 });
        strictEqual(await running, 2, 'running RPC switches back to the pipe');
        endpoint.notify('ready', { wsUrl: 'ws://127.0.0.1/' });
        endpoint.dispose();
        endpoint.notify('ready', { wsUrl: 'ws://127.0.0.1/' });
        await Promise.resolve();
    } finally {
        endpoint.dispose();
    }
});

Deno.test('inspector serialization: unreadable values keep their handles and readable preview siblings', () => {
    const serializer = new Serializer();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('prototype unavailable'); } });
    for (const value of [proxy, hostile]) {
        const remote = serializer.serialize(value, 'backtrace', { preview: true });
        ok(remote.objectId);
        strictEqual(serializer.resolve(remote.objectId), value);
        const parent = serializer.serialize({ bad: value, keep: 7 }, 'backtrace', { preview: true });
        ok(parent.preview?.properties.some(property => property.name === 'keep' && property.value === '7'));
        serializer.releaseGroup('backtrace');
        strictEqual(serializer.has(remote.objectId), false);
    }
    const error = new Error('readable message');
    Object.defineProperty(error, 'stack', { get: () => { throw new Error('stack unavailable'); } });
    const remote = serializer.serialize(error, 'runtime', { preview: true });
    ok(remote.preview?.properties.some(property => property.name === 'message' && property.value === 'readable message'));
    strictEqual(typeof serializer.serialize({ constructor: { name: 42 } }).className, 'string');
});

Deno.test('inspector evaluator: a hostile thrown value is still an evaluation reply', async () => {
    const serializer = new Serializer();
    const evaluator = new Evaluator(serializer);
    const result = await evaluator.evaluate({
        expression: `(() => { const error = new Error('bad'); Object.defineProperty(error, 'message', { get() { throw 'unreadable message'; } }); throw error; })()`,
    });
    ok(result.exceptionDetails);
    ok(result.result.objectId);
    strictEqual(serializer.has(result.result.objectId), true);
});
