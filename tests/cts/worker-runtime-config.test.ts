import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

async function runCno(root: string, args: string[], env: Record<string, string> = {}) {
    const output = await new Deno.Command(Deno.execPath(), {
        args, cwd: root, stdout: 'piped', stderr: 'piped',
        env: { NODE_OPTIONS: '', CTS_SILENT: 'true', ...env },
    }).output();
    return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
    };
}

function probe(output: Awaited<ReturnType<typeof runCno>>) {
    strictEqual(output.code, 0, output.stdout + output.stderr);
    const rows = output.stdout.split(/\r?\n/).filter(line => line.startsWith('CONFIG:'));
    strictEqual(rows.length, 1, output.stdout + output.stderr);
    return JSON.parse(rows[0]!.slice('CONFIG:'.length));
}

Deno.test({ name: 'runtime config: explicit false overrides environment while project imports still resolve', timeout: 15000 }, async () => {
    let requests = 0;
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, () => {
        requests++;
        return new Response('export default "project-import";', { headers: { 'content-type': 'application/javascript' } });
    });
    try {
        await withTempDir('runtime-config-false', async root => {
            await Deno.writeTextFile(join(root, 'deno.json'), JSON.stringify({
                imports: { 'project-value': `http://127.0.0.1:${server.addr.port}/value.mjs` },
            }));
            const code = `
                import value from 'project-value';
                const cfg = Reflect.get(globalThis, '__cno_worker_runtime_config');
                console.log('CONFIG:' + JSON.stringify({ value, http: cfg.enableHttp, cache: cfg.enableCache, silent: cfg.silent }));
            `;
            await Deno.writeTextFile(join(root, 'main.mjs'), code);
            const env = {
                CTS_CACHE_DIR: join(root, 'cache'), CTS_ENABLE_HTTP: 'false',
                CTS_DISABLE_CACHE: 'true', CTS_SILENT: 'true', CTS_REQUEST_TIMEOUT: '2500',
                HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*',
                http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '*',
            };
            const disabled = await runCno(root, ['run', 'main.mjs'], env);
            ok(disabled.code !== 0, disabled.stdout + disabled.stderr);
            strictEqual(requests, 0, 'disabled HTTP must not send the project import request');
            for (const command of [['run', 'main.mjs'], ['eval', code]]) {
                const output = await runCno(root, [
                    '--no-http', command[0]!, '--no-http=false', '--disable-cache=false', '--silent=false', command[1]!,
                ], env);
                deepStrictEqual(probe(output), { value: 'project-import', http: true, cache: true, silent: false });
            }
            ok(requests > 0, 'enabled HTTP must resolve the project import through the loopback server');
        });
    } finally {
        await server.shutdown();
    }
});

Deno.test({ name: 'runtime config: eval keeps environment defaults when flags are absent', timeout: 10000 }, async () => {
    await withTempDir('eval-config-defaults', async root => {
        const code = `
            const cfg = Reflect.get(globalThis, '__cno_worker_runtime_config');
            console.log('CONFIG:' + JSON.stringify({ silent: cfg.silent, cache: cfg.enableCache }));
        `;
        deepStrictEqual(probe(await runCno(root, ['eval', code], {
            CTS_SILENT: 'true', CTS_DISABLE_CACHE: 'true',
        })), { silent: true, cache: false });
    });
});

