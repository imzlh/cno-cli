import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import { jsonLine, outputOf, prepareCache, prepareLocalSetupSource, runCno } from '../_helpers/bun-cli.ts';

Deno.test({ name: 'bun cli: cache, precache, and frozen runs keep bun out of the lock boundary', timeout: 110000 }, async () => {
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
        prepareCache(cacheDir);
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

        const precacheCache = join(root, 'cache-precache');
        prepareCache(precacheCache);
        const precache = await runCno([
            'run',
            '--precache',
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-node',
            '--no-oxc',
            `--cache-dir=${precacheCache}`,
            `--lock-dir=${join(root, 'lock-precache')}`,
            entry,
        ], root, precacheCache);
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
