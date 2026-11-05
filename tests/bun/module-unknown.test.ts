import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import { jsonLine, outputOf, prepareCache, runCno } from '../_helpers/bun-cli.ts';

Deno.test({ name: 'bun module: unknown bun:* imports fail closed without npm or network fallback', timeout: 110000 }, async () => {
    await withTempDir('bun-module-unknown', async (root) => {
        const specifier = 'bun:not-a-supported-m1-module';
        const caught = join(root, 'caught.ts');
        const staticEntry = join(root, 'static.ts');
        await Deno.writeTextFile(caught, `
            const specifier = ${JSON.stringify(specifier)};
            let dynamic = '';
            let cjs = '';
            try {
                await import(specifier);
            } catch (error) {
                dynamic = String(error);
            }
            try {
                require(specifier);
            } catch (error) {
                cjs = String(error);
            }
            console.log('BUN_UNKNOWN:' + JSON.stringify({ dynamic, cjs }));
        `);
        await Deno.writeTextFile(staticEntry, `import ${JSON.stringify(specifier)};\n`);

        const cacheDir = join(root, 'cache-caught');
        prepareCache(cacheDir);
        const caughtResult = await runCno([
            'run',
            `--cache-dir=${cacheDir}`,
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-node',
            '--no-lock',
            '--no-oxc',
            caught,
        ], root, cacheDir);
        strictEqual(caughtResult.code, 0, outputOf(caughtResult));
        const caughtProbe = jsonLine(caughtResult, 'BUN_UNKNOWN:');
        ok(String(caughtProbe.dynamic).includes(specifier), String(caughtProbe.dynamic));
        ok(String(caughtProbe.cjs).includes(specifier), String(caughtProbe.cjs));
        ok(!outputOf(caughtResult).includes('npm package'), outputOf(caughtResult));

        const staticCache = join(root, 'cache-static');
        prepareCache(staticCache);
        const staticResult = await runCno([
            'run',
            `--cache-dir=${staticCache}`,
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-node',
            '--no-lock',
            '--no-oxc',
            staticEntry,
        ], root, staticCache);
        strictEqual(staticResult.code !== 0, true, outputOf(staticResult));
        ok(outputOf(staticResult).includes(specifier), outputOf(staticResult));
        ok(!outputOf(staticResult).includes('npm package'), outputOf(staticResult));

        let npmCacheExists = false;
        try {
            npmCacheExists = Deno.statSync(join(root, 'cache-caught', 'npm')).isDirectory;
        } catch {
            // A failed bun:* lookup must not create an npm cache namespace.
        }
        strictEqual(npmCacheExists, false);
    });
});
