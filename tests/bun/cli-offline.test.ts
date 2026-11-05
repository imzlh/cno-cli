import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import { jsonLine, outputOf, prepareCache, runCno } from '../_helpers/bun-cli.ts';

Deno.test({ name: 'bun cli: bare bun works offline with --no-node while node builtins stay disabled', timeout: 110000 }, async () => {
    await withTempDir('bun-cli-no-node', async (root) => {
        const entry = join(root, 'entry.ts');
        await Deno.writeTextFile(entry, `
            import Bun from 'bun';

            let dynamic = '';
            let cjs = '';
            try {
                await import('node:fs');
            } catch (error) {
                dynamic = String(error);
            }
            try {
                if (typeof require !== 'function') throw new Error('require is not available');
                require('node:fs');
            } catch (error) {
                cjs = String(error);
            }
            console.log('BUN_NO_NODE:' + JSON.stringify({
                global: Bun === globalThis.Bun,
                dynamic,
                cjs,
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

        const probe = jsonLine(result, 'BUN_NO_NODE:');
        strictEqual(probe.global, true);
        ok(/node:fs|node|disabled|require/i.test(String(probe.dynamic)), String(probe.dynamic));
        ok(/node:fs|node|disabled|require/i.test(String(probe.cjs)), String(probe.cjs));

        let npmCacheExists = false;
        try {
            npmCacheExists = Deno.statSync(join(cacheDir, 'npm')).isDirectory;
        } catch {
            // The bare builtin must not be reinterpreted as an npm package.
        }
        strictEqual(npmCacheExists, false);
    });
});
