// CNO_NATIVE_BIN=/absolute/path/to/rebuilt/cno node --test tests/ci/async-context.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const harness = join(repository, 'tests/_helpers/async-context-lane.mjs');
const files = ['async-hooks', 'async-hooks-concurrency', 'async-hooks-als-concurrency-rotation']
    .map(name => pathToFileURL(join(repository, `tests/node/${name}.test.ts`)).href);
const binary = process.env.CNO_NATIVE_BIN && resolve(process.env.CNO_NATIVE_BIN);

function run(binary, args, env = process.env, timeout = 10_000) {
    const result = spawnSync(binary, args, { cwd: repository, env, encoding: 'utf8', timeout });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function contract(binary, prefix, file, selected, env) {
    const stdout = run(binary, [...prefix, harness, file, selected], env);
    const reports = stdout.split(/\r?\n/).filter(line => line.startsWith('CNO_ASYNC_CONTEXT_RESULT '));
    assert.equal(reports.length, 1, `Missing or duplicate contract report:\n${stdout}`);
    return JSON.parse(reports[0].slice('CNO_ASYNC_CONTEXT_RESULT '.length));
}

const contracts = files.flatMap(file => {
    const names = contract(process.execPath, [], file, '--list');
    assert.ok(names.length > 0, `No known gaps found in ${file}`);
    assert.equal(new Set(names).size, names.length, `Duplicate contracts in ${file}`);
    return names.map(name => ({ file, name }));
});

test('async-context: isolated Node oracle validates every known-gap contract', async t => {
    for (const { file, name } of contracts) {
        await t.test(name, () => {
            const result = contract(process.execPath, [], file, name);
            assert.equal(result.outcome, 'pass', result.stack ?? JSON.stringify(result));
        });
    }
});

function nativeSources(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? nativeSources(path) : /\.[ch]$/.test(entry.name) ? [path] : [];
    });
}

test('async-context: rebuilt cno reports expected failures separately', {
    skip: !binary && 'Set CNO_NATIVE_BIN to a rebuilt artifact; the default staged binary may be stale',
    timeout: 180_000,
}, async t => {
    const artifact = statSync(binary);
    const sources = [
        ...nativeSources(join(repository, 'circu.js/src')),
        join(repository, 'circu.js/deps/quickjs/quickjs.c'),
        join(repository, 'circu.js/deps/quickjs/quickjs.h'),
    ];
    const newer = sources.filter(path => statSync(path).mtimeMs > artifact.mtimeMs);
    assert.deepEqual(newer, [], 'Stale native artifact; rebuild after native freeze before running this lane');
    t.diagnostic(`artifact ${binary}; sha256 ${createHash('sha256').update(readFileSync(binary)).digest('hex')}`);
    const directory = mkdtempSync(join(tmpdir(), 'cno-async-context-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const env = { ...process.env, CTS_CACHE_DIR: join(directory, 'cache') };
    run(binary, ['setup'], env, 30_000);

    for (const { file, name } of contracts) {
        // Classification happens outside TODO, so crashes/timeouts never become expected failures.
        const result = contract(binary, ['run', '--no-oxc', '--no-lock'], file, name, env);
        if (result.outcome === 'gap') {
            await t.test(name, { todo: 'runtime async-context propagation is incomplete' }, () => {
                assert.fail(result.stack ?? result.message);
            });
        } else {
            await t.test(name, () => {
                assert.fail(`XPASS: promote this contract to the ordinary suite: ${name}`);
            });
        }
    }
});

test('async-context harness rejects unrelated failures and reports successful contracts', t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-async-context-harness-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const fixture = join(directory, 'contracts.mjs');
    const name = '[known gap: async-context] fixture';
    for (const body of [
        'throw new TypeError("async-context: unrelated failure")',
        'strictEqual(1, 2, "unrelated assertion")',
        'process.exit(0)',
    ]) {
        writeFileSync(fixture, `import { strictEqual } from 'node:assert';\nDeno.test({name:${JSON.stringify(name)},ignore:true,fn(){${body}}});`);
        assert.throws(() => contract(process.execPath, [], pathToFileURL(fixture).href, name));
    }
    writeFileSync(fixture, `Deno.test({name:${JSON.stringify(name)},ignore:true,fn(){}});`);
    assert.deepEqual(contract(process.execPath, [], pathToFileURL(fixture).href, name), { outcome: 'pass' });
    writeFileSync(fixture, `import { strictEqual } from 'node:assert';\nDeno.test({name:${JSON.stringify(name)},ignore:true,fn(){strictEqual(1,2,'async-context: missing store')}});`);
    const gap = contract(process.execPath, [], pathToFileURL(fixture).href, name);
    assert.equal(gap.outcome, 'gap');
    assert.match(gap.message, /^async-context: missing store(?:\n|$)/);
    assert.throws(() => run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.env, 100));
});
