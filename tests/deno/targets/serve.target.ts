// Target for Deno.serve behavior test. Port is configurable via CNO_SERVE_PORT
// (defaults to 0 = OS-assigned; the test discovers it via /text probe on a fixed
// port, so we default to 18091 when the env var is unset for the test's sake).
const PORT = Number(Deno.env.get('CNO_SERVE_PORT') ?? '18091');

Deno.serve({ port: PORT, hostname: '127.0.0.1', onListen: ({ port }) => {
    console.error(`serve-target listening on ${port}`);
} }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === '/text') return new Response('hello', { status: 200 });
    if (url.pathname === '/json') return Response.json({ ok: true });
    if (url.pathname === '/echo') return new Response(req.body, { status: 200 });
    if (url.pathname === '/headers') return new Response(req.headers.get('x-foo') ?? '');
    if (url.pathname === '/stream') {
        return new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('stream-'));
                controller.enqueue(new TextEncoder().encode('body'));
                controller.close();
            },
        }));
    }
    if (url.pathname === '/bad') return 'not a response' as unknown as Response;
    return new Response('not found', { status: 404 });
});
// keep alive
await new Promise(() => {});
