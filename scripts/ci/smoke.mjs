#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stageArgument = process.argv[2];
const coreOnly = process.argv[3] === '--core-only';
if (!stageArgument || process.argv.length !== (coreOnly ? 4 : 3)) {
    console.error('Usage: node scripts/ci/smoke.mjs <stage-directory> [--core-only]');
    process.exit(1);
}

const stage = resolve(stageArgument);
const binary = join(stage, process.platform === 'win32' ? 'cno.exe' : 'cno');
const extensionSuffix = process.platform === 'win32' ? '.dll'
    : process.platform === 'darwin' ? '.dylib' : '.so';
const artifacts = coreOnly ? [binary] : [binary, join(stage, 'ext', `oxc${extensionSuffix}`)];
for (const file of artifacts) {
    if (!existsSync(file)) throw new Error(`Missing staged artifact: ${file}`);
}
if (!existsSync(join(repository, 'cno', 'src', 'node', 'fs', 'index.ts'))) {
    throw new Error('Local Node polyfills are missing; check out recursive submodules before smoke testing.');
}

const cache = process.env.CTS_CACHE_DIR
    ? resolve(process.env.CTS_CACHE_DIR)
    : mkdtempSync(join(tmpdir(), 'cno-ci-smoke-'));
mkdirSync(cache, { recursive: true });
const environment = {
    ...process.env,
    CTS_CACHE_DIR: cache,
    CTS_EXT_PATH: join(stage, 'ext'),
    NO_COLOR: '1',
};

function run(label, args, expectedOutput, timeout = 60_000, envOverrides = {}) {
    console.log(`\n[smoke] ${label}`);
    const result = spawnSync(binary, args, {
        cwd: repository,
        env: { ...environment, ...envOverrides },
        encoding: 'utf8',
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw new Error(`${label}: ${result.error.message}`, { cause: result.error });
    if (result.signal) throw new Error(`${label}: terminated by ${result.signal}`);
    if (result.status !== 0) throw new Error(`${label}: exited with status ${result.status}`);
    if (expectedOutput && !expectedOutput.test(result.stdout)) {
        throw new Error(`${label}: expected output ${expectedOutput} was missing`);
    }
    return result.stdout + result.stderr;
}

run('version', ['--version'], /^cno \d+\.\d+\.\d+/m);
// setup finds the checked-out polyfills from cwd, keeping this check offline.
run('install local polyfills', ['setup'], /Node polyfills ready at:/);
run('JavaScript evaluation', ['eval', '--ext=js',
    'if (await Promise.resolve(6 * 7) !== 42) throw new Error("evaluation failed"); console.log("CNO_CI_EVAL_OK");'],
    /^CNO_CI_EVAL_OK\r?$/m);
const nativeTransform = /oxc(?: bytes)?: [^\r\n]*[/\\]fixtures[/\\]typescript\.ts/;
if (coreOnly) {
    const coreOutput = run('TypeScript without native OXC',
        ['run', '--disable-cache', 'scripts/ci/fixtures/typescript.ts'],
        /^CNO_CI_TYPESCRIPT_OK\r?$/m, 60_000, { DEBUG: 'transformer' });
    if (nativeTransform.test(coreOutput)) {
        throw new Error('Core-only TypeScript unexpectedly used the native transformer');
    }
} else {
    run('load and call native OXC', ['run', 'scripts/ci/fixtures/oxc.mjs'], /^CNO_CI_OXC_OK\r?$/m);
    const oxcOutput = run('TypeScript with OXC', ['run', '--disable-cache', 'scripts/ci/fixtures/typescript.ts'],
        /^CNO_CI_TYPESCRIPT_OK\r?$/m, 60_000, { DEBUG: 'transformer' });
    if (!nativeTransform.test(oxcOutput)) {
        throw new Error('TypeScript with OXC: the runtime did not use the native transformer');
    }
}
// Disable caches in both runs so fallback must transform the TypeScript again.
const fallbackOutput = run('TypeScript with Sucrase fallback',
    ['run', '--no-oxc', '--disable-cache', 'scripts/ci/fixtures/typescript.ts'],
    /^CNO_CI_TYPESCRIPT_OK\r?$/m, 60_000, { DEBUG: 'transformer' });
if (nativeTransform.test(fallbackOutput)) {
    throw new Error('TypeScript with Sucrase fallback: --no-oxc still used the native transformer');
}
run('CLI flag regression tests', ['test', 'tests/cts/cli-flag-consumers.test.ts'], /1\/1/, 180_000);
console.log('\n[smoke] All staged runtime checks passed.');
