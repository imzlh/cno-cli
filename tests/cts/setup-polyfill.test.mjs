// Run with: node --test tests/cts/setup-polyfill.test.mjs
// Exercise setup's real filesystem transactions with offline GitHub responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
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
                        '../../cno/src/utils/path': ['normalize', 'resolvePath', 'pathParents', 'dirname', 'join'],
                        '../../cts/src/utils/log': ['log'],
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

async function fixture(t, revision = REVISION_A, root, options = {}) {
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
    let failRawPath = options.failRawPath ?? null;
    let failPublishRename = false;
    let failCleanupAfter = null;
    let cleanupMutations = 0;
    let cleanupFaultAfterMutation = false;
    let lockHeld = false;
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
            unlink(value) {
                const cleanupMutation = failCleanupAfter !== null
                    && value.includes(`${path.sep}.setup-publish${path.sep}`);
                if (cleanupMutation && !cleanupFaultAfterMutation && cleanupMutations++ === failCleanupAfter) {
                    failCleanupAfter = null;
                    throw new Error('injected committed cleanup failure');
                }
                fs.unlinkSync(value);
                if (cleanupMutation && cleanupFaultAfterMutation && cleanupMutations++ === failCleanupAfter) {
                    failCleanupAfter = null;
                    throw new Error('injected committed cleanup failure');
                }
            },
            rmdir(value) {
                const cleanupMutation = failCleanupAfter !== null
                    && (value.includes(`${path.sep}.setup-publish${path.sep}`)
                        || value.endsWith(`${path.sep}.setup-publish`));
                if (cleanupMutation && !cleanupFaultAfterMutation && cleanupMutations++ === failCleanupAfter) {
                    failCleanupAfter = null;
                    throw new Error('injected committed cleanup failure');
                }
                fs.rmdirSync(value);
                if (cleanupMutation && cleanupFaultAfterMutation && cleanupMutations++ === failCleanupAfter) {
                    failCleanupAfter = null;
                    throw new Error('injected committed cleanup failure');
                }
            },
            rename(from, to) {
                // Fail only at the live-tree publication seam, not while staging files.
                if (failPublishRename
                    && path.basename(from) === 'bun'
                    && path.basename(path.dirname(from)) === 'next') {
                    failPublishRename = false;
                    throw new Error('injected publish rename failure');
                }
                return fs.renameSync(from, to);
            },
            open: fs.openSync, close: fs.closeSync,
            flock(_fd, operation) {
                if (!options.strictLock) return;
                if (operation === 2) {
                    if (lockHeld) throw new Error('lock contention');
                    lockHeld = true;
                } else if (operation === 8) {
                    lockHeld = false;
                }
            }, LOCK_EX: 2, LOCK_UN: 8,
        },
        engine: { decodeString: value => new TextDecoder().decode(value), encodeString: value => Buffer.from(value) },
        crypto: {
            sha256: value => new Uint8Array(createHash('sha256').update(value).digest()),
            createSha256() {
                const hash = createHash('sha256');
                return {
                    update(value) { hash.update(value); },
                    digest() { return new Uint8Array(hash.digest()); },
                };
            },
            hexEncode: value => Buffer.from(value).toString('hex'),
        },
        error: { errno: { ENOENT: 'ENOENT', EEXIST: 'EEXIST' } },
    };
    const host = {
        ...path,
        resolvePath: (value, cwd) => path.resolve(cwd, value),
        *pathParents(value) {
            const parsed = path.parse(value);
            const relative = value.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
            let current = parsed.root;
            for (const part of relative) {
                current = path.join(current, part);
                yield current;
            }
        },
        ensureDirectorySync: (value, mode) => fs.mkdirSync(value, { recursive: true, mode }),
        readEnv: () => null,
        log: { debug() {} },
        async fetchAsync(url) {
            if (options.fetchDelayMs) await new Promise(resolve => setTimeout(resolve, options.fetchDelayMs));
            requests.push(url);
            if (url.startsWith('https://api.github.com/')) {
                return { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify({
                    tree: [
                        { type: 'blob', path: 'src/node/fs/index.ts' },
                        { type: 'blob', path: 'src/node/path.ts' },
                        { type: 'blob', path: 'src/bun/index.ts' },
                        { type: 'blob', path: 'src/bun/sqlite/index.ts' },
                        { type: 'blob', path: 'src/utils/path.ts' },
                        { type: 'blob', path: 'src/webapi/ignored.ts' },
                    ],
                })) };
            }
            const failed = failDownload || (failRawPath !== null && url.endsWith(`/${failRawPath}`));
            return { ok: !failed, status: failed ? 503 : 200, arrayBuffer: async () => Buffer.from(`// ${url}\n`) };
        },
    };
    const output = await compile(revision);
    const modules = Object.fromEntries(output.outputFiles.map(file => {
        const module = { exports: {} };
        runInNewContext(file.text, {
            module, exports: module.exports, __setup_host__: host,
            __test_use__: name => name === 'evbus' ? { get() {}, set() {} } : native[name],
        });
        return [path.basename(file.path, '.js'), module.exports];
    }));
    return {
        ...modules.setup, cli: modules.cli, root, cacheDir, requests,
        flags: { 'cache-dir': cacheDir },
        metadata: () => JSON.parse(fs.readFileSync(path.join(cacheDir, 'node/.cno-setup-ready'), 'utf8')),
        failDownload: () => { failDownload = true; },
        failRaw: file => { failRawPath = file; },
        failPublishRename: () => { failPublishRename = true; },
        failCommittedCleanupAfter: (count, afterMutation = false) => {
            failCleanupAfter = count;
            cleanupMutations = 0;
            cleanupFaultAfterMutation = afterMutation;
        },
    };
}

