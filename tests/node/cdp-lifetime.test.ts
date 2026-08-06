/**
 * Object-store lifetime and pipe-RPC failure modes, both driven against the
 * working tree (`src/inspector/**`) rather than the CDP code baked into cno.exe.
 *
 * These two files are what a long DevTools session leans on: the store holds real
 * JS references behind obj:N ids, and the pipe carries every inspect RPC while the
 * program runs. A leak in the first grows without bound; a dropped reply in the
 * second wedges DevTools with no error shown.
 */

import { ok, rejects, strictEqual } from 'node:assert';
import { ObjectStore } from '../../src/inspector/main/object-store';
import { Inspector } from '../../src/inspector/main/inspector';
import { PipeClient, PipeServer } from '../../src/inspector/transport/pipe-rpc';
import { PipeKind } from '../../src/inspector/shared/wire';

/** Reach the private groups map; there is no public accessor and none is wanted. */
function groupCount(store: ObjectStore): number {
    return (Reflect.get(store, 'groups') as Map<string, Set<string>>).size;
}

function storeSize(store: ObjectStore): number {
    return (Reflect.get(store, 'store') as Map<string, unknown>).size;
}

Deno.test('object-store: releasing the last member drops the group', () => {
    const store = new ObjectStore();
    const id = store.add({ a: 1 }, 'group-1');
    strictEqual(groupCount(store), 1);

    store.release(id);
    strictEqual(storeSize(store), 0);
    // Group names come straight from DevTools' objectGroup param. Before this was
    // fixed an emptied group left its Set behind forever, so a session that used
    // many group names grew the map without bound.
    strictEqual(groupCount(store), 0, 'an emptied group must not linger');
});

Deno.test('object-store: many distinct groups do not accumulate once released', () => {
    const store = new ObjectStore();
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) ids.push(store.add({ i }, `group-${i}`));
    strictEqual(groupCount(store), 500);

    for (const id of ids) store.release(id);
    strictEqual(storeSize(store), 0);
    strictEqual(groupCount(store), 0, 'releasing every object must leave no groups');
});

Deno.test('object-store: releaseGroup clears both the entries and the group', () => {
    const store = new ObjectStore();
    const a = store.add({ a: 1 }, 'backtrace');
    const b = store.add({ b: 2 }, 'backtrace');
    const keep = store.add({ c: 3 }, 'console');

    store.releaseGroup('backtrace');
    strictEqual(store.resolve(a), undefined);
    strictEqual(store.resolve(b), undefined);
    // Releasing one group must not touch another.
    ok(store.resolve(keep) !== undefined, 'an unrelated group must survive');
    strictEqual(groupCount(store), 1);
    strictEqual(storeSize(store), 1);

    // Releasing an unknown group is a no-op, not a throw: DevTools sends stale ids.
    store.releaseGroup('never-existed');
    strictEqual(storeSize(store), 1);
});

Deno.test('object-store: releasing an unknown id is a no-op', () => {
    const store = new ObjectStore();
    const id = store.add({ a: 1 }, 'g');
    store.release('obj:99999');
    store.release(id);
    store.release(id); // double release must not throw or corrupt the maps
    strictEqual(storeSize(store), 0);
    strictEqual(groupCount(store), 0);
});

Deno.test('object-store: the store is bounded and eviction keeps groups consistent', () => {
    const store = new ObjectStore();
    // MAX_STORE_SIZE is memory-tier dependent (1000/3000/10000), so drive well past
    // the largest tier and assert the invariant rather than a specific cap.
    for (let i = 0; i < 12_000; i++) store.add({ i }, `g-${i % 8}`);

    ok(storeSize(store) <= 10_000, `store must stay bounded, got ${storeSize(store)}`);
    // Eviction goes through release(), so an evicted id must never be left behind in
    // a group Set — otherwise the group map grows even though the store is capped.
    const groups = Reflect.get(store, 'groups') as Map<string, Set<string>>;
    let tracked = 0;
    for (const ids of groups.values()) {
        for (const id of ids) {
            ok(store.has(id), `group holds ${id} which is no longer in the store`);
            tracked++;
        }
    }
    strictEqual(tracked, storeSize(store), 'group membership must match the store exactly');
});

/** Minimal MessagePipe stand-in; records what was posted and lets a test inject. */
class FakePipe {
    posted: unknown[] = [];
    onmessage: ((data: unknown) => void) | undefined;
    onmessageerror: ((data: unknown) => void) | undefined;
    throwOnPost: Error | null = null;

    postMessage(data: unknown): void {
        if (this.throwOnPost) throw this.throwOnPost;
        this.posted.push(data);
    }
    ref(): void {}
    unref(): void {}
    get [Symbol.toStringTag](): 'MessagePipe' { return 'MessagePipe'; }
}

function newPipe(): FakePipe {
    return new FakePipe();
}

Deno.test('inspector: completed entries release the debug worker loop hold', () => {
    const inspector = Object.create(Inspector.prototype) as Inspector;
    let unrefs = 0;
    Reflect.set(inspector, 'worker', {
        messagePipe: { unref: () => { unrefs++; } },
    });

    inspector.allowProcessExit();
    strictEqual(unrefs, 1, 'the debug pipe must not keep a completed program alive');
});

