// @cno-host: false
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

// Transform only these two modules: native transports are fixture boundaries,
// while the real Hooks implementation and wire enum values stay under test.
function compile(path) {
    return transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2024',
        define: { 'import.meta.use': '__useNative' },
    }).code;
}
const hooksCode = compile('../../src/inspector/main/hooks.ts');
const wireModule = { exports: {} };
runInNewContext(compile('../../src/inspector/shared/wire.ts'), { module: wireModule });
const wire = wireModule.exports;

function fixture({ preview = 16, budget = 8 } = {}) {
    const clock = { now: 200_000 };
    const callbacks = {};
    const events = [];
    const allocations = [];
    const copies = [];
    const control = { budget: String(budget), throwEmit: false };
    const bus = { set() {}, delete() {} };
    const modules = {
        '../../../cno/src/utils/memory-tier': {
            getTierLimits: () => ({ inspectorPreviewBodyBytes: preview, maxPendingBodyBytes: 8 }),
        },
        '../../../cno/src/utils/network-hooks': {
            setFetchHook: hook => { callbacks.fetch = hook; },
            setServeHook: hook => { callbacks.serve = hook; },
            setWebSocketHook: hook => { callbacks.websocket = hook; },
            setFetchInterceptHook: hook => { callbacks.intercept = hook; },
            getFetchHook: () => callbacks.fetch,
            getServeHook: () => callbacks.serve,
            captureUserNetworkCallFrames: () => undefined,
        },
        '../../../cts/src/utils/memfs': {},
        '../../../cts/src/utils/path': {},
        '../shared/native': { native: {} },
        '../shared/console-utils': {},
        '../shared/user-files': {},
        '../shared/wire': wire,
        '../../env': { readEnv: () => control.budget },
    };
    const module = { exports: {} };
    runInNewContext(hooksCode, {
        module,
        require(path) {
            assert.ok(Object.hasOwn(modules, path), `unexpected dependency: ${path}`);
            return modules[path];
        },
        __useNative: name => name === 'evbus' ? bus : {},
        Date: { now: () => clock.now },
        Uint8Array: new Proxy(Uint8Array, {
            construct(target, args) {
                allocations.push(args[0]);
                return Reflect.construct(target, args);
            },
        }),
    });
    const hooks = new module.exports.Hooks({
        emit(ev, params) {
            if (control.throwEmit) throw new Error('worker gone');
            events.push({ ev, params });
        },
    }, {});
    const copyBytes = hooks.copyBytes;
    hooks.copyBytes = function(data) {
        copies.push(data.byteLength);
        return copyBytes.call(this, data);
    };
    hooks.installNetwork();
    return {
        hooks, states: hooks.bodySources, callbacks, events, copies, allocations, clock, control,
        data(source, requestId, bytes) {
            const data = Uint8Array.from(bytes);
            callbacks[source].onData({ requestId, data, timestamp: clock.now / 1000 });
            return data;
        },
        finish(source, requestId, extra = {}) {
            callbacks[source].onFinished({ requestId, success: true, timestamp: clock.now / 1000, ...extra });
            return events.at(-1)?.params;
        },
        resetCopies() { copies.length = 0; allocations.length = 0; },
    };
}

const bytesOf = chunks => chunks === undefined ? undefined : Array.from(chunks, chunk => [...chunk]);

