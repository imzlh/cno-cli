import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const HELP = `Usage: node scripts/diagnostics/monitor-memory-cdp.mjs [options]
  --inspect=http://127.0.0.1:9229  Discovery endpoint or ws:// target
  --interval=2000                Milliseconds between samples
  --duration=120                 Seconds to monitor; 0 until Ctrl+C
  --gc-every=0                   Collect every N samples; 0 disables forced GC
  --output=memory.jsonl          JSONL file; otherwise JSONL goes to stdout
  --timeout=10000                CDP/discovery timeout in milliseconds
  --help                        Print this help

Requires Node.js 22+ and a rebuilt cno with CNO.getMemoryUsage.
Does not enable Network or retain CDP events.\n`;

export function parseOptions(args) {
    const options = { inspect: 'http://127.0.0.1:9229', interval: 2000, duration: 120, gcEvery: 0, timeout: 10000, output: undefined, help: false };
    const names = { inspect: 'inspect', interval: 'interval', duration: 'duration', 'gc-every': 'gcEvery', timeout: 'timeout', output: 'output' };
    for (let i = 0; i < args.length; i++) {
        const argument = args[i];
        if (argument === '--help' || argument === '-h') { options.help = true; continue; }
        const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
        if (!match || !Object.hasOwn(names, match[1])) throw new Error(`Unknown option: ${argument}`);
        const key = names[match[1]];
        const value = match[2] ?? args[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for --${match[1]}`);
        options[key] = key === 'inspect' || key === 'output' ? value : Number(value);
    }
    for (const key of ['interval', 'duration', 'gcEvery', 'timeout']) {
        if (!Number.isSafeInteger(options[key]) || options[key] < (key === 'interval' || key === 'timeout' ? 1 : 0)) {
            throw new Error(`Invalid ${key}: expected ${key === 'interval' || key === 'timeout' ? 'a positive' : 'a nonnegative'} integer`);
        }
    }
    const url = new URL(options.inspect);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('--inspect must use http, https, ws or wss');
    return options;
}

export async function discoverTarget(address, timeout, signal) {
    const url = new URL(address);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return url.href;
    if (url.pathname === '/') url.pathname = '/json/list';
    const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(timeout), signal].filter(Boolean)) });
    if (!response.ok) throw new Error(`Inspector discovery returned HTTP ${response.status} at ${url}`);
    const discovery = await response.json();
    const target = Array.isArray(discovery) ? discovery.find(entry => typeof entry?.webSocketDebuggerUrl === 'string') : discovery;
    if (typeof target?.webSocketDebuggerUrl !== 'string') throw new Error(`Inspector discovery did not return a WebSocket target at ${url}`);
    const wsUrl = new URL(target.webSocketDebuggerUrl);
    if (!['ws:', 'wss:'].includes(wsUrl.protocol)) throw new Error('Inspector discovery returned an invalid WebSocket URL');
    return wsUrl.href;
}

export class CdpClient {
    #socket;
    #timeout;
    #pending = new Map();
    #nextId = 0;
    #closed = false;

    constructor(socket, timeout) {
        this.#socket = socket;
        this.#timeout = timeout;
        socket.addEventListener('message', event => {
            let message;
            try { message = JSON.parse(String(event.data)); }
            catch { this.#fail(new Error('Inspector returned invalid JSON')); return; }
            // Events, including Runtime/Network traffic, are intentionally discarded.
            if (typeof message.id !== 'number') return;
            const pending = this.#pending.get(message.id);
            if (!pending) return;
            this.#pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(Object.assign(new Error(`${pending.method}: ${message.error.message}`), { code: message.error.code }));
            else pending.resolve(message.result);
        });
        socket.addEventListener('close', () => this.#fail(new Error('Inspector connection closed')));
        socket.addEventListener('error', () => this.#fail(new Error('Inspector WebSocket error')));
    }

    static async connect(address, timeout, signal) {
        if (typeof WebSocket !== 'function') throw new Error('WebSocket is unavailable; use Node.js 22 or newer');
        const socket = new WebSocket(address);
        const client = new CdpClient(socket, timeout);
        try {
            await once(socket, 'open', { signal: AbortSignal.any([AbortSignal.timeout(timeout), signal].filter(Boolean)) });
            return client;
        } catch (error) { client.close(); throw error; }
    }

    #fail(error) {
        this.#closed = true;
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pending.clear();
    }

    call(method, params = {}) {
        if (this.#closed) return Promise.reject(new Error('Inspector connection is closed'));
        return new Promise((resolve, reject) => {
            const id = ++this.#nextId;
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`${method}: no CDP reply within ${this.#timeout}ms`));
            }, this.#timeout);
            this.#pending.set(id, { resolve, reject, timer, method });
            try { this.#socket.send(JSON.stringify({ id, method, params })); }
            catch (error) {
                this.#pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    close() {
        this.#fail(new Error('Inspector client closed'));
        this.#socket.close();
    }
}

export function counterDelta(current, baseline) {
    const delta = {};
    for (const [key, value] of Object.entries(current)) {
        if (Number.isFinite(value) && Number.isFinite(baseline?.[key])) delta[key] = value - baseline[key];
    }
    return delta;
}

function validateSample(sample) {
    if (sample?.runtime !== 'QuickJS' || sample.scope !== 'main' || !sample.memory || !Number.isFinite(sample.memory['vm.used'])) {
        throw new Error('CNO.getMemoryUsage returned an unexpected response');
    }
    return sample;
}

export async function monitor(client, options, write, signal) {
    const started = Date.now();
    const deadline = options.duration ? started + options.duration * 1000 : Infinity;
    let baseline;
    let gcBaseline;
    let samples = 0;
    while (!signal?.aborted && Date.now() < deadline) {
        const sampleStarted = Date.now();
        let usage;
        try { usage = validateSample(await client.call('CNO.getMemoryUsage')); }
        catch (error) {
            if (error.code === -32601) throw new Error('This cno does not implement CNO.getMemoryUsage. Rebuild cno before using this monitor; older HeapProfiler.collectGarbage may be a no-op.');
            throw error;
        }
        baseline ??= usage;
        const sample = { type: 'sample', index: ++samples, elapsedMs: Date.now() - started, ...usage,
            delta: { memory: counterDelta(usage.memory, baseline.memory), inspector: counterDelta(usage.inspector ?? {}, baseline.inspector), referencedHandleCount: usage.referencedHandleCount - baseline.referencedHandleCount } };
        if (options.gcEvery && samples % options.gcEvery === 0) {
            await client.call('HeapProfiler.collectGarbage');
            // Give native finalizers and pending jobs a loop turn before the second collection.
            await delay(20, undefined, { signal });
            await client.call('HeapProfiler.collectGarbage');
            const collected = validateSample(await client.call('CNO.getMemoryUsage'));
            gcBaseline ??= collected;
            sample.afterGC = { ...collected, delta: { memory: counterDelta(collected.memory, gcBaseline.memory), inspector: counterDelta(collected.inspector ?? {}, gcBaseline.inspector) } };
            sample.reclaimedBytes = usage.memory['vm.used'] - collected.memory['vm.used'];
        }
        await write(sample);
        const wait = Math.min(deadline - Date.now(), options.interval - (Date.now() - sampleStarted));
        if (wait > 0) {
            try { await delay(wait, undefined, { signal }); }
            catch (error) { if (!signal?.aborted) throw error; }
        }
    }
    return { type: 'summary', samples, elapsedMs: Date.now() - started };
}

async function main(args) {
    const options = parseOptions(args);
    if (options.help) { process.stdout.write(HELP); return; }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    let client;
    let output;
    let outputError;
    try {
        const target = await discoverTarget(options.inspect, options.timeout, controller.signal);
        client = await CdpClient.connect(target, options.timeout, controller.signal);
        output = options.output ? createWriteStream(options.output, { flags: 'wx' }) : process.stdout;
        output.on('error', error => { outputError = error; controller.abort(); client?.close(); });
        if (options.output) await once(output, 'open');
        const write = async value => {
            if (outputError) throw outputError;
            if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, 'drain');
        };
        process.stderr.write('Monitoring main QuickJS counters and process RSS. buffer.used counts bytecode; forced GC changes the workload.\n');
        const summary = await monitor(client, options, async sample => {
            await write(sample);
            const m = sample.afterGC?.memory ?? sample.memory;
            process.stderr.write(`#${sample.index} ${(sample.elapsedMs / 1000).toFixed(1)}s VM ${(m['vm.used'] / 1048576).toFixed(2)} MiB RSS ${(m['os.rss'] / 1048576).toFixed(2)} MiB objects=${m['object.count']} handles=${sample.referencedHandleCount}${sample.afterGC ? ' [after GC]' : ''}\n`);
        }, controller.signal);
        await write(summary);
    } catch (error) {
        if (outputError) throw outputError;
        if (!controller.signal.aborted) throw error;
    } finally {
        client?.close();
        if (output && options.output && !output.destroyed) {
            output.end();
            await once(output, 'finish');
        }
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
