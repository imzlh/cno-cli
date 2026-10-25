// CNO_TEST_BINARY=/path/to/cno node --test tests/cts/pack-command.test.mjs
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

test('pack command preserves mixed modules, attribute views and container integrity', {
    skip: !existsSync(binary) && !process.env.CNO_TEST_BINARY ? 'Build cno or set CNO_TEST_BINARY first' : false,
    timeout: 60_000,
}, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-pack-command-'));
    t.after(() => {
        assert.equal(dirname(directory), resolve(tmpdir()));
        rmSync(directory, { recursive: true, force: true });
    });
    const bundle = join(directory, 'pack-command.test.js');
    // Bundle the fixture and used Node helpers before running it. The staged
    // runtime still executes every assertion and the real pack/run child processes.
    await build({
        absWorkingDir: repository,
        entryPoints: ['tests/cts/fixtures/pack-command.ts'],
        bundle: true, format: 'esm', platform: 'node', target: 'es2024', keepNames: true,
        outfile: bundle,
        plugins: [{
            name: 'bundle-runtime-assertions',
            setup(plugin) {
                plugin.onResolve({ filter: /^node:assert$/ }, () => ({
                    path: join(repository, 'cno/src/node/assert/mod.ts'),
                }));
                plugin.onResolve({ filter: /^node:fs$/ }, () => ({
                    path: join(repository, 'cno/src/node/fs/index.ts'),
                }));
                plugin.onResolve({ filter: /^node:path$/ }, () => ({
                    path: join(repository, 'cno/src/node/path/index.ts'),
                }));
            },
        }],
    });
    const cache = join(directory, 'cache');
    const run = args => {
        const result = spawnSync(binary, args, {
            cwd: repository,
            env: { ...process.env, CTS_CACHE_DIR: cache, CNO_TEST_CHILD_TIMEOUT_MS: '45000' },
            encoding: 'utf8', timeout: 50_000, windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return result.stdout;
    };
    run(['setup', `--cache-dir=${cache}`]);
    const output = run(['test', `--cache-dir=${cache}`, '--concurrency=1', bundle]);
    assert.equal((output.match(/^\s+ok /gm) ?? []).length, 13, output);
    assert.match(output, /PASS\s+.*pack-command\.test\.js/);
});
