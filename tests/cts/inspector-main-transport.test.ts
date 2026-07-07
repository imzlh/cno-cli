import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { ObjectStore } from '../../src/inspector/main/object-store.ts';
import { Serializer } from '../../src/inspector/main/remote-object.ts';
import { PipeClient, PipeServer } from '../../src/inspector/transport/pipe-rpc.ts';
import { PipeKind, WorkerEvent, type PipeMsg } from '../../src/inspector/shared/wire.ts';

class FakePipe {
    peer: FakePipe | null = null;
    sent: unknown[] = [];
    onmessage: ((msg: unknown) => void) | null = null;
    onmessageerror: ((err: unknown) => void) | null = null;

    postMessage(message: unknown): void {
        this.sent.push(message);
        queueMicrotask(() => this.peer?.onmessage?.(message));
    }
}

function pipePair(): [FakePipe, FakePipe] {
    const a = new FakePipe();
    const b = new FakePipe();
    a.peer = b;
    b.peer = a;
    return [a, b];
}

Deno.test('inspector pipe rpc: client calls server handlers and resolves replies', async () => {
    const [workerPipe, mainPipe] = pipePair();
    const client = new PipeClient(workerPipe as unknown as CModuleWorker.MessagePipe);
    const server = new PipeServer(mainPipe as unknown as CModuleWorker.MessagePipe);
    server.onRequest = (method, params) => ({ method, params });

    const result = await client.call('evaluate', { expression: '1 + 1' } as any);
    deepStrictEqual(result, {
        method: 'evaluate',
        params: { expression: '1 + 1' },
    });
    strictEqual((workerPipe.sent[0] as PipeMsg).kind, PipeKind.RpcReq);
    strictEqual((mainPipe.sent[0] as PipeMsg).kind, PipeKind.RpcRes);
});

Deno.test('inspector pipe rpc: server errors reject pending client calls', async () => {
    const [workerPipe, mainPipe] = pipePair();
    const client = new PipeClient(workerPipe as unknown as CModuleWorker.MessagePipe);
    const server = new PipeServer(mainPipe as unknown as CModuleWorker.MessagePipe);
    server.onRequest = () => {
        throw new Error('handler failed');
    };

    let err: Error | null = null;
    try {
        await client.call('evaluate', {} as any);
    } catch (e) {
        err = e as Error;
    }
    strictEqual(err?.message, 'handler failed');
});

Deno.test('inspector pipe rpc: events flow from server to client listener', async () => {
    const [workerPipe, mainPipe] = pipePair();
    const client = new PipeClient(workerPipe as unknown as CModuleWorker.MessagePipe);
    const server = new PipeServer(mainPipe as unknown as CModuleWorker.MessagePipe);

    const seen = new Promise<{ event: WorkerEvent; params: unknown }>((resolve) => {
        client.onEvent = (event, params) => resolve({ event, params });
    });
    server.emit(WorkerEvent.ScriptParsed, { url: 'file:///tmp/main.ts' });

    deepStrictEqual(await seen, {
        event: WorkerEvent.ScriptParsed,
        params: { url: 'file:///tmp/main.ts' },
    });
});

Deno.test('inspector object store: release object and group are idempotent', () => {
    const store = new ObjectStore();
    const first = store.add({ a: 1 }, 'console');
    const second = store.add({ b: 2 }, 'console');
    const other = store.add({ c: 3 }, 'watch');

    strictEqual(store.has(first), true);
    strictEqual(store.groupOf(first), 'console');
    store.release(first);
    strictEqual(store.has(first), false);
    store.release(first);

    store.releaseGroup('console');
    strictEqual(store.has(second), false);
    strictEqual(store.has(other), true);
    store.releaseGroup('missing');
});

Deno.test('inspector serializer: primitives and object ids match CDP RemoteObject shape', () => {
    const serializer = new Serializer();

    deepStrictEqual(serializer.serialize(undefined), { type: 'undefined' });
    deepStrictEqual(serializer.serialize(-0), { type: 'number', unserializableValue: '-0', description: '0' });
    deepStrictEqual(serializer.serialize(NaN), { type: 'number', unserializableValue: 'NaN', description: 'NaN' });
    deepStrictEqual(serializer.serialize(12n), { type: 'bigint', unserializableValue: '12n', description: '12n' });

    const value = { label: 'stored' };
    const remote = serializer.serialize(value, 'console');
    strictEqual(remote.type, 'object');
    ok(remote.objectId);
    strictEqual(serializer.resolve(remote.objectId!), value);
    serializer.releaseGroup('console');
    strictEqual(serializer.has(remote.objectId!), false);
});

Deno.test('inspector serializer: previews and property descriptors include own data and accessors', () => {
    const serializer = new Serializer();
    const value: any = { a: 1, b: 'two' };
    Object.defineProperty(value, 'computed', {
        enumerable: true,
        configurable: true,
        get() { return 3; },
    });

    const remote = serializer.serialize(value, 'props', { preview: true });
    ok(remote.objectId);
    strictEqual(remote.preview?.type, 'object');
    ok(remote.preview?.properties.some((prop) => prop.name === 'a' && prop.value === '1'));
    ok(remote.preview?.properties.some((prop) => prop.name === 'computed' && prop.value === '3'));

    const props = serializer.getProperties(remote.objectId!, 'props').result;
    const names = props.map((prop) => prop.name).sort();
    deepStrictEqual(names, ['a', 'b', 'computed']);
    const computed = props.find((prop) => prop.name === 'computed')!;
    strictEqual(computed.isOwn, true);
    strictEqual(computed.get?.type, 'function');
    strictEqual(computed.value, undefined);
});

Deno.test('inspector serializer: map previews expose entry previews and overflow', () => {
    const serializer = new Serializer();
    const map = new Map<unknown, unknown>();
    for (let i = 0; i < 6; i++) map.set(`k${i}`, { value: i });

    const remote = serializer.serialize(map, 'maps', { preview: true });
    strictEqual(remote.subtype, 'map');
    strictEqual(remote.preview?.entries?.length, 5);
    strictEqual(remote.preview?.overflow, true);
    strictEqual(remote.preview?.entries?.[0]?.key?.type, 'object');
    strictEqual(remote.preview?.entries?.[0]?.value?.description, 'Object');
});
