import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import { jsonLine, outputOf, prepareCache, runCno } from '../_helpers/bun-cli.ts';

Deno.test({ name: 'bun cli: Web Worker contexts load bun without Node compatibility', timeout: 110000 }, async () => {
    await withTempDir('bun-web-worker', async (root) => {
        const worker = join(root, 'worker.ts');
        const entry = join(root, 'entry.ts');
        await Deno.writeTextFile(worker, `
            import Bun, { argv, env, main, sleep, fetch as bunFetch, isMainThread } from 'bun';
            const marker = '__cno_bun_web_worker_marker';
            Reflect.set(Bun, marker, true);
            const dynamic = await import('bun');
            await sleep(2);

            self.onmessage = () => {
                self.postMessage({
                    global: Bun === globalThis.Bun,
                    threadAndFetch: !isMainThread && isMainThread === Bun.isMainThread
                        && bunFetch === Bun.fetch && bunFetch !== globalThis.fetch
                        && dynamic.fetch === Bun.fetch && dynamic.isMainThread === Bun.isMainThread,
                    staticNamed: argv === Bun.argv && env === Bun.env
                        && main === Bun.main && sleep === Bun.sleep,
                    dynamicDefaultAbsent: !Object.hasOwn(dynamic, 'default'),
                    dynamicNamed: dynamic.argv === Bun.argv && dynamic.env === Bun.env
                        && dynamic.main === Bun.main && dynamic.sleep === Bun.sleep,
                    workerMarker: Reflect.get(Bun, marker) === true,
                    main: Bun.main,
                });
            };
        `);
        await Deno.writeTextFile(entry, `
            import Bun, { fetch as bunFetch, isMainThread } from 'bun';

            const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
            const message = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    worker.terminate();
                    reject(new Error('Bun Web Worker timed out'));
                }, 8000);
                worker.onmessage = (event) => {
                    clearTimeout(timer);
                    resolve(event.data);
                };
                worker.onerror = (event) => {
                    clearTimeout(timer);
                    worker.terminate();
                    reject(new Error(event.message || 'Bun Web Worker failed'));
                };
                worker.postMessage('probe');
            });
            worker.terminate();
            console.log('BUN_WEB_WORKER:' + JSON.stringify({
                main: Bun === globalThis.Bun,
                threadAndFetch: isMainThread && isMainThread === Bun.isMainThread
                    && bunFetch === Bun.fetch && bunFetch !== globalThis.fetch,
                mainMarker: Reflect.get(Bun, '__cno_bun_web_worker_marker') === undefined,
                worker: message,
            }));
        `);

        const cacheDir = join(root, 'cache');
        prepareCache(cacheDir);
        const result = await runCno([
            'run',
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-node',
            '--no-lock',
            '--no-oxc',
            `--cache-dir=${cacheDir}`,
            entry,
        ], root, cacheDir);
        strictEqual(result.code, 0, outputOf(result));
        const probe = jsonLine(result, 'BUN_WEB_WORKER:');
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
