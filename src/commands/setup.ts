import { fetchAsync } from '../../cno/src/webapi/fetch';
import { ensureDirectorySync } from '../../cno/src/utils/fs-path';
import { normalize, dirname, join } from '../../cno/src/utils/path';
import { log } from '../../cts/src/api';

const os = import.meta.use('os');
const console = import.meta.use('console');

const fs     = import.meta.use('fs');
const engine = import.meta.use('engine');
const sysError = import.meta.use('error');

const GITHUB_BASE = 'https://raw.githubusercontent.com/imzlh/cno/master/src/node';
const GITHUB_TREE = 'https://api.github.com/repos/imzlh/cno/git/trees/master?recursive=1';

type GitHubTreeNode = { path: string; type: string };
type GitHubTreeResponse = {
    tree?: GitHubTreeNode[];
    truncated?: boolean;
    message?: string;
};

function env(k: string): string | null {
    try {
        return os.getenv(k) ?? null;
    } catch {
        return null;
    }
}

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

function unlinkIfPresent(path: string): boolean {
    try {
        fs.unlink(path);
        return true;
    } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
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

const HOME = os.homeDir || (os.platform === 'win32' ? (env('USERPROFILE') || '') : (env('HOME') || '/root'));

function resolveCacheDir(flags: Record<string, string | boolean>): string {
    const flag = flags['cache-dir'] || flags['cacheDir'];
    if (typeof flag === 'string' && flag) return flag;
    const envDir = env('CTS_CACHE_DIR');
    if (envDir) return envDir;
    return join(HOME, '.cts');
}


const setupLockQueue = new Map<string, Promise<void>>();

async function withSetupLock<T>(cacheDir: string, fn: () => Promise<T>): Promise<T> {
    const previous = setupLockQueue.get(cacheDir);
    let release = () => {};
    const turn = new Promise<void>(resolve => { release = resolve; });
    setupLockQueue.set(cacheDir, turn);
    if (previous) await previous.catch(() => {});

    try {
        ensureDirectorySync(cacheDir, 0o755);
        const path = join(cacheDir, '.setup.lock');
        let fd: number;
        try {
            fd = fs.open(path, 'wx', 0o600);
        } catch (error) {
            if (!isAlreadyExists(error)) throw error;
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
        return fs.stat(path).size === expected.byteLength
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
    if (isExistingDirectory(dst)) {
        throw new Error(`Cannot replace directory with file: ${dst}`);
    }
    ensureDirectorySync(dirname(dst), 0o755);
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
                if (st.isSymbolicLink) continue;
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

function isNodeSourceFile(path: string): boolean {
    return path.endsWith('.ts');
}

function isHttpPackageSourceFile(path: string): boolean {
    return /(?:^|[\\/])package\.json$/.test(path)
        || path.endsWith('.ts')
        || path.endsWith('.json')
        || path.endsWith('.js');
}

function findLocalNodeSource(start: string): string | null {
    let dir = normalize(start);
    const seen = new Set<string>();

    while (dir && !seen.has(dir)) {
        seen.add(dir);
        for (const rel of ['src/node', 'cno/src/node']) {
            const candidate = join(dir, rel);
            try {
                if (fs.stat(candidate).isDirectory) return candidate;
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
 * Locate workspace `http/` next to cno polyfills.
 * node source: <root>/cno/src/node or <root>/src/node → http at <root>/http or sibling.
 */
function findLocalHttpPackage(nodeSrc: string): { dir: string; version: string } | null {
    const candidates = [
        join(nodeSrc, '../../../http'),   // cno/src/node → repo/http
        join(nodeSrc, '../../http'),      // src/node → repo/http
        join(nodeSrc, '../../../../http'),
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
            // Candidate paths above deliberately include a few layouts that
            // may not exist. Once a package file is present, though, a read or
            // parse failure must not make setup claim a complete local install.
            if (isNotFound(error)) continue;
            throw new Error(`Cannot read local @cnojs/http package at ${dir}: ${error}`);
        }
    }
    return null;
}

/**
 * Polyfills import `@cnojs/http/*` via the npm store. Local `cno setup` only
 * refreshed node/ before — keep the store package in lockstep with workspace http.
 */
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

function installLocal(srcBase: string, dstBase: string): void {
    const files = walkManagedSourceFiles(srcBase, isNodeSourceFile);
    if (files.length === 0) throw new Error(`No .ts files found in ${srcBase}`);

    const { copied, skip } = copyTreeIfChanged(srcBase, dstBase, files);
    const removed = pruneStaleManagedFiles(dstBase, files, isNodeSourceFile);
    console.log(`Local install: ${copied} copied, ${skip} up-to-date, ${removed} stale removed`);
}

async function batchRun<T>(items: T[], fn: (item: T) => Promise<void>, concurrency = 8): Promise<void> {
    for (let i = 0; i < items.length; i += concurrency) {
        await Promise.all(items.slice(i, i + concurrency).map(fn));
    }
}

// ── Remote: fetch .ts files from GitHub → dstBase ───────────────────────────

async function installRemote(dstBase: string): Promise<void> {
    log.debug('oxc', () => 'Fetching file list from GitHub...');
    const treeResp = await fetchAsync(GITHUB_TREE);
    if (!treeResp.ok) throw new Error(`GitHub API error: ${treeResp.status}`);
    const treeJson = engine.decodeString(await treeResp.arrayBuffer());
    const tree = parseGitHubTreeResponse(treeJson);

    if (tree.message) throw new Error(`GitHub API: ${tree.message}`);
    if (!tree.tree || tree.truncated) throw new Error('GitHub tree truncated or missing');

    const nodeFiles = tree.tree.filter(
        n => n.type === 'blob' && n.path.startsWith('src/node/') && n.path.endsWith('.ts')
    );
    if (nodeFiles.length === 0) throw new Error('No node files found in GitHub tree');
    log.debug('oxc', () => `Found ${nodeFiles.length} files, downloading in batches of 8...`);

    let ok = 0, fail = 0;
    await batchRun(nodeFiles, async (entry) => {
        const rel = entry.path.slice('src/node/'.length);
        const dst = join(dstBase, rel);
        try {
            log.debug('oxc', () => `  GET   ${rel}`);
            const response = await fetchAsync(GITHUB_BASE + '/' + rel);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength === 0) {
                throw new Error('empty response body');
            }
            commitFileTransaction(dst, bytes);
            clearSourceBytecode(dst);
            ok++;
        } catch (e) {
            console.error(`  FAIL  ${rel}: ${e instanceof Error ? e.message : e}`);
            fail++;
        }
    });
    log.debug('oxc', () => `\nRemote install: ${ok} downloaded, ${fail} failed`);
    if (fail > 0) throw new Error('Some files failed to download');
    const removed = pruneStaleManagedFiles(
        dstBase,
        nodeFiles.map(entry => entry.path.slice('src/node/'.length)),
        isNodeSourceFile,
    );
    log.debug('setup', () => `Removed ${removed} stale node polyfill file(s)`);
}

// Written only after a complete setup pass. The legacy fs/index.ts probe can
// exist after a failed copy, so it is insufficient as a completion signal.
const NODE_POLYFILL_MARKER = '.cno-setup-ready';

function nodePolyfillMarker(cacheDir: string): string {
    return join(cacheDir, 'node', NODE_POLYFILL_MARKER);
}

function clearNodePolyfillMarker(cacheDir: string): void {
    unlinkIfPresent(nodePolyfillMarker(cacheDir));
}

function writeNodePolyfillMarker(cacheDir: string): void {
    commitFileTransaction(nodePolyfillMarker(cacheDir), engine.encodeString('ready\n'));
}

function nodePolyfillsPresent(cacheDir: string): boolean {
    try {
        return fs.stat(nodePolyfillMarker(cacheDir)).isFile
            && fs.stat(join(cacheDir, 'node', 'fs', 'index.ts')).isFile;
    } catch {
        return false;
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runSetup(flags: Record<string, string | boolean>): Promise<void> {
    const cacheDir = resolveCacheDir(flags);
    await withSetupLock(cacheDir, async () => {
        // Clear a prior success marker before any mutation. If this pass throws
        // or the process dies mid-copy, ensureNodePolyfills() will retry.
        clearNodePolyfillMarker(cacheDir);
        const dstBase  = join(cacheDir, 'node');
        ensureDirectorySync(dstBase, 0o755);

        const localSrc = findLocalNodeSource(os.cwd);

        if (localSrc) {
            log.debug('setup', () => `Installing from local source: ${localSrc}`);
            log.debug('setup', () => `Destination: ${dstBase}`);
            installLocal(localSrc, dstBase);
            const httpPackage = findLocalHttpPackage(localSrc);
            if (httpPackage) {
                log.debug('setup', () => `Syncing @cnojs/http from ${httpPackage.dir}`);
                installLocalHttpToStore(httpPackage.dir, httpPackage.version, cacheDir);
            } else {
                log.debug('setup', () => 'Local @cnojs/http package not found beside node source');
            }
        } else {
            log.debug('setup', () => 'Local source not found, fetching from GitHub (imzlh/cno)...');
            await installRemote(dstBase);
        }

        writeNodePolyfillMarker(cacheDir);
        console.log(`Node polyfills ready at: ${dstBase}`);
    });
}

/** Install node polyfills only when missing (cache/exec lifecycle needs them). */
export async function ensureNodePolyfills(cacheDir?: string): Promise<void> {
    const flags: Record<string, string | boolean> = {};
    if (cacheDir) flags['cache-dir'] = cacheDir;
    const dir = resolveCacheDir(flags);
    if (nodePolyfillsPresent(dir)) return;
    log.debug('setup', () => `node polyfills missing under ${dir}; running setup`);
    await runSetup(flags);
}
