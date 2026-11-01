import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = join(root, 'tests/bun/differential-fixture.mjs');
const cno = process.env.CNO_TEST_BINARY || join(root, 'build/stage', process.platform === 'win32' ? 'cno.exe' : 'cno');
const bun = process.env.CNO_BUN_ORACLE;

test('supported Bun file and global behavior matches the selected Bun oracle', { skip: !bun && 'set CNO_BUN_ORACLE to a Bun executable' }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-bun-oracle-'));
    try {
        const env = {
            ...process.env,
            CNO_BUN_ORACLE_DIR: directory,
            CNO_BUN_ORACLE_VALUE: 'oracle-value',
            CTS_CACHE_DIR: join(directory, 'cache'),
            NO_COLOR: '1',
        };
        function run(binary, args) {
            const result = spawnSync(binary, args, { cwd: directory, env, encoding: 'utf8', timeout: 30000 });
            assert.equal(result.status, 0, `${binary}: ${result.error || result.stderr || result.stdout}`);
            return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
        }
        const expected = run(bun, ['run', fixture, 'arg']);
        const actual = run(cno, ['run', '--cached-only', '--no-http', '--no-jsr', '--no-lock', '--no-oxc', fixture, 'arg']);
        assert.deepEqual(actual, expected);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
