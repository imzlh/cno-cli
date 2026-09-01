/**
 * Warm re-cache must resolve ranges from the flat store without registry meta.
 * Regression: ensureInstalled called resolveVersion/fetchMeta for every ^range
 * even when name@version already existed under cacheDir/npm.
 * Complete package views skip re-walk; incomplete views still repair.
 */
import { ok, strictEqual } from 'node:assert';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { createRuntime } from '../../cts/src/api/index.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';

function seedPkg(
    cacheDir: string,
    name: string,
    version: string,
    deps: Record<string, string> = {},
    extra: Record<string, unknown> = {},
): string {
    const dir = joinPaths(cacheDir, 'npm', `${name}@${version}`);
    mkdirSync(join(dir), { recursive: true });
    writeFileSync(join(dir, 'index.js'), `export const v = '${version}';\n`);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name,
        version,
        main: 'index.js',
        type: 'module',
        ...(Object.keys(deps).length ? { dependencies: deps } : {}),
        ...extra,
    }));
    return dir;
}

/** Soft link dep into parent package node_modules (store-local view). */
function linkDep(parentDir: string, depName: string, depDir: string): void {
    const target = joinPaths(parentDir, 'node_modules', depName);
    mkdirSync(join(target, '..'), { recursive: true });
    try {
        symlinkSync(depDir, target);
    } catch {
        // already linked
    }
}

function rtOpts(cacheDir: string, projectDir: string) {
    return {
        cacheDir,
        lockDir: projectDir,
        enableCache: true,
        enableNode: false,
        enableHttp: false,
        enableJsr: false,
        cachedOnly: true as const,
        silent: true,
        disableLock: true,
        ignoreScripts: true,
        nodeModulesMode: 'normal' as const,
    };
}

Deno.test('npm store hit: range resolves from flat store without meta.json', async () => {
    const root = makePosixTempDir('npm-store-hit');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });

        // Store already has the packages; no meta.json → network would fail under cached-only.
        seedPkg(cacheDir, 'dep', '1.2.3');
        seedPkg(cacheDir, 'host', '1.0.0', { dep: '^1.0.0' });
        writeFileSync(join(projectDir, 'main.ts'), `import 'npm:host@^1.0.0';\n`);
        writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
            name: 'app',
            version: '0.0.0',
            dependencies: { host: '^1.0.0' },
        }));

        const rt = createRuntime(rtOpts(cacheDir, projectDir), projectDir);

        // Must not throw ModuleNotFound / network — store hit path only.
        const result = await rt.precache(
            joinPaths(projectDir, 'main.ts'),
            joinPaths(projectDir, 'main.ts'),
        );
        ok(result.errors.length === 0, `errors: ${JSON.stringify(result.errors)}`);
        const hostHit = result.modules.some(m => m.specPath.includes('npm:host@'));
        ok(hostHit, `expected host in modules: ${result.modules.map(m => m.specPath).join(', ')}`);
        ok(existsSync(join(cacheDir, 'npm', 'host@1.0.0', 'package.json')));
        ok(existsSync(join(cacheDir, 'npm', 'dep@1.2.3', 'package.json')));
        // No registry meta should have been required/created for dep range resolve.
        ok(!existsSync(join(cacheDir, 'npm', 'dep', 'meta.json')), 'must not fetch meta for store-hit range');
        ok(!existsSync(join(cacheDir, 'npm', 'host', 'meta.json')), 'must not fetch meta for store-hit range');
        rt.cleanup();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('npm store hit: multi-version prefers matchLatest among store only', async () => {
    const root = makePosixTempDir('npm-store-multiver');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });
        seedPkg(cacheDir, 'dep', '1.0.0');
        seedPkg(cacheDir, 'dep', '1.9.0');
        seedPkg(cacheDir, 'host', '1.0.0', { dep: '^1.0.0' });
        writeFileSync(join(projectDir, 'main.ts'), `import 'npm:host@1.0.0';\n`);

        const rt = createRuntime({
            ...rtOpts(cacheDir, projectDir),
            enableNode: true,
            nodeModulesMode: 'soft',
        }, projectDir);

        await rt.precache(joinPaths(projectDir, 'main.ts'), joinPaths(projectDir, 'main.ts'));
        // Install graph links dep under host; without prior install link, store
        // match picks latest satisfying ^1.0.0 → 1.9.0.
        const hostNm = join(cacheDir, 'npm', 'host@1.0.0', 'node_modules', 'dep');
        ok(existsSync(join(hostNm, 'package.json')) || existsSync(hostNm), `expected dep link under host: ${hostNm}`);
        let verPath = hostNm;
        try {
            if (lstatSync(hostNm).isSymbolicLink()) verPath = readlinkSync(hostNm);
        } catch { /* hard or dir */ }
        const pkg = JSON.parse(readFileSync(join(verPath, 'package.json'), 'utf8'));
        strictEqual(pkg.version, '1.9.0');
        rt.cleanup();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * Multi-package store with complete local views: second precache must finish
 * quickly (complete-view skip) and without meta/tarball.
 */
