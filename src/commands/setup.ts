// The webapi/fetch graph evaluates at module scope (it Reflect.sets the
// fetch globals), which on `cno exec` happens before the polyfill bootstrap
// imports — keep that graph free of bare-global dereferences.
import { fetchAsync } from '../../cno/src/webapi/fetch';
import { ensureDirectorySync } from '../../cno/src/utils/fs-path';
import { normalize, resolvePath, pathParents, dirname, join } from '../../cno/src/utils/path';
import { log } from '../../cts/src/utils/log';
import { readEnv } from '../env';
import { bundledPolyfillRevision, requirePolyfillRevision } from '../polyfill-version';

const os = import.meta.use('os');
const console = import.meta.use('console');

const fs     = import.meta.use('fs');
const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');
const sysError = import.meta.use('error');

type GitHubTreeNode = { path: string; type: string };
type GitHubTreeResponse = {
    tree?: GitHubTreeNode[];
    truncated?: boolean;
    message?: string;
};

function isNotFound(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false;
    const code = (value as { code?: unknown }).code;
    return code === sysError.errno.ENOENT || code === 'ENOENT';
}

function isAlreadyExists(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false;
    const code = (value as { code?: unknown }).code;
    return code === sysError.errno.EEXIST || code === 'EEXIST';
}

function symlinkRefused(path: string): Error {
    return new Error(`Refusing symlink in setup cache path: ${path}`);
}

/** Reject symlinks in every existing component, including the final target. */
function assertNoSymlinkPath(path: string): void {
    for (const current of pathParents(path)) {
        try {
            if (fs.lstat(current).isSymbolicLink) throw symlinkRefused(current);
        } catch (error) {
            if (isNotFound(error)) break;
            throw error;
        }
    }
}

function assertNoSymlinksInTree(path: string): void {
    let stat: ReturnType<typeof fs.lstat>;
    try {
        stat = fs.lstat(path);
    } catch (error) {
        if (isNotFound(error)) return;
        throw error;
    }
    if (stat.isSymbolicLink) throw symlinkRefused(path);
    if (!stat.isDirectory) return;
    for (const name of fs.readdir(path)) {
        assertNoSymlinksInTree(join(path, name));
    }
}

function unlinkIfPresent(path: string): boolean {
    try {
        fs.unlink(path);
        return true;
    } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
    }
}

function pathExists(path: string): boolean {
    try {
        fs.lstat(path);
        return true;
    } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
    }
}

function removeTree(path: string): void {
    let stat: ReturnType<typeof fs.lstat>;
    try {
        stat = fs.lstat(path);
    } catch (error) {
        if (isNotFound(error)) return;
        throw error;
    }
    if (stat.isDirectory && !stat.isSymbolicLink) {
        for (const name of fs.readdir(path)) removeTree(join(path, name));
        fs.rmdir(path);
        return;
    }
    fs.unlink(path);
}

function removeTreeContents(path: string): void {
    if (!pathExists(path)) return;
    assertNoSymlinksInTree(path);
    for (const name of fs.readdir(path)) removeTree(join(path, name));
}

function copyTree(src: string, dst: string): void {
    let stat: ReturnType<typeof fs.lstat>;
    try {
        stat = fs.lstat(src);
    } catch (error) {
        if (isNotFound(error)) {
            ensureDirectorySync(dst, 0o755);
            return;
        }
        throw error;
    }
    if (stat.isSymbolicLink) throw symlinkRefused(src);
    if (!stat.isDirectory) throw new Error(`Setup cache tree is not a directory: ${src}`);
    ensureDirectorySync(dst, 0o755);
    for (const name of fs.readdir(src)) {
        const source = join(src, name);
        const target = join(dst, name);
        const entry = fs.lstat(source);
        if (entry.isSymbolicLink) throw symlinkRefused(source);
        if (entry.isDirectory) {
            copyTree(source, target);
        } else if (entry.isFile) {
            fs.writeFile(target, fs.readFile(source));
        } else {
            throw new Error(`Unsupported file in setup cache tree: ${source}`);
        }
    }
}

function clearSourceBytecode(path: string): void {
    unlinkIfPresent(path + '.jsc');
    unlinkIfPresent(path + '.jsc.mt');
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return value !== null && typeof value === 'object';
}

