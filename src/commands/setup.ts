import { fetchAsync } from '../../cno/src/webapi/fetch';
import { normalize, dirname, join, systemPathSplit } from '../../cno/src/utils/path';
import { log } from '../../cts/src/api';

const os = import.meta.use('os');
const console = import.meta.use('console');

const fs     = import.meta.use('fs');
const engine = import.meta.use('engine');

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

function unlinkQuietly(path: string): void {
    try {
        fs.unlink(path);
    } catch {
        // Missing or read-only stale bytecode should not fail setup copying.
    }
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

function mkdirp(dir: string): void {
    const normalized = normalize(dir);
    const parts = normalized.split(/[/\\]/);
    const isAbs = normalized.startsWith('/') || /^[A-Za-z]:[/\\]/.test(normalized);
    let cur = isAbs ? (normalized.startsWith('/') ? systemPathSplit : '') : '';

    for (const p of parts) {
        if (!p) continue;

        if (p.endsWith(':')) {
            cur = p + systemPathSplit;
            continue;
        }

        cur = cur
            ? (cur.endsWith(systemPathSplit) ? cur + p : cur + systemPathSplit + p)
            : p;
        try {
            fs.mkdir(cur, 0o755);
        } catch { /* exists */ }
    }
}

function copyFile(src: string, dst: string): void {
    mkdirp(dirname(dst));
    fs.writeFile(dst, fs.readFile(src));
}

function walkTs(dir: string, prefix = ''): string[] {
    const out: string[] = [];
    try {
        for (const name of fs.readdir(dir)) {
            const full = join(dir, name);
            const rel  = prefix ? join(prefix, name) : name;
            const st   = fs.stat(full);
            if (st.isDirectory) out.push(...walkTs(full, rel));
            else if (name.endsWith('.ts')) out.push(rel);
        }
    } catch { /* not readable */ }
    return out;
}

/** Copy package files needed for runtime resolution (skip build artifacts). */
function walkHttpPackageFiles(dir: string, prefix = ''): string[] {
    const out: string[] = [];
    try {
        for (const name of fs.readdir(dir)) {
            if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build') continue;
            if (isJscArtifact(name)) continue;
            const full = join(dir, name);
            const rel = prefix ? join(prefix, name) : name;
            const st = fs.stat(full);
            if (st.isDirectory) {
                out.push(...walkHttpPackageFiles(full, rel));
                continue;
            }
            // Source + package metadata; not C/Rust build trees under ext-*.
            if (
                name === 'package.json'
                || name.endsWith('.ts')
                || name.endsWith('.d.ts')
                || name.endsWith('.json')
                || name.endsWith('.js')
            ) {
                out.push(rel);
            }
        }
    } catch { /* not readable */ }
    return out;
}

function copyTreeIfNewer(srcBase: string, dstBase: string, files: string[]): { copied: number; skip: number } {
    let copied = 0, skip = 0;
    for (const rel of files) {
        const src = join(srcBase, rel);
        const dst = join(dstBase, rel);
        try {
            const srcMtime = fs.stat(src).mtim;
            try {
                if (fs.stat(dst).mtim >= srcMtime) { skip++; continue; }
            } catch { /* missing dst */ }
            copyFile(src, dst);
            unlinkQuietly(dst + '.jsc');
            unlinkQuietly(dst + '.jsc.mt');
            log.debug('oxc', () => `  COPY  ${rel}`);
            copied++;
        } catch (e) {
            console.error(`  FAIL  ${rel}: ${e instanceof Error ? e.message : e}`);
        }
    }
    return { copied, skip };
}

function isJscArtifact(name: string): boolean {
    return name.endsWith('.jsc') || name.endsWith('.jsc.mt');
}

function clearJsc(dir: string): number {
    let count = 0;
    try {
        for (const name of fs.readdir(dir)) {
            const full = join(dir, name);
            try {
                const st = fs.stat(full);
                if (st.isDirectory) count += clearJsc(full);
                else if (isJscArtifact(name)) {
                    fs.unlink(full);
                    count++;
                }
            } catch {}
        }
    } catch {}
    return count;
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
            } catch { /* not found */ }
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
function findLocalHttpPackage(nodeSrc: string): string | null {
    const candidates = [
        join(nodeSrc, '../../../http'),   // cno/src/node → repo/http
        join(nodeSrc, '../../http'),      // src/node → repo/http
        join(nodeSrc, '../../../../http'),
    ];
    for (const dir of candidates) {
        try {
            const pkgPath = join(normalize(dir), 'package.json');
            const raw = engine.decodeString(fs.readFile(pkgPath));
            const pkg = JSON.parse(raw) as { name?: string };
            if (pkg.name === '@cnojs/http') return normalize(dir);
        } catch { /* try next */ }
    }
    return null;
}

function readPackageVersion(pkgDir: string): string {
    try {
        const raw = engine.decodeString(fs.readFile(join(pkgDir, 'package.json')));
        const pkg = JSON.parse(raw) as { version?: string };
        if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch { /* default */ }
    return '1.0.0';
}

/**
 * Polyfills import `@cnojs/http/*` via the npm store. Local `cno setup` only
 * refreshed node/ before — keep the store package in lockstep with workspace http.
 */
function installLocalHttpToStore(httpSrc: string, cacheDir: string): void {
    const version = readPackageVersion(httpSrc);
    const dstBase = join(cacheDir, 'npm', `@cnojs/http@${version}`);
    mkdirp(dstBase);
    const files = walkHttpPackageFiles(httpSrc);
    if (files.length === 0) {
        console.error(`@cnojs/http: no files under ${httpSrc}`);
        return;
    }
    const { copied, skip } = copyTreeIfNewer(httpSrc, dstBase, files);
    // New exports / sources invalidate any prior bytecode beside the store tree.
    clearJsc(dstBase);
    console.log(`@cnojs/http@${version} store: ${copied} copied, ${skip} up-to-date → ${dstBase}`);
}

// ── Local: copy .ts files from srcBase → dstBase ────────────────────────────

function installLocal(srcBase: string, dstBase: string): void {
    const files = walkTs(srcBase);
    if (files.length === 0) throw new Error(`No .ts files found in ${srcBase}`);

    const { copied, skip } = copyTreeIfNewer(srcBase, dstBase, files);
    console.log(`Local install: ${copied} copied, ${skip} up-to-date`);
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
            const data = await fetchAsync(GITHUB_BASE + '/' + rel);
            mkdirp(dirname(dst));
            fs.writeFile(dst, await data.arrayBuffer());
            ok++;
        } catch (e) {
            console.error(`  FAIL  ${rel}: ${e instanceof Error ? e.message : e}`);
            fail++;
        }
    });
    log.debug('oxc', () => `\nRemote install: ${ok} downloaded, ${fail} failed`);
    if (fail > 0) throw new Error('Some files failed to download');
}

