import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createGzip, constants as zlibConstants } from 'node:zlib';

// Keep the producer outside cno so its buffers do not affect the measured heap.
export function createUpstream({ bytes = 8 * 1024 * 1024, chunkBytes = 16 * 1024, delayMs = 1, headersDelayMs = 0, gzip = false, timeoutMs = 60000 } = {}) {
    const stats = { started: 0, active: 0, completed: 0, aborted: 0, bytes: 0 };
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/stats') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(stats));
            return;
        }
        if (url.pathname !== '/stream') {
            res.writeHead(404).end();
            return;
        }
        let total, chunkSize, delay, headersDelay;
        try {
            total = integer(url.searchParams.get('bytes') ?? bytes, 'bytes', 1);
            chunkSize = integer(url.searchParams.get('chunk-bytes') ?? chunkBytes, 'chunk-bytes', 1);
            delay = integer(url.searchParams.get('delay-ms') ?? delayMs, 'delay-ms', 0);
            headersDelay = integer(url.searchParams.get('headers-delay-ms') ?? headersDelayMs, 'headers-delay-ms', 0);
            if (chunkSize > 16 * 1024 * 1024) throw new Error('chunk-bytes must be <= 16777216');
        } catch (error) {
            res.writeHead(400, { 'content-type': 'text/plain' }).end(error.message);
            return;
        }
        const idle = url.searchParams.get('idle') === '1';
        const compressed = url.searchParams.has('gzip') ? url.searchParams.get('gzip') === '1' : gzip;
        const chunk = Buffer.alloc(Math.min(chunkSize, total), 0x61);
        const encoder = compressed ? createGzip() : undefined;
        const destination = encoder ?? res;
        let sent = 0;
        let timer;
        let immediate;
        let closed = false;
        stats.started++;
        stats.active++;
        const deadline = setTimeout(() => res.destroy(), timeoutMs);
        res.once('close', () => {
            closed = true;
            clearTimeout(timer);
            clearImmediate(immediate);
            clearTimeout(deadline);
            encoder?.destroy();
            stats.active--;
            stats[res.writableFinished ? 'completed' : 'aborted']++;
        });
        res.on('error', () => {});
        encoder?.on('error', error => res.destroy(error));
        const begin = () => {
            if (closed) return;
            res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', ...(compressed ? { 'content-encoding': 'gzip' } : {}) });
            encoder?.pipe(res);
            send();
        };
        function send() {
            if (closed) return;
            const size = Math.min(chunk.length, total - sent);
            const ready = destination.write(size === chunk.length ? chunk : chunk.subarray(0, size));
            sent += size;
            stats.bytes += size;
            if (idle) {
                // Emit one decoded chunk even though the compressed stream stays open.
                encoder?.flush(zlibConstants.Z_SYNC_FLUSH);
                return;
            }
            if (sent === total) {
                destination.end();
                return;
            }
            const schedule = () => {
                if (!closed) {
                    if (delay) timer = setTimeout(send, delay);
                    else immediate = setImmediate(send);
                }
            };
            if (ready) schedule();
            else destination.once('drain', schedule);
        }
        if (headersDelay) timer = setTimeout(begin, headersDelay);
        else begin();
    });
    return { server, stats };
}

function integer(value, name, minimum) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
    return number;
}

async function main() {
    const options = { port: 8788, host: '127.0.0.1', bytes: 8 * 1024 * 1024, chunkBytes: 16 * 1024, delayMs: 1, headersDelayMs: 0, gzip: false, timeoutMs: 60000 };
    const flags = { '--port': ['port', 0], '--bytes': ['bytes', 1], '--chunk-bytes': ['chunkBytes', 1], '--delay-ms': ['delayMs', 0], '--headers-delay-ms': ['headersDelayMs', 0], '--timeout-ms': ['timeoutMs', 1] };
    for (let i = 2; i < process.argv.length; i++) {
        const flag = process.argv[i];
        if (flag === '--help') {
            console.log('node scripts/diagnostics/streaming-upstream.mjs [--port 8788] [--bytes 8388608] [--chunk-bytes 16384] [--delay-ms 1] [--headers-delay-ms 0] [--gzip] [--timeout-ms 60000]\nGET /stream?bytes=...&chunk-bytes=...&delay-ms=...&headers-delay-ms=...&gzip=1&idle=1; GET /stats');
            return;
        }
        if (flag === '--host') { options.host = process.argv[++i]; continue; }
        if (flag === '--gzip') { options.gzip = true; continue; }
        const field = flags[flag];
        if (!field) throw new Error(`Unknown option: ${flag}`);
        options[field[0]] = integer(process.argv[++i], flag.slice(2), field[1]);
    }
    const { server } = createUpstream(options);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, resolve);
    });
    console.log(JSON.stringify({ event: 'listening', url: `http://${options.host}:${server.address().port}/stream`, pid: process.pid }));
    const stop = () => { server.close(); server.closeAllConnections(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