function parseGitHubTreeResponse(raw: string): GitHubTreeResponse {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error('GitHub tree response is not an object');
    const rawTree = parsed.tree;
    const tree = Array.isArray(rawTree)
        ? rawTree.filter((item): item is GitHubTreeNode =>
            isRecord(item) && typeof item.path === 'string' && typeof item.type === 'string')
        : undefined;
    return {
        tree,
        truncated: parsed.truncated === true,
        message: typeof parsed.message === 'string' ? parsed.message : undefined,
    };
}

const HOME = os.homeDir || ((os.platform === 'windows' || os.platform === 'win32') ? (readEnv('USERPROFILE') || '') : (readEnv('HOME') || '/root'));

function resolveCacheDir(flags: Record<string, string | boolean>): string {
    const flag = flags['cache-dir'] || flags['cacheDir'];
    const raw = typeof flag === 'string' && flag
        ? flag
        : (readEnv('CTS_CACHE_DIR') || join(HOME, '.cts'));
    const resolved = normalize(resolvePath(raw, os.cwd));
    // `normalize` preserves a trailing separator, but it is not part of the
    // cache identity and would create a second in-process lock queue.
    if (resolved.length > 1 && !/^[A-Za-z]:[\\/]$/.test(resolved)) {
        return resolved.replace(/[\\/]+$/, '');
    }
    return resolved;
}


const setupLockQueue = new Map<string, Promise<void>>();

async function withSetupLock<T>(cacheDir: string, fn: () => Promise<T>): Promise<T> {
    const previous = setupLockQueue.get(cacheDir);
    let release = () => {};
    const turn = new Promise<void>(resolve => { release = resolve; });
    setupLockQueue.set(cacheDir, turn);
    if (previous) await previous.catch(() => {});

    try {
        assertNoSymlinkPath(cacheDir);
        ensureDirectorySync(cacheDir, 0o755);
        const path = join(cacheDir, '.setup.lock');
        assertNoSymlinkPath(path);
        let fd: number;
        try {
            fd = fs.open(path, 'wx', 0o600);
        } catch (error) {
            if (!isAlreadyExists(error)) throw error;
            assertNoSymlinkPath(path);
            fd = fs.open(path, 'r+');
        }
        let locked = false;
        try {
            fs.flock(fd, fs.LOCK_EX);
            locked = true;
            return await fn();
        } finally {
            try {
                if (locked) fs.flock(fd, fs.LOCK_UN);
            } finally {
                fs.close(fd);
            }
        }
    } finally {
        release();
        if (setupLockQueue.get(cacheDir) === turn) setupLockQueue.delete(cacheDir);
    }
}

let tempSequence = 0;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    for (let i = 0; i < left.byteLength; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}

function hasContent(path: string, expected: Uint8Array): boolean {
    try {
        const stat = fs.lstat(path);
        return stat.isFile
            && stat.size === expected.byteLength
            && bytesEqual(new Uint8Array(fs.readFile(path)), expected);
    } catch {
        return false;
    }
}

function isExistingDirectory(path: string): boolean {
    try {
        return fs.stat(path).isDirectory;
    } catch {
        return false;
    }
}

function commitFileTransaction(dst: string, bytes: Uint8Array): void {
    assertNoSymlinkPath(dst);
    if (isExistingDirectory(dst)) {
        throw new Error(`Cannot replace directory with file: ${dst}`);
    }
    assertNoSymlinkPath(dirname(dst));
    ensureDirectorySync(dirname(dst), 0o755);
    assertNoSymlinkPath(dirname(dst));
    const temp = `${dst}.tmp-${os.pid ?? 'runtime'}-${Date.now()}-${tempSequence++}`;
    const backup = `${dst}.old-${tempSequence++}`;
    let parked = false;
    let committed = false;

    try {
        fs.writeFile(temp, bytes);
        try {
            fs.rename(temp, dst);
            committed = true;
            return;
        } catch {
            if (hasContent(dst, bytes)) return;
        }

        try {
            fs.rename(dst, backup);
            parked = true;
        } catch {
            // The destination may not exist. Commit still proceeds atomically.
        }

        try {
            fs.rename(temp, dst);
            committed = true;
        } catch (commitError) {
            if (parked) {
                try {
                    fs.rename(backup, dst);
                    parked = false;
                } catch (rollbackError) {
                    throw new AggregateError(
                        [commitError, rollbackError],
                        `Failed to commit ${dst} and restore the previous file`,
                    );
                }
            }
            throw commitError;
        }
    } finally {
        if (!committed) {
            try { fs.unlink(temp); } catch { /* absent or already moved */ }
        }
        if (committed && parked) {
            try { fs.unlink(backup); } catch { /* stale backup is safer than losing the commit */ }
        }
    }
}