// Marker file for "node polyfills installed in this cache dir".
// Lifecycle scripts (`node ./postinstall.mjs`) need these paths.
function nodePolyfillMarker(cacheDir: string): string {
    return join(cacheDir, 'node', 'fs', 'index.ts');
}

function nodePolyfillsPresent(cacheDir: string): boolean {
    try {
        return fs.stat(nodePolyfillMarker(cacheDir)).isFile;
    } catch {
        return false;
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runSetup(flags: Record<string, string | boolean>): Promise<void> {
    const cacheDir = resolveCacheDir(flags);
    const dstBase  = join(cacheDir, 'node');
    mkdirp(dstBase);

    const localSrc = findLocalNodeSource(os.cwd);

    if (localSrc) {
        log.debug('setup', () => `Installing from local source: ${localSrc}`);
        log.debug('setup', () => `Destination: ${dstBase}`);
        installLocal(localSrc, dstBase);
        const httpSrc = findLocalHttpPackage(localSrc);
        if (httpSrc) {
            log.debug('setup', () => `Syncing @cnojs/http from ${httpSrc}`);
            installLocalHttpToStore(httpSrc, cacheDir);
        } else {
            log.debug('setup', () => 'Local @cnojs/http package not found beside node source');
        }
    } else {
        log.debug('setup', () => 'Local source not found, fetching from GitHub (imzlh/cno)...');
        await installRemote(dstBase);
    }

    const cleared = clearJsc(dstBase);
    if (cleared > 0) log.debug('setup', () => `Cleared ${cleared} stale node polyfill bytecode files`);
    console.log(`Node polyfills ready at: ${dstBase}`);
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
