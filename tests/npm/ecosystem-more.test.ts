import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createServer, request } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function tempDir(name: string): string {
    const dir = join(tmpdir(), `cno-${name}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') reject(new Error('server did not expose a port'));
            else resolve(address.port);
        });
    });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

async function withHttpServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
    const server = createServer((req, res) => {
        if (req.url === '/redirect') {
            res.writeHead(302, { location: '/json' });
            res.end();
            return;
        }
        if (req.url === '/json') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, method: req.method }));
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

    try {
        const port = await listen(server);
        await fn(`http://127.0.0.1:${port}`);
    } finally {
        await close(server);
    }
}

Deno.test({ name: 'axios and got: follow redirects and send JSON bodies', timeout: 60000 }, async () => {
    const axiosMod = await import('npm:axios');
    const gotMod = await import('npm:got');
    const axios = axiosMod.default ?? axiosMod;
    const got = gotMod.default ?? gotMod.got ?? gotMod;

    await withHttpServer(async (baseUrl) => {
        const axiosRedirect = await axios.get(`${baseUrl}/redirect`);
        strictEqual(axiosRedirect.status, 200);
        strictEqual(axiosRedirect.data.ok, true);

        const gotRedirect = await got(`${baseUrl}/redirect`).json();
        strictEqual(gotRedirect.ok, true);

        const axiosPost = await axios.post(`${baseUrl}/echo`, { source: 'axios' });
        strictEqual(axiosPost.data.method, 'POST');
        ok(String(axiosPost.data.contentType).includes('application/json'));
        strictEqual(JSON.parse(axiosPost.data.body).source, 'axios');

        const gotPost = await got.post(`${baseUrl}/echo`, { json: { source: 'got' } }).json();
        strictEqual(gotPost.method, 'POST');
        ok(String(gotPost.contentType).includes('application/json'));
        strictEqual(JSON.parse(gotPost.body).source, 'got');
    });
});

Deno.test({ name: 'form-data and busboy: stream multipart upload through node:http', timeout: 60000 }, async () => {
    const formDataMod = await import('npm:form-data');
    const busboyMod = await import('npm:busboy');
    const FormData = formDataMod.default ?? formDataMod;
    const busboyFactory = busboyMod.default ?? busboyMod;

    const server = createServer((req, res) => {
        const bb = busboyFactory({ headers: req.headers });
        const fields: Record<string, string> = {};
        const files: Record<string, string> = {};
        bb.on('field', (name: string, value: string) => {
            fields[name] = value;
        });
        bb.on('file', (name: string, stream: NodeJS.ReadableStream, info: { filename: string }) => {
            let body = '';
            stream.setEncoding('utf8');
            stream.on('data', (chunk: string) => {
                body += chunk;
            });
            stream.on('end', () => {
                files[name] = `${info.filename}:${body}`;
            });
        });
        bb.on('close', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ fields, files }));
        });
        req.pipe(bb);
    });

    try {
        const port = await listen(server);
        const form = new FormData();
        form.append('kind', 'compat');
        form.append('asset', Buffer.from('multipart-body'), { filename: 'asset.txt' });

        const result = await new Promise<Record<string, any>>((resolve, reject) => {
            const req = request({
                method: 'POST',
                host: '127.0.0.1',
                port,
                path: '/upload',
                headers: form.getHeaders(),
            }, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    body += chunk;
                });
                res.on('end', () => resolve(JSON.parse(body)));
            });
            req.once('error', reject);
            form.pipe(req);
        });

        strictEqual(result.fields.kind, 'compat');
        strictEqual(result.files.asset, 'asset.txt:multipart-body');
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'tar: creates gzip archive and extracts files from disk', timeout: 60000 }, async () => {
    const tar = await import('npm:tar');
    const root = tempDir('tar');
    const input = join(root, 'input');
    const output = join(root, 'output');
    const archive = join(root, 'bundle.tgz');
    mkdirSync(join(input, 'nested'), { recursive: true });
    writeFileSync(join(input, 'nested', 'a.txt'), 'alpha');
    writeFileSync(join(input, 'b.txt'), 'bravo');

    try {
        await tar.c({ gzip: true, file: archive, cwd: input }, ['.']);
        mkdirSync(output);
        await tar.x({ file: archive, cwd: output });
        strictEqual(readFileSync(join(output, 'nested', 'a.txt'), 'utf8'), 'alpha');
        strictEqual(readFileSync(join(output, 'b.txt'), 'utf8'), 'bravo');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'execa: runs a child process with stdin and captures stdout', timeout: 60000 }, async () => {
    const mod = await import('npm:execa');
    const execa = mod.execa ?? mod.default;
    const result = await execa('sh', ['-lc', 'read line; printf "child:%s" "$line"'], {
        input: 'payload\n',
    });
    strictEqual(result.exitCode, 0);
    strictEqual(result.stdout, 'child:payload');
});

Deno.test({ name: 'chokidar: observes add change and unlink events', timeout: 60000 }, async () => {
    const mod = await import('npm:chokidar');
    const chokidar = mod.default ?? mod;
    const root = tempDir('chokidar');
    const target = join(root, 'watched.txt');
    const events: string[] = [];

    const watcher = chokidar.watch(root, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
    });

    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`chokidar ready timed out; events=${events.join(',')}`)), 5000);
            watcher.once('ready', () => {
                clearTimeout(timer);
                resolve();
            });
        });

        watcher.on('all', (event: string, path: string) => {
            if (path === target) events.push(event);
        });

        writeFileSync(target, 'one');
        await new Promise((resolve) => setTimeout(resolve, 150));
        writeFileSync(target, 'two');
        await new Promise((resolve) => setTimeout(resolve, 150));
        rmSync(target);

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`chokidar events timed out; events=${events.join(',')}`)), 5000);
            const poll = () => {
                if (events.includes('add') && events.includes('change') && events.includes('unlink')) {
                    clearTimeout(timer);
                    resolve();
                    return;
                }
                setTimeout(poll, 25);
            };
            poll();
        });

        deepStrictEqual(['add', 'change', 'unlink'].every(event => events.includes(event)), true);
    } finally {
        await watcher.close();
        rmSync(root, { recursive: true, force: true });
    }
});
