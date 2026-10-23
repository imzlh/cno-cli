import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createUpstream } from './streaming-upstream.mjs';
import { runLoad } from './streaming-load.mjs';

async function fixture(t, options) {
    const { server, stats } = createUpstream(options);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => { server.close(); server.closeAllConnections(); });
    return { url: `http://127.0.0.1:${server.address().port}`, stats };
}

test('normal and slow consumers receive every byte and release upstream connections', { timeout: 10000 }, async t => {
    const { url, stats } = await fixture(t, { bytes: 64 * 1024, chunkBytes: 4096, delayMs: 1 });
    for (const slowMs of [0, 2]) {
        const result = await runLoad({ url: `${url}/stream`, requests: 12, concurrency: 3, slowMs, timeoutMs: 2000 });
        assert.equal(result.completed, 12);
        assert.equal(result.failed, 0);
        assert.equal(result.bytes, 12 * 64 * 1024);
    }
    assert.equal(stats.active, 0);
    assert.equal(stats.completed, 24);
});

test('abort after first chunk closes an upstream that otherwise stays idle', { timeout: 5000 }, async t => {
    const { url, stats } = await fixture(t, { bytes: 1024 * 1024, chunkBytes: 4096 });
    const result = await runLoad({ url: `${url}/stream?idle=1`, requests: 16, concurrency: 4, abortAfterBytes: 1024, timeoutMs: 1000 });
    assert.equal(result.aborted, 16);
    assert.equal(result.failed, 0);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(stats.active, 0);
    assert.equal(stats.aborted, 16);
});

test('a deadline cleans up an idle connection and reports failure once', { timeout: 5000 }, async t => {
    const { url, stats } = await fixture(t, { chunkBytes: 4096 });
    const result = await runLoad({ url: `${url}/stream?idle=1`, requests: 2, concurrency: 1, timeoutMs: 50 });
    assert.equal(result.failed, 2);
    assert.equal(result.errors.TIMEOUT, 2);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(stats.active, 0);
});

test('invalid producer parameters return 400 without terminating the server', { timeout: 5000 }, async t => {
    const { url } = await fixture(t, { bytes: 4096 });
    assert.equal((await fetch(`${url}/stream?bytes=NaN`)).status, 400);
    assert.equal((await fetch(`${url}/stream?chunk-bytes=999999999`)).status, 400);
    assert.equal((await fetch(`${url}/stats`)).status, 200);
});

test('abort before response headers releases the upstream request', { timeout: 5000 }, async t => {
    const { url, stats } = await fixture(t, { headersDelayMs: 1000 });
    const result = await runLoad({ url: `${url}/stream`, requests: 8, concurrency: 2, abortAfterMs: 50, timeoutMs: 500 });
    assert.equal(result.aborted, 8);
    assert.equal(result.failed, 0);
    assert.equal(result.bytes, 0);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(stats.active, 0);
    assert.equal(stats.aborted, 8);
});

test('compressed producer emits the expected decoded byte count', { timeout: 5000 }, async t => {
    const { url, stats } = await fixture(t, { bytes: 64 * 1024, chunkBytes: 4096, delayMs: 0, gzip: true });
    const response = await fetch(`${url}/stream`);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.equal((await response.arrayBuffer()).byteLength, 64 * 1024);
    assert.equal(stats.completed, 1);
});