function snapshotPolyfillTree(cacheDir) {
    const snapshot = new Map();
    const visit = (full, relative) => {
        const stat = fs.lstatSync(full);
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(full).sort()) visit(path.join(full, name), path.join(relative, name));
        } else {
            snapshot.set(relative, fs.readFileSync(full));
        }
    };
    for (const name of ['node', 'bun', 'utils']) {
        const full = path.join(cacheDir, name);
        if (fs.existsSync(full)) visit(full, name);
    }
    return snapshot;
}

function assertSameSnapshot(actual, expected) {
    assert.deepEqual([...actual.keys()], [...expected.keys()]);
    for (const [relative, bytes] of expected) assert.deepEqual(actual.get(relative), bytes, relative);
}

function sourceDigest(cacheDir, files) {
    const hash = createHash('sha256');
    for (const relative of files) {
        hash.update(Buffer.from(relative));
        hash.update(Buffer.from([0]));
        hash.update(fs.readFileSync(path.join(cacheDir, relative)));
        hash.update(Buffer.from([0]));
    }
    return hash.digest('hex');
}

function assertNoRemoteTransactionTrees(cacheDir) {
    assert.deepEqual(
        fs.readdirSync(cacheDir).filter(name => name.startsWith('.setup-download-') || name === '.setup-publish'),
        [],
    );
}

test('remote setup downloads the tree and all sources at the bundled commit', async t => {
    const f = await fixture(t);
    await f.runSetup(f.flags);
    assert.equal(f.requests[0], `https://api.github.com/repos/imzlh/cno/git/trees/${REVISION_A}?recursive=1`);
    assert.deepEqual(f.requests.slice(1).sort(), [
        'src/node/fs/index.ts', 'src/node/path.ts',
        'src/bun/index.ts', 'src/bun/sqlite/index.ts', 'src/utils/path.ts',
    ].map(file => `https://raw.githubusercontent.com/imzlh/cno/${REVISION_A}/${file}`).sort());
    assert.equal(f.metadata().revision, REVISION_A);
    await f.ensureNodePolyfills(f.cacheDir);
    assert.equal(f.requests.length, 6, 'same CLI reuses the complete installation');
});

test('a failed raw download leaves the previous remote tree and marker byte-for-byte intact', async t => {
    const f = await fixture(t);
    await f.runSetup(f.flags);
    const before = snapshotPolyfillTree(f.cacheDir);
    const markerBefore = fs.readFileSync(path.join(f.cacheDir, 'node/.cno-setup-ready'));

    f.failRaw('src/node/path.ts');
    await assert.rejects(
        f.runSetup({ ...f.flags, 'polyfill-revision': REVISION_B }),
        /Some files failed to download/,
    );

    assertSameSnapshot(snapshotPolyfillTree(f.cacheDir), before);
    assert.deepEqual(fs.readFileSync(path.join(f.cacheDir, 'node/.cno-setup-ready')), markerBefore);
    assertNoRemoteTransactionTrees(f.cacheDir);
});

