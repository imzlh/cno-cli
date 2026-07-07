import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { request } from 'node:http';

function requestBody(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = request({
            host: u.hostname,
            port: u.port,
            path: `${u.pathname}${u.search}`,
            method: options.method ?? 'GET',
            headers: options.headers,
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                body += chunk;
            });
            res.on('end', () => resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body,
            }));
        });
        req.once('error', reject);
        if (options.body !== undefined) req.end(options.body);
        else req.end();
    });
}

function listen(server: { listen: (...args: any[]) => any; address: () => any; once: (event: string, listener: (...args: any[]) => void) => any }): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') reject(new Error('server did not expose a port'));
            else resolve(address.port);
        });
    });
}

function close(server: { close: (callback: () => void) => void }): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

Deno.test({ name: 'express: routes JSON requests through node:http server', timeout: 60000 }, async () => {
    const expressMod = await import('npm:express');
    const { createServer } = await import('node:http');
    const express = expressMod.default ?? expressMod;
    const app = express();

    app.use(express.json());
    app.get('/hello/:name', (req: any, res: any) => {
        res.set('x-powered-by', 'cno-compat');
        res.json({ hello: req.params.name, q: req.query.q });
    });
    app.post('/echo', (req: any, res: any) => {
        res.status(201).json({ body: req.body, contentType: req.get('content-type') });
    });

    const server = createServer(app);
    try {
        const port = await listen(server);
        const get = await requestBody(`http://127.0.0.1:${port}/hello/runtime?q=node`);
        strictEqual(get.status, 200);
        strictEqual(get.headers['x-powered-by'], 'cno-compat');
        deepStrictEqual(JSON.parse(get.body), { hello: 'runtime', q: 'node' });

        const post = await requestBody(`http://127.0.0.1:${port}/echo`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ok: true }),
        });
        strictEqual(post.status, 201);
        const echoed = JSON.parse(post.body);
        deepStrictEqual(echoed.body, { ok: true });
        ok(String(echoed.contentType).includes('application/json'));
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'koa: middleware reads request stream and sets response headers', timeout: 60000 }, async () => {
    const koaMod = await import('npm:koa');
    const { createServer } = await import('node:http');
    const Koa = koaMod.default ?? koaMod;
    const app = new Koa();

    app.use(async (ctx: any) => {
        if (ctx.path === '/sum' && ctx.method === 'POST') {
            let raw = '';
            ctx.req.setEncoding('utf8');
            for await (const chunk of ctx.req) raw += chunk;
            const values = JSON.parse(raw).values;
            ctx.set('x-middleware', 'koa');
            ctx.body = { total: values.reduce((sum: number, value: number) => sum + value, 0) };
            return;
        }
        ctx.status = 404;
        ctx.body = 'missing';
    });

    const server = createServer(app.callback());
    try {
        const port = await listen(server);
        const res = await requestBody(`http://127.0.0.1:${port}/sum`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ values: [2, 3, 5] }),
        });
        strictEqual(res.status, 200);
        strictEqual(res.headers['x-middleware'], 'koa');
        deepStrictEqual(JSON.parse(res.body), { total: 10 });
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'fastify: listens on loopback and serializes JSON replies', timeout: 60000 }, async () => {
    const fastifyMod = await import('npm:fastify');
    const makeFastify = fastifyMod.default ?? fastifyMod.fastify ?? fastifyMod;
    const app = makeFastify();

    app.get('/status', async () => ({ ready: true }));
    app.post('/items', async (req: any, reply: any) => {
        reply.code(202);
        return { id: req.body.id, name: req.body.name.toUpperCase() };
    });

    try {
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('fastify did not expose a port');
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const status = await requestBody(`${baseUrl}/status`);
        strictEqual(status.status, 200);
        deepStrictEqual(JSON.parse(status.body), { ready: true });

        const created = await requestBody(`${baseUrl}/items`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: 7, name: 'cno' }),
        });
        strictEqual(created.status, 202);
        deepStrictEqual(JSON.parse(created.body), { id: 7, name: 'CNO' });
    } finally {
        await app.close();
    }
});
