import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import { jsonLine, outputOf, prepareLocalSetupSource, runCno } from '../_helpers/bun-cli.ts';

Deno.test({ name: 'bun cli: worker contexts install an independent Bun object and module view', timeout: 110000 }, async () => {
    await withTempDir('bun-worker', async (root) => {
        // This test deliberately exercises node:worker_threads as well as the
        // runtime builtin. Seed setup from the checkout so the child remains
        // offline and does not depend on the parent test cache.
        prepareLocalSetupSource(root);
        const worker = join(root, 'worker.ts');
        const entry = join(root, 'entry.ts');
        await Deno.writeTextFile(worker, `
            import Bun, { argv, env, main, sleep, fetch as bunFetch, isMainThread } from 'bun';
            import { parentPort } from 'node:worker_threads';
            const marker = '__cno_bun_worker_marker';
            Reflect.set(Bun, marker, true);
            const dynamic = await import('bun');
            await sleep(2);
            parentPort!.postMessage({
                global: Bun === globalThis.Bun,
                threadAndFetch: !isMainThread && isMainThread === Bun.isMainThread
                    && bunFetch === Bun.fetch && bunFetch !== globalThis.fetch
                    && dynamic.fetch === Bun.fetch && dynamic.isMainThread === Bun.isMainThread,
                staticNamed: argv === Bun.argv && env === Bun.env && main === Bun.main && sleep === Bun.sleep,
                dynamicDefaultAbsent: !Object.hasOwn(dynamic, 'default'),
                dynamicNamed: dynamic.argv === Bun.argv && dynamic.env === Bun.env
                    && dynamic.main === Bun.main && dynamic.sleep === Bun.sleep,
                workerMarker: Reflect.get(Bun, marker) === true,
                main: Bun.main,
            });
        `);
        await Deno.writeTextFile(entry, `
            import Bun, { fetch as bunFetch, isMainThread } from 'bun';
            import { Worker } from 'node:worker_threads';

            const child = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
            const message = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    void child.terminate();
                    reject(new Error('Bun worker timed out'));
                }, 8000);
                child.once('message', (value) => { clearTimeout(timer); resolve(value); });
                child.once('error', (error) => { clearTimeout(timer); reject(error); });
                child.once('exit', (code) => {
                    if (code !== 0) { clearTimeout(timer); reject(new Error('Bun worker exited: ' + code)); }
                });
            });
            await child.terminate();
            console.log('BUN_WORKER:' + JSON.stringify({
                main: Bun === globalThis.Bun,
                threadAndFetch: isMainThread && isMainThread === Bun.isMainThread
                    && bunFetch === Bun.fetch && bunFetch !== globalThis.fetch,
                mainMarker: Reflect.get(Bun, '__cno_bun_worker_marker') === undefined,
                worker: message,
            }));
        `);

        const cacheDir = join(root, 'cache');
        const setup = await runCno(['setup', `--cache-dir=${cacheDir}`], root, cacheDir);
        strictEqual(setup.code, 0, outputOf(setup));
        const result = await runCno([
            'run',
            '--no-lock',
            '--no-oxc',
            `--cache-dir=${cacheDir}`,
            entry,
        ], root, cacheDir);
        strictEqual(result.code, 0, outputOf(result));
        const probe = jsonLine(result, 'BUN_WORKER:');
        strictEqual(probe.main, true);
        strictEqual(probe.threadAndFetch, true);
        strictEqual(probe.mainMarker, true);
        const workerProbe = probe.worker as Record<string, unknown>;
        for (const key of ['global', 'staticNamed', 'dynamicDefaultAbsent', 'dynamicNamed', 'workerMarker', 'threadAndFetch']) {
            strictEqual(workerProbe[key], true, key);
        }
        ok(String(workerProbe.main).replaceAll('\\', '/').endsWith('/worker.ts'), String(workerProbe.main));
    });
});
