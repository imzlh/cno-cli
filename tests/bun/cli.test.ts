import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

function commandEnv(cacheDir: string, extra: Record<string, string> = {}): Record<string, string> {
    const env = Deno.env.toObject();
    // Do not let a developer's global CTS/NODE settings change this isolated run.
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
    return { ...env, ...extra };
}

async function runCno(
    args: string[],
    cwd: string,
    cacheDir: string,
    env: Record<string, string> = {},
): Promise<CommandResult> {
    const executable = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(executable, {
        args,
        cwd,
        env: commandEnv(cacheDir, env),
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

function normalizedPath(value: unknown): string {
    return String(value).replaceAll('\\', '/');
}

async function runBunProbe(
    root: string,
    entry: string,
    cacheDir: string,
    options: string[],
): Promise<Record<string, unknown>> {
    const result = await runCno([
        'run',
        `--cache-dir=${cacheDir}`,
        '--cached-only',
        '--no-http',
        '--no-jsr',
        '--no-lock',
        '--no-node',
        ...options,
        entry,
        '--frozen',
        'script-value',
    ], root, cacheDir);
    strictEqual(result.code, 0, outputOf(result));
    return jsonLine(result, 'BUN_RUN:');
}

Deno.test({ name: 'bun cli: run accepts an absolute env file and observes lifecycle argv/env/main with OXC and --no-oxc', timeout: 30000 }, async () => {
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

Deno.test({ name: 'bun cli: eval loads the builtin after environment setup and supports print', timeout: 30000 }, async () => {
    await withTempDir('bun-cli-eval', async (root) => {
        const cacheDir = join(root, 'cache-eval');
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

        const printed = await runCno([
            'eval',
            `--cache-dir=${join(root, 'cache-print')}`,
            '--cached-only',
            '--no-http',
            '--no-jsr',
            '--no-lock',
            '--no-node',
            '--no-oxc',
            '-p',
            '!Object.hasOwn(await import("bun"), "default")',
        ], root, join(root, 'cache-print'));
        strictEqual(printed.code, 0, outputOf(printed));
        strictEqual(printed.stdout.trim(), 'true');
    });
});

Deno.test({ name: 'bun cli: bare bun works offline with --no-node while node builtins stay disabled', timeout: 30000 }, async () => {
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
