import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'cno-protocol-gate-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const stage = join(directory, 'staged runtime');
    const record = join(directory, 'calls.jsonl');
    const preloader = join(directory, 'preload.mjs');
    mkdirSync(join(stage, 'ext'), { recursive: true });
    for (const name of ['cno', 'cno.exe']) writeFileSync(join(stage, name), 'runtime fixture');
    writeFileSync(preloader, [
        "import childProcess from 'node:child_process';",
        "import { appendFileSync } from 'node:fs';",
        "import { syncBuiltinESMExports } from 'node:module';",
        "Object.defineProperty(process, 'platform', { value: process.env.CNO_GATE_PLATFORM });",
        "Object.defineProperty(process, 'arch', { value: 'x64' });",
        'childProcess.spawnSync = (command, args, options) => {',
        '    appendFileSync(process.env.CNO_GATE_RECORD, JSON.stringify({ command, args, cache: options.env?.CTS_CACHE_DIR, childTimeout: options.env?.CNO_TEST_CHILD_TIMEOUT_MS }) + "\\n");',
        "    if (command === 'cmake') return { status: 0 };",
        "    if (args[0] === '--version') return { status: 0, stdout: 'cno 1.0.0\\n' };",
        "    if (args[0] === 'setup') return { status: 0, stdout: 'Node polyfills ready at: fixture\\n' };",
        "    if (args[0] === 'test') return { status: args.includes(process.env.CNO_GATE_FAIL_BUCKET) ? 27 : 0 };",
        "    if (!args.includes('tests/ci/fixtures/protocols.ts')) throw new Error('unexpected runtime command');",
        "    if (process.env.CNO_GATE_RESULT === 'failure') return { status: 27, stderr: 'protocol failed' };",
        "    if (process.env.CNO_GATE_RESULT === 'signal') return { status: null, signal: 'SIGKILL' };",
        "    return { status: 0, stdout: process.env.CNO_GATE_RESULT === 'missing' ? '' : 'CNO_CI_PROTOCOLS_OK\\n' };",
        '};',
        'syncBuiltinESMExports();',
    ].join('\n'));
    const run = (script, args, env = {}) => spawnSync(process.execPath, ['--import', preloader, script, ...args], {
        cwd: repository, encoding: 'utf8', timeout: 10_000,
        env: {
            ...process.env, CNO_GATE_PLATFORM: 'linux', CNO_GATE_RECORD: record,
            CTS_CACHE_DIR: join(directory, 'cache'), CNO_GATE_RESULT: '', ...env,
        },
    });
    const calls = () => readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { directory, stage, record, run, calls };
}

test('native CI configure overrides cached protocol options on every native platform', t => {
    for (const platform of ['linux', 'darwin', 'win32']) {
        const f = fixture(t);
        const build = join(f.directory, 'build');
        mkdirSync(join(build, 'oxc-ci'), { recursive: true });
        writeFileSync(join(build, 'oxc-ci', platform === 'win32' ? 'oxc.dll' : 'oxc.so'), 'extension fixture');
        const opensslRoot = join(f.directory, 'openssl@3');
        const result = f.run(join(repository, 'scripts/ci/build.mjs'), [build], {
            CNO_GATE_PLATFORM: platform,
            CNO_OPENSSL_ROOT_DIR: opensslRoot,
        });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        const configure = f.calls().find(call => call.args[0] === '-S');
        assert.ok(configure.args.includes('-DCNO_EMBED_EXT_H2=ON'));
        assert.ok(configure.args.includes(`-DCNO_EMBED_EXT_QUIC=${platform === 'win32' ? 'OFF' : 'ON'}`));
        assert.equal(configure.args.includes(`-DOPENSSL_ROOT_DIR=${opensslRoot}`), platform === 'darwin');
    }
});

test('release protocol-only smoke requires the protocol fixture after setup without OXC or broad tests', t => {
    const f = fixture(t);
    const result = f.run(join(repository, 'scripts/ci/smoke.mjs'), [f.stage, '--protocols-only']);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(f.calls().map(call => call.args), [
        ['--version'], ['setup'], ['run', '--no-lock', 'tests/ci/fixtures/protocols.ts'],
    ]);
    assert.ok(f.calls().every(call => call.cache === join(f.directory, 'cache')));
});

