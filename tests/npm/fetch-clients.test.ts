import { ok, strictEqual } from 'node:assert';
import { createServer } from 'node:http';

async function withJsonServer(fn: (url: string) => Promise<void>): Promise<void> {
    const server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, path: req.url, ok: true }));
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    try {
        const address = server.address();
        ok(address && typeof address === 'object', 'server.address() should be an address object');
        await fn(`http://127.0.0.1:${address.port}/probe`);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

async function assertFetch(fetchFn: (url: string) => Promise<any>, url: string): Promise<void> {
    const response = await fetchFn(url);
    strictEqual(response.status, 200);
    const body = await response.json();
    strictEqual(body.path, '/probe');
    strictEqual(body.ok, true);
}

async function withBehaviorServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
    const server = createServer((req, res) => {
        if (req.url === '/redirect') {
            res.writeHead(302, { location: '/final' });
            res.end();
            return;
        }
        if (req.url === '/final') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('redirect-ok');
            return;
        }
        if (req.url === '/echo') {
            const chunks: Buffer[] = [];
            req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            req.on('end', () => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    method: req.method,
                    contentType: req.headers['content-type'],
                    body: Buffer.concat(chunks).toString('utf8'),
                }));
            });
            return;
        }
        res.writeHead(404);
        res.end('missing');
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    try {
        const address = server.address();
        ok(address && typeof address === 'object', 'server.address() should be an address object');
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

Deno.test({ name: 'undici: fetches JSON from a local http server', timeout: 30000 }, async () => {
    const mod = await import('npm:undici');
    await withJsonServer((url) => assertFetch(mod.fetch, url));
});

Deno.test({ name: 'node-fetch@2: CJS fetches JSON from a local http server', timeout: 30000 }, async () => {
    const mod = await import('npm:node-fetch@2');
    const fetchFn = mod.default ?? mod;
    await withJsonServer((url) => assertFetch(fetchFn, url));
});

Deno.test({ name: 'node-fetch@3: ESM fetches JSON from a local http server', timeout: 30000 }, async () => {
    const mod = await import('npm:node-fetch@3');
    await withJsonServer((url) => assertFetch(mod.default, url));
});

Deno.test({ name: 'cross-fetch: fetches JSON from a local http server', timeout: 30000 }, async () => {
    const mod = await import('npm:cross-fetch');
    const fetchFn = mod.fetch ?? mod.default ?? mod;
    await withJsonServer((url) => assertFetch(fetchFn, url));
});

Deno.test({ name: 'fetch clients: send POST bodies and follow redirects', timeout: 30000 }, async () => {
    const undici = await import('npm:undici');
    const nodeFetch2Mod = await import('npm:node-fetch@2');
    const nodeFetch3Mod = await import('npm:node-fetch@3');
    const crossFetchMod = await import('npm:cross-fetch');
    const clients: Array<[string, (url: string, init?: Record<string, unknown>) => Promise<any>]> = [
        ['undici', undici.fetch],
        ['node-fetch@2', nodeFetch2Mod.default ?? nodeFetch2Mod],
        ['node-fetch@3', nodeFetch3Mod.default],
        ['cross-fetch', crossFetchMod.fetch ?? crossFetchMod.default ?? crossFetchMod],
    ];

    await withBehaviorServer(async (baseUrl) => {
        for (const [name, fetchFn] of clients) {
            const redirected = await fetchFn(`${baseUrl}/redirect`);
            strictEqual(redirected.status, 200, `${name} should follow redirect`);
            strictEqual(await redirected.text(), 'redirect-ok', `${name} should read redirected body`);

            const response = await fetchFn(`${baseUrl}/echo`, {
                method: 'POST',
                headers: { 'content-type': 'text/plain;charset=utf-8' },
                body: `${name}-payload`,
            });
            strictEqual(response.status, 200, `${name} POST should succeed`);
            const echo = await response.json();
            strictEqual(echo.method, 'POST', `${name} should preserve POST method`);
            strictEqual(echo.body, `${name}-payload`, `${name} should send request body`);
            ok(String(echo.contentType).includes('text/plain'), `${name} should send content-type header`);
        }
    });
});