function walkManagedSourceFiles(
    dir: string,
    isManagedSource: (path: string) => boolean,
    skipDirectory: (name: string) => boolean = () => false,
    prefix = '',
): string[] {
    const out: string[] = [];
    for (const name of fs.readdir(dir).sort()) {
        const full = join(dir, name);
        const rel  = prefix ? join(prefix, name) : name;
        const st   = fs.lstat(full);
        if (st.isSymbolicLink) continue;
        if (st.isDirectory) {
            if (!skipDirectory(name)) out.push(...walkManagedSourceFiles(full, isManagedSource, skipDirectory, rel));
            continue;
        }
        if (st.isFile && isManagedSource(rel)) out.push(rel);
    }
    return out;
}

function copyTreeIfChanged(srcBase: string, dstBase: string, files: string[]): { copied: number; skip: number } {
    let copied = 0, skip = 0;
    for (const rel of files) {
        const src = join(srcBase, rel);
        const dst = join(dstBase, rel);
        const bytes = new Uint8Array(fs.readFile(src));
        if (hasContent(dst, bytes)) {
            skip++;
            continue;
        }
        commitFileTransaction(dst, bytes);
        clearSourceBytecode(dst);
        log.debug('oxc', () => `  COPY  ${rel}`);
        copied++;
    }
    return { copied, skip };
}

function sourceForBytecode(path: string): string | null {
    if (path.endsWith('.jsc.mt')) return path.slice(0, -'.jsc.mt'.length);
    if (path.endsWith('.jsc')) return path.slice(0, -'.jsc'.length);
    return null;
}

function managedPathKey(path: string): string {
    return path.replaceAll('\\', '/');
}

function pruneStaleManagedFiles(
    dstBase: string,
    sourceFiles: readonly string[],
    isManagedSource: (path: string) => boolean,
): number {
    const expected = new Set(sourceFiles.map(managedPathKey));
    let count = 0;
    const visit = (dir: string, prefix = ''): void => {
        for (const name of fs.readdir(dir)) {
            const full = join(dir, name);
            const rel = prefix ? join(prefix, name) : name;
            const key = managedPathKey(rel);
            const bytecodeSource = sourceForBytecode(key);
            try {
                const st = fs.lstat(full);
                if (st.isSymbolicLink) throw symlinkRefused(full);
                if (st.isDirectory) {
                    visit(full, rel);
                } else if (
                    st.isFile
                    && (
                        (isManagedSource(key) && !expected.has(key))
                        || (
                            bytecodeSource !== null
                            && isManagedSource(bytecodeSource)
                            && !expected.has(bytecodeSource)
                        )
                    )
                ) {
                    if (unlinkIfPresent(full)) count++;
                }
            } catch (error) {
                if (isNotFound(error)) continue;
                throw error;
            }
        }
    };
    visit(dstBase);
    return count;
}

function isPolyfillSourceFile(path: string): boolean {
    return path.endsWith('.ts');
}

function isHttpPackageSourceFile(path: string): boolean {
    return /(?:^|[\\/])package\.json$/.test(path)
        || path.endsWith('.ts')
        || path.endsWith('.json')
        || path.endsWith('.js');
}

interface LocalPolyfillSource {
    root: string;
    node: string;
    bun: string | null;
    utils: string | null;
}

function findLocalPolyfillSource(start: string): LocalPolyfillSource | null {
    let dir = normalize(start);
    const seen = new Set<string>();

    while (dir && !seen.has(dir)) {
        seen.add(dir);
        for (const rel of ['src', 'cno/src']) {
            const root = join(dir, rel);
            const candidate = join(root, 'node');
            try {
                if (fs.stat(candidate).isDirectory) {
                    const bun = join(root, 'bun');
                    const utils = join(root, 'utils');
                    return {
                        root,
                        node: candidate,
                        bun: isExistingDirectory(bun) ? bun : null,
                        utils: isExistingDirectory(utils) ? utils : null,
                    };
                }
            } catch (error) {
                if (!isNotFound(error)) throw error;
            }
        }

        const up = dirname(dir);
        if (up === dir || up === '.') break;
        dir = up;
    }
    return null;
}

