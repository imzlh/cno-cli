import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpClient, counterDelta, discoverTarget, monitor, parseOptions } from './monitor-memory-cdp.mjs';

test('monitor options accept both forms and reject invalid limits', () => {
    const options = parseOptions(['--inspect', 'ws://localhost:9229/token', '--interval=20', '--duration=0', '--gc-every', '3']);
    assert.equal(options.interval, 20);
    assert.equal(options.duration, 0);
    assert.equal(options.gcEvery, 3);
    assert.equal(options.inspect, 'ws://localhost:9229/token');
    for (const args of [['--interval=0'], ['--duration=-1'], ['--gc-every=1.5'], ['--timeout=NaN'], ['--interval'], ['--wrong'], ['--inspect=file:///foo']]) {
        assert.throws(() => parseOptions(args));
    }
});

class Socket extends EventTarget {
    sent = [];
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.dispatchEvent(new Event('close')); }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}

test('CDP client ignores events, matches replies, preserves errors and rejects closed calls', async () => {
    const socket = new Socket();
    const client = new CdpClient(socket, 500);
    const first = client.call('CNO.getMemoryUsage');
    socket.message({ method: 'Network.dataReceived', params: { requestId: 'stream' } });
    socket.message({ id: socket.sent[0].id, result: { memory: 100 } });
    assert.deepEqual(await first, { memory: 100 });
    const second = client.call('HeapProfiler.takeHeapSnapshot');
    socket.message({ id: socket.sent[1].id, error: { code: -32000, message: 'unsupported' } });
    await assert.rejects(second, error => error.code === -32000 && /unsupported/.test(error.message));
    const pending = client.call('CNO.getMemoryUsage');
    client.close();
    await assert.rejects(pending, /closed/);
    await assert.rejects(client.call('CNO.getMemoryUsage'), /closed/);
});

test('CDP timed-out requests discard late replies and leave later requests usable', async () => {
    const socket = new Socket();
    const client = new CdpClient(socket, 10);
    await assert.rejects(client.call('Slow.method'), /no CDP reply/);
    socket.message({ id: socket.sent[0].id, result: {} });
    const later = client.call('CNO.getMemoryUsage');
    socket.message({ id: socket.sent[1].id, result: { good: true } });
    assert.deepEqual(await later, { good: true });
    client.close();
});

test('monitor samples after GC separately and keeps only numeric baseline counters', async () => {
    const controller = new AbortController();
    const calls = [];
    const rows = [];
    const values = [200, 100, 260, 130];
    const client = { call: async method => {
        calls.push(method);
        if (method === 'HeapProfiler.collectGarbage') return {};
        return { runtime: 'QuickJS', scope: 'main', memory: { 'vm.used': values.shift(), 'os.rss': 1000, 'object.count': 10 }, inspector: { objectCount: 0 }, referencedHandleCount: 2 };
    } };
    const summary = await monitor(client, { interval: 1, duration: 0, gcEvery: 1 }, async row => {
        rows.push(row);
        if (rows.length === 2) controller.abort();
    }, controller.signal);
    assert.equal(summary.samples, 2);
    assert.equal(rows[0].reclaimedBytes, 100);
    assert.equal(rows[1].afterGC.delta.memory['vm.used'], 30);
    assert.equal(rows[1].delta.memory['vm.used'], 60);
    assert.equal(calls.filter(method => method === 'HeapProfiler.collectGarbage').length, 4);
    assert.deepEqual(counterDelta({ number: 20, noBaseline: 30, label: 'x' }, { number: 10 }), { number: 10 });
});

test('monitor explains why an old inspector cannot provide trustworthy GC readings', async () => {
    const client = { call: async () => { throw Object.assign(new Error('unknown method'), { code: -32601 }); } };
    await assert.rejects(() => monitor(client, { duration: 1 }, () => {}), /Rebuild cno.*no-op/);
    assert.equal(await discoverTarget('ws://localhost:9229/token', 100), 'ws://localhost:9229/token');
});