test('release protocol-only smoke rejects missing markers, failures and terminated fixtures', t => {
    for (const failure of ['missing', 'failure', 'signal']) {
        const f = fixture(t);
        const result = f.run(join(repository, 'scripts/ci/smoke.mjs'), [f.stage, '--protocols-only'], {
            CNO_GATE_RESULT: failure,
        });
        assert.notEqual(result.status, 0, failure);
        assert.match(result.stderr, /built-in protocol round trips/);
        assert.equal(f.calls().length, 3);
    }
});

test('runtime CI keeps package file budgets above their individual test deadlines and runs every bucket after a failure', t => {
    const f = fixture(t);
    const result = f.run(join(repository, 'scripts/ci/run-tests.mjs'), [
        `--stage=${f.stage}`, '--shards=core,node,web,compat', '--concurrency=2',
    ], { CNO_GATE_FAIL_BUCKET: 'tests/node', CNO_TEST_CHILD_TIMEOUT_MS: '60000' });
    assert.equal(result.status, 1, result.stderr || result.error?.message);
    const calls = f.calls();
    assert.deepEqual(calls.slice(0, 2).map(call => call.args), [
        ['setup'], ['run', '--no-lock', 'tests/ci/fixtures/protocols.ts'],
    ]);
    assert.deepEqual(calls.slice(2).map(call => [call.args, call.childTimeout]), [
        [['test', 'tests/cno', 'tests/cjs', 'tests/cts', '--concurrency=2'], '60000'],
        [['test', 'tests/node', '--concurrency=2'], '60000'],
        [['test', 'tests/deno', 'tests/webapi', '--concurrency=2'], '60000'],
        [['test', 'tests/bun', '--concurrency=2'], '300000'],
        [['test', 'tests/jsr', '--concurrency=2'], '60000'],
        [['test', 'tests/npm', '--concurrency=1'], '600000'],
    ]);
    assert.ok(calls.every(call => call.cache === join(f.directory, 'cache')));
});

test('Linux release protocol-only smoke fails before packaging on a failed or empty fixture', {
    skip: process.platform === 'win32' && 'Requires executable shell fixtures',
}, t => {
    for (const failure of ['', 'missing', 'failure']) {
        const f = fixture(t);
        const tools = join(f.directory, 'tools');
        mkdirSync(tools);
        writeFileSync(join(tools, 'timeout'), '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
        writeFileSync(join(f.stage, 'cno'), [
            '#!/bin/sh',
            'printf "%s\\n" "$*" >> "$CNO_GATE_RECORD"',
            'case "$1" in',
            '    --version) echo "cno 1.0.0" ;;',
            '    setup) echo "Node polyfills ready at: fixture" ;;',
            '    run)',
            '        case "$CNO_GATE_RESULT" in',
            '            missing) exit 0 ;;',
            '            failure) exit 27 ;;',
            '        esac',
            '        echo CNO_CI_PROTOCOLS_OK ;;',
            '    *) exit 29 ;;',
            'esac',
        ].join('\n'), { mode: 0o755 });
        chmodSync(join(f.stage, 'cno'), 0o755);
        const result = spawnSync('sh', [join(repository, 'scripts/ci/linux/smoke.sh'), f.stage, '--protocols-only'], {
            cwd: repository, encoding: 'utf8', timeout: 10_000,
            env: {
                ...process.env, PATH: tools + delimiter + process.env.PATH,
                CTS_CACHE_DIR: join(f.directory, 'cache'), CNO_GATE_RECORD: f.record, CNO_GATE_RESULT: failure,
            },
        });
        if (failure) assert.notEqual(result.status, 0, failure);
        else assert.equal(result.status, 0, result.stderr || result.error?.message);
        assert.deepEqual(readFileSync(f.record, 'utf8').trim().split('\n'), [
            '--version', 'setup', 'run --no-lock tests/ci/fixtures/protocols.ts',
        ]);
    }
});
