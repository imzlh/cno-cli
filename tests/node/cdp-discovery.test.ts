import { ok, strictEqual } from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOST = '127.0.0.1';
const PORT = 9239;
const TIMEOUT_MS = 15_000;
const CNO = resolve('build/stage/cno');
const TARGET = resolve('tests/node/targets/cdp-discovery.target.ts');

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function getJson(path: string) {
    const deadline = Date.now() + TIMEOUT_MS;
    let last: unknown = null;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://${HOST}:${PORT}${path}`);
            if (res.ok) return await res.json();
        } catch (e) {
            last = e;
        }
        await sleep(120);
    }
    throw last ?? new Error(`timeout fetching ${path}`);
}

Deno.test({ name: 'cdp: /json/version exposes protocol version and webSocketDebuggerUrl', timeout: 10000 }, async () => {
    const child = spawn(CNO, ['run', `--inspect=${HOST}:${PORT}`, TARGET], {
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    let wsUrl = '';
    try {
        const deadline = Date.now() + TIMEOUT_MS;
        let version: any = null;
        while (Date.now() < deadline) {
            try { version = await getJson('/json/version'); break; } catch { await sleep(120); }
        }
        ok(version, '/json/version must respond');
        strictEqual(version?.Browser?.startsWith('cno'), true, `Browser should start with cno, got ${version?.Browser}`);
        ok(typeof version['Protocol-Version'] === 'string', 'Protocol-Version must be a string');
        ok(typeof version['webSocketDebuggerUrl'] === 'string' && version.webSocketDebuggerUrl.startsWith('ws://'),
            'webSocketDebuggerUrl must be a ws:// URL');
        wsUrl = version.webSocketDebuggerUrl as string;
    } finally {
        child.kill('SIGKILL');
        await new Promise((r) => child.on('exit', r));
    }
    return wsUrl;
});

Deno.test({ name: 'cdp: /json lists a page target with a debugger ws URL', timeout: 10000 }, async () => {
    const child = spawn(CNO, ['run', `--inspect=${HOST}:${PORT}`, TARGET], {
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    try {
        const list: any[] = await getJson('/json');
        ok(Array.isArray(list) && list.length >= 1, '/json must return a non-empty target list');
        const page = list.find((t) => t.type === 'page');
        ok(page, 'must expose a page target');
        ok(typeof page.webSocketDebuggerUrl === 'string' && page.webSocketDebuggerUrl.startsWith('ws://'),
            'page target must carry a ws debugger URL');
        ok(page.title !== undefined && page.id !== undefined, 'page target must have title and id');
    } finally {
        child.kill('SIGKILL');
        await new Promise((r) => child.on('exit', r));
    }
});

Deno.test({ name: 'cdp: WebSocket attach accepts a Runtime.evaluate round-trip', timeout: 10000 }, async () => {
    const child = spawn(CNO, ['run', `--inspect=${HOST}:${PORT}`, TARGET], {
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    let wsUrl = '';
    try {
        const deadline = Date.now() + TIMEOUT_MS;
        while (Date.now() < deadline) {
            try {
                const v: any = await getJson('/json/version');
                if (v?.webSocketDebuggerUrl) { wsUrl = v.webSocketDebuggerUrl; break; }
            } catch { /* not up yet */ }
            await sleep(120);
        }
        ok(wsUrl, 'must discover a ws URL');

        const result = await new Promise<any>((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            const timer = setTimeout(() => { ws.close(); reject(new Error('ws timeout')); }, TIMEOUT_MS);
            ws.addEventListener('open', () => {
                ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1 + 2' } }));
            });
            ws.addEventListener('message', (ev) => {
                const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
                if (msg.id === 1) {
                    clearTimeout(timer);
                    ws.close();
                    resolve(msg.result);
                }
            });
            ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('ws error')); });
        });
        ok(result && result.result, 'evaluate must return a result');
        strictEqual(result.result.value, 3, '1 + 2 must evaluate to 3');
    } finally {
        child.kill('SIGKILL');
        await new Promise((r) => child.on('exit', r));
    }
});
