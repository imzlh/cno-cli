import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

function commandEnv(cacheDir: string): Record<string, string> {
    const env = Deno.env.toObject();
    env.CTS_CACHE_DIR = cacheDir;
    env.CTS_LOCK_DIR = '';
    env.CTS_SILENT = 'true';
    env.NODE_OPTIONS = '';
    delete env.__CNO_TEST_CHILD;
    env.ALL_PROXY = '';
    env.HTTP_PROXY = '';
    env.HTTPS_PROXY = '';
    env.all_proxy = '';
    env.http_proxy = '';
    env.https_proxy = '';
    env.no_proxy = '*';
    env.NO_PROXY = '*';
    return env;
}

async function runCno(args: string[], cwd: string, cacheDir: string): Promise<CommandResult> {
    const executable = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(executable, {
        args,
        cwd,
        env: commandEnv(cacheDir),
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

function outputOf(result: CommandResult): string {
    return `${result.stdout}\n${result.stderr}`;
}

function jsonLine(result: CommandResult, prefix: string): Record<string, unknown> {
    const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith(prefix));
    ok(line, `missing ${prefix} line in:\n${outputOf(result)}`);
    return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
}

function copyNodeSource(src: string, dst: string): void {
    Deno.mkdirSync(dst, { recursive: true });
    for (const entry of Deno.readDirSync(src)) {
        const from = join(src, entry.name);
        const to = join(dst, entry.name);
        if (entry.isDirectory) copyNodeSource(from, to);
        else if (entry.isFile && entry.name.endsWith('.ts')) Deno.copyFileSync(from, to);
    }
}

function prepareLocalSetupSource(root: string): void {
    copyNodeSource(join(Deno.cwd(), 'cno', 'src', 'node'), join(root, 'cno', 'src', 'node'));
}

Deno.test({ name: 'bun cli: cache, precache, and frozen runs keep bun out of the lock boundary', timeout: 90000 }, async () => {
    await withTempDir('bun-cache-frozen', async (root) => {
        prepareLocalSetupSource(root);
        const entry = join(root, 'entry.ts');
        const dep = join(root, 'dep.ts');
        await Deno.writeTextFile(dep, `export const marker = 'CACHE_DEP_OK';\n`);
        await Deno.writeTextFile(entry, `
            import Bun from 'bun';
            import { marker } from './dep.ts';
            console.log('BUN_CACHE:' + JSON.stringify({ marker, identity: Bun === globalThis.Bun }));
        `);

        const cacheDir = join(root, 'cache');
        const cached = await runCno([
            'cache',
            '--silent',
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-node',
            '--no-oxc',
            `--cache-dir=${cacheDir}`,
            `--lock-dir=${root}`,
            entry,
        ], root, cacheDir);
        strictEqual(cached.code, 0, outputOf(cached));
        strictEqual(Deno.statSync(join(root, 'cts.lock')).isFile, true);

        const frozen = await runCno([
            'run',
            '--frozen',
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-node',
            '--no-oxc',
            `--cache-dir=${cacheDir}`,
            `--lock-dir=${root}`,
            entry,
        ], root, cacheDir);
        strictEqual(frozen.code, 0, outputOf(frozen));
        const frozenProbe = jsonLine(frozen, 'BUN_CACHE:');
        strictEqual(frozenProbe.marker, 'CACHE_DEP_OK');
        strictEqual(frozenProbe.identity, true);

        const precache = await runCno([
            'run',
            '--precache',
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-node',
            '--no-oxc',
            `--cache-dir=${join(root, 'cache-precache')}`,
            `--lock-dir=${join(root, 'lock-precache')}`,
            entry,
        ], root, join(root, 'cache-precache'));
        strictEqual(precache.code, 0, outputOf(precache));
        strictEqual(jsonLine(precache, 'BUN_CACHE:').identity, true);

        await Deno.writeTextFile(join(root, 'new-dep.ts'), `export const marker = 'UNLOCKED_DEP';\n`);
        await Deno.writeTextFile(entry, `
            import Bun from 'bun';
            import { marker } from './new-dep.ts';
            console.log('BUN_CACHE:' + JSON.stringify({ marker, identity: Bun === globalThis.Bun }));
        `);
        const rejected = await runCno([
            'run',
            '--frozen',
            '--disable-cache',
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-node',
            '--no-oxc',
            `--cache-dir=${cacheDir}`,
            `--lock-dir=${root}`,
            entry,
        ], root, cacheDir);
        strictEqual(rejected.code !== 0, true, outputOf(rejected));
        ok(/frozen|not in lock|lock/i.test(outputOf(rejected)), outputOf(rejected));
    });
});

Deno.test({ name: 'bun cli: a relocated offline jspack runs without the source checkout', timeout: 90000 }, async () => {
    await withTempDir('bun-pack-relocated', async (root) => {
        const project = join(root, 'project');
        const relocated = join(root, 'relocated');
        const projectCache = join(root, 'pack-cache');
        const offlineCache = join(root, 'offline-cache');
        Deno.mkdirSync(project, { recursive: true });
        Deno.mkdirSync(relocated, { recursive: true });
        await Deno.writeTextFile(join(project, 'payload.ts'), `export const marker = 'PACK_BUN_OK';\n`);
        await Deno.writeTextFile(join(project, 'entry.ts'), `
            import Bun, { sleep } from 'bun';
            import { marker } from './payload.ts';
            await sleep(2);
            console.log('BUN_PACK:' + JSON.stringify({ marker, identity: Bun === globalThis.Bun }));
        `);
        const pack = join(project, 'app.jspack');
        const packed = await runCno([
            'pack',
            '--silent',
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-node',
            '--no-lock',
            '--no-oxc',
            `--cache-dir=${projectCache}`,
            `--out=${pack}`,
            join(project, 'entry.ts'),
        ], project, projectCache);
        strictEqual(packed.code, 0, outputOf(packed));
        strictEqual(Deno.statSync(pack).isFile, true);

        const relocatedPack = join(relocated, 'app.jspack');
        Deno.copyFileSync(pack, relocatedPack);
        Deno.removeSync(project, { recursive: true });

        const run = await runCno([
            'run',
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-node',
            '--no-lock',
            '--no-oxc',
            relocatedPack,
        ], relocated, offlineCache);
        strictEqual(run.code, 0, outputOf(run));
        const probe = jsonLine(run, 'BUN_PACK:');
        strictEqual(probe.marker, 'PACK_BUN_OK');
        strictEqual(probe.identity, true);

        const secondRun = await runCno([
            'run',
            '--cached-only',
            '--disable-cache',
            '--no-http',
            '--no-jsr',
            '--no-node',
            '--no-lock',
            '--no-oxc',
            relocatedPack,
        ], relocated, join(root, 'offline-cache-second-run'));
        strictEqual(secondRun.code, 0, outputOf(secondRun));
        const secondProbe = jsonLine(secondRun, 'BUN_PACK:');
        strictEqual(secondProbe.marker, 'PACK_BUN_OK');
        strictEqual(secondProbe.identity, true);
    });
});

Deno.test({ name: 'bun cli: worker contexts install an independent Bun object and module view', timeout: 60000 }, async () => {
    await withTempDir('bun-worker', async (root) => {
        // This test deliberately exercises node:worker_threads as well as the
        // runtime builtin. Seed setup from the checkout so the child remains
        // offline and does not depend on the parent test cache.
        prepareLocalSetupSource(root);
        const worker = join(root, 'worker.ts');
        const entry = join(root, 'entry.ts');
        await Deno.writeTextFile(worker, `
            import Bun, { argv, env, main, sleep } from 'bun';
            import { parentPort } from 'node:worker_threads';
            const marker = '__cno_bun_worker_marker';
            Reflect.set(Bun, marker, true);
            const dynamic = await import('bun');
            await sleep(2);
            parentPort!.postMessage({
                global: Bun === globalThis.Bun,
                staticNamed: argv === Bun.argv && env === Bun.env && main === Bun.main && sleep === Bun.sleep,
                dynamicDefaultAbsent: !Object.hasOwn(dynamic, 'default'),
                dynamicNamed: dynamic.argv === Bun.argv && dynamic.env === Bun.env
                    && dynamic.main === Bun.main && dynamic.sleep === Bun.sleep,
                workerMarker: Reflect.get(Bun, marker) === true,
                main: Bun.main,
            });
        `);
        await Deno.writeTextFile(entry, `
            import Bun from 'bun';
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
        strictEqual(probe.mainMarker, true);
        const workerProbe = probe.worker as Record<string, unknown>;
        for (const key of ['global', 'staticNamed', 'dynamicDefaultAbsent', 'dynamicNamed', 'workerMarker']) {
            strictEqual(workerProbe[key], true, key);
        }
        ok(String(workerProbe.main).replaceAll('\\', '/').endsWith('/worker.ts'), String(workerProbe.main));
    });
});

Deno.test({ name: 'bun cli: Web Worker contexts load bun without Node compatibility', timeout: 60000 }, async () => {
    await withTempDir('bun-web-worker', async (root) => {
        const worker = join(root, 'worker.ts');
        const entry = join(root, 'entry.ts');
        await Deno.writeTextFile(worker, `
            import Bun, { argv, env, main, sleep } from 'bun';
            const marker = '__cno_bun_web_worker_marker';
            Reflect.set(Bun, marker, true);
            const dynamic = await import('bun');
            await sleep(2);

            self.onmessage = () => {
                self.postMessage({
                    global: Bun === globalThis.Bun,
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
            import Bun from 'bun';

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
                mainMarker: Reflect.get(Bun, '__cno_bun_web_worker_marker') === undefined,
                worker: message,
            }));
        `);

        const cacheDir = join(root, 'cache');
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
        strictEqual(probe.mainMarker, true);
        const workerProbe = probe.worker as Record<string, unknown>;
        for (const key of ['global', 'staticNamed', 'dynamicDefaultAbsent', 'dynamicNamed', 'workerMarker']) {
            strictEqual(workerProbe[key], true, key);
        }
        ok(String(workerProbe.main).replaceAll('\\', '/').endsWith('/worker.ts'), String(workerProbe.main));
    });
});