test('hooks body states retain source-specific events, metadata and independent counters', () => {
    const f = fixture();
    const connection = { remoteIPAddress: '127.0.0.1', remotePort: 443 };
    for (const source of ['fetch', 'serve']) {
        const info = { requestId: 'same', timestamp: 1, url: 'https://example.test/', method: 'GET', headers: {} };
        f.callbacks[source].onRequest({ ...info, postData: null, resourceType: 'XHR' });
        f.callbacks[source].onResponse({ ...info, status: 200, statusText: 'OK', resourceType: 'XHR', connection });
    }
    assert.deepEqual(f.events.map(event => [event.ev, event.params.ev, event.params.source]), [
        [wire.WorkerEvent.NetFetch, wire.NetFetchKind.Req, 'fetch'],
        [wire.WorkerEvent.NetFetch, wire.NetFetchKind.Res, 'fetch'],
        [wire.WorkerEvent.NetServe, wire.NetServeKind.Req, 'serve'],
        [wire.WorkerEvent.NetServe, wire.NetServeKind.Res, 'serve'],
    ]);
    assert.equal(f.events[0].params.postData, undefined);
    assert.equal(f.events[0].params.resourceType, 'XHR');
    assert.equal(f.events[1].params.connection, connection);
    assert.equal(f.events[3].params.statusText, 'OK');
    assert.ok(!Object.hasOwn(f.events[3].params, 'connection'));
    f.events.length = 0;
    f.data('fetch', 'same', [1, 2]);
    f.data('serve', 'same', [3, 4, 5]);
    assert.equal(f.events.length, 0, 'buffered chunks do not emit Data events');
    assert.equal(f.hooks.memoryUsage().fetchBodyBufferBytes, 2);
    assert.equal(f.hooks.memoryUsage().serveBodyBufferBytes, 3);
    const fetchDone = f.finish('fetch', 'same', { connection, success: false, errorText: 'failed' });
    assert.deepEqual(structuredClone(fetchDone), {
        ev: wire.NetFetchKind.Done, source: 'fetch', requestId: 'same', timestamp: 200,
        success: false, errorText: 'failed', connection, body: [new Uint8Array([1, 2])], totalBytes: 2,
    });
    assert.equal(f.states.serve.bytes, 3, 'finishing fetch must not clear the same serve id');
    const serveDone = f.finish('serve', 'same', { connection });
    assert.equal(serveDone.ev, wire.NetServeKind.Done);
    assert.equal(serveDone.source, 'serve');
    assert.equal(serveDone.totalBytes, 3);
    assert.deepEqual(bytesOf(serveDone.body), [[3, 4, 5]]);
    assert.ok(!Object.hasOwn(serveDone, 'connection'));
    assert.deepEqual(f.events.map(event => event.ev), [wire.WorkerEvent.NetFetch, wire.WorkerEvent.NetServe]);
});