test('a successful remote refresh publishes every source, prunes stale bytecode, and keeps unmanaged files', async t => {
    const f = await fixture(t);
    await f.runSetup(f.flags);

    const stale = path.join(f.cacheDir, 'node', 'stale.ts');
    fs.writeFileSync(stale, '// stale');
    fs.writeFileSync(`${stale}.jsc`, '// stale bytecode');
    fs.writeFileSync(`${stale}.jsc.mt`, '// stale metadata');
    fs.writeFileSync(path.join(f.cacheDir, 'bun', 'stale.ts'), '// stale');
    fs.writeFileSync(path.join(f.cacheDir, 'utils', 'stale.ts.jsc'), '// stale bytecode');
    const unmanaged = path.join(f.cacheDir, 'node', 'keep.data');
    fs.writeFileSync(unmanaged, 'do not remove');

    await f.runSetup({ ...f.flags, 'polyfill-revision': REVISION_B });
    const requestsAfterRefresh = f.requests.length;
    const expectedFiles = [
        'bun/index.ts', 'bun/sqlite/index.ts',
        'node/fs/index.ts', 'node/path.ts', 'utils/path.ts',
    ];
    const metadata = f.metadata();
    assert.equal(metadata.version, 3);
    assert.equal(metadata.revision, REVISION_B);
    assert.equal(metadata.bundledRevision, REVISION_A);
    assert.deepEqual(metadata.files, expectedFiles);
    assert.match(metadata.digest, /^[0-9a-f]{64}$/);
    assert.equal(metadata.digest, sourceDigest(f.cacheDir, metadata.files));
    for (const relative of expectedFiles) {
        assert.equal(
            fs.readFileSync(path.join(f.cacheDir, relative), 'utf8'),
            `// https://raw.githubusercontent.com/imzlh/cno/${REVISION_B}/src/${relative}\n`,
        );
    }
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(`${stale}.jsc`), false);
    assert.equal(fs.existsSync(`${stale}.jsc.mt`), false);
    assert.equal(fs.existsSync(path.join(f.cacheDir, 'bun', 'stale.ts')), false);
    assert.equal(fs.existsSync(path.join(f.cacheDir, 'utils', 'stale.ts.jsc')), false);
    assert.equal(fs.readFileSync(unmanaged, 'utf8'), 'do not remove');
    assertNoRemoteTransactionTrees(f.cacheDir);

    await f.ensureNodePolyfills(f.cacheDir);
    assert.equal(f.requests.length, requestsAfterRefresh, 'valid v3 digest avoids duplicate requests');
});

test('a publish rename failure rolls back all live trees and the old marker', async t => {
    const f = await fixture(t);
    await f.runSetup(f.flags);
    const before = snapshotPolyfillTree(f.cacheDir);
    const markerBefore = fs.readFileSync(path.join(f.cacheDir, 'node/.cno-setup-ready'));

    f.failPublishRename();
    await assert.rejects(
        f.runSetup({ ...f.flags, 'polyfill-revision': REVISION_B }),
        /injected publish rename failure/,
    );

    assertSameSnapshot(snapshotPolyfillTree(f.cacheDir), before);
    assert.deepEqual(fs.readFileSync(path.join(f.cacheDir, 'node/.cno-setup-ready')), markerBefore);
    assertNoRemoteTransactionTrees(f.cacheDir);
});

test('recovery distinguishes an interrupted prepare from an interrupted publish', async t => {
    for (const name of ['prepare', 'publish']) {
        const f = await fixture(t);
        await f.runSetup(f.flags);
        const before = snapshotPolyfillTree(f.cacheDir);

        // Model SIGKILL by constructing the durable transaction shape that the
        // next setup process must consume.
        const transaction = path.join(f.cacheDir, '.setup-publish');
        if (name === 'prepare') {
            fs.mkdirSync(path.join(transaction, 'next', 'node'), { recursive: true });
            fs.mkdirSync(path.join(transaction, 'backup'), { recursive: true });
            fs.writeFileSync(path.join(transaction, 'state.json'), JSON.stringify({
                version: 1, phase: 'prepared', original: ['node', 'bun', 'utils'],
            }));
        } else {
            fs.mkdirSync(path.join(transaction, 'next'), { recursive: true });
            fs.mkdirSync(path.join(transaction, 'backup'), { recursive: true });
            fs.renameSync(path.join(f.cacheDir, 'node'), path.join(transaction, 'backup', 'node'));
            fs.cpSync(path.join(f.cacheDir, 'bun'), path.join(transaction, 'backup', 'bun'), { recursive: true });
            fs.cpSync(path.join(f.cacheDir, 'utils'), path.join(transaction, 'backup', 'utils'), { recursive: true });
            fs.writeFileSync(path.join(transaction, 'state.json'), JSON.stringify({
                version: 1, phase: 'publishing', original: ['node', 'bun', 'utils'],
            }));
        }
        f.failDownload();
        await assert.rejects(f.runSetup(f.flags), /Some files failed to download/, name);
        assertSameSnapshot(snapshotPolyfillTree(f.cacheDir), before);
        assertNoRemoteTransactionTrees(f.cacheDir);
    }
});

