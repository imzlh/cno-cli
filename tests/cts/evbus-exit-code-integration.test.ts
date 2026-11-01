import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

async function runCno(root: string, args: string[]) {
    const output = await new Deno.Command(Deno.execPath().replace(/ \(deleted\)$/, ''), {
        args,
        cwd: root,
        stdout: 'piped',
        stderr: 'piped',
        env: { NODE_OPTIONS: '', CTS_SILENT: 'true', CTS_CACHE_DIR: join(root, 'cache') },
    }).output();
    return { code: output.code, stdout: decodeUtf8(output.stdout), stderr: decodeUtf8(output.stderr) };
}

Deno.test({ name: 'evbus exit: a sandbox can request the CLI status without its global slot', timeout: 20000 }, async () => {
    await withTempDir('evbus-exit-sandbox', async root => {
        const marker = join(root, 'marker');
        const file = join(root, 'main.mjs');
        await Deno.writeTextFile(file, `
            const evbus = import.meta.use('evbus');
            const sandbox = new (import.meta.use('engine').Sandbox)();
            sandbox.global.evbus = evbus;
            sandbox.call(\`
                if (globalThis[Symbol.for('cno.runtime.requestExitCode')] !== undefined) throw new Error('unexpected global slot');
                const handler = evbus.get('cno.runtime', 'requestExitCode');
                if (typeof handler !== 'function') throw new Error('missing evbus handler');
                handler(1);
            \`);
            Deno.writeTextFileSync(${JSON.stringify(marker)}, 'continued');
        `);
        const result = await runCno(root, ['run', file]);
        strictEqual(result.code, 1, result.stdout + result.stderr);
        strictEqual(await Deno.readTextFile(marker), 'continued');
    });
});

Deno.test({ name: 'evbus exit: a throwing handler fails the request, not the runtime', timeout: 20000 }, async () => {
    await withTempDir('evbus-exit-throw', async root => {
        const marker = join(root, 'marker');
        const file = join(root, 'main.mjs');
        await Deno.writeTextFile(file, `
            let evbusCalls = 0;
            import.meta.use('evbus').set('cno.runtime', 'requestExitCode', () => { evbusCalls++; throw undefined; });
            Promise.reject(new Error('expected rejection'));
            setTimeout(() => Deno.writeTextFileSync(${JSON.stringify(marker)}, String(evbusCalls)), 30);
        `);
        const result = await runCno(root, ['run', file]);
        strictEqual(result.code, 0, result.stdout + result.stderr);
        strictEqual(await Deno.readTextFile(marker), '1');
        ok(result.stderr.includes('expected rejection'), result.stderr);
    });
});

Deno.test({ name: 'evbus exit: a test child ignores requested failure status', timeout: 30000 }, async () => {
    await withTempDir('evbus-exit-test-child', async root => {
        const file = join(root, 'fixture.test.ts');
        await Deno.writeTextFile(file, `
            Deno.test('child exit hook is a no-op', () => {
                const handler = import.meta.use('evbus').get('cno.runtime', 'requestExitCode');
                if (typeof handler !== 'function') throw new Error('missing test-child handler');
                handler(1);
            });
        `);
        const result = await runCno(root, ['test', file]);
        strictEqual(result.code, 0, result.stdout + result.stderr);
        ok(result.stdout.includes('child exit hook is a no-op'), result.stdout);
    });
});

Deno.test({ name: 'evbus exit: a worker does not inherit the CLI exit handler', timeout: 30000 }, async () => {
    await withTempDir('evbus-exit-worker', async root => {
        const marker = join(root, 'marker');
        const file = join(root, 'main.mjs');
        await Deno.writeTextFile(join(root, 'worker.mjs'), `
            const handler = import.meta.use('evbus').get('cno.runtime', 'requestExitCode');
            postMessage(typeof handler + ':' + typeof globalThis[Symbol.for('cno.runtime.requestExitCode')]);
        `);
        await Deno.writeTextFile(file, `
            if (typeof import.meta.use('evbus').get('cno.runtime', 'requestExitCode') !== 'function') {
                throw new Error('missing main-thread handler');
            }
            const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
            const timer = setTimeout(() => { console.error('worker timed out'); process.exitCode = 1; worker.terminate(); }, 5000);
            worker.onmessage = event => {
                clearTimeout(timer);
                Deno.writeTextFileSync(${JSON.stringify(marker)}, event.data);
                worker.terminate();
            };
            worker.onerror = error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; worker.terminate(); };
        `);
        const result = await runCno(root, ['run', file]);
        strictEqual(result.code, 0, result.stdout + result.stderr);
        strictEqual(await Deno.readTextFile(marker), 'undefined:undefined');
    });
});