/**
 * Locate a workspace `http/` next to the cno polyfills.
 * source root: <root>/cno/src or <root>/src -> http at <root>/http or sibling.
 */
function findLocalHttpPackage(sourceRoot: string): { dir: string; version: string } | null {
    const candidates = [
        join(sourceRoot, '../../http'),   // cno/src -> repo/http
        join(sourceRoot, '../http'),      // src -> repo/http
        join(sourceRoot, '../../../http'),
    ];
    for (const candidate of candidates) {
        const dir = normalize(candidate);
        try {
            const raw = engine.decodeString(fs.readFile(join(dir, 'package.json')));
            const pkg = JSON.parse(raw) as { name?: string; version?: string };
            if (pkg.name === '@cnojs/http') {
                return {
                    dir,
                    version: typeof pkg.version === 'string' && pkg.version ? pkg.version : '1.0.0',
                };
            }
        } catch (error) {
            // Candidate paths include layouts that may not exist. But once a package
            // file is present, a read or parse failure must not make setup claim a
            // complete local install.
            if (isNotFound(error)) continue;
            throw new Error(`Cannot read local @cnojs/http package at ${dir}: ${error}`);
        }
    }
    return null;
}

/** Keep the npm store package in lockstep with workspace http. */
function installLocalHttpToStore(httpSrc: string, version: string, cacheDir: string): void {
    const dstBase = join(cacheDir, 'npm', `@cnojs/http@${version}`);
    ensureDirectorySync(dstBase, 0o755);
    const files = walkManagedSourceFiles(
        httpSrc,
        isHttpPackageSourceFile,
        (name) => name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build',
    );
    if (files.length === 0) {
        throw new Error(`@cnojs/http: no files under ${httpSrc}`);
    }
    const { copied, skip } = copyTreeIfChanged(httpSrc, dstBase, files);
    const removed = pruneStaleManagedFiles(dstBase, files, isHttpPackageSourceFile);
    console.log(`@cnojs/http@${version} store: ${copied} copied, ${skip} up-to-date, ${removed} stale removed → ${dstBase}`);
}

// ── Local: copy .ts files from srcBase → dstBase ────────────────────────────

function installLocal(srcBase: string, dstBase: string, label: string, markerName?: string): void {
    const files = walkManagedSourceFiles(srcBase, isPolyfillSourceFile);
    if (files.length === 0) throw new Error(`No .ts files found in ${srcBase}`);

    const { copied, skip } = copyTreeIfChanged(srcBase, dstBase, files);
    const expected = markerName ? [...files, markerName] : files;
    const removed = pruneStaleManagedFiles(dstBase, expected, path =>
        isPolyfillSourceFile(path) || path === markerName);
    console.log(`${label} polyfills: ${copied} copied, ${skip} up-to-date, ${removed} stale removed`);
}

async function batchRun<T>(items: T[], fn: (item: T) => Promise<void>, concurrency = 8): Promise<void> {
    for (let i = 0; i < items.length; i += concurrency) {
        await Promise.all(items.slice(i, i + concurrency).map(fn));
    }
}

// ── Remote: fetch .ts files from GitHub into an unpublished tree ────────────

interface RemoteInstall {
    stageRoot: string;
    files: string[];
    digest: string;
}

function sourceTreeDigest(root: string, files: readonly string[]): string {
    const hash = crypto.createSha256();
    const separator = new Uint8Array([0]);
    for (const relativeSource of files) {
        const path = engine.encodeString(relativeSource);
        const body = new Uint8Array(fs.readFile(join(root, relativeSource)));
        hash.update(path);
        hash.update(separator);
        hash.update(body);
        hash.update(separator);
    }
    return crypto.hexEncode(hash.digest());
}

