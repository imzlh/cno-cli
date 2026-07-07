import { deepStrictEqual, strictEqual } from 'node:assert';

Deno.test({ name: 'hono: c.json treats undefined status as the default response status', timeout: 60000 }, async () => {
    const { Hono } = await import('jsr:@hono/hono@4.12.27');
    const app = new Hono();

    app.get('/json', (c) => c.json({ ok: true }, undefined));

    const response = await app.request('http://localhost/json');
    strictEqual(response.status, 200);
    deepStrictEqual(await response.json(), { ok: true });
});
