// Run with: node --test tests/cts/setup-polyfill.test.mjs
// Exercise setup's real filesystem transactions with offline GitHub responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const REVISION_A = '0123456789abcdef0123456789abcdef01234567';
const REVISION_B = 'fedcba9876543210fedcba9876543210fedcba98';
const bundledSources = new Map();

async function compile(revision) {
    const key = revision ?? 'source';
    if (!bundledSources.has(key)) {
        bundledSources.set(key, build({
            absWorkingDir: repository,
            entryPoints: ['src/commands/setup.ts', 'src/cli.ts'],
            outdir: 'test-bundle', bundle: true, write: false, format: 'cjs', platform: 'node',
            define: {
                'import.meta.use': '__test_use__',
                ...(revision ? { __CNO_POLYFILL_REVISION__: JSON.stringify(revision) } : {}),
            },
            plugins: [{
                name: 'setup-host',
                setup(plugin) {
                    const exports = {
                        '../../cno/src/webapi/fetch': ['fetchAsync'],
                        '../../cno/src/utils/fs-path': ['ensureDirectorySync'],
                        '../../cno/src/utils/path': ['normalize', 'dirname', 'join'],
                        '../../cts/src/api': ['log'],
                        '../env': ['readEnv'],
                    };
                    plugin.onResolve({ filter: /./ }, args => Object.hasOwn(exports, args.path)
                        ? { path: args.path, namespace: 'setup-host' } : undefined);
                    plugin.onLoad({ filter: /./, namespace: 'setup-host' }, args => ({
                        contents: exports[args.path].map(name => `export const ${name} = __setup_host__.${name};`).join('\n'),
                    }));
                },
            }],
        }));
    }
    return bundledSources.get(key);
}

async function fixture(t, revision = REVISION_A, root) {
    if (!root) {
        root = fs.mkdtempSync(path.join(tmpdir(), 'cno-setup-pin-'));
        t.after(() => {
            assert.equal(path.dirname(root), path.resolve(tmpdir()));
            assert.ok(path.basename(root).startsWith('cno-setup-pin-'));
            fs.rmSync(root, { recursive: true, force: true });
        });
    }
    const cacheDir = path.join(root, 'cache');
    const requests = [];
    let failDownload = false;
    const stat = value => ({
        size: value.size, isFile: value.isFile(), isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink(),
    });
    const native = {
        os: {
            cwd: root, homeDir: root, platform: process.platform, pid: process.pid, args: ['cno'],
            uname: () => ({ sysname: process.platform === 'win32' ? 'Windows_NT' : 'Linux' }),
        },
        console: { log() {}, error() {} },
        fs: {
            stat: value => stat(fs.statSync(value)), lstat: value => stat(fs.lstatSync(value)),
            readFile: fs.readFileSync, writeFile: fs.writeFileSync, readdir: fs.readdirSync,
            unlink: fs.unlinkSync, rename: fs.renameSync, open: fs.openSync, close: fs.closeSync,
            flock() {}, LOCK_EX: 2, LOCK_UN: 8,
        },
        engine: { decodeString: value => new TextDecoder().decode(value), encodeString: value => Buffer.from(value) },
        error: { errno: { ENOENT: 'ENOENT', EEXIST: 'EEXIST' } },
    };
    const host = {
        ...path,
        ensureDirectorySync: (value, mode) => fs.mkdirSync(value, { recursive: true, mode }),
        readEnv: () => null,
        log: { debug() {} },
        async fetchAsync(url) {
            requests.push(url);
            if (url.startsWith('https://api.github.com/')) {
                return { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify({
                    tree: [
                        { type: 'blob', path: 'src/node/fs/index.ts' },
                        { type: 'blob', path: 'src/node/path.ts' },
                        { type: 'blob', path: 'src/webapi/ignored.ts' },
                    ],
                })) };
            }
            return { ok: !failDownload, status: failDownload ? 503 : 200, arrayBuffer: async () => Buffer.from(`// ${url}\n`) };
        },
    };
    const output = await compile(revision);
    const modules = Object.fromEntries(output.outputFiles.map(file => {
        const module = { exports: {} };
        runInNewContext(file.text, {
            module, exports: module.exports, __setup_host__: host, __test_use__: name => native[name],
        });
        return [path.basename(file.path, '.js'), module.exports];
    }));
    return {
        ...modules.setup, cli: modules.cli, root, cacheDir, requests,
        flags: { 'cache-dir': cacheDir },
        metadata: () => JSON.parse(fs.readFileSync(path.join(cacheDir, 'node/.cno-setup-ready'), 'utf8')),
        failDownload: () => { failDownload = true; },
    };
}