function validateRemoteSourcePath(path: string): boolean {
    if (!/^(?:node|bun|utils)\/.+\.ts$/.test(path)) return false;
    const segments = path.split('/');
    return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

async function installRemote(cacheDir: string, revision: string): Promise<RemoteInstall> {
    const githubBase = `https://raw.githubusercontent.com/imzlh/cno/${revision}`;
    const githubTree = `https://api.github.com/repos/imzlh/cno/git/trees/${revision}?recursive=1`;
    log.debug('oxc', () => 'Fetching file list from GitHub...');
    const treeResp = await fetchAsync(githubTree);
    if (!treeResp.ok) throw new Error(`GitHub API error: ${treeResp.status}`);
    const treeJson = engine.decodeString(await treeResp.arrayBuffer());
    const tree = parseGitHubTreeResponse(treeJson);

    if (tree.message) throw new Error(`GitHub API: ${tree.message}`);
    if (!tree.tree || tree.truncated) throw new Error('GitHub tree truncated or missing');

    const polyfillFiles = tree.tree.filter(n =>
        n.type === 'blob'
        && n.path.startsWith('src/')
        && validateRemoteSourcePath(n.path.slice('src/'.length)));
    if (!polyfillFiles.some(entry => entry.path.startsWith('src/node/'))
        || !polyfillFiles.some(entry => entry.path === 'src/bun/index.ts')
        || !polyfillFiles.some(entry => entry.path === 'src/bun/sqlite/index.ts')
        || !polyfillFiles.some(entry => entry.path === 'src/utils/path.ts')) {
        throw new Error('GitHub tree is missing required Node, Bun, or shared polyfill sources');
    }
    polyfillFiles.sort((left, right) => left.path.localeCompare(right.path));
    log.debug('oxc', () => `Found ${polyfillFiles.length} polyfill files, downloading in batches of 8...`);

    const stageRoot = join(cacheDir, `${SETUP_DOWNLOAD_PREFIX}${revision}-${os.pid ?? 'runtime'}-${Date.now()}-${tempSequence++}`);
    assertNoSymlinkPath(stageRoot);
    ensureDirectorySync(stageRoot, 0o755);
    let ok = 0, fail = 0;
    try {
        await batchRun(polyfillFiles, async (entry) => {
            const relativeSource = entry.path.slice('src/'.length);
            const dst = join(stageRoot, relativeSource);
            try {
                log.debug('oxc', () => `  GET   ${relativeSource}`);
                const response = await fetchAsync(githubBase + '/' + entry.path);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const bytes = new Uint8Array(await response.arrayBuffer());
                if (bytes.byteLength === 0) {
                    throw new Error('empty response body');
                }
                commitFileTransaction(dst, bytes);
                ok++;
            } catch (e) {
                console.error(`  FAIL  ${relativeSource}: ${e instanceof Error ? e.message : e}`);
                fail++;
            }
        });
        log.debug('oxc', () => `\nRemote install: ${ok} downloaded, ${fail} failed`);
        if (fail > 0) throw new Error('Some files failed to download');
        const files = polyfillFiles.map(entry => entry.path.slice('src/'.length));
        return { stageRoot, files, digest: sourceTreeDigest(stageRoot, files) };
    } catch (error) {
        try {
            removeTree(stageRoot);
        } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Remote setup failed and its staging tree could not be removed');
        }
        throw error;
    }
}

const SETUP_PUBLISH_DIR = '.setup-publish';
const SETUP_DOWNLOAD_PREFIX = '.setup-download-';
const SETUP_PUBLISH_STATE = 'state.json';
const SETUP_PUBLISH_COMMITTED = 'committed';
const POLYFILL_TREE_NAMES = ['node', 'bun', 'utils'] as const;

interface PublishState {
    version: 1;
    phase: 'prepared' | 'publishing';
    original: string[];
}

function writePublishState(transactionRoot: string, state: PublishState): void {
    commitFileTransaction(
        join(transactionRoot, SETUP_PUBLISH_STATE),
        engine.encodeString(JSON.stringify(state) + '\n'),
    );
}

