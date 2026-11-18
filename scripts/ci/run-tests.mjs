// Cross-platform test runner for CI: runs staged-runtime test buckets on the
// packaged artifact downloaded from the build job. Node hosts the script so
// Windows/macOS/Linux share one code path with no shell quoting pitfalls.
//
// Usage: node scripts/ci/run-tests.mjs --stage=<dir> --shards=a,b [--concurrency=4]
// The stage directory is the unpacked artifact (cno binary + ext/ + lib/).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, delimiter } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const i = a.indexOf('=');
    return i === -1 ? [a.slice(2), ''] : [a.slice(2, i), a.slice(i + 1)];
}));

const stage = resolve(args.stage ?? 'build/stage');
const concurrency = args.concurrency ?? '4';
const cacheDir = process.env.CTS_CACHE_DIR ?? join(stage, '.test-cache');

// Shards mirror the test-bucket sizes so no job approaches the 60-minute
// runner cap on the slowest platform (Windows spawns processes much slower).
const SHARDS = {
    core: ['tests/cno', 'tests/cjs', 'tests/cts'],
    node: ['tests/node'],
    web: ['tests/deno', 'tests/webapi'],
    compat: ['tests/bun', 'tests/jsr', 'tests/npm'],
};

const shardNames = (args.shards ?? '').split(',').filter(Boolean);
if (shardNames.length === 0) {
    console.error(`no shards given; available: ${Object.keys(SHARDS).join(', ')}`);
    process.exit(2);
}
for (const name of shardNames) {
    if (!SHARDS[name]) {
        console.error(`unknown shard "${name}"; available: ${Object.keys(SHARDS).join(', ')}`);
        process.exit(2);
    }
}

const binaryName = process.platform === 'win32' ? 'cno.exe' : 'cno';
const binary = join(stage, binaryName);
if (!existsSync(binary)) {
    console.error(`staged runtime not found: ${binary}`);
    process.exit(2);
}

// Native extensions and bundled shared libraries load relative to the binary,
// matching how an unpacked release archive is meant to run.
const env = {
    ...process.env,
    CTS_CACHE_DIR: cacheDir,
    PATH: `${stage}${delimiter}${process.env.PATH ?? ''}`,
};
if (process.platform === 'win32') {
    // vcpkg runtime DLLs ship beside the binary; loading them needs the
    // staged lib/ on PATH for child processes spawned by the tests.
    const libDir = join(stage, 'lib');
    if (existsSync(libDir)) env.PATH = `${libDir}${delimiter}${env.PATH}`;
}

// Install polyfill sources once so the suite starts from the documented
// post-`setup` state instead of every spawned child racing to populate the
// same fresh cache.
const setup = spawnSync(binary, ['setup'], { stdio: 'inherit', env });
if (setup.status !== 0) {
    console.error(`cno setup failed with exit ${setup.status}`);
    process.exit(setup.status ?? 1);
}

let failed = false;
for (const name of shardNames) {
    const paths = SHARDS[name];
    console.log(`\n=== shard ${name}: ${paths.join(' ')} ===`);
    const r = spawnSync(binary, ['test', ...paths, `--concurrency=${concurrency}`], {
        stdio: 'inherit',
        env,
        cwd: process.cwd(),
    });
    if (r.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