Deno.test('npm warm multi-package: complete views re-resolve under 2s', async () => {
    const root = makePosixTempDir('npm-warm-multi');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });

        // Leaf packages
        const leafA = seedPkg(cacheDir, 'leaf-a', '1.0.0');
        const leafB = seedPkg(cacheDir, 'leaf-b', '1.0.0');
        const leafC = seedPkg(cacheDir, 'leaf-c', '1.0.0');
        // Mid-tier with deps
        const midX = seedPkg(cacheDir, 'mid-x', '1.0.0', { 'leaf-a': '^1.0.0', 'leaf-b': '^1.0.0' });
        const midY = seedPkg(cacheDir, 'mid-y', '1.0.0', {
            'leaf-c': '^1.0.0',
            'leaf-a': '^1.0.0',
        }, {
            peerDependencies: { 'leaf-b': '^1.0.0' },
        });
        // Roots imported by the app
        const rootP = seedPkg(cacheDir, 'root-p', '1.0.0', { 'mid-x': '^1.0.0', 'mid-y': '^1.0.0' });
        const rootQ = seedPkg(cacheDir, 'root-q', '1.0.0', { 'mid-x': '1.0.0', 'leaf-c': '^1.0.0' });

        // Pre-complete package-local views (same as a prior successful install).
        linkDep(midX, 'leaf-a', leafA);
        linkDep(midX, 'leaf-b', leafB);
        linkDep(midY, 'leaf-c', leafC);
        linkDep(midY, 'leaf-a', leafA);
        linkDep(midY, 'leaf-b', leafB);
        linkDep(rootP, 'mid-x', midX);
        linkDep(rootP, 'mid-y', midY);
        linkDep(rootQ, 'mid-x', midX);
        linkDep(rootQ, 'leaf-c', leafC);

        writeFileSync(join(projectDir, 'main.ts'), [
            `import 'npm:root-p@^1.0.0';`,
            `import 'npm:root-q@1.0.0';`,
            `import 'npm:mid-x@^1.0.0';`,
            `import 'npm:mid-y@1.0.0';`,
            `import 'npm:leaf-a@^1.0.0';`,
            `import 'npm:leaf-b@1.0.0';`,
            `import 'npm:leaf-c@^1.0.0';`,
            '',
        ].join('\n'));

        // Cold-ish first pass (still store-only): builds any missing links.
        {
            const rt1 = createRuntime(rtOpts(cacheDir, projectDir), projectDir);
            const r1 = await rt1.precache(
                joinPaths(projectDir, 'main.ts'),
                joinPaths(projectDir, 'main.ts'),
            );
            ok(r1.errors.length === 0, `first pass errors: ${JSON.stringify(r1.errors)}`);
            rt1.cleanup();
        }

        // Warm second pass — complete-view skip is the hot path.
        const t0 = performance.now();
        const rt2 = createRuntime(rtOpts(cacheDir, projectDir), projectDir);
        const r2 = await rt2.precache(
            joinPaths(projectDir, 'main.ts'),
            joinPaths(projectDir, 'main.ts'),
        );
        const elapsed = performance.now() - t0;
        ok(r2.errors.length === 0, `warm errors: ${JSON.stringify(r2.errors)}`);
        ok(elapsed < 2000, `warm multi-package precache took ${elapsed.toFixed(1)}ms (want <2000ms)`);
        // Still no registry meta for store-hit names.
        for (const n of ['root-p', 'root-q', 'mid-x', 'mid-y', 'leaf-a', 'leaf-b', 'leaf-c']) {
            ok(!existsSync(join(cacheDir, 'npm', n, 'meta.json')), `no meta for ${n}`);
        }
        // Deps remain linked under mid-x.
        ok(existsSync(join(midX, 'node_modules', 'leaf-a', 'package.json')));
        ok(existsSync(join(midX, 'node_modules', 'leaf-b', 'package.json')));
        rt2.cleanup();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * Circular package.json deps (A→B→A) used to hang forever: installOnce FLOW key
 * covered the whole dep walk, so re-entering A awaited itself. Body/prepare split
 * + preparingPackages must finish under a hard wall clock.
 */
