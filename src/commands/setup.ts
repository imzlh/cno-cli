/**
 * `cno setup` — install node built-in polyfills into cts cache.
 *
 * Strategy:
 *   1. If cno/src/node exists locally (dev tree or cwd), copy from there.
 *   2. Otherwise, fetch .ts files from GitHub (imzlh/cno) and write them.
 *
 * cts resolves `node:*` by looking for .ts files in cacheDir/node/.
 * No pre-compilation needed — cts transforms on first import.
 */

import { fetchAsync } from '../../cno/src/webapi/fetch';
import { normalize, dirname, join, systemPathSplit } from '../../cno/src/utils/path';
import { log } from '../../cts/src/utils/log';

const os = import.meta.use('os');
const console = import.meta.use('console');

const fs     = import.meta.use('fs');
const engine = import.meta.use('engine');

const GITHUB_BASE = 'https://raw.githubusercontent.com/imzlh/cno/master/src/node';
const GITHUB_TREE = 'https://api.github.com/repos/imzlh/cno/git/trees/master?recursive=1';

function env(k: string): string | null { try { return os.getenv(k); } catch { return null; } }

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
        try { fs.mkdir(cur, 0o755); } catch { /* exists */ }
    }
}

function copyFile(src: string, dst: string): void {
    mkdirp(dirname(dst));
    fs.writeFile(dst, fs.readFile(src));
}

function walkTs(dir: string, prefix = ''): string[] {
    const out: string[] = [];
    try {
        for (const name of fs.readdir(dir) as string[]) {
            const full = join(dir, name);
            const rel  = prefix ? join(prefix, name) : name;
            const st   = fs.stat(full);
            if (st.isDirectory) out.push(...walkTs(full, rel));
            else if (name.endsWith('.ts')) out.push(rel);
        }
    } catch { /* not readable */ }
    return out;
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

// ── Local: copy .ts files from srcBase → dstBase ────────────────────────────

function installLocal(srcBase: string, dstBase: string): void {
    const files = walkTs(srcBase);
    if (files.length === 0) throw new Error(`No .ts files found in ${srcBase}`);

    let copied = 0, skip = 0;
    for (const rel of files) {
        const src = join(srcBase, rel);
        const dst = join(dstBase, rel);
        try {
            const srcMtime = fs.stat(src).mtim;
            try {
                if (fs.stat(dst).mtim >= srcMtime) { skip++; continue; }
            } catch {}
            copyFile(src, dst);
            try { fs.unlink(dst + '.jsc') } catch {}
            log.debug('oxc', () => `  COPY  ${rel}`);
            copied++;
        } catch (e: any) {
            console.error(`  FAIL  ${rel}: ${e?.message ?? e}`);
        }
    }
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
    const tree: { tree?: Array<{ path: string; type: string }>; truncated?: boolean; message?: string } = JSON.parse(treeJson);

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
        } catch (e: any) {
            console.error(`  FAIL  ${rel}: ${e?.message ?? e}`);
            fail++;
        }
    });
    log.debug('oxc', () => `\nRemote install: ${ok} downloaded, ${fail} failed`);
    if (fail > 0) throw new Error('Some files failed to download');
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runSetup(flags: Record<string, string | boolean>): Promise<void> {
    const cacheDir = resolveCacheDir(flags);
    const dstBase  = join(cacheDir, 'node');
    mkdirp(dstBase);

    const cwd = os.cwd;
    const localSrc = findLocalNodeSource(cwd);

    if (localSrc) {
        log.debug('setup', () => `Installing from local source: ${localSrc}`);
        log.debug('setup', () => `Destination: ${dstBase}`);
        installLocal(localSrc, dstBase);
    } else {
        log.debug('setup', () => 'Local source not found, fetching from GitHub (imzlh/cno)...');
        await installRemote(dstBase);
    }

    console.log(`Node polyfills ready at: ${dstBase}`);
}
