import { spawn } from 'node:child_process';
import { strictEqual } from 'node:assert';
import { resolve } from 'node:path';

const CNO = resolve('build/stage/cno');
const TARGET = resolve('tests/deno/targets/serve.target.ts');
const TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// Find a free port by spawning with port 0 is not observable via stdout here,
// so we bind a fixed port unlikely to collide.
const PORT = 18091;

async function waitForServer(): Promise<void> {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/text`);
            if (r.ok) return;
        } catch { /* not up yet */ }
        await sleep(120);
    }
    throw new Error('server did not start');
}

Deno.test({ name: 'deno: Deno.serve handles text/json/404 routes', timeout: 10000 }, async () => {
    const child = spawn(CNO, ['run', '--allow-net', `--inspect=0`, TARGET], {
        env: { ...process.env, CNO_SERVE_PORT: String(PORT) },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    try {
        await waitForServer();

        const text = await fetch(`http://127.0.0.1:${PORT}/text`);
        strictEqual(await text.text(), 'hello');
        strictEqual(text.status, 200);

        const json = await fetch(`http://127.0.0.1:${PORT}/json`);
        strictEqual(json.status, 200);
        const j = await json.json();
        strictEqual(j.ok, true);

        const miss = await fetch(`http://127.0.0.1:${PORT}/nope`);
        strictEqual(miss.status, 404);
    } finally {
        child.kill('SIGKILL');
        await new Promise((r) => child.on('exit', r));
    }
});

Deno.test({ name: 'deno: Deno.serve echoes request headers', timeout: 10000 }, async () => {
    const child = spawn(CNO, ['run', '--allow-net', TARGET], {
        env: { ...process.env, CNO_SERVE_PORT: String(PORT) },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    try {
        await waitForServer();
        const r = await fetch(`http://127.0.0.1:${PORT}/headers`, {
            headers: { 'x-foo': 'bar' },
        });
        strictEqual(await r.text(), 'bar');
    } finally {
        child.kill('SIGKILL');
        await new Promise((r) => child.on('exit', r));
    }
});