function readPublishState(transactionRoot: string): PublishState {
    let value: unknown;
    try {
        value = JSON.parse(engine.decodeString(fs.readFile(join(transactionRoot, SETUP_PUBLISH_STATE))));
    } catch (error) {
        throw new Error(`Cannot recover incomplete setup publication: ${error}`);
    }
    if (!isRecord(value)
        || value.version !== 1
        || (value.phase !== 'prepared' && value.phase !== 'publishing')
        || !Array.isArray(value.original)
        || value.original.some(name => typeof name !== 'string'
            || !(POLYFILL_TREE_NAMES as readonly string[]).includes(name))
        || new Set(value.original).size !== value.original.length) {
        throw new Error('Cannot recover incomplete setup publication: invalid transaction state');
    }
    return value as unknown as PublishState;
}

function cleanupRemoteDownloads(cacheDir: string): void {
    for (const name of fs.readdir(cacheDir)) {
        if (!name.startsWith(SETUP_DOWNLOAD_PREFIX)) continue;
        const path = join(cacheDir, name);
        assertNoSymlinksInTree(path);
        removeTree(path);
    }
}

function recoverRemotePublish(cacheDir: string): void {
    const transactionRoot = join(cacheDir, SETUP_PUBLISH_DIR);
    if (!pathExists(transactionRoot)) return;
    assertNoSymlinkPath(transactionRoot);
    assertNoSymlinksInTree(transactionRoot);
    if (pathExists(join(transactionRoot, SETUP_PUBLISH_COMMITTED))) {
        cleanupCommittedPublish(transactionRoot);
        return;
    }
    const statePath = join(transactionRoot, SETUP_PUBLISH_STATE);
    if (!pathExists(statePath)) {
        // Publication cannot start before the publishing state is durable. An
        // unmarked tree is either an interrupted prepare or finished cleanup.
        removeTree(transactionRoot);
        return;
    }
    const state = readPublishState(transactionRoot);
    const backupRoot = join(transactionRoot, 'backup');
    const nextRoot = join(transactionRoot, 'next');
    if (state.phase === 'prepared') {
        removeTree(transactionRoot);
        return;
    }
    const original = new Set(state.original);
    for (const name of POLYFILL_TREE_NAMES) {
        const backup = join(backupRoot, name);
        const live = join(cacheDir, name);
        const next = join(nextRoot, name);
        if (original.has(name)) {
            if (pathExists(backup)) {
                removeTree(live);
                fs.rename(backup, live);
            } else if (!pathExists(live)) {
                throw new Error(`Cannot recover incomplete setup publication: missing backup for ${name}`);
            }
        } else if (!pathExists(next)) {
            // This live tree did not exist before publication and was already
            // moved out of `next` when the process stopped.
            removeTree(live);
        }
    }
    removeTree(transactionRoot);
}

function cleanupCommittedPublish(transactionRoot: string): void {
    const committed = join(transactionRoot, SETUP_PUBLISH_COMMITTED);
    for (const name of fs.readdir(transactionRoot)) {
        if (name !== SETUP_PUBLISH_COMMITTED) removeTree(join(transactionRoot, name));
    }
    // Keep the commit decision durable until every other transaction entry is
    // gone. If the final rmdir is interrupted, recovery can discard the empty
    // unmarked directory without touching the published live trees.
    fs.unlink(committed);
    fs.rmdir(transactionRoot);
}

