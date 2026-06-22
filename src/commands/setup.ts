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

import { loadConfigFile } from '../../cts/src/config';
import { fetchAsync } from '../../cno/src/webapi/fetch';
import { normalize, dirname, join, systemPathSplit } from '../../cno/src/utils/path';
import { log } from '../../cts/src/utils/log';

const os = import.meta.use('os');
const console = import.meta.use('console');

const fs     = import.meta.use('fs');
const engine = import.meta.use('engine');

const GITHUB_BASE = 'https://raw.githubusercontent.com/imzlh/cno/master/cno/src/node';
const GITHUB_TREE = 'https://api.github.com/repos/imzlh/cno/git/trees/master?recursive=1';

function mkdirp(dir: string): void {
    const normalized = normalize(dir);
    const parts = normalized.split(/[/\\]/);
    let cur = '';

    for (const p of parts) {
        if (!p) continue;

        if (p.endsWith(':')) {
            cur = p + systemPathSplit;
            continue;
        }

        cur = cur ? (cur + systemPathSplit + p) : p;
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

// ── Remote: fetch .ts files from GitHub → dstBase ───────────────────────────

async function installRemote(dstBase: string): Promise<void> {
    log.debug('oxc', () => 'Fetching file list from GitHub...');
    const treeJson = engine.decodeString(await fetchAsync(GITHUB_TREE).then(r => r.arrayBuffer()));
    const tree: { tree: Array<{ path: string; type: string }> } = JSON.parse(treeJson);

    const nodeFiles = tree.tree.filter(
        n => n.type === 'blob' && n.path.startsWith('cno/src/node/') && n.path.endsWith('.ts')
    );
    if (nodeFiles.length === 0) throw new Error('No node files found in GitHub tree');
    log.debug('oxc', () => `Found ${nodeFiles.length} files, downloading...`);

    let ok = 0, fail = 0;
    for (const entry of nodeFiles) {
        const rel = entry.path.slice('cno/src/node/'.length);
        const dst = join(dstBase, rel);
        try {
            const data = await fetchAsync(GITHUB_BASE + '/' + rel);
            mkdirp(dirname(dst));
            fs.writeFile(dst, await data.arrayBuffer());
            log.debug('oxc', () => `  GET   ${rel}`);
            ok++;
        } catch (e: any) {
            console.error(`  FAIL  ${rel}: ${e?.message ?? e}`);
            fail++;
        }
    }
    log.debug('oxc', () => `\nRemote install: ${ok} downloaded, ${fail} failed`);
    if (fail > 0) throw new Error('Some files failed to download');
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runSetup(_flags: Record<string, string | boolean>): Promise<void> {
    // Resolve cacheDir the same way cts does
    const cwd = os.cwd;
    const cfg  = loadConfigFile(cwd);
    const cacheDir = cfg.cacheDir ?? (join(os.homeDir, '.cts'));
    const dstBase  = join(cacheDir, 'node');
    mkdirp(dstBase);

    // Find local source tree
    const candidates = [
        join(cwd, 'cno', 'src', 'node'),
        join(cwd, 'src', 'node')
    ];
    let localSrc: string | null = null;
    for (const c of candidates) {
        try {
            if (fs.stat(c).isDirectory) { localSrc = c; break; }
        } catch { /* not found */ }
    }

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
