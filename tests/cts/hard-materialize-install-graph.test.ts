/**
 * hard/soft materialize must not fail when required package.json deps are
 * missing from the store after import-scan — ensureInstallGraph fills them.
 */
import { ok, rejects, strictEqual } from 'node:assert';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { createRuntime } from '../../cts/src/api/index.ts';
import { materializeNodeModules } from '../../cts/src/resolve/linker.ts';
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

function edge(parentSpecPath: string, name: string, childSpecPath: string, childLocalPath: string) {
    return { parentSpecPath, name, childSpecPath, childLocalPath };
}

/**
 * errno-style: host is a package.json cache seed (cno cache path); required dep
 * prr is in the store but never linked. ensureInstallGraph + hard materialize
 * must place project root + package view links.
 */
Deno.test('hard materialize: ensureInstallGraph links missing required dep then materializes', async () => {
    const root = makePosixTempDir('hard-mat-ensure');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });

        // prr present in store but never imported / not linked under errno.
        const prrDir = seedPkg(cacheDir, 'prr', '1.0.1');
        const errnoDir = seedPkg(cacheDir, 'errno', '0.1.8', { prr: '~1.0.1' });
        ok(!existsSync(join(errnoDir, 'node_modules', 'prr')));

        // Mirror `cno cache` with package.json deps (parent ends with /<cache>).
        writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
            name: 'app',
            version: '0.0.0',
            dependencies: { errno: '0.1.8' },
        }));

        const rt = createRuntime({
            cacheDir,
            lockDir: projectDir,
            enableCache: true,
            enableNode: false,
            enableHttp: false,
            enableJsr: false,
            cachedOnly: true,
            silent: true,
            disableLock: true,
            ignoreScripts: true,
            nodeModulesMode: 'hard',
        }, projectDir);

        // Same entry path as runCacheNoArgs: scanFromSpecifiers via precacheFromSpecifiers.
        const result = await rt.precacheFromSpecifiers(['npm:errno@0.1.8'], projectDir);
        ok(result.errors.length === 0, `precache errors: ${JSON.stringify(result.errors)}`);

        ok(existsSync(join(prrDir, 'package.json')));
        const linked = join(errnoDir, 'node_modules', 'prr');
        ok(existsSync(join(linked, 'package.json')) || existsSync(linked), `expected prr under errno: ${linked}`);
        // Project root from <cache> seed edge.
        ok(existsSync(join(projectDir, 'node_modules', 'errno', 'package.json'))
            || existsSync(join(projectDir, 'node_modules', 'errno')));
        rt.cleanup();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

/** Optional dep missing from store must not fail hard materialize. */
Deno.test('hard materialize: optional missing dep is skipped', async () => {
    const root = makePosixTempDir('hard-mat-opt');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });

        const hostDir = seedPkg(cacheDir, 'opt-host', '1.0.0', {}, {
            optionalDependencies: { 'never-fetched-opt': '^1.0.0' },
        });
        writeFileSync(join(projectDir, 'main.ts'), `import 'npm:opt-host@1.0.0';\n`);

        const rt = createRuntime({
            cacheDir,
            lockDir: projectDir,
            enableCache: true,
            enableNode: false,
            enableHttp: false,
            enableJsr: false,
            cachedOnly: true,
            silent: true,
            disableLock: true,
            ignoreScripts: true,
            nodeModulesMode: 'hard',
        }, projectDir);

        const handlers = Reflect.get(rt.resolver, 'handlers') as Map<string, {
            isPackageViewComplete(dir: string): boolean;
        }>;
        const npm = handlers.get('npm');
        ok(npm, 'runtime must register the npm handler');
        strictEqual(
            npm.isPackageViewComplete(hostDir),
            true,
            'a missing optional dependency must not invalidate an otherwise complete package view',
        );

        const result = await rt.precache(
            joinPaths(projectDir, 'main.ts'),
            joinPaths(projectDir, 'main.ts'),
        );
        ok(result.errors.length === 0, `errors: ${JSON.stringify(result.errors)}`);
        ok(existsSync(join(hostDir, 'package.json')));
        ok(!existsSync(join(cacheDir, 'npm', 'never-fetched-opt@1.0.0', 'package.json')));
        rt.cleanup();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * Required dep absent from store and unobtainable (cachedOnly): ensure soft-
 * continues, materialize still fail-closes (no success manifest).
 */
