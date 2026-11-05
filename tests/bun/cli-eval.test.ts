import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import { jsonLine, normalizedPath, outputOf, prepareCache, runCno } from '../_helpers/bun-cli.ts';

Deno.test({ name: 'bun cli: eval loads the builtin after environment setup and supports print', timeout: 110000 }, async () => {
    await withTempDir('bun-cli-eval', async (root) => {
        const cacheDir = join(root, 'cache-eval');
        prepareCache(cacheDir);
        const code = `
            import Bun, { env, sleep } from 'bun';
            const started = Date.now();
            await sleep(3);
            console.log('BUN_EVAL:' + JSON.stringify({
                global: Bun === globalThis.Bun,
                env: env.CNO_BUN_EVAL_ENV,
                main: Bun.main,
                delayed: Date.now() - started >= 1,
            }));
        `;
        const evaluated = await runCno([
            'eval',
            `--cache-dir=${cacheDir}`,
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-lock',
            '--no-node',
            '--no-oxc',
            code,
        ], root, cacheDir, { CNO_BUN_EVAL_ENV: 'from-parent-env' });
        strictEqual(evaluated.code, 0, outputOf(evaluated));
        const probe = jsonLine(evaluated, 'BUN_EVAL:');
        strictEqual(probe.global, true);
        strictEqual(probe.env, 'from-parent-env');
        ok(normalizedPath(probe.main).includes('<eval>'), String(probe.main));
        strictEqual(probe.delayed, true);

        const printCache = join(root, 'cache-print');
        prepareCache(printCache);
        const printed = await runCno([
            'eval',
            `--cache-dir=${printCache}`,
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-lock',
            '--no-node',
            '--no-oxc',
            '-p',
            '!Object.hasOwn(await import("bun"), "default")',
        ], root, printCache);
        strictEqual(printed.code, 0, outputOf(printed));
        strictEqual(printed.stdout.trim(), 'true');
    });
});
