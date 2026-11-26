import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const binary = resolve(repository, process.env.CNO_TEST_BINARY
    ?? `build/stage/cno${process.platform === 'win32' ? '.exe' : ''}`);
const fixture = join(repository, 'tests/node/fixtures/http2-interop.mjs');

function startPeer(t, command, args, env) {
    const child = spawn(command, args, {
        cwd: repository, env, windowsHide: true, signal: t.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const readiness = Promise.withResolvers();
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
        stdout += data;
        const ready = /^CNO_NODE_HTTP2_READY:(\d+)\r?$/m.exec(stdout);
        if (ready) readiness.resolve(Number(ready[1]));
    });
    child.stderr.on('data', data => { stderr += data; });
    const closeComplete = new Promise(resolve => child.once('close', resolve));
    const finished = new Promise((resolve, reject) => {
        child.once('error', error => {
            readiness.reject(error);
            reject(error);
        });
        child.once('close', (code, signal) => {
            readiness.reject(new Error(`HTTP/2 peer exited before readiness (${code ?? signal})\n${stdout}${stderr}`));
            resolve({ code, signal, stdout, stderr });
        });
    });
    void readiness.promise.catch(() => {});
    void finished.catch(() => {});
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closeComplete;
    });
    return { child, ready: readiness.promise, finished };
}

function successful(result, marker) {
    assert.equal(result.signal, null, result.stdout + result.stderr);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, marker);
}

test('HTTP/2 exchanges multiplexed bodies with the real Node runtime in both directions', {
    skip: !existsSync(binary) && !process.env.CNO_TEST_BINARY ? 'Build cno or set CNO_TEST_BINARY first' : false,
    timeout: 90_000,
}, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-node-http2-interop-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const env = { ...process.env, CTS_CACHE_DIR: join(directory, 'cache'), NO_COLOR: '1' };
    const setup = spawnSync(binary, ['setup'], {
        cwd: repository, env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.ifError(setup.error);
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    const credentials = spawnSync(binary, ['run', '--no-lock', fixture, 'credentials'], {
        cwd: repository, env, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.ifError(credentials.error);
    assert.equal(credentials.status, 0, credentials.stdout + credentials.stderr);
    const credentialsPath = join(directory, 'credentials.json');
    writeFileSync(credentialsPath, JSON.stringify(JSON.parse(credentials.stdout)));

    for (const direction of ['cno server', 'Node server']) {
        for (const transport of direction === 'cno server' ? ['h2c', 'tls', 'deno'] : ['h2c', 'tls']) {
            await t.test(`${direction}, ${transport}`, { timeout: 15_000 }, async context => {
                const cnoArgs = ['run', '--no-lock', fixture];
                const server = direction === 'cno server'
                    ? startPeer(context, binary, [...cnoArgs, 'server', transport, credentialsPath], env)
                    : startPeer(context, process.execPath, [fixture, 'server', transport, credentialsPath], env);
                const port = await server.ready;
                assert.ok(port > 0);
                const client = direction === 'cno server'
                    ? startPeer(context, process.execPath, [fixture, 'client', transport, String(port)], env)
                    : startPeer(context, binary, [...cnoArgs, 'client', transport, String(port)], env);
                successful(await client.finished, /^CNO_NODE_HTTP2_CLIENT_OK\r?$/m);
                server.child.stdin.end('stop\n');
                successful(await server.finished, /^CNO_NODE_HTTP2_SERVER_OK\r?$/m);
            });
        }
    }
});