function publishRemoteInstall(cacheDir: string, revision: string, install: RemoteInstall): void {
    const transactionRoot = join(cacheDir, SETUP_PUBLISH_DIR);
    const nextRoot = join(transactionRoot, 'next');
    const backupRoot = join(transactionRoot, 'backup');
    const names = POLYFILL_TREE_NAMES;
    const movedLive: string[] = [];
    const published: string[] = [];
    let rollbackComplete = true;

    assertNoSymlinkPath(transactionRoot);
    ensureDirectorySync(nextRoot, 0o755);
    ensureDirectorySync(backupRoot, 0o755);
    writePublishState(transactionRoot, {
        version: 1,
        phase: 'prepared',
        original: names.filter(name => pathExists(join(cacheDir, name))),
    });
    try {
        for (const name of names) copyTree(join(cacheDir, name), join(nextRoot, name));
        for (const relativeSource of install.files) {
            const dst = join(nextRoot, relativeSource);
            commitFileTransaction(dst, new Uint8Array(fs.readFile(join(install.stageRoot, relativeSource))));
            clearSourceBytecode(dst);
        }
        for (const name of names) {
            const prefix = `${name}/`;
            const files = install.files
                .filter(path => path.startsWith(prefix))
                .map(path => path.slice(prefix.length));
            pruneStaleManagedFiles(join(nextRoot, name), files, isPolyfillSourceFile);
        }
        writeNodePolyfillMarker(nextRoot, revision, install.files, install.digest);

        try {
            rollbackComplete = false;
            writePublishState(transactionRoot, {
                version: 1,
                phase: 'publishing',
                original: names.filter(name => pathExists(join(cacheDir, name))),
            });
            for (const name of names) {
                const live = join(cacheDir, name);
                if (!pathExists(live)) continue;
                fs.rename(live, join(backupRoot, name));
                movedLive.push(name);
            }
            for (const name of names) {
                fs.rename(join(nextRoot, name), join(cacheDir, name));
                published.push(name);
            }
            commitFileTransaction(
                join(transactionRoot, SETUP_PUBLISH_COMMITTED),
                engine.encodeString('committed\n'),
            );
        } catch (commitError) {
            const rollbackErrors: unknown[] = [];
            for (let i = published.length - 1; i >= 0; i--) {
                const name = published[i]!;
                try { removeTree(join(cacheDir, name)); } catch (error) { rollbackErrors.push(error); }
            }
            for (let i = movedLive.length - 1; i >= 0; i--) {
                const name = movedLive[i]!;
                try { fs.rename(join(backupRoot, name), join(cacheDir, name)); } catch (error) { rollbackErrors.push(error); }
            }
            rollbackComplete = rollbackErrors.length === 0;
            if (rollbackErrors.length > 0) {
                throw new AggregateError([commitError, ...rollbackErrors], 'Failed to publish setup sources and restore the previous tree');
            }
            throw commitError;
        }
        rollbackComplete = true;
    } finally {
        if (rollbackComplete) {
            if (pathExists(join(transactionRoot, SETUP_PUBLISH_COMMITTED))) {
                cleanupCommittedPublish(transactionRoot);
            } else {
                removeTree(transactionRoot);
            }
        }
        removeTree(install.stageRoot);
    }
}

// Written only after a complete setup pass. The legacy fs/index.ts probe can
// exist after a failed copy, so it is insufficient as a completion signal.
const NODE_POLYFILL_MARKER = '.cno-setup-ready';

function nodePolyfillMarker(cacheDir: string): string {
    return join(cacheDir, 'node', NODE_POLYFILL_MARKER);
}

function isRegularFile(path: string): boolean {
    try {
        assertNoSymlinkPath(path);
        return fs.lstat(path).isFile;
    } catch {
        return false;
    }
}

function clearNodePolyfillMarker(cacheDir: string): void {
    unlinkIfPresent(nodePolyfillMarker(cacheDir));
}

function writeNodePolyfillMarker(cacheDir: string, revision: string | null, files?: readonly string[], digest?: string): void {
    const metadata = {
        version: 3,
        source: revision === null ? 'local' : 'github',
        revision,
        bundledRevision: bundledPolyfillRevision,
        ...(files ? { files: [...files], digest } : {}),
    };
    commitFileTransaction(nodePolyfillMarker(cacheDir), engine.encodeString(JSON.stringify(metadata) + '\n'));
}

