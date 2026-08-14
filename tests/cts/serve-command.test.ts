import { spawn, type ChildProcess } from 'node:child_process';
import { ok, strictEqual } from 'node:assert';

const CNO = Deno.execPath().replace(/ \(deleted\)$/, '');

interface ChildRun {
    proc: ChildProcess;
    readonly stdout: string;
    readonly stderr: string;
    readonly closed: Promise<{ code: number | null; signal: string | null }>;
}

function startCno(args: string[], cwd: string, cacheDir: string): ChildRun {
    const proc = spawn(CNO, args, {
        cwd,
        env: { ...process.env, CTS_CACHE_DIR: cacheDir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    proc.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        proc.once('error', reject);
        proc.once('close', (code: number | null, signal: string | null) => resolve({ code, signal }));
    });
    return {
        proc,
        get stdout() { return stdout; },
        get stderr() { return stderr; },
        closed,
    };
}

async function waitForOutput(child: ChildRun, pattern: RegExp, timeoutMs = 8000): Promise<RegExpExecArray> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const match = pattern.exec(child.stdout);
        if (match) return match;
        const closed = await Promise.race([
            child.closed.then((result) => result),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
        ]);
        if (closed) {
            throw new Error(`cno serve exited before listening: ${JSON.stringify(closed)}\nstderr:\n${child.stderr}`);
        }
    }
    throw new Error(`cno serve did not listen within ${timeoutMs}ms\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
}

async function stop(child: ChildRun): Promise<void> {
    if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill();
    await child.closed;
}

async function assertServeFailure(
    source: string,
    expected: string,
    extraArgs: string[] = [],
): Promise<void> {
    const dir = Deno.makeTempDirSync();
    const cacheDir = Deno.makeTempDirSync();
    const entry = `${dir}/invalid.ts`;
    Deno.writeTextFileSync(entry, source);
    const child = startCno(['serve', ...extraArgs, entry], dir, cacheDir);
    try {
        const result = await Promise.race([
            child.closed,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        if (result === null) {
            await stop(child);
            throw new Error(`cno serve did not reject invalid export\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
        }
        strictEqual(result.code, 1, child.stderr);
        ok(child.stderr.includes(expected), child.stderr);
    } finally {
        await stop(child);
        removeTree(dir);
        removeTree(cacheDir);
    }
}

function removeTree(path: string): void {
    try { Deno.removeSync(path, { recursive: true }); } catch { /* best effort */ }
}

Deno.test({ name: 'cli: serve starts the default.fetch export', timeout: 15000 }, async () => {
    const dir = Deno.makeTempDirSync();
    const cacheDir = Deno.makeTempDirSync();
    const entry = `${dir}/server.ts`;
    Deno.writeTextFileSync(entry, `
export default {
    fetch(request) {
        return new Response('serve-command:' + new URL(request.url).pathname + ':' + Deno.args[0]);
    },
    onListen(addr) {
        console.log('serve-command-listening:' + addr.port);
    },
};
`);

    const child = startCno(
        ['serve', '--host', '127.0.0.1', '--port', '0', entry, 'entry-argument'],
        dir,
        cacheDir,
    );
    try {
        const match = await waitForOutput(child, /serve-command-listening:(\d+)/);
        const port = Number(match[1]);
        const response = await fetch(`http://127.0.0.1:${port}/hello`);
        strictEqual(response.status, 200);
        strictEqual(await response.text(), 'serve-command:/hello:entry-argument');
    } finally {
        await stop(child);
        removeTree(dir);
        removeTree(cacheDir);
    }
});

Deno.test({ name: 'cli: serve rejects an entry without default.fetch', timeout: 10000 }, async () => {
    await assertServeFailure(
        `export default { onListen() { console.log('must-not-listen'); } };`,
        'cno serve requires export default { fetch }',
    );
});

Deno.test({ name: 'cli: serve requires an object default export', timeout: 10000 }, async () => {
    await assertServeFailure(
        `export default Object.assign(() => new Response('wrong shape'), { fetch() { return new Response('wrong shape'); } });`,
        'cno serve requires export default { fetch }',
    );
});

Deno.test({ name: 'cli: serve rejects a non-function fetch', timeout: 10000 }, async () => {
    await assertServeFailure(`export default { fetch: null };`, 'default export fetch must be a function');
});

Deno.test({ name: 'cli: serve rejects a non-function onListen', timeout: 10000 }, async () => {
    await assertServeFailure(
        `export default { fetch() { return new Response('wrong shape'); }, onListen: null };`,
        'default export onListen must be a function',
    );
});

Deno.test({ name: 'cli: serve ignores extra export properties and supports inherited fetch', timeout: 15000 }, async () => {
    const dir = Deno.makeTempDirSync();
    const cacheDir = Deno.makeTempDirSync();
    const entry = `${dir}/server.ts`;
    Deno.writeTextFileSync(entry, `
const prototype = {
    fetch() {
        return new Response('inherited-fetch');
    },
};
const server = Object.create(prototype);
Object.defineProperty(server, 'ignored', {
    get() {
        throw new Error('ignored property was read');
    },
});
export default server;
`);
    const child = startCno(['serve', '--host', '127.0.0.1', '--port', '0', entry], dir, cacheDir);
    try {
        const match = await waitForOutput(child, /Listening on http:\/\/127\.0\.0\.1:(\d+)\//);
        const response = await fetch(`http://127.0.0.1:${Number(match[1])}/`);
        strictEqual(response.status, 200);
        strictEqual(await response.text(), 'inherited-fetch');
    } finally {
        await stop(child);
        removeTree(dir);
        removeTree(cacheDir);
    }
});

Deno.test({ name: 'cli: run does not start a default server export', timeout: 10000 }, async () => {
    const dir = Deno.makeTempDirSync();
    const cacheDir = Deno.makeTempDirSync();
    const entry = `${dir}/server.ts`;
    Deno.writeTextFileSync(entry, `
export default {
    fetch() {
        return new Response('run-does-not-serve');
    },
    onListen() {
        throw new Error('run must not call onListen');
    },
};
`);
    const child = startCno(['run', entry], dir, cacheDir);
    try {
        const result = await child.closed;
        strictEqual(result.code, 0, child.stderr);
        ok(!child.stderr.includes('run must not call onListen'), child.stderr);
    } finally {
        removeTree(dir);
        removeTree(cacheDir);
    }
});