Deno.test('pipe-rpc: a pipe error rejects everything in flight', async () => {
    const pipe = newPipe();
    const client = new PipeClient(pipe as unknown as CModuleWorker.MessagePipe);

    // Attach the rejection handlers BEFORE faulting the pipe. failAllPending
    // rejects synchronously, and a promise with no handler at that instant is
    // reported as an unhandled rejection even though a later await would catch it.
    const first = client.call('evaluate', { expression: '1' });
    const second = client.call('getProperties', { objectId: 'obj:1' });
    const settled = Promise.all([
        first.then(() => 'resolved', (e: unknown) => String(e)),
        second.then(() => 'resolved', (e: unknown) => String(e)),
    ]);

    // Without this, a pipe fault leaves both promises pending forever and every CDP
    // command waiting on one hangs — DevTools shows a spinner and no error. This is
    // the same contract ChannelClient.setActive(false) already had.
    pipe.onmessageerror?.('EPIPE');

    const [a, b] = await settled;
    ok(a.includes('inspector pipe error'), `first must reject with the pipe error, got ${a}`);
    ok(b.includes('inspector pipe error'), `second must reject with the pipe error, got ${b}`);

    // Idempotent: a second fault on a drained map must not throw.
    pipe.onmessageerror?.('EPIPE again');
});

Deno.test('pipe-rpc: a failed post does not leak the pending entry', async () => {
    const pipe = newPipe();
    const client = new PipeClient(pipe as unknown as CModuleWorker.MessagePipe);
    pipe.throwOnPost = new Error('pipe is closed');

    await rejects(() => client.call('evaluate', { expression: '1' }), /pipe is closed/);
    // The promise rejected, so the map entry must go with it; otherwise it is leaked
    // for the life of the worker and a later reply reusing the id resolves a dead one.
    strictEqual((Reflect.get(client, 'pending') as Map<number, unknown>).size, 0);
});

Deno.test('pipe-rpc: an unknown method still gets a reply', async () => {
    const pipe = newPipe();
    new PipeServer(pipe as unknown as CModuleWorker.MessagePipe);

    // Silently dropping this would strand the caller's promise: it is keyed on the
    // id and nothing else will ever settle it.
    await pipe.onmessage?.({ kind: PipeKind.RpcReq, id: 7, method: 'notARealMethod', params: {} });
    const reply = pipe.posted.find((m) => Reflect.get(m as object, 'id') === 7) as Record<string, unknown>;
    ok(reply, 'an unknown method must still produce a reply for its id');
    strictEqual(reply.kind, PipeKind.RpcRes);
    ok(String(reply.error).includes('unknown rpc method'), `got ${String(reply.error)}`);
});

Deno.test('pipe-rpc: a request with no usable id is dropped, not answered', async () => {
    const pipe = newPipe();
    new PipeServer(pipe as unknown as CModuleWorker.MessagePipe);

    // No id means no pending promise to strand, and replying would be malformed.
    await pipe.onmessage?.({ kind: PipeKind.RpcReq, method: 'evaluate', params: {} });
    await pipe.onmessage?.({ kind: PipeKind.RpcReq, id: 'not-a-number', method: 'evaluate' });
    strictEqual(pipe.posted.length, 0);
});

Deno.test('pipe-rpc: a handler throw becomes an error reply, not an unhandled rejection', async () => {
    const pipe = newPipe();
    const server = new PipeServer(pipe as unknown as CModuleWorker.MessagePipe);
    server.onRequest = () => { throw new Error('handler exploded'); };

    await pipe.onmessage?.({ kind: PipeKind.RpcReq, id: 3, method: 'evaluate', params: {} });
    const reply = pipe.posted.find((m) => Reflect.get(m as object, 'id') === 3) as Record<string, unknown>;
    ok(reply, 'a throwing handler must still answer');
    strictEqual(reply.error, 'handler exploded');
});

Deno.test('pipe-rpc: garbage messages are ignored without throwing', async () => {
    const pipe = newPipe();
    const server = new PipeServer(pipe as unknown as CModuleWorker.MessagePipe);
    let handled = 0;
    server.onRequest = () => { handled++; return {}; };

    // A hostile or buggy peer must not be able to crash the runtime from here.
    for (const junk of [null, undefined, 42, 'string', [], {}, { kind: 999 }, { kind: PipeKind.RpcReq }]) {
        await pipe.onmessage?.(junk);
    }
    strictEqual(handled, 0);
    strictEqual(pipe.posted.length, 0);
});

Deno.test('pipe-rpc: a reply for an unknown id is ignored', () => {
    const pipe = newPipe();
    const client = new PipeClient(pipe as unknown as CModuleWorker.MessagePipe);
    // A late or forged reply must not throw; there is simply nothing to settle.
    pipe.onmessage?.({ kind: PipeKind.RpcRes, id: 4242, result: {} });
    strictEqual((Reflect.get(client, 'pending') as Map<number, unknown>).size, 0);
});
