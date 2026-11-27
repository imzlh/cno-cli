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