for (const source of ['fetch', 'serve']) {
    test(`hooks ${source}: copy only buffered or live bytes, keep dropped-byte totals`, () => {
        const f = fixture({ budget: 32 });
        const state = f.states[source];
        const first = f.data(source, 'body', [1, 2, 3, 4]);
        first.fill(255);
        assert.deepEqual([...state.buffers.get('body').chunks[0]], [1, 2, 3, 4]);
        assert.deepEqual(f.copies, [4]);
        f.resetCopies();
        f.data(source, 'body', new Uint8Array(13));
        assert.deepEqual(f.copies, [], 'preview overflow must not copy discarded input');
        assert.deepEqual(f.allocations.filter(size => size > 0), []);
        assert.equal(state.buffers.get('body').total, 0, 'preview truncation retains its reaper placeholder');
        assert.equal(state.bytes, 0);
        assert.deepEqual([...state.completed.get('body').data], [1, 2, 3, 4]);
        f.data(source, 'body', new Uint8Array(5));
        assert.deepEqual(f.copies, [], 'already-dropped chunks must not be copied');
        assert.deepEqual(f.events.map(({ params }) => [params.source, params.data.byteLength, params.byteLength]),
            [[source, 0, 13], [source, 0, 5]]);
        const event = source === 'fetch' ? wire.WorkerEvent.NetFetch : wire.WorkerEvent.NetServe;
        const kind = source === 'fetch' ? wire.NetFetchKind.Data : wire.NetServeKind.Data;
        assert.ok(f.events.every(({ ev, params }) => ev === event && params.ev === kind && params.timestamp === 200));

        assert.deepEqual([...f.hooks.enableStreamingForRequest('body', source)], [1, 2, 3, 4]);
        state.dropped.add('body'); // Live streaming takes precedence if both flags are present.
        f.resetCopies();
        const live = f.data(source, 'body', [7, 8, 9]);
        live.fill(255);
        assert.deepEqual(f.copies, [3]);
        assert.deepEqual([...f.events.at(-1).params.data], [7, 8, 9]);
        assert.equal(f.finish(source, 'body').totalBytes, 25);
        assert.equal(state.totals.size, 0);
        assert.equal(state.live.size, 0);
        assert.equal(state.dropped.size, 0);
        assert.equal(f.hooks.streamRegisteredAt.size, 0);
    });

    test(`hooks ${source}: capacity evicts other requests FIFO before the current buffer`, () => {
        const f = fixture();
        const state = f.states[source];
        f.data(source, 'current', [1, 2, 3, 4]);
        f.data(source, 'older', [5, 6]);
        f.data(source, 'newer', [7, 8]);
        const current = state.buffers.get('current');
        f.data(source, 'current', [9, 10, 11]);
        assert.equal(state.buffers.get('current'), current, 'the caller-held buffer must remain attached');
        assert.deepEqual([...state.completed.keys()], ['older', 'newer']);
        assert.deepEqual([...state.buffers.keys()], ['current']);
        assert.equal(state.bytes, 7);
        f.resetCopies();
        f.data(source, 'current', [12, 13]);
        assert.deepEqual(f.copies, [], 'capacity rejection must not copy incoming bytes');
        assert.equal(state.buffers.size, 0, 'capacity drops do not leave preview placeholders');
        assert.equal(state.bytes, 0, 'no orphaned buffer may inflate the counter');
        assert.deepEqual([...state.completed.keys()], ['older', 'newer', 'current']);
        assert.equal(f.finish(source, 'current').totalBytes, 9);
    });

    test(`hooks ${source}: handoff owns single chunks and merges multiple chunks only once`, () => {
        for (const [name, chunks, completed] of [
            ['empty', []],
            ['single', [new Uint8Array([1, 2])]],
            ['multi', [new Uint8Array([1, 2]), new Uint8Array([3])]],
            ['completed', [new Uint8Array([99])], new Uint8Array([4, 5])],
            ['empty completed', [new Uint8Array([99])], new Uint8Array(0)],
        ]) {
            const f = fixture();
            const state = f.states[source];
            const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
            state.buffers.set('handoff', { chunks, total, createdAt: f.clock.now });
            state.bytes = total;
            if (completed !== undefined) state.completed.set('handoff', { data: completed, createdAt: f.clock.now });
            const originals = completed !== undefined ? [completed] : chunks;
            const expected = originals.flatMap(chunk => [...chunk]);
            const data = f.hooks.takeBodyBuffer(state, 'handoff');
            assert.deepEqual([...data], expected, name);
            assert.equal(f.copies.length, originals.length === 1 ? 1 : 0, name);
            assert.deepEqual(f.allocations, [expected.length], `${name}: exactly one owned output allocation`);
            for (const original of originals) assert.notEqual(data.buffer, original.buffer, name);
            assert.equal(state.buffers.size, 0);
            assert.equal(state.completed.size, 0);
            assert.equal(state.bytes, 0);
            assert.equal(f.hooks.takeBodyBuffer(state, 'handoff').byteLength, 0);
        }
    });

    test(`hooks ${source}: completed previews are capped FIFO and Done preserves absent/empty bodies`, () => {
        const f = fixture({ preview: 2 });
        const state = f.states[source];
        assert.equal(f.finish(source, 'absent').body, undefined);
        f.data(source, 'zero-chunk', []);
        assert.deepEqual(bytesOf(f.finish(source, 'zero-chunk').body), [[]]);
        for (let i = 0; i < 52; i++) {
            f.data(source, `r${i}`, [i]);
            f.data(source, `r${i}`, [1, 2]);
        }
        assert.equal(state.completed.size, 50);
        assert.equal(state.completed.keys().next().value, 'r2');
        assert.equal(state.bytes, 0);
        assert.deepEqual(bytesOf(f.finish(source, 'r0').body), [], 'evicted preview leaves an empty placeholder');
        const done = f.finish(source, 'r51');
        assert.deepEqual(bytesOf(done.body), [[51]]);
        assert.equal(done.totalBytes, 3);
    });

    test(`hooks ${source}: TTL cutoffs, cleanup throttle and shared stream timestamps stay intact`, () => {
        const f = fixture();
        const state = f.states[source];
        for (const [id, age, total] of [['old', 120_001, 1], ['boundary', 120_000, 1], ['truncated', 30_001, 0], ['trunc-boundary', 30_000, 0]]) {
            state.buffers.set(id, { chunks: total ? [new Uint8Array(total)] : [], total, createdAt: f.clock.now - age });
            state.bytes += total;
            state.totals.set(id, total + 1);
            state.dropped.add(id);
        }
        for (const [id, age] of [['old', 120_001], ['boundary', 120_000], ['truncated', 30_001]]) {
            state.completed.set(id, { data: new Uint8Array(1), createdAt: f.clock.now - age });
        }
        f.hooks.enableStreamingForRequest('lost');
        f.hooks.streamRegisteredAt.set('lost', f.clock.now - 120_001);
        f.hooks.enableStreamingForRequest('guarded', source);
        f.hooks.streamRegisteredAt.set('guarded', f.clock.now - 120_001);
        const other = f.states[source === 'fetch' ? 'serve' : 'fetch'];
        other.buffers.set('guarded', { chunks: [new Uint8Array(1)], total: 1, createdAt: f.clock.now });
        other.bytes = 1;
        f.hooks.cleanupStaleBodyBuffers();
        assert.deepEqual([...state.buffers.keys()], ['boundary', 'trunc-boundary']);
        assert.deepEqual([...state.totals.keys()], ['boundary', 'trunc-boundary']);
        assert.deepEqual([...state.dropped], ['boundary', 'trunc-boundary']);
        assert.equal(state.bytes, 1);
        assert.deepEqual([...state.completed.keys()], ['boundary', 'truncated']);
        assert.ok(!f.states.fetch.live.has('lost') && !f.states.serve.live.has('lost'));
        assert.ok(state.live.has('guarded'), 'another source buffer protects the shared stream timestamp');
        assert.ok(f.hooks.streamRegisteredAt.has('guarded'));
        f.clock.now += 29_999;
        f.hooks.cleanupStaleBodyBuffers();
        assert.equal(state.buffers.size, 2, 'cleanup is throttled for strictly less than 30 s');
        f.clock.now++;
        f.hooks.cleanupStaleBodyBuffers();
        assert.equal(state.buffers.size, 0);
        assert.equal(state.bytes, 0);
        assert.deepEqual([...state.completed.keys()], ['truncated']);
    });
}