Deno.test('npm cycle: mutual deps finish without hang', async () => {
    const root = makePosixTempDir('npm-cycle');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });

        // Incomplete views force prepare → installDependencies (cycle path).
        seedPkg(cacheDir, 'cycle-a', '1.0.0', { 'cycle-b': '1.0.0' });
        seedPkg(cacheDir, 'cycle-b', '1.0.0', { 'cycle-a': '1.0.0' });
        writeFileSync(join(projectDir, 'main.ts'), `import 'npm:cycle-a@1.0.0';\n`);

        const rt = createRuntime(rtOpts(cacheDir, projectDir), projectDir);
        let timedOut = false;
        const wall = new Promise<never>((_, reject) => {
            setTimeout(() => {
                timedOut = true;
                reject(new Error('cycle precache wall-clock timeout (8s)'));
            }, 8000);
        });
        const t0 = performance.now();
        const result = await Promise.race([
            rt.precache(joinPaths(projectDir, 'main.ts'), joinPaths(projectDir, 'main.ts')),
            wall,
        ]);
        const elapsed = performance.now() - t0;
        ok(!timedOut, 'must not hang on A↔B cycle');
        ok(result.errors.length === 0, `errors: ${JSON.stringify(result.errors)}`);
        ok(elapsed < 8000, `cycle precache took ${elapsed.toFixed(1)}ms`);
        // At least one direction of the link graph should exist after prepare.
        const aToB = join(cacheDir, 'npm', 'cycle-a@1.0.0', 'node_modules', 'cycle-b');
        const bToA = join(cacheDir, 'npm', 'cycle-b@1.0.0', 'node_modules', 'cycle-a');
        ok(
            existsSync(join(aToB, 'package.json')) || existsSync(aToB) ||
            existsSync(join(bToA, 'package.json')) || existsSync(bToA),
            `expected cycle link a→b or b→a`,
        );
        rt.cleanup();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

/** Incomplete package view must still be repaired on prepare (not skipped forever). */
Deno.test('npm warm: incomplete package view is repaired on second pass', async () => {
    const root = makePosixTempDir('npm-warm-repair');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });

        const depDir = seedPkg(cacheDir, 'need-me', '2.0.0');
        const hostDir = seedPkg(cacheDir, 'hollow', '1.0.0', { 'need-me': '^2.0.0' });
        // Deliberately incomplete: host has no node_modules/need-me yet.
        ok(!existsSync(join(hostDir, 'node_modules', 'need-me', 'package.json')));

        writeFileSync(join(projectDir, 'main.ts'), `import 'npm:hollow@1.0.0';\n`);

        const rt = createRuntime(rtOpts(cacheDir, projectDir), projectDir);
        const result = await rt.precache(
            joinPaths(projectDir, 'main.ts'),
            joinPaths(projectDir, 'main.ts'),
        );
        ok(result.errors.length === 0, `errors: ${JSON.stringify(result.errors)}`);
        // Repair: installDependencies links the missing dep from the store.
        const linked = join(hostDir, 'node_modules', 'need-me');
        ok(
            existsSync(join(linked, 'package.json')) || existsSync(linked),
            `expected need-me linked under hollow after repair: ${linked}`,
        );
        let verPath = linked;
        try {
            if (lstatSync(linked).isSymbolicLink()) verPath = readlinkSync(linked);
        } catch { /* hard */ }
        const pkg = JSON.parse(readFileSync(join(verPath, 'package.json'), 'utf8'));
        strictEqual(pkg.version, '2.0.0');
        ok(existsSync(join(depDir, 'package.json')));
        ok(!existsSync(join(cacheDir, 'npm', 'need-me', 'meta.json')), 'repair must not need meta');
        ok(!existsSync(join(cacheDir, 'npm', 'hollow', 'meta.json')), 'repair must not need meta');
        rt.cleanup();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
