import { Hono } from 'npm:hono@4.12.27';
import { stream } from 'npm:hono@4.12.27/streaming';

const os = import.meta.use('os');
const engine = import.meta.use('engine');
const options = { port: 8787, upstream: 'http://127.0.0.1:8788/stream' };
for (let i = 0; i < Deno.args.length; i++) {
    const flag = Deno.args[i];
    if (flag === '--port') options.port = Number(Deno.args[++i]);
    else if (flag === '--upstream') options.upstream = Deno.args[++i];
    else if (flag === '--help') {
        console.log('cno run scripts/diagnostics/streaming-proxy.ts [--port 8787] [--upstream http://127.0.0.1:8788/stream]\nRoutes: /direct (return fetch Response), /pipe (Hono stream.pipe), /plain (without Hono), /memory?gc=1');
        Deno.exit(0);
    } else throw new Error(`Unknown option: ${flag}`);
}
if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid --port');
new URL(options.upstream);

function upstreamUrl(request: Request): URL {
    const target = new URL(options.upstream);
    new URL(request.url).searchParams.forEach((value, key) => target.searchParams.set(key, value));
    return target;
}

const app = new Hono();
app.onError((error, c) => {
    if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
    console.error(error);
    return c.text('Upstream error', 502);
});
app.get('/direct', c => fetch(upstreamUrl(c.req.raw), { signal: c.req.raw.signal }));
app.get('/pipe', async c => {
    const controller = new AbortController();
    const abort = () => controller.abort(c.req.raw.signal.reason);
    c.req.raw.signal.addEventListener('abort', abort, { once: true });
    if (c.req.raw.signal.aborted) abort();
    let response: Response;
    try {
        response = await fetch(upstreamUrl(c.req.raw), { signal: controller.signal });
    } catch (error) {
        c.req.raw.signal.removeEventListener('abort', abort);
        throw error;
    }
    c.status(response.status);
    c.header('Content-Type', response.headers.get('content-type') ?? 'application/octet-stream');
    return stream(c, async output => {
        output.onAbort(() => controller.abort());
        try {
            if (response.body) await output.pipe(response.body);
        } finally {
            c.req.raw.signal.removeEventListener('abort', abort);
            controller.abort();
        }
    });
});

Deno.serve({ hostname: '127.0.0.1', port: options.port, onListen: ({ port }) => {
    console.log(JSON.stringify({ event: 'listening', url: `http://127.0.0.1:${port}/direct`, pid: os.pid }));
} }, async request => {
    const url = new URL(request.url);
    if (url.pathname === '/plain') return fetch(upstreamUrl(request), { signal: request.signal });
    if (url.pathname === '/memory') {
        if (url.searchParams.get('gc') === '1') {
            engine.gc.run();
            await new Promise(resolve => setTimeout(resolve, 10));
            engine.gc.run();
        }
        return Response.json(os.memoryUsage());
    }
    return app.fetch(request);
});
