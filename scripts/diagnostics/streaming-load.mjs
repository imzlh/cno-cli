import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// IncomingMessage backpressure bounds client memory; no response body is saved.
export async function runLoad({ url, requests = 100, concurrency = 4, slowMs = 0, abortAfterBytes = 0, abortAfterMs = 0, timeoutMs = 30000, signal, onProgress } = {}) {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('URL must use http: or https:');
    const agent = target.protocol === 'https:' ? new HttpsAgent({ keepAlive: true, maxSockets: concurrency }) : new HttpAgent({ keepAlive: true, maxSockets: concurrency });
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const summary = { requests, completed: 0, aborted: 0, failed: 0, bytes: 0, errors: {} };
    let next = 0;
    const started = performance.now();
    async function consume() {
        while (next++ < requests && !signal?.aborted) {
            const result = await new Promise(resolve => {
                let body;
                let pauseTimer;
                let abortTimer;
                let finished = false;
                let bytes = 0;
                const req = request(target, { agent, signal });
                const deadline = setTimeout(() => {
                    const error = new Error(`Request exceeded ${timeoutMs}ms`);
                    error.code = 'TIMEOUT';
                    finish('failed', error);
                    req.destroy(error);
                }, timeoutMs);
                function finish(status, error) {
                    if (finished) return;
                    finished = true;
                    clearTimeout(deadline);
                    clearTimeout(pauseTimer);
                    clearTimeout(abortTimer);
                    resolve({ status, bytes, error: error?.code ?? error?.message });
                }
                req.once('response', response => {
                    body = response;
                    response.on('error', error => finish('failed', error));
                    response.once('aborted', () => finish('failed', new Error('Upstream response aborted')));
                    response.once('end', () => finish('completed'));
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        finish('failed', new Error(`HTTP ${response.statusCode}`));
                        response.destroy();
                        req.destroy();
                        return;
                    }
                    response.on('data', chunk => {
                        bytes += chunk.length;
                        if (abortAfterBytes && bytes >= abortAfterBytes) {
                            finish('aborted');
                            response.destroy();
                            req.destroy();
                        } else if (slowMs) {
                            response.pause();
                            pauseTimer = setTimeout(() => { if (!finished) response.resume(); }, slowMs);
                        }
                    });
                });
                req.once('error', error => {
                    finish('failed', error);
                    body?.destroy();
                });
                if (abortAfterMs) abortTimer = setTimeout(() => {
                    finish('aborted');
                    body?.destroy();
                    req.destroy();
                }, abortAfterMs);
                req.end();
            });
            summary[result.status]++;
            summary.bytes += result.bytes;
            if (result.error) summary.errors[result.error] = (summary.errors[result.error] ?? 0) + 1;
            onProgress?.({ ...summary, elapsedMs: Math.round(performance.now() - started) });
        }
    }
    try {
        await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, consume));
    } finally {
        agent.destroy();
    }
    return { ...summary, elapsedMs: Math.round(performance.now() - started) };
}

function integer(value, name, minimum) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
    return number;
}

async function main() {
    const options = { url: 'http://127.0.0.1:8787/direct', requests: 100, concurrency: 4, slowMs: 0, abortAfterBytes: 0, abortAfterMs: 0, timeoutMs: 30000 };
    const fields = { '--requests': ['requests', 1], '--concurrency': ['concurrency', 1], '--slow-ms': ['slowMs', 0], '--abort-after-bytes': ['abortAfterBytes', 0], '--abort-after-ms': ['abortAfterMs', 0], '--timeout-ms': ['timeoutMs', 1] };
    for (let i = 2; i < process.argv.length; i++) {
        const flag = process.argv[i];
        if (flag === '--help') {
            console.log('node scripts/diagnostics/streaming-load.mjs [--url http://127.0.0.1:8787/direct] [--requests 100] [--concurrency 4] [--slow-ms 0] [--abort-after-bytes 0] [--abort-after-ms 0] [--timeout-ms 30000]');
            return;
        }
        if (flag === '--url') { options.url = process.argv[++i]; continue; }
        const field = fields[flag];
        if (!field) throw new Error(`Unknown option: ${flag}`);
        options[field[0]] = integer(process.argv[++i], flag.slice(2), field[1]);
    }
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    let lastReported = 0;
    const summary = await runLoad({
        ...options,
        signal: controller.signal,
        onProgress(value) {
            if (performance.now() - lastReported >= 1000) {
                lastReported = performance.now();
                console.log(JSON.stringify({ event: 'progress', ...value }));
            }
        },
    });
    console.log(JSON.stringify({ event: 'summary', ...summary }));
    if (summary.failed || controller.signal.aborted) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
