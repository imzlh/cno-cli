import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import { normalizedPath, runBunProbe } from '../_helpers/bun-cli.ts';

Deno.test({ name: 'bun cli: run accepts an absolute env file and observes lifecycle argv/env/main with OXC and --no-oxc', timeout: 110000 }, async () => {
    await withTempDir('bun-cli-run', async (root) => {
        const entry = join(root, 'entry.ts');
        const envFile = join(root, 'run.env');
        await Deno.writeTextFile(envFile, 'CNO_BUN_RUN_ENV=from-env-file\n');
        await Deno.writeTextFile(entry, `
            import Bun, { argv, env, main, sleep } from 'bun';

            const started = Date.now();
            await sleep(4);
            const dateStarted = Date.now();
            await sleep(new Date(dateStarted + 4));
            const globalMatches = Bun === globalThis.Bun;
            const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Bun');
            console.log('BUN_RUN:' + JSON.stringify({
                global: globalMatches,
                named: argv === Bun.argv && env === Bun.env && main === Bun.main && sleep === Bun.sleep,
                args: Bun.argv.slice(-2),
                env: Bun.env.CNO_BUN_RUN_ENV,
                main: Bun.main,
                delayed: Date.now() - started >= 2,
                dateDelayed: Date.now() - dateStarted >= 2,
                descriptor: descriptor && {
                    writable: descriptor.writable,
                    configurable: descriptor.configurable,
                    enumerable: descriptor.enumerable,
                },
            }));
        `);

        const envArgs = [`--env-file=${envFile}`];
        const oxc = await runBunProbe(root, entry, join(root, 'cache-oxc'), envArgs);
        const noOxc = await runBunProbe(root, entry, join(root, 'cache-no-oxc'), ['--no-oxc', ...envArgs]);

        for (const probe of [oxc, noOxc]) {
            strictEqual(probe.global, true);
            strictEqual(probe.named, true);
            ok(Array.isArray(probe.args), 'JSON probe should expose args as an array');
            strictEqual(JSON.stringify(probe.args), JSON.stringify(['--frozen', 'script-value']));
            strictEqual(probe.env, 'from-env-file');
            ok(normalizedPath(probe.main).endsWith('/entry.ts'), String(probe.main));
            strictEqual(probe.delayed, true);
            strictEqual(probe.dateDelayed, true);
            strictEqual(JSON.stringify(probe.descriptor), JSON.stringify({
                writable: false,
                configurable: false,
                enumerable: true,
            }));
        }
    });
});