Deno.test('hard materialize: required dep absent and unobtainable still fails closed', async () => {
    const root = makePosixTempDir('hard-mat-fail');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });

        const hostDir = seedPkg(cacheDir, 'hollow-host', '1.0.0', { 'ghost-dep': '1.0.0' });

        const rt = createRuntime({
            cacheDir,
            lockDir: projectDir,
            enableCache: true,
            enableNode: false,
            enableHttp: false,
            enableJsr: false,
            cachedOnly: true,
            silent: true,
            disableLock: true,
            ignoreScripts: true,
            nodeModulesMode: 'hard',
        }, projectDir);

        // ensureInstallGraph: soft on ghost-dep miss (cachedOnly cannot fetch).
        await rt.resolver.ensureInstallGraph([{ name: 'hollow-host', version: '1.0.0' }]);
        ok(!existsSync(join(cacheDir, 'npm', 'ghost-dep@1.0.0', 'package.json')));

        await rejects(
            () => materializeNodeModules([
                edge(`${projectDir}/<entry>`, 'hollow-host', 'npm:hollow-host@1.0.0/index.js', joinPaths(hostDir, 'index.js')),
            ], 'hard', cacheDir, projectDir),
            (e: unknown) => {
                ok(e instanceof Error);
                ok(/materialization failed|ghost-dep|store package missing/i.test(e.message), e.message);
                return true;
            },
        );
        ok(!existsSync(join(projectDir, 'node_modules', '.cts-node-modules.json')),
            'must not write success manifest after fail-closed materialize');
        rt.cleanup();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * Multi-level install graph: scan only imports root; mid-tier required dep
 * must be linked via ensureInstallGraph before hard materialize.
 */
Deno.test('hard materialize: multi-level package.json deps filled from store', async () => {
    const root = makePosixTempDir('hard-mat-multi');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });

        const leaf = seedPkg(cacheDir, 'leaf-prr', '1.0.0');
        const mid = seedPkg(cacheDir, 'mid-errno', '1.0.0', { 'leaf-prr': '^1.0.0' });
        const top = seedPkg(cacheDir, 'top-app', '1.0.0', { 'mid-errno': '1.0.0' });
        // Only top is imported; mid→leaf never scanned.
        writeFileSync(join(projectDir, 'main.ts'), `import 'npm:top-app@1.0.0';\n`);

        const rt = createRuntime({
            cacheDir,
            lockDir: projectDir,
            enableCache: true,
            enableNode: false,
            enableHttp: false,
            enableJsr: false,
            cachedOnly: true,
            silent: true,
            disableLock: true,
            ignoreScripts: true,
            nodeModulesMode: 'hard',
        }, projectDir);

        const result = await rt.precache(
            joinPaths(projectDir, 'main.ts'),
            joinPaths(projectDir, 'main.ts'),
        );
        ok(result.errors.length === 0, `errors: ${JSON.stringify(result.errors)}`);
        ok(existsSync(join(mid, 'node_modules', 'leaf-prr', 'package.json'))
            || existsSync(join(mid, 'node_modules', 'leaf-prr')));
        ok(existsSync(join(top, 'node_modules', 'mid-errno', 'package.json'))
            || existsSync(join(top, 'node_modules', 'mid-errno')));
        // leaf remains a real store package
        ok(existsSync(join(leaf, 'package.json')));
        let linkedPath = join(mid, 'node_modules', 'leaf-prr');
        try {
            if (lstatSync(linkedPath).isSymbolicLink()) linkedPath = readlinkSync(linkedPath);
        } catch { /* hard copy */ }
        const pkg = JSON.parse(readFileSync(join(linkedPath, 'package.json'), 'utf8'));
        strictEqual(pkg.name, 'leaf-prr');
        rt.cleanup();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
