import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const revision = process.env.CNO_POLYFILL_REVISION
    || execFileSync('git', ['-C', join(root, 'cno'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const slash = (path) => path.replaceAll('\\', '/');

// The main bundle may contain exactly the Bun injector. Implementations are
// installed as TypeScript by `cno setup` and transformed on demand by CTS.
test('embedded CLI bundle contains only the Bun injector', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-bun-boundary-'));
    const outfile = join(directory, 'cno-cli.min.js');
    const metafile = join(directory, 'meta.json');
    execFileSync(process.execPath, [join(root, 'scripts/bundle.mjs'), 'min'], {
        cwd: root,
        env: { ...process.env, CNO_POLYFILL_REVISION: revision, CNO_BUNDLE_OUTFILE: outfile, CNO_BUNDLE_METAFILE: metafile },
        stdio: 'pipe',
    });
    const inputs = Object.keys(JSON.parse(readFileSync(metafile, 'utf8')).inputs).map(slash);
    assert.deepEqual(
        inputs.filter((input) => /(^|\/)cno\/src\/bun\//.test(input)),
        ['cno/src/bun/_internal/inject.ts'],
    );
    assert.ok(inputs.includes('cno/src/node/_internal/cts-bridge.ts'));

    const text = readFileSync(outfile, 'utf8');
    // Setup necessarily names source-tree paths; implementation-only symbols
    // are the reliable output boundary once setup owns Bun installation.
    for (const marker of ['BunFile', 'randomUUIDv7', 'CryptoHasher']) {
        assert.ok(!text.includes(marker), `main bundle contains Bun implementation marker: ${marker}`);
    }
});

test('release verification rejects stale Bun payloads in tar and zip archives', t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-release-archives-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const stage = join(directory, 'stage');
    const artifacts = join(directory, 'artifacts');
    mkdirSync(join(stage, 'ext'), { recursive: true });
    mkdirSync(join(stage, 'lib'), { recursive: true });
    mkdirSync(artifacts);
    for (const file of ['cno', 'cno.exe', 'ext/oxc.so', 'ext/oxc.dylib', 'ext/oxc.dll', 'lib/example.so']) {
        writeFileSync(join(stage, file), 'fixture');
    }
    const tar = join(directory, 'clean.tar.gz');
    const zip = join(directory, 'clean.zip');
    execFileSync('tar', ['-czf', tar, '-C', stage, '.']);
    execFileSync('zip', ['-qr', zip, '.'], { cwd: stage });
    for (const target of ['x86_64', 'i386', 'arm64', 'armv7', 'armv6']) {
        for (const prefix of ['cno-linux-', 'cno-linux-minimal-']) copyFileSync(tar, join(artifacts, `${prefix}${target}.tar.gz`));
    }
    for (const target of ['x86_64', 'i386', 'arm64', 'armv7', 'armv6', 'mips', 'mipsel', 'mips64', 'riscv64', 'armv5']) {
        for (const prefix of ['cno-linux-musl-', 'cno-linux-musl-dynamic-']) copyFileSync(tar, join(artifacts, `${prefix}${target}.tar.gz`));
    }
    for (const target of ['x86_64', 'arm64']) copyFileSync(tar, join(artifacts, `cno-macos-${target}.tar.gz`));
    for (const target of ['x64', 'arm64']) copyFileSync(zip, join(artifacts, `cno-windows-${target}.zip`));
    const verify = () => spawnSync('sh', [join(root, 'scripts/ci/verify-release-artifacts.sh'), artifacts], { encoding: 'utf8' });
    let result = verify();
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);

    mkdirSync(join(stage, 'lib/cno/bun'), { recursive: true });
    writeFileSync(join(stage, 'lib/cno/bun/index.js'), 'stale');
    const badTar = join(artifacts, 'cno-linux-x86_64.tar.gz');
    execFileSync('tar', ['-czf', badTar, '-C', stage, '.']);
    result = verify();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /contains a stale Bun payload under lib\/cno\/bun/);
    copyFileSync(tar, badTar);
    const badZip = join(artifacts, 'cno-windows-x64.zip');
    execFileSync('zip', ['-qr', badZip, 'lib/cno/bun'], { cwd: stage });
    result = verify();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /contains a stale Bun payload under lib\/cno\/bun/);
});
