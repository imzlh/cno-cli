import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const reporter = join(repository, 'scripts/ci/report-build-errors.mjs');

test('build failure reporter emits portable compiler errors as workflow annotations', t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-build-diagnostics-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const log = join(directory, 'native-build.log');
    const summary = join(directory, 'summary.md');
    writeFileSync(log, [
        'cmake --build build --config Release --target cno',
        'src/mod_process.c(846): error C4018: signed/unsigned mismatch',
        'error[E0308]: mismatched types',
        'error[E0308]: mismatched types',
        '\u001b[91merror\u001b[0m: failed to compile `oxc`',
        'error: rejected text % and ::workflow::command',
    ].join('\n'));

    const result = spawnSync(process.execPath, [reporter, log], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::error title=Native build diagnostics::/);
    assert.match(result.stdout, /error C4018/);
    assert.match(result.stdout, /error\[E0308\]/);
    assert.match(result.stdout, /error: failed to compile `oxc`/);
    assert.match(result.stdout, /rejected text %25 and ::workflow::command/);
    assert.doesNotMatch(result.stdout, /rejected text % and/);
    assert.equal(result.stdout.match(/error\[E0308\]/g)?.length, 1);
    assert.match(readFileSync(summary, 'utf8'), /Native build diagnostics/);
});

test('build failure reporter falls back to the log tail when no compiler error matches', t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-build-diagnostics-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const log = join(directory, 'native-build.log');
    writeFileSync(log, 'configure started\ncmake failed before compiler diagnostics\n');

    const result = spawnSync(process.execPath, [reporter, log], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cmake failed before compiler diagnostics/);
});

test('runtime failure reporter groups failures across buckets without annotating expected errors', t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-test-diagnostics-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const log = join(directory, 'runtime-tests.log');
    const summary = join(directory, 'summary.md');
    writeFileSync(log, [
        '=== shard core: tests/cts ===',
        '  ok expected Error: invalid input',
        'Failed tests:',
        '  tests/cts/example.test.ts  retains module identity',
        '    AssertionError: mismatched value %25',
        '+ actual - expected',
        "+ 'actual-path'",
        "- 'expected-path'",
        '    at strictEqual (node:assert/mod:321:15)',
        '  tests/cts/example.test.ts  rejects invalid input',
        '    TypeError: unexpected value',
        '\u001b[31m✖ 3/4\u001b[0m',
        '=== shard compat/npm: tests/npm ===',
        '  ok expected parse error',
        'Failed tests:',
        '  tests/npm/example.test.ts  test module failed',
        '    test worker timed out after 600000ms without reporting a result',
        '✖ 1/2',
    ].join('\n'));
    const result = spawnSync(process.execPath, [join(repository, 'scripts/ci/report-test-errors.mjs'), log], {
        encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.match(/::error /g)?.length, 2);
    assert.match(result.stdout, /file=tests\/cts\/example.test.ts/);
    assert.match(result.stdout, /mismatched value %2525%0A\+ actual - expected/);
    assert.match(result.stdout, /\+ 'actual-path'%0A- 'expected-path'%0Arejects invalid input/);
    assert.match(result.stdout, /test worker timed out after 600000ms/);
    assert.doesNotMatch(result.stdout, /expected Error|expected parse error|at strictEqual/);
    assert.match(readFileSync(summary, 'utf8'), /example.test.ts`: 2 failed cases/);
    assert.match(readFileSync(summary, 'utf8'), /tests\/npm\/example.test.ts`: 1 failed case/);
});

test('runtime failure reporter surfaces preflight failures without per-file results', t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-test-diagnostics-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const log = join(directory, 'runtime-tests.log');
    writeFileSync(log, 'built-in protocol preflight failed: 1\n');
    const result = spawnSync(process.execPath, [join(repository, 'scripts/ci/report-test-errors.mjs'), log], {
        encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::error title=Runtime test failure::Runtime tests failed before a per-file failure report/);
});

test('runtime failure summary preserves later cases and long details beyond the annotation budget', t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-test-diagnostics-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const log = join(directory, 'runtime-tests.log');
    const summary = join(directory, 'summary.md');
    writeFileSync(log, [
        'Failed tests:',
        '  tests/npm/example.test.ts  returns a failed transform response',
        `    AssertionError: ${'response '.repeat(500)}`,
        ...Array.from({ length: 20 }, (_, index) => `    response detail ${index}`),
        '    ```text',
        '    echoed source with a code fence',
        '    ```',
        '  tests/npm/example.test.ts  resolves Windows disk paths',
        '    Error: original path was resolved relative to the repository',
        '✖ 0/1',
    ].join('\n'));

    const result = spawnSync(process.execPath, [join(repository, 'scripts/ci/report-test-errors.mjs'), log], {
        encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[Truncated; see complete failure details in the job summary\.\]/);
    assert.ok(result.stdout.length < 3200);
    const report = readFileSync(summary, 'utf8');
    assert.match(report, /example.test.ts`: 2 failed cases/);
    assert.match(report, /response detail 19/);
    assert.match(report, /resolves Windows disk paths\nError: original path/);
    assert.match(report, /````text\n/);
    assert.match(report, /\n```\n\nresolves Windows disk paths/);
});
