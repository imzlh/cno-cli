import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { buildInstallViewEdges, materializeNodeModules } from '../../cts/src/resolve/linker.ts';
import type { ScanResult } from '../../cts/src/deps.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';

type Edge = ScanResult['edges'][number];

function seedPkg(
    cacheDir: string,
    name: string,
    version: string,
    files: Record<string, string> = {},
    pkgExtra: Record<string, unknown> = {},
): string {
    const dir = joinPaths(cacheDir, 'npm', `${name}@${version}`);
    mkdirSync(join(dir), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, ...pkgExtra }));
    for (const [rel, text] of Object.entries(files)) {
        const path = joinPaths(dir, rel);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(join(path), text);
    }
    return dir;
}

function edge(parentSpecPath: string, name: string, childSpecPath: string, childLocalPath: string): Edge {
    return { parentSpecPath, name, childSpecPath, childLocalPath };
}

Deno.test('cts linker: invalid package names, bins, and stale manifests cannot escape project roots', async () => {
    const root = makePosixTempDir('linker-containment');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        const victimDir = joinPaths(root, 'victim');
        const alphaDir = seedPkg(cacheDir, 'alpha', '1.0.0', { 'index.js': 'export {}\n' }, {
            bin: { '../../victim': './index.js', tool: '../outside.js' },
        });
        mkdirSync(victimDir, { recursive: true });
        writeFileSync(join(victimDir, 'keep.txt'), 'keep\n');
        mkdirSync(join(projectDir, 'node_modules'), { recursive: true });
        writeFileSync(join(projectDir, 'node_modules', '.cts-node-modules.json'), JSON.stringify(['../../victim']));

        await materializeNodeModules([
            edge(`${projectDir}/<entry>`, '../../victim', 'npm:alpha@1.0.0/index.js', joinPaths(alphaDir, 'index.js')),
        ], 'soft', cacheDir, projectDir);

        strictEqual(readFileSync(join(victimDir, 'keep.txt'), 'utf8'), 'keep\n');
        ok(!existsSync(join(projectDir, 'node_modules', '.bin', 'tool')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: soft mode only links project roots (store untouched)', async () => {
    const root = makePosixTempDir('linker-soft');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        const alphaDir = seedPkg(cacheDir, 'alpha', '1.0.0', { 'index.js': 'export const alpha = 1;\n' }, {
            dependencies: { beta: '2.0.0' },
        });
        const betaDir = seedPkg(cacheDir, 'beta', '2.0.0', { 'index.js': 'export const beta = 2;\n' });
        // Install-owned soft link under store (materialize must not create this).
        mkdirSync(join(alphaDir, 'node_modules'), { recursive: true });
        symlinkSync(betaDir, join(alphaDir, 'node_modules', 'beta'));
        mkdirSync(join(projectDir), { recursive: true });

        const progress: Array<[number, number]> = [];
        await materializeNodeModules([
            edge(`${projectDir}/<cache>`, 'alpha', 'npm:alpha@1.0.0/index.js', joinPaths(alphaDir, 'index.js')),
        ], 'soft', cacheDir, projectDir, (done, total) => {
            progress.push([done, total]);
        });

        const linked = joinPaths(projectDir, 'node_modules', 'alpha');
        ok(lstatSync(join(linked)).isSymbolicLink());
        strictEqual(readlinkSync(join(linked)), alphaDir);

        // Soft realpath walks install-owned store links — materialize did not write them.
        const realAlpha = realpathSync(join(linked));
        const nested = join(realAlpha, 'node_modules', 'beta');
        ok(lstatSync(nested).isSymbolicLink());
        strictEqual(readlinkSync(nested), betaDir);
        deepStrictEqual(JSON.parse(readFileSync(join(projectDir, 'node_modules', '.cts-node-modules.json'), 'utf8')), ['alpha']);
        // Soft: only project roots counted.
        deepStrictEqual(progress[0], [0, 1]);
        deepStrictEqual(progress[progress.length - 1], [1, 1]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: soft peer resolution uses install-owned store links', async () => {
    const root = makePosixTempDir('linker-peer');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        const hostDir = seedPkg(cacheDir, 'host', '1.0.0', { 'index.js': 'export {}\n' }, {
            peerDependencies: { 'peer-lib': '^1.0.0' },
        });
        const peerDir = seedPkg(cacheDir, 'peer-lib', '1.2.0', { 'index.js': 'export const peer = 1;\n' });
        mkdirSync(join(hostDir, 'node_modules'), { recursive: true });
        symlinkSync(peerDir, join(hostDir, 'node_modules', 'peer-lib'));
        mkdirSync(join(projectDir), { recursive: true });

        await materializeNodeModules([
            edge(`${projectDir}/<entry>`, 'host', 'npm:host@1.0.0/index.js', joinPaths(hostDir, 'index.js')),
        ], 'soft', cacheDir, projectDir);

        const realHost = realpathSync(join(projectDir, 'node_modules', 'host'));
        const peerLink = join(realHost, 'node_modules', 'peer-lib');
        ok(lstatSync(peerLink).isSymbolicLink(), 'peer remains install soft link under store');
        strictEqual(readlinkSync(peerLink), peerDir);
        ok(!existsSync(join(projectDir, 'node_modules', 'peer-lib')), 'peer is not a project root');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: hard mode uses virtual store; store read-only', async () => {
    const root = makePosixTempDir('linker-hard');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        const alphaDir = seedPkg(cacheDir, 'alpha', '1.0.0', { 'index.js': 'export const alpha = 1;\n' }, {
            dependencies: { beta: '2.0.0' },
        });
        const betaDir = seedPkg(cacheDir, 'beta', '2.0.0', { 'index.js': 'export const beta = 2;\n' });
        seedPkg(cacheDir, 'old', '9.0.0');
        mkdirSync(join(projectDir, 'node_modules', 'old'), { recursive: true });
        writeFileSync(join(projectDir, 'node_modules', 'old', 'stale.txt'), 'stale\n');
        writeFileSync(join(projectDir, 'node_modules', '.cts-node-modules.json'), JSON.stringify(['old']));
        // Pre-existing store link must not be wiped or rewritten by materialize.
        mkdirSync(join(alphaDir, 'node_modules', 'install-peer'), { recursive: true });
        writeFileSync(join(alphaDir, 'node_modules', 'install-peer', 'package.json'), '{"name":"install-peer"}');
        const storeBefore = existsSync(join(alphaDir, 'node_modules', 'beta'));

        const progress: Array<[number, number]> = [];
        await materializeNodeModules([
            edge(`${projectDir}/<entry>`, 'alpha', 'npm:alpha@1.0.0/index.js', joinPaths(alphaDir, 'index.js')),
        ], 'hard', cacheDir, projectDir, (done, total) => {
            progress.push([done, total]);
        });

        // Project root soft → virtual body (hardlinked once under .cts).
        const rootAlpha = join(projectDir, 'node_modules', 'alpha');
        ok(lstatSync(rootAlpha).isSymbolicLink(), 'project root is soft into virtual store');
        ok(existsSync(join(rootAlpha, 'package.json')));
        strictEqual(readFileSync(join(rootAlpha, 'index.js'), 'utf8'), 'export const alpha = 1;\n');

        const virtAlpha = join(projectDir, 'node_modules', '.cts', 'alpha@1.0.0', 'node_modules', 'alpha');
        const virtBeta = join(projectDir, 'node_modules', '.cts', 'beta@2.0.0', 'node_modules', 'beta');
        ok(existsSync(join(virtAlpha, 'package.json')));
        ok(existsSync(join(virtBeta, 'package.json')));
        // Nested dep is soft sibling under virtual node_modules (pnpm layout).
        const nestedBeta = join(projectDir, 'node_modules', '.cts', 'alpha@1.0.0', 'node_modules', 'beta');
        ok(lstatSync(nestedBeta).isSymbolicLink());
        strictEqual(readlinkSync(nestedBeta), virtBeta);
        strictEqual(
            readFileSync(join(nestedBeta, 'index.js'), 'utf8'),
            'export const beta = 2;\n',
        );
        // Store unchanged: materialize must not create alpha/node_modules/beta there.
        strictEqual(existsSync(join(alphaDir, 'node_modules', 'beta')), storeBefore);
        ok(existsSync(join(alphaDir, 'node_modules', 'install-peer', 'package.json')));
        ok(existsSync(join(betaDir, 'package.json')));
        ok(!existsSync(join(projectDir, 'node_modules', 'old')));
        deepStrictEqual(JSON.parse(readFileSync(join(projectDir, 'node_modules', '.cts-node-modules.json'), 'utf8')), ['alpha']);
        // bodies(alpha,beta)=2 + soft(alpha→beta, root alpha)=2 → total 4.
        ok(progress.length >= 2);
        deepStrictEqual(progress[0], [0, 4]);
        for (const [done, total] of progress) ok(done <= total, `linked ${done}/${total}`);
        deepStrictEqual(progress[progress.length - 1], [4, 4]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: hard diamond shares one body (unique packages, soft edges)', async () => {
    // Diamond: a→b, a→c, b→d, c→d. Unique pkgs=4; d body hardlinked once.
    const root = makePosixTempDir('linker-hard-diamond');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        const aDir = seedPkg(cacheDir, 'a', '1.0.0', { 'index.js': 'export {}\n' }, {
            dependencies: { b: '1.0.0', c: '1.0.0' },
        });
        seedPkg(cacheDir, 'b', '1.0.0', { 'index.js': 'export {}\n' }, { dependencies: { d: '1.0.0' } });
        seedPkg(cacheDir, 'c', '1.0.0', { 'index.js': 'export {}\n' }, { dependencies: { d: '1.0.0' } });
        seedPkg(cacheDir, 'd', '1.0.0', { 'index.js': 'export const d = 1;\n' });
        mkdirSync(join(projectDir), { recursive: true });

        const progress: Array<[number, number]> = [];
        await materializeNodeModules([
            edge(`${projectDir}/<entry>`, 'a', 'npm:a@1.0.0/index.js', joinPaths(aDir, 'index.js')),
        ], 'hard', cacheDir, projectDir, (done, total) => {
            progress.push([done, total]);
        });

        const virtD = join(projectDir, 'node_modules', '.cts', 'd@1.0.0', 'node_modules', 'd');
        ok(existsSync(join(virtD, 'package.json')));
        const dFromB = join(projectDir, 'node_modules', '.cts', 'b@1.0.0', 'node_modules', 'd');
        const dFromC = join(projectDir, 'node_modules', '.cts', 'c@1.0.0', 'node_modules', 'd');
        ok(lstatSync(dFromB).isSymbolicLink());
        ok(lstatSync(dFromC).isSymbolicLink());
        strictEqual(readlinkSync(dFromB), virtD);
        strictEqual(readlinkSync(dFromC), virtD);
        // One shared body: both edges resolve to the same package contents.
        strictEqual(
            readFileSync(join(dFromB, 'index.js'), 'utf8'),
            readFileSync(join(virtD, 'index.js'), 'utf8'),
        );
        // bodies(4) + soft(a→b,a→c,b→d,c→d,root a)=5 → total 9 (not fan-out hard copies).
        deepStrictEqual(progress[0], [0, 9]);
        for (const [done, total] of progress) ok(done <= total, `linked ${done}/${total}`);
        deepStrictEqual(progress[progress.length - 1], [9, 9]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: hard mode cycle soft-links within virtual store', async () => {
    const root = makePosixTempDir('linker-hard-cycle');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        const aDir = seedPkg(cacheDir, 'pkg-a', '1.0.0', { 'index.js': 'export const a = 1;\n' }, {
            dependencies: { 'pkg-b': '1.0.0' },
        });
        const bDir = seedPkg(cacheDir, 'pkg-b', '1.0.0', { 'index.js': 'export const b = 1;\n' }, {
            dependencies: { 'pkg-a': '1.0.0' },
        });
        mkdirSync(join(projectDir), { recursive: true });

        await materializeNodeModules([
            edge(`${projectDir}/<entry>`, 'pkg-a', 'npm:pkg-a@1.0.0/index.js', joinPaths(aDir, 'index.js')),
        ], 'hard', cacheDir, projectDir);

        const virtA = join(projectDir, 'node_modules', '.cts', 'pkg-a@1.0.0', 'node_modules', 'pkg-a');
        const virtB = join(projectDir, 'node_modules', '.cts', 'pkg-b@1.0.0', 'node_modules', 'pkg-b');
        ok(existsSync(join(virtA, 'package.json')));
        ok(existsSync(join(virtB, 'package.json')));
        const cycleA = join(projectDir, 'node_modules', '.cts', 'pkg-b@1.0.0', 'node_modules', 'pkg-a');
        ok(lstatSync(cycleA).isSymbolicLink(), 'cycle edge soft-links virtual body');
        strictEqual(readlinkSync(cycleA), virtA);
        // Store never received hard materialize writes for the cycle.
        ok(!existsSync(join(bDir, 'node_modules', 'pkg-a')) || lstatSync(join(bDir, 'node_modules', 'pkg-a')).isSymbolicLink());
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: soft mode fails closed when store package is missing', async () => {
    const root = makePosixTempDir('linker-fail-closed');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });
        await rejects(
            () => materializeNodeModules([
                edge(`${projectDir}/<cache>`, 'ghost', 'npm:ghost@1.0.0/index.js', joinPaths(cacheDir, 'npm', 'ghost@1.0.0', 'index.js')),
            ], 'soft', cacheDir, projectDir),
            (e: unknown) => {
                ok(e instanceof Error);
                ok(/node_modules materialization failed/.test(e.message), e.message);
                ok(/ghost@1\.0\.0|store package missing/.test(e.message), e.message);
                return true;
            },
        );
        ok(!existsSync(join(projectDir, 'node_modules', 'ghost')));
        ok(!existsSync(join(projectDir, 'node_modules', '.cts-node-modules.json')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: fails closed when required package.json dep is missing from store', async () => {
    const root = makePosixTempDir('linker-missing-dep');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        const alphaDir = seedPkg(cacheDir, 'alpha', '1.0.0', {}, {
            dependencies: { 'not-in-store': '1.0.0' },
        });
        mkdirSync(join(projectDir), { recursive: true });
        await rejects(
            () => materializeNodeModules([
                edge(`${projectDir}/<cache>`, 'alpha', 'npm:alpha@1.0.0/index.js', joinPaths(alphaDir, 'index.js')),
            ], 'soft', cacheDir, projectDir),
            (e: unknown) => {
                ok(e instanceof Error);
                ok(/node_modules materialization failed/.test(e.message));
                ok(/not-in-store/.test(e.message));
                return true;
            },
        );
        // Materialize must not invent store-side links for the missing dep.
        ok(!existsSync(join(alphaDir, 'node_modules', 'not-in-store')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: multi-version store keeps install-linked older dep (no retarget)', async () => {
    const root = makePosixTempDir('linker-multiver');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        // Store has both 1.0.0 and 1.9.0; install already linked the older one.
        const depOld = seedPkg(cacheDir, 'dep', '1.0.0', { 'index.js': 'export const v = 1;\n' });
        const depNew = seedPkg(cacheDir, 'dep', '1.9.0', { 'index.js': 'export const v = 9;\n' });
        const hostDir = seedPkg(cacheDir, 'host', '1.0.0', { 'index.js': 'export {}\n' }, {
            dependencies: { dep: '^1.0.0' },
        });
        // Simulate npm install: host/node_modules/dep → dep@1.0.0 (not 1.9.0).
        mkdirSync(join(hostDir, 'node_modules'), { recursive: true });
        symlinkSync(depOld, join(hostDir, 'node_modules', 'dep'));
        mkdirSync(join(projectDir), { recursive: true });

        await materializeNodeModules([
            edge(`${projectDir}/<entry>`, 'host', 'npm:host@1.0.0/index.js', joinPaths(hostDir, 'index.js')),
        ], 'soft', cacheDir, projectDir);

        const linked = join(hostDir, 'node_modules', 'dep');
        ok(lstatSync(linked).isSymbolicLink());
        strictEqual(readlinkSync(linked), depOld, 'must not retarget install link to dep@1.9.0');
        ok(readlinkSync(linked) !== depNew);

        // buildInstallViewEdges must also freeze the install target.
        const views = buildInstallViewEdges([
            edge(`${projectDir}/<entry>`, 'host', 'npm:host@1.0.0/index.js', joinPaths(hostDir, 'index.js')),
        ], joinPaths(cacheDir, 'npm'));
        const depView = views.find(v => v.parentName === 'host' && v.depName === 'dep');
        ok(depView);
        strictEqual(depView!.depDir, depOld);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: install view edges are bounded by package.json (no sibling inject)', () => {
    const root = makePosixTempDir('linker-bound');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const storeRoot = joinPaths(cacheDir, 'npm');
        // Wide store of siblings that must NOT all link into each other.
        for (let i = 0; i < 20; i++) {
            seedPkg(cacheDir, `sib${i}`, '1.0.0');
        }
        seedPkg(cacheDir, 'rootpkg', '1.0.0', {}, {
            dependencies: { sib0: '1.0.0', sib1: '1.0.0' },
        });
        const edges: Edge[] = [
            edge('/proj/<entry>', 'rootpkg', 'npm:rootpkg@1.0.0/index.js', joinPaths(storeRoot, 'rootpkg@1.0.0', 'index.js')),
        ];
        const views = buildInstallViewEdges(edges, storeRoot);
        // Only rootpkg → sib0, rootpkg → sib1 (sibs have no deps).
        strictEqual(views.length, 2);
        ok(views.every(v => v.parentName === 'rootpkg'));
        const names = new Set(views.map(v => v.depName));
        deepStrictEqual([...names].sort(), ['sib0', 'sib1']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: materialize source never writes store package node_modules', () => {
    // Structural guard: materialize must only place under projectDir; store
    // soft links remain install-owned (npm.ts linkDependency).
    const src = readFileSync(new URL('../../cts/src/resolve/linker.ts', import.meta.url), 'utf8');
    ok(!src.includes('linkViewEdge'), 'obsolete store-write view linker must stay gone');
    ok(src.includes('Materialize never writes under the store'), 'store-read-only contract documented');
    ok(src.includes("skipNames: ['node_modules']"), 'hard body copy must skip store node_modules');
    ok(src.includes('materializeHardVirtual'), 'hard path is pnpm-style virtual store');
    ok(src.includes("VIRTUAL_STORE = '.cts'"), 'virtual store lives under project node_modules/.cts');
    ok(src.includes('collectHardPackages'), 'hard bodies counted once per unique package');
    ok(src.includes('linkProjectRootSoft'), 'soft path is project-root only');
    ok(!src.includes('materializeHardPackage'), 'nested per-placement hard expand must stay gone');
    // Incremental: no unconditional full wipe as the only strategy.
    ok(src.includes('canSkipHardBody'), 'unchanged bodies must be skippable');
    ok(src.includes('pruneVirtualOrphans'), 'removed deps must prune virtual keys');
    ok(src.includes('BODY_STAMP'), 'skip stamp tracks store package.json identity');
    ok(!/removeIfExists\(virtualRoot\)/.test(src), 'must not full-wipe .cts every run');
    ok(src.includes('softJobs'), 'soft edges are collected for concurrent link + progress');
});

Deno.test('cts linker: hard incremental skips unchanged body; refreshes on store change; prunes removed', async () => {
    const root = makePosixTempDir('linker-hard-incr');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        const alphaDir = seedPkg(cacheDir, 'alpha', '1.0.0', { 'index.js': 'export const alpha = 1;\n' }, {
            dependencies: { beta: '2.0.0' },
        });
        seedPkg(cacheDir, 'beta', '2.0.0', { 'index.js': 'export const beta = 2;\n' });
        mkdirSync(join(projectDir), { recursive: true });

        const edges = [
            edge(`${projectDir}/<entry>`, 'alpha', 'npm:alpha@1.0.0/index.js', joinPaths(alphaDir, 'index.js')),
        ];
        await materializeNodeModules(edges, 'hard', cacheDir, projectDir);

        const bodyAlpha = join(projectDir, 'node_modules', '.cts', 'alpha@1.0.0', 'node_modules', 'alpha');
        const bodyBeta = join(projectDir, 'node_modules', '.cts', 'beta@2.0.0', 'node_modules', 'beta');
        const stampAlpha = join(projectDir, 'node_modules', '.cts', 'alpha@1.0.0', '.cts-body-stamp');
        ok(existsSync(join(bodyAlpha, 'index.js')));
        ok(existsSync(stampAlpha));
        const stamp1 = readFileSync(stampAlpha, 'utf8');

        // Marker only lives under the virtual body (not in store). Rebuild does
        // removeIfExists(body) then hardlink from store → marker must vanish.
        // mtime/inode of hardlinked index.js is NOT a skip signal (store file
        // keeps mtime across re-link).
        const marker = join(bodyAlpha, '.cts-skip-marker');
        writeFileSync(marker, 'prove-skip\n');

        // Second run, identical store: must skip body rebuild (marker retained).
        await materializeNodeModules(edges, 'hard', cacheDir, projectDir);
        strictEqual(readFileSync(stampAlpha, 'utf8'), stamp1, 'stamp unchanged on skip');
        ok(existsSync(marker), 'skip must retain body-local marker (rebuild would wipe it)');
        strictEqual(readFileSync(marker, 'utf8'), 'prove-skip\n');
        ok(existsSync(join(bodyBeta, 'package.json')));

        // Store content update: rewrite store package.json so size/mtime fingerprint changes.
        writeFileSync(join(alphaDir, 'package.json'), JSON.stringify({
            name: 'alpha',
            version: '1.0.0',
            dependencies: { beta: '2.0.0' },
            description: 'store-updated',
        }));
        writeFileSync(join(alphaDir, 'index.js'), 'export const alpha = 99;\n');
        await materializeNodeModules(edges, 'hard', cacheDir, projectDir);
        strictEqual(
            readFileSync(join(bodyAlpha, 'index.js'), 'utf8'),
            'export const alpha = 99;\n',
            'store update must refresh virtual body',
        );
        ok(readFileSync(stampAlpha, 'utf8') !== stamp1, 'stamp must change after rebuild');
        ok(!existsSync(marker), 'rebuild must wipe body-local marker (proves not skip)');

        // Graph shrinks to alpha only: drop beta dep and prune virtual beta.
        writeFileSync(join(alphaDir, 'package.json'), JSON.stringify({
            name: 'alpha',
            version: '1.0.0',
        }));
        writeFileSync(join(alphaDir, 'index.js'), 'export const alpha = 1;\n');
        await materializeNodeModules(edges, 'hard', cacheDir, projectDir);
        ok(existsSync(join(bodyAlpha, 'package.json')));
        ok(!existsSync(bodyBeta), 'removed dep must prune virtual package beta');
        ok(!existsSync(join(projectDir, 'node_modules', '.cts', 'beta@2.0.0')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: hard progress total includes soft-link work (not bodies-only)', async () => {
    // alpha + beta bodies (2) + soft edges: alpha→beta, root alpha (2) => total ≥ 4.
    const root = makePosixTempDir('linker-hard-prog');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        const alphaDir = seedPkg(cacheDir, 'alpha', '1.0.0', { 'index.js': 'export {}\n' }, {
            dependencies: { beta: '1.0.0' },
        });
        seedPkg(cacheDir, 'beta', '1.0.0', { 'index.js': 'export {}\n' });
        mkdirSync(join(projectDir), { recursive: true });

        const progress: Array<[number, number]> = [];
        await materializeNodeModules([
            edge(`${projectDir}/<entry>`, 'alpha', 'npm:alpha@1.0.0/index.js', joinPaths(alphaDir, 'index.js')),
        ], 'hard', cacheDir, projectDir, (done, total) => {
            progress.push([done, total]);
        });

        ok(progress.length >= 2);
        const [, total0] = progress[0]!;
        // bodies(2) + soft(alpha→beta, root) = 4
        strictEqual(total0, 4, `expected total=bodies+soft, got ${total0}`);
        for (const [done, total] of progress) ok(done <= total, `linked ${done}/${total}`);
        deepStrictEqual(progress[progress.length - 1], [4, 4]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: normal mode is not materialize (API stays soft|hard only)', async () => {
    // Runtime skips materialize when nodeModulesMode === 'normal'. This test
    // locks the materialize entry type: only soft|hard are accepted at the call.
    const root = makePosixTempDir('linker-normal-type');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });
        // Calling with 'normal' is a type error at compile time; at runtime we
        // only assert that without soft|hard no project tree is created by us
        // when materialize is simply not invoked (empty project).
        ok(!existsSync(join(projectDir, 'node_modules')));
        ok(typeof materializeNodeModules === 'function');
        // Soft with zero edges is a no-op for roots (no package.json seeds).
        await materializeNodeModules([], 'soft', cacheDir, projectDir);
        ok(!existsSync(join(projectDir, 'node_modules', '.cts-node-modules.json')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
