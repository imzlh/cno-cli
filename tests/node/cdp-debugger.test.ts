import { ok, strictEqual } from 'node:assert';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const HOST = '127.0.0.1';
const PORT = 9240;
const TIMEOUT_MS = 15_000;
const CNO = resolve('build/stage/cno');
const TARGET = resolve('tests/node/targets/cdp-discovery.target.ts');

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(path: string) {
    const deadline = Date.now() + TIMEOUT_MS;
    let last: unknown = null;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://${HOST}:${PORT}${path}`);
            if (res.ok) return await res.json();
        } catch (error) {
            last = error;
        }
        await sleep(120);
    }
    throw last ?? new Error(`timeout fetching ${path}`);
}

async function discoverWsUrl(): Promise<string> {
    const version = await getJson('/json/version') as { webSocketDebuggerUrl?: string };
    const wsUrl = version.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('missing webSocketDebuggerUrl');
    return wsUrl;
}

function sendCommand(wsUrl: string, command: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
            ws.close();
            reject(new Error('ws timeout'));
        }, TIMEOUT_MS);
        ws.addEventListener('open', () => ws.send(JSON.stringify(command)));
        ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
            if (msg.id !== command.id) return;
            clearTimeout(timer);
            ws.close();
            resolve(msg);
        });
        ws.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('ws error'));
        });
    });
}

Deno.test({ name: 'cdp: Debugger rejects invalid breakpoint line numbers', timeout: 10000 }, async () => {
    const child = spawn(CNO, ['run', `--inspect=${HOST}:${PORT}`, TARGET], {
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    try {
        const wsUrl = await discoverWsUrl();
        const reply = await sendCommand(wsUrl, {
            id: 1,
            method: 'Debugger.setBreakpointByUrl',
            params: { url: `file://${TARGET}`, lineNumber: -1 },
        });
        ok(reply.error, 'invalid breakpoint request must return an error');
        strictEqual(reply.error.code, -32602);
    } finally {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.on('exit', resolve));
    }
});

Deno.test({ name: 'cdp: Debugger rejects invalid pause-on-exceptions state', timeout: 10000 }, async () => {
    const child = spawn(CNO, ['run', `--inspect=${HOST}:${PORT}`, TARGET], {
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    try {
        const wsUrl = await discoverWsUrl();
        const reply = await sendCommand(wsUrl, {
            id: 1,
            method: 'Debugger.setPauseOnExceptions',
            params: { state: 'sometimes' },
        });
        ok(reply.error, 'invalid pause-on-exceptions request must return an error');
        strictEqual(reply.error.code, -32602);
    } finally {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.on('exit', resolve));
    }
});