test('remote setup downloads the tree and all sources at the bundled commit', async t => {
    const f = await fixture(t);
    await f.runSetup(f.flags);
    assert.equal(f.requests[0], `https://api.github.com/repos/imzlh/cno/git/trees/${REVISION_A}?recursive=1`);
    assert.deepEqual(f.requests.slice(1).sort(), ['fs/index.ts', 'path.ts'].map(file =>
        `https://raw.githubusercontent.com/imzlh/cno/${REVISION_A}/src/node/${file}`));
    assert.equal(f.metadata().revision, REVISION_A);
    await f.ensureNodePolyfills(f.cacheDir);
    assert.equal(f.requests.length, 3, 'same CLI reuses the complete installation');
});

test('explicit SHA selects remote setup inside a checkout and remains installed for the same CLI', async t => {
    const f = await fixture(t);
    fs.mkdirSync(path.join(f.root, 'src/node/fs'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'src/node/fs/index.ts'), '// local');
    const parsed = f.cli.parseArgv(['setup', '--polyfill-revision', REVISION_B.toUpperCase()]);
    assert.equal(f.cli.unknownFlags(parsed).length, 0);
    assert.equal(f.cli.missingFlagValues(parsed).length, 0);
    await f.runSetup({ ...f.flags, ...parsed.flags });
    assert.ok(f.requests.every(url => url.includes(REVISION_B)));
    assert.equal(f.metadata().revision, REVISION_B);
    await f.ensureNodePolyfills(f.cacheDir);
    assert.equal(f.requests.length, 3);
});

test('branch names, missing SHA values, and URL-like revisions fail before mutating a ready cache', async t => {
    const f = await fixture(t);
    await f.runSetup(f.flags);
    const before = f.metadata();
    for (const value of ['master', 'v1.0.0', '', true, '../master', REVISION_A + '?x=1']) {
        await assert.rejects(f.runSetup({ ...f.flags, 'polyfill-revision': value }), /40-character Git commit SHA/);
    }
    assert.deepEqual(f.metadata(), before);
    assert.equal(f.requests.length, 3);
    assert.deepEqual([...f.cli.missingFlagValues(f.cli.parseArgv(['setup', '--polyfill-revision']))], ['polyfill-revision']);
    assert.deepEqual([...f.cli.unknownFlags(f.cli.parseArgv(['cache', '--polyfill-revision', REVISION_A]))], ['--polyfill-revision']);
});

test('a new bundled revision refreshes an existing remote cache', async t => {
    const previous = await fixture(t);
    await previous.runSetup(previous.flags);
    const next = await fixture(t, REVISION_B, previous.root);
    await next.ensureNodePolyfills(next.cacheDir);
    assert.equal(next.requests.length, 3);
    assert.equal(next.metadata().revision, REVISION_B);
    assert.equal(next.metadata().bundledRevision, REVISION_B);
});

test('legacy readiness markers are refreshed and failed downloads leave no ready marker', async t => {
    const f = await fixture(t);
    fs.mkdirSync(path.join(f.cacheDir, 'node/fs'), { recursive: true });
    fs.writeFileSync(path.join(f.cacheDir, 'node/fs/index.ts'), '// old');
    fs.writeFileSync(path.join(f.cacheDir, 'node/.cno-setup-ready'), 'ready\n');
    await f.ensureNodePolyfills(f.cacheDir);
    assert.equal(f.requests.length, 3);
    f.failDownload();
    await assert.rejects(f.runSetup(f.flags), /Some files failed to download/);
    assert.equal(fs.existsSync(path.join(f.cacheDir, 'node/.cno-setup-ready')), false);
});

test('source-mode setup keeps local installs and requires an explicit commit for remote downloads', async t => {
    const f = await fixture(t, null);
    await assert.rejects(f.runSetup(f.flags), /40-character Git commit SHA/);
    assert.equal(f.requests.length, 0);
    fs.mkdirSync(path.join(f.root, 'src/node/fs'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'src/node/fs/index.ts'), '// local');
    await f.runSetup(f.flags);
    assert.equal(f.metadata().source, 'local');
    assert.equal(f.requests.length, 0);
    await f.runSetup({ ...f.flags, 'polyfill-revision': REVISION_A });
    assert.equal(f.metadata().revision, REVISION_A);
    assert.equal(f.requests.length, 3);
});
