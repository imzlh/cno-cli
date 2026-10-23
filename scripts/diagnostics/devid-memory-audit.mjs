import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createUpstream } from './streaming-upstream.mjs';
import { runLoad } from './streaming-load.mjs';

// Node owns the producer and client; only the actual devid proxy runs in cno.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = {
    devid: resolve(root, '../devid'), binary: resolve(root, 'build/stage/cno.exe'),
    cache: resolve(root, 'build/audit-devid-20261023-cache'),
    output: resolve(root, 'build/devid-memory-audit.jsonl'), rounds: 4,
};
for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i].replace(/^--/, '');
    if (!Object.hasOwn(options, key) || !process.argv[i + 1]) throw new Error(`Invalid option: ${process.argv[i]}`);
    options[key] = key === 'rounds' ? Number(process.argv[++i]) : resolve(process.argv[++i]);
}
assert.ok(Number.isSafeInteger(options.rounds) && options.rounds > 0);
const records = [];
function record(value) { records.push(value); process.stdout.write(`${JSON.stringify(value)}\n`); }
async function json(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, url);
    return response.json();
}
async function waitFor(check, message, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await delay(25);
    }
    throw new Error(message);
}
async function unusedPort() {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

const producer = createUpstream({ bytes: 1048576, delayMs: 0 });
let errorActive = 0;
let errorStarted = 0;
let rangeRequests = 0;
let invalidRangeRequests = 0;
let invalidEncodingRequests = 0;
const upstream = createServer((request, response) => {
    if (new URL(request.url, 'http://localhost').pathname === '/fail') {
        errorStarted++;
        errorActive++;
        const timer = setTimeout(() => response.destroy(), 10000);
        response.once('close', () => { clearTimeout(timer); errorActive--; });
        response.writeHead(503, { 'content-type': 'application/octet-stream' });
        response.write(Buffer.alloc(4096));
        return; // Rejected responses must cancel an otherwise idle producer.
    }
    const writeHead = response.writeHead.bind(response);
    response.writeHead = (status, headers) => {
        if (request.headers.range) {
            rangeRequests++;
            if (request.headers.range !== 'bytes=0-1048575') invalidRangeRequests++;
            status = 206;
            headers = { ...headers, 'content-range': 'bytes 0-1048575/2097152', 'content-length': '1048576' };
        }
        if (!request.url.includes('audit-fetch2=1') && request.headers['accept-encoding'] !== 'identity') invalidEncodingRequests++;
        return writeHead(status, headers);
    };
    producer.server.emit('request', request, response);
});

await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
try {
    for (const limitMB of [32, 64]) {
        const port = await unusedPort();
        const proxyUrl = `http://127.0.0.1:${port}`;
        let log = '';
        const child = spawn(options.binary, [`--memory-limit=${limitMB}MB`, '--no-lock', 'run', 'tests/proxy-memory-fixture.ts', String(port)], {
            cwd: options.devid, env: { ...process.env, CTS_CACHE_DIR: options.cache }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
        child.on('error', error => { log += error.stack; });
        child.stdout.on('data', data => { log = (log + data).slice(-16384); });
        child.stderr.on('data', data => { log = (log + data).slice(-16384); });
        const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
        try {
            await waitFor(async () => {
                if (child.exitCode !== null) throw new Error(`Proxy exited: ${log}`);
                try { return Boolean((await json(`${proxyUrl}/__memory`))['vm.used']); }
                catch { return false; }
            }, `Proxy did not start: ${log}`, 60000);
            const proxy = (query = '', extra = '', type = 'video') => `${proxyUrl}/api/proxy/audit?url=${encodeURIComponent(`${upstreamUrl}/stream${query}`)}&type=${type}${extra}`;
            const run = async (name, config, expected, expectedBytes) => {
                const result = await runLoad({ requests: 20, concurrency: 4, timeoutMs: 10000, ...config });
                assert.equal(result.failed, expected === 'failed' ? result.requests : 0, `${name}: ${JSON.stringify(result)}\n${log}`);
                if (expected !== 'failed') assert.equal(result[expected], result.requests, name);
                if (expectedBytes !== undefined) assert.equal(result.bytes, expectedBytes, name);
                await waitFor(() => producer.stats.active === 0 && errorActive === 0, `${name}: upstream connections retained`);
                assert.equal(invalidRangeRequests, 0, 'proxy must forward the requested byte range');
                assert.equal(invalidEncodingRequests, 0, 'video proxy must request identity encoding');
                record({ type: 'workload', limitMB, name, ...result, upstreamActive: producer.stats.active + errorActive });
            };
            await run('warmup', { url: proxy() }, 'completed', 20 * 1048576);
            const baseline = await json(`${proxyUrl}/__memory?gc=1`);
            record({ type: 'memory', limitMB, label: 'baseline', memory: baseline });
            for (let round = 1; round <= options.rounds; round++) {
                await run(`normal-${round}`, { url: proxy() }, 'completed', 20 * 1048576);
                await run(`slow-${round}`, { url: proxy('?bytes=2097152'), requests: 8, slowMs: 5 }, 'completed', 8 * 2097152);
                await run(`idle-cancel-${round}`, { url: proxy('?idle=1'), abortAfterBytes: 1024 }, 'aborted');
                const observedBefore = producer.stats.started;
                await run(`headers-cancel-${round}`, { url: proxy('?headers-delay-ms=3000'), requests: 12, abortAfterMs: 1000 }, 'aborted');
                assert.equal(producer.stats.started - observedBefore, 12, 'all before-header cancellations must reach the upstream');
                await run(`segment-cancel-${round}`, { url: proxy('?idle=1', '&taskId=audit', 'segment'), abortAfterBytes: 1024 }, 'aborted');
                const rejectedBefore = errorStarted;
                await run(`error-${round}`, { url: `${proxyUrl}/api/proxy/audit?url=${encodeURIComponent(`${upstreamUrl}/fail`)}&type=video`, requests: 12 }, 'failed');
                assert.equal(errorStarted - rejectedBefore, 12);
                const signalResult = await json(`${proxyUrl}/__fetch2?url=${encodeURIComponent(`${upstreamUrl}/stream?idle=1&audit-fetch2=1`)}`);
                assert.equal(signalResult.aborted, true, 'fetch2 signal remains effective after headers');
                await waitFor(() => producer.stats.active === 0, 'fetch2 retained its producer');
                const range = await fetch(proxy(), { headers: { range: 'bytes=0-1048575' }, signal: AbortSignal.timeout(10000) });
                assert.equal(range.status, 206);
                assert.equal(range.headers.get('content-range'), 'bytes 0-1048575/2097152');
                assert.equal((await range.arrayBuffer()).byteLength, 1048576);
                const head = await fetch(proxy('?idle=1'), { method: 'HEAD', signal: AbortSignal.timeout(10000) });
                assert.equal(head.status, 200);
                await head.body?.cancel();
                await waitFor(() => producer.stats.active === 0, 'HEAD retained its unused body');
                await delay(100);
                const memory = await json(`${proxyUrl}/__memory?gc=1`);
                const vmDelta = memory['vm.used'] - baseline['vm.used'];
                record({ type: 'memory', limitMB, label: `round-${round}`, memory, vmDelta, objectDelta: memory['object.count'] - baseline['object.count'] });
                assert.equal(memory.limit, limitMB * 1048576);
                assert.ok(vmDelta < 2 * 1048576, `retained VM growth exceeds 2 MiB: ${vmDelta}\n${log}`);
            }
        } finally {
            child.kill();
            await exited;
        }
    }
    record({ type: 'summary', rounds: options.rounds, limitsMB: [32, 64], upstream: producer.stats, errorStarted, errorActive, rangeRequests });
} finally {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}