test('recovery keeps a committed live tree when transaction cleanup was interrupted', async t => {
    const f = await fixture(t);
    await f.runSetup(f.flags);
    const live = snapshotPolyfillTree(f.cacheDir);
    const transaction = path.join(f.cacheDir, '.setup-publish');
    fs.mkdirSync(path.join(transaction, 'backup'), { recursive: true });
    fs.mkdirSync(path.join(transaction, 'next'), { recursive: true });
    fs.writeFileSync(path.join(transaction, 'backup', 'partial'), 'old');
    fs.writeFileSync(path.join(transaction, 'next', 'partial'), 'next');
    fs.writeFileSync(path.join(transaction, 'committed'), 'committed\n');

    f.failDownload();
    await assert.rejects(f.runSetup(f.flags), /Some files failed to download/);
    assertSameSnapshot(snapshotPolyfillTree(f.cacheDir), live);
    assertNoRemoteTransactionTrees(f.cacheDir);
});

test('recovery finishes interrupted committed cleanup without rolling back the live tree', async t => {
    const f = await fixture(t);
    await f.runSetup(f.flags);

    f.failCommittedCleanupAfter(12);
    await assert.rejects(
        f.runSetup({ ...f.flags, 'polyfill-revision': REVISION_B }),
        /injected committed cleanup failure/,
    );
    const committedLive = snapshotPolyfillTree(f.cacheDir);
    assert.equal(f.metadata().revision, REVISION_B);
    assert.equal(fs.existsSync(path.join(f.cacheDir, '.setup-publish')), true);

    const requestsBeforeRecovery = f.requests.length;
    await f.ensureNodePolyfills(f.cacheDir);
    assertSameSnapshot(snapshotPolyfillTree(f.cacheDir), committedLive);
    assert.equal(f.requests.length, requestsBeforeRecovery, 'recovery reuses the committed tree offline');
    assertNoRemoteTransactionTrees(f.cacheDir);
});

test('recovery accepts the final committed-marker and transaction-root cleanup boundaries', async t => {
    for (const afterMutation of [false, true]) {
        for (const offset of [0, 1]) {
            const f = await fixture(t);
            await f.runSetup(f.flags);
            const live = snapshotPolyfillTree(f.cacheDir);
            const transaction = path.join(f.cacheDir, '.setup-publish');
            fs.mkdirSync(transaction);
            fs.writeFileSync(path.join(transaction, 'committed'), 'committed\n');

            f.failCommittedCleanupAfter(offset, afterMutation);
            await assert.rejects(f.ensureNodePolyfills(f.cacheDir), /injected committed cleanup failure/);
            const requestsBeforeRecovery = f.requests.length;
            await f.ensureNodePolyfills(f.cacheDir);
            assertSameSnapshot(snapshotPolyfillTree(f.cacheDir), live);
            assert.equal(f.requests.length, requestsBeforeRecovery);
            assertNoRemoteTransactionTrees(f.cacheDir);
        }
    }
});

test('readiness rejects symlinked polyfill directories even with a valid marker', async t => {
    const f = await fixture(t);
    await f.runSetup(f.flags);
    const requestsBefore = f.requests.length;
    const realBun = path.join(f.cacheDir, 'bun-real');
    fs.renameSync(path.join(f.cacheDir, 'bun'), realBun);
    fs.symlinkSync(realBun, path.join(f.cacheDir, 'bun'), process.platform === 'win32' ? 'junction' : 'dir');

    await assert.rejects(f.ensureNodePolyfills(f.cacheDir), /Refusing symlink in setup cache path/);
    assert.equal(f.requests.length, requestsBefore, 'symlink rejection happens before network access');
});

test('setup serializes equivalent cache path spellings in one process', async t => {
    const f = await fixture(t, REVISION_A, undefined, { strictLock: true, fetchDelayMs: 5 });
    const alias = `${f.root}/./cache`;
    await Promise.race([
        Promise.all([
            f.runSetup({ ...f.flags, 'cache-dir': alias }),
            f.runSetup(f.flags),
        ]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('setup lock did not serialize')), 2000)),
    ]);
});