Deno.test({ name: 'runtime config: file and eval workers inherit the prepared snapshot after environment changes', timeout: 15000 }, async () => {
    await withTempDir('worker-config-snapshot', async root => {
        const workerSource = `
            const { parentPort } = require('node:worker_threads');
            const cfg = Reflect.get(globalThis, '__cno_worker_runtime_config');
            parentPort.postMessage({
                silent: cfg.silent, jsx: cfg.jsxPragma, fragment: cfg.jsxFragmentPragma,
                timeout: cfg.requestTimeout, ttl: cfg.jsrCacheTTL,
            });
        `;
        await Deno.writeTextFile(join(root, 'worker.cjs'), workerSource);
        await Deno.writeTextFile(join(root, 'main.mjs'), `
            import { Worker } from 'node:worker_threads';
            for (const [name, value] of Object.entries({
                CTS_SILENT: 'false', CTS_JSX_PRAGMA: 'changed', CTS_JSX_FRAGMENT_PRAGMA: 'changed',
                CTS_REQUEST_TIMEOUT: '1', CTS_JSR_CACHE_TTL: '0',
            })) Deno.env.set(name, value);
            async function runWorker(evalMode) {
                const worker = new Worker(evalMode ? ${JSON.stringify(workerSource)} : new URL('./worker.cjs', import.meta.url), { eval: evalMode });
                let timer;
                try {
                    return await new Promise((resolve, reject) => {
                        let message;
                        worker.once('message', value => { message = value; });
                        worker.once('error', reject);
                        worker.once('exit', code => code === 0 && message ? resolve(message) : reject(new Error('worker exited without a result: ' + code)));
                        timer = setTimeout(() => { worker.terminate(); reject(new Error('worker timed out')); }, 4000);
                    });
                } finally { clearTimeout(timer); }
            }
            console.log('CONFIG:' + JSON.stringify([await runWorker(false), await runWorker(true)]));
        `);
        const output = await runCno(root, ['--silent', 'run', 'main.mjs'], {
            CTS_SILENT: 'false', CTS_JSX_PRAGMA: 'h', CTS_JSX_FRAGMENT_PRAGMA: 'Fragment',
            CTS_REQUEST_TIMEOUT: '2345', CTS_JSR_CACHE_TTL: '2',
        });
        const expected = { silent: true, jsx: 'h', fragment: 'Fragment', timeout: 2345, ttl: 2 * 24 * 60 * 60 * 1000 };
        deepStrictEqual(probe(output), [expected, expected]);
    });
});

Deno.test({ name: 'runtime config: parent empty import map overrides a worker directory project map', timeout: 10000 }, async () => {
    await withTempDir('worker-empty-import-map', async root => {
        const childDir = join(root, 'child');
        const packageDir = join(childDir, 'node_modules', 'worker-value');
        await Deno.mkdir(packageDir, { recursive: true });
        await Deno.writeTextFile(join(root, 'deno.json'), JSON.stringify({ imports: {} }));
        await Deno.writeTextFile(join(childDir, 'deno.json'), JSON.stringify({ imports: { 'worker-value': './mapped.cjs' } }));
        await Deno.writeTextFile(join(childDir, 'mapped.cjs'), 'module.exports = "child-project-map";');
        await Deno.writeTextFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'worker-value', version: '1.0.0', main: './index.cjs' }));
        await Deno.writeTextFile(join(packageDir, 'index.cjs'), 'module.exports = "local-package";');
        await Deno.writeTextFile(join(childDir, 'worker.mjs'), `
            import { parentPort } from 'node:worker_threads';
            import value from 'worker-value';
            parentPort.postMessage({
                value,
                map: Reflect.get(globalThis, '__cno_worker_runtime_config').importMap,
            });
        `);
        await Deno.writeTextFile(join(root, 'main.mjs'), `
            import { Worker } from 'node:worker_threads';
            const worker = new Worker(${JSON.stringify(join(childDir, 'worker.mjs'))});
            const timer = setTimeout(() => { worker.terminate(); process.exitCode = 1; }, 4000);
            worker.once('message', value => console.log('CONFIG:' + JSON.stringify(value)));
            worker.once('error', error => { console.error(error); process.exitCode = 1; });
            worker.once('exit', code => { clearTimeout(timer); if (code) process.exitCode = code; });
        `);
        deepStrictEqual(probe(await runCno(root, ['run', 'main.mjs'])), { value: 'local-package', map: {} });
    });
});
