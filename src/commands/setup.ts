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

import { os, console } from '../../cts/src/utils';
import { joinPaths, dirname } from '../../cts/src/utils/path';
import { loadConfigFile } from '../../cts/src/config';
import { fetchBytes } from '../../http/src/fetch';

const fs     = import.meta.use('fs');
const engine = import.meta.use('engine');

const GITHUB_BASE = 'https://raw.githubusercontent.com/imzlh/cno/master/cno/src/node';
const GITHUB_TREE = 'https://api.github.com/repos/imzlh/cno/git/trees/master?recursive=1';

function selfDir(): string {
    const self = (os as any).exePath as string | undefined
        ?? (os.args as string[])[0]!;
    return dirname(self.replace(/\\/g, '/'));
}

function mkdirp(dir: string): void {
    const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
        cur += '/' + p;
        try { (fs as any).mkdir(cur, 0o755); } catch { /* exists */ }
    }
}

function copyFile(src: string, dst: string): void {
    mkdirp(dst.substring(0, dst.lastIndexOf('/')));
    (fs as any).writeFile(dst, (fs as any).readFile(src));
}

function walkTs(dir: string, prefix = ''): string[] {
    const out: string[] = [];
    try {
        for (const name of (fs as any).readdir(dir) as string[]) {
            const full = dir + '/' + name;
            const rel  = prefix ? prefix + '/' + name : name;
            const st   = (fs as any).stat(full);
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
        const src = srcBase + '/' + rel;
        const dst = dstBase + '/' + rel;
        try {
            const srcMtime = (fs as any).stat(src).mtime;
            try {
                if ((fs as any).stat(dst).mtime >= srcMtime) { skip++; continue; }
            } catch { /* dst missing */ }
            copyFile(src, dst);
            console.log(`  COPY  ${rel}`);
            copied++;
        } catch (e: any) {
            console.error(`  FAIL  ${rel}: ${e?.message ?? e}`);
        }
    }
    console.log(`\nLocal install: ${copied} copied, ${skip} up-to-date`);
}

// ── Remote: fetch .ts files from GitHub → dstBase ───────────────────────────

function installRemote(dstBase: string): void {
    console.log('Fetching file list from GitHub...');
    const treeJson = engine.decodeString(fetchBytes(GITHUB_TREE));
    const tree: { tree: Array<{ path: string; type: string }> } = JSON.parse(treeJson);

    const nodeFiles = tree.tree.filter(
        n => n.type === 'blob' && n.path.startsWith('cno/src/node/') && n.path.endsWith('.ts')
    );
    if (nodeFiles.length === 0) throw new Error('No node files found in GitHub tree');
    console.log(`Found ${nodeFiles.length} files, downloading...`);

    let ok = 0, fail = 0;
    for (const entry of nodeFiles) {
        const rel = entry.path.slice('cno/src/node/'.length);
        const dst = dstBase + '/' + rel;
        try {
            const data = fetchBytes(GITHUB_BASE + '/' + rel);
            mkdirp(dst.substring(0, dst.lastIndexOf('/')));
            (fs as any).writeFile(dst, data);
            console.log(`  GET   ${rel}`);
            ok++;
        } catch (e: any) {
            console.error(`  FAIL  ${rel}: ${e?.message ?? e}`);
            fail++;
        }
    }
    console.log(`\nRemote install: ${ok} downloaded, ${fail} failed`);
    if (fail > 0) throw new Error('Some files failed to download');
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function runSetup(_flags: Record<string, string | boolean>): void {
    // Resolve cacheDir the same way cts does
    const cwd = String(os.cwd).replace(/\\/g, '/');
    const cfg  = loadConfigFile(cwd);
    const cacheDir = (cfg as any).cacheDir ?? (joinPaths(String((os as any).homeDir ?? '~'), '.cts'));
    const dstBase  = cacheDir + '/node';
    mkdirp(dstBase);

    // Find local source tree
    const candidates = [
        cwd + '/src/node',
        cwd + '/../cno/src/node',
        joinPaths(selfDir(), '../cno/src/node'),
    ];
    let localSrc: string | null = null;
    for (const c of candidates) {
        try {
            if ((fs as any).stat(c).isDirectory) { localSrc = c; break; }
        } catch { /* not found */ }
    }

    if (localSrc) {
        console.log(`Installing from local source: ${localSrc}`);
        installLocal(localSrc, dstBase);
    } else {
        console.log('Local source not found, fetching from GitHub (imzlh/cno)...');
        installRemote(dstBase);
    }

    console.log(`\nNode polyfills ready at: ${dstBase}`);
    console.log('Run any script that uses node: imports — cts will compile on first use.');
}