function nodePolyfillsPresent(cacheDir: string): boolean {
    try {
        assertNoSymlinkPath(cacheDir);
        if (pathExists(join(cacheDir, SETUP_PUBLISH_DIR))) return false;
        const marker = nodePolyfillMarker(cacheDir);
        assertNoSymlinkPath(marker);
        if (!fs.lstat(marker).isFile) return false;
        const metadata: unknown = JSON.parse(engine.decodeString(fs.readFile(marker)));
        if (!(isRecord(metadata)
            && metadata.version === 3
            && metadata.bundledRevision === bundledPolyfillRevision
            && (metadata.source === 'local' || (
                metadata.source === 'github'
                && typeof metadata.revision === 'string'
                && /^[0-9a-f]{40}$/.test(metadata.revision)
                && Array.isArray(metadata.files)
                && metadata.files.every(path => typeof path === 'string')
                && typeof metadata.digest === 'string'
                && /^[0-9a-f]{64}$/.test(metadata.digest)
            ))
            && isRegularFile(join(cacheDir, 'node', 'fs', 'index.ts'))
            && isRegularFile(join(cacheDir, 'bun', 'index.ts'))
            && isRegularFile(join(cacheDir, 'bun', 'sqlite', 'index.ts'))
            && isRegularFile(join(cacheDir, 'utils', 'path.ts')))) return false;
        if (metadata.source !== 'github') return true;
        const files = metadata.files as string[];
        return files.length > 0
            && files.every(path => validateRemoteSourcePath(path) && isRegularFile(join(cacheDir, path)))
            && sourceTreeDigest(cacheDir, files) === metadata.digest;
    } catch {
        return false;
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runSetup(flags: Record<string, string | boolean>): Promise<void> {
    const cacheDir = resolveCacheDir(flags);
    // An explicit revision selects remote installation even inside a checkout.
    const requestedRevision = flags['polyfill-revision'];
    const localSrc = requestedRevision === undefined ? findLocalPolyfillSource(os.cwd) : null;
    const revision = localSrc ? null : requirePolyfillRevision(requestedRevision ?? bundledPolyfillRevision);
    await withSetupLock(cacheDir, async () => {
        cleanupRemoteDownloads(cacheDir);
        recoverRemotePublish(cacheDir);
        const nodeDst = join(cacheDir, 'node');
        const bunDst = join(cacheDir, 'bun');
        const utilsDst = join(cacheDir, 'utils');
        assertNoSymlinkPath(nodeDst);
        assertNoSymlinkPath(bunDst);
        assertNoSymlinkPath(utilsDst);
        assertNoSymlinksInTree(nodeDst);
        assertNoSymlinksInTree(bunDst);
        assertNoSymlinksInTree(utilsDst);
        ensureDirectorySync(nodeDst, 0o755);
        ensureDirectorySync(bunDst, 0o755);
        ensureDirectorySync(utilsDst, 0o755);

        if (localSrc) {
            // Local workspace refreshes keep the existing per-file transaction
            // semantics; invalidate readiness before their first live mutation.
            clearNodePolyfillMarker(cacheDir);
            if (!localSrc.bun) throw new Error(`No Bun polyfill sources found beside ${localSrc.node}`);
            if (!localSrc.utils) throw new Error(`No shared polyfill sources found beside ${localSrc.node}`);
            log.debug('setup', () => `Installing from local source: ${localSrc.root}`);
            installLocal(localSrc.node, nodeDst, 'Node', NODE_POLYFILL_MARKER);
            installLocal(localSrc.bun, bunDst, 'Bun');
            installLocal(localSrc.utils, utilsDst, 'Shared');
            const httpPackage = findLocalHttpPackage(localSrc.root);
            if (httpPackage) {
                log.debug('setup', () => `Syncing @cnojs/http from ${httpPackage.dir}`);
                installLocalHttpToStore(httpPackage.dir, httpPackage.version, cacheDir);
            } else {
                log.debug('setup', () => 'Local @cnojs/http package not found beside node source');
            }
            writeNodePolyfillMarker(cacheDir, revision);
        } else {
            console.log(`Installing Node and Bun polyfills from imzlh/cno@${revision}`);
            const install = await installRemote(cacheDir, revision!);
            publishRemoteInstall(cacheDir, revision!, install);
        }

        console.log(`Node polyfills ready at: ${nodeDst}`);
        console.log(`Bun polyfills ready at: ${bunDst}`);
    });
}

/** Install missing polyfills and refresh caches created for a different build. */
export async function ensureNodePolyfills(cacheDir?: string): Promise<void> {
    const flags: Record<string, string | boolean> = {};
    if (cacheDir) flags['cache-dir'] = cacheDir;
    const dir = resolveCacheDir(flags);
    if (nodePolyfillsPresent(dir)) return;
    // Symlinks are rejected, not treated as a cache miss that setup may repair.
    assertNoSymlinkPath(nodePolyfillMarker(dir));
    for (const name of POLYFILL_TREE_NAMES) assertNoSymlinkPath(join(dir, name));
    await withSetupLock(dir, async () => {
        cleanupRemoteDownloads(dir);
        recoverRemotePublish(dir);
    });
    if (nodePolyfillsPresent(dir)) return;
    log.debug('setup', () => `node polyfills missing or outdated under ${dir}; running setup`);
    await runSetup(flags);
}
