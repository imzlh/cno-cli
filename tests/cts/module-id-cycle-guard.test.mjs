// CNO_TEST_BINARY=/path/to/cno node --test tests/cts/module-id-cycle-guard.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const binary = resolve(repository, process.env.CNO_TEST_BINARY
    ?? `build/stage/cno${process.platform === 'win32' ? '.exe' : ''}`);

test('CTS cycle guards cover aliases, explicit views, compilation and evaluation', {
    skip: !existsSync(binary) && !process.env.CNO_TEST_BINARY ? 'Build cno or set CNO_TEST_BINARY first' : false,
    timeout: 60_000,
}, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-cycle-guards-'));
    t.after(() => {
        assert.equal(dirname(directory), resolve(tmpdir()));
        rmSync(directory, { recursive: true, force: true });
    });
    const bundle = join(directory, 'cycle-probe.mjs');
    // Importing CTS through its own source loader recursively transforms a large
    // dependency graph. Bundle first; the assertions still use the real compiler
    // methods and the staged binary's native Module implementation.
    await build({
        absWorkingDir: repository, bundle: true, format: 'esm', platform: 'node',
        target: 'es2024', keepNames: true, outfile: bundle,
        plugins: [{
            name: 'bundle-runtime-assertions',
            setup(plugin) {
                plugin.onResolve({ filter: /^node:assert$/ }, () => ({
                    path: join(repository, 'cno/src/node/assert/mod.ts'),
                }));
                plugin.onResolve({ filter: /^node:path$/ }, () => ({
                    path: join(repository, 'cno/src/node/path/index.ts'),
                }));
            },
        }],
        stdin: {
            resolveDir: repository,
            contents: `
                const cases = [];
                Deno.test = (name, fn) => cases.push({ name, fn });
                await import('./tests/cts/fixtures/module-id-cycle-guard.ts');
                for (const { name, fn } of cases) {
                    await fn();
                    console.log('PASS ' + name);
                }
                console.log('CYCLE_GUARDS_OK:' + cases.length);
            `,
        },
    });
    const cache = join(directory, 'cache');
    const run = args => {
        const result = spawnSync(binary, args, {
            cwd: repository, encoding: 'utf8', timeout: 25_000, windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return result.stdout;
    };
    run(['setup', `--cache-dir=${cache}`]);
    assert.match(run(['run', `--cache-dir=${cache}`, '--no-lock', bundle]), /CYCLE_GUARDS_OK:13\b/);
});
