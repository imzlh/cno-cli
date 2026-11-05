import { strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import { jsonLine, outputOf, prepareCache, runCno } from '../_helpers/bun-cli.ts';

Deno.test({ name: 'bun cli: a relocated offline jspack runs without the source checkout', timeout: 110000 }, async () => {
    await withTempDir('bun-pack-relocated', async (root) => {
        const project = join(root, 'project');
        const relocated = join(root, 'relocated');
        const projectCache = join(root, 'pack-cache');
        const offlineCache = join(root, 'offline-cache');
        prepareCache(projectCache);
        prepareCache(offlineCache);
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

        const secondCache = join(root, 'offline-cache-second-run');
        prepareCache(secondCache);
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
        ], relocated, secondCache);
        strictEqual(secondRun.code, 0, outputOf(secondRun));
        const secondProbe = jsonLine(secondRun, 'BUN_PACK:');
        strictEqual(secondProbe.marker, 'PACK_BUN_OK');
        strictEqual(secondProbe.identity, true);
    });
});