test('explicit SHA selects remote setup inside a checkout and remains installed for the same CLI', async t => {
    const f = await fixture(t);
    fs.mkdirSync(path.join(f.root, 'src/node/fs'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'src/node/fs/index.ts'), '// local');
    fs.mkdirSync(path.join(f.root, 'src/bun/sqlite'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'src/bun/index.ts'), '// local');
    fs.writeFileSync(path.join(f.root, 'src/bun/sqlite/index.ts'), '// local');
    fs.mkdirSync(path.join(f.root, 'src/utils'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'src/utils/path.ts'), '// local');
    const parsed = f.cli.parseArgv(['setup', '--polyfill-revision', REVISION_B.toUpperCase()]);
    assert.equal(f.cli.unknownFlags(parsed).length, 0);
    assert.equal(f.cli.missingFlagValues(parsed).length, 0);
    await f.runSetup({ ...f.flags, ...parsed.flags });
    assert.ok(f.requests.every(url => url.includes(REVISION_B)));
    assert.equal(f.metadata().revision, REVISION_B);
    await f.ensureNodePolyfills(f.cacheDir);
    assert.equal(f.requests.length, 6);
});

test('branch names, missing SHA values, and URL-like revisions fail before mutating a ready cache', async t => {
    const f = await fixture(t);
    await f.runSetup(f.flags);
    const before = f.metadata();
    for (const value of ['master', 'v1.0.0', '', true, '../master', REVISION_A + '?x=1']) {
        await assert.rejects(f.runSetup({ ...f.flags, 'polyfill-revision': value }), /40-character Git commit SHA/);
    }
    assert.deepEqual(f.metadata(), before);
    assert.equal(f.requests.length, 6);
    assert.deepEqual([...f.cli.missingFlagValues(f.cli.parseArgv(['setup', '--polyfill-revision']))], ['polyfill-revision']);
    assert.deepEqual([...f.cli.unknownFlags(f.cli.parseArgv(['cache', '--polyfill-revision', REVISION_A]))], ['--polyfill-revision']);
});

test('a new bundled revision refreshes an existing remote cache', async t => {
    const previous = await fixture(t);
    await previous.runSetup(previous.flags);
    const next = await fixture(t, REVISION_B, previous.root);
    await next.ensureNodePolyfills(next.cacheDir);
    assert.equal(next.requests.length, 6);
    assert.equal(next.metadata().revision, REVISION_B);
    assert.equal(next.metadata().bundledRevision, REVISION_B);
});

test('legacy readiness markers are refreshed and failed downloads preserve the previous marker', async t => {
    const f = await fixture(t);
    fs.mkdirSync(path.join(f.cacheDir, 'node/fs'), { recursive: true });
    fs.writeFileSync(path.join(f.cacheDir, 'node/fs/index.ts'), '// old');
    fs.writeFileSync(path.join(f.cacheDir, 'node/.cno-setup-ready'), 'ready\n');
    await f.ensureNodePolyfills(f.cacheDir);
    assert.equal(f.requests.length, 6);
    const markerBeforeFailure = fs.readFileSync(path.join(f.cacheDir, 'node/.cno-setup-ready'));
    f.failDownload();
    await assert.rejects(f.runSetup(f.flags), /Some files failed to download/);
    assert.deepEqual(fs.readFileSync(path.join(f.cacheDir, 'node/.cno-setup-ready')), markerBeforeFailure);
    assertNoRemoteTransactionTrees(f.cacheDir);
});

test('source-mode setup keeps local installs and requires an explicit commit for remote downloads', async t => {
    const f = await fixture(t, null);
    await assert.rejects(f.runSetup(f.flags), /40-character Git commit SHA/);
    assert.equal(f.requests.length, 0);
    fs.mkdirSync(path.join(f.root, 'src/node/fs'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'src/node/fs/index.ts'), '// local');
    fs.mkdirSync(path.join(f.root, 'src/bun/sqlite'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'src/bun/index.ts'), '// local');
    fs.writeFileSync(path.join(f.root, 'src/bun/sqlite/index.ts'), '// local');
    fs.mkdirSync(path.join(f.root, 'src/utils'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'src/utils/path.ts'), '// local');
    await f.runSetup(f.flags);
    assert.equal(f.metadata().source, 'local');
    assert.equal(f.requests.length, 0);
    await f.runSetup({ ...f.flags, 'polyfill-revision': REVISION_A });
    assert.equal(f.metadata().revision, REVISION_A);
    assert.equal(f.requests.length, 6);
});