test('hooks streaming source selection and legacy combined history stay independent', () => {
    const f = fixture();
    f.data('fetch', 'same', [1, 2]);
    f.data('serve', 'same', [3, 4]);
    assert.deepEqual([...f.hooks.enableStreamingForRequest('same')], [1, 2, 3, 4]);
    assert.equal(f.states.fetch.bytes + f.states.serve.bytes, 0);
    assert.ok(f.states.fetch.live.has('same') && f.states.serve.live.has('same'));
    f.clock.now++;
    assert.equal(f.hooks.enableStreamingForRequest('same').byteLength, 0);
    assert.equal(f.hooks.streamRegisteredAt.get('same'), f.clock.now);
    f.hooks.enableStreamingForRequest('fetch-only', 'fetch');
    assert.ok(!f.states.serve.live.has('fetch-only'));
    f.hooks.enableStreamingForRequest('serve-only', 'serve');
    assert.ok(!f.states.fetch.live.has('serve-only'));
    f.finish('fetch', 'same');
    assert.ok(f.states.serve.live.has('same'));
    assert.ok(!f.hooks.streamRegisteredAt.has('same'), 'Done retains the existing shared timestamp deletion semantics');
});

test('hooks pending-byte limit still reads changing environment values with the same fallback', () => {
    const f = fixture();
    for (const [value, expected] of [[null, 8], ['', 8], ['0', 8], ['-1', 8], ['invalid', 8], ['Infinity', 8], ['16.9', 16], ['0.5', 0]]) {
        f.control.budget = value;
        assert.equal(f.hooks.maxPendingBodyBytes(), expected);
    }
});

test('hooks keep cleanup reliable when the worker is gone and teardown drains both sources', () => {
    const f = fixture();
    f.control.throwEmit = true;
    for (const source of ['fetch', 'serve']) {
        f.hooks.enableStreamingForRequest('live', source);
        assert.doesNotThrow(() => f.data(source, 'live', [1, 2]));
        assert.doesNotThrow(() => f.finish(source, 'live'));
        f.data(source, 'pending', [3]);
        f.states[source].completed.set('completed', { data: new Uint8Array(2), createdAt: f.clock.now });
        f.states[source].dropped.add('dropped');
    }
    let resumed = 0;
    f.hooks.pendingIntercepts.set('pending', result => { assert.equal(result, null); resumed++; });
    assert.doesNotThrow(() => f.hooks.teardown());
    assert.equal(resumed, 1);
    for (const value of Object.values(f.hooks.memoryUsage())) assert.equal(value, 0);
    for (const state of Object.values(f.states)) {
        for (const [name, value] of Object.entries(state)) assert.equal(name === 'bytes' ? value : value.size, 0);
    }
    assert.equal(f.hooks.streamRegisteredAt.size, 0);
    assert.ok(Object.values(f.callbacks).every(hook => hook === null));
});
