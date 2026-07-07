import { deepStrictEqual, strictEqual } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { buildCacheConfig, collectSpecifiers } from '../../src/commands/cache-utils.ts';
import { joinPaths, type ConfigOptions } from '../../cts/src/api/index.ts';
import { LockStore } from '../../cts/src/lock.ts';

const decoder = new TextDecoder();

function copyNodeSource(src: string, dst: string): void {
    mkdirSync(dst, { recursive: true });
    for (const entry of Deno.readDirSync(src)) {
        const srcPath = join(src, entry.name);
        const dstPath = join(dst, entry.name);
        if (entry.isDirectory) copyNodeSource(srcPath, dstPath);
        else if (entry.isFile && entry.name.endsWith('.ts')) writeFileSync(dstPath, readFileSync(srcPath));
    }
}

function prepareLocalSetupSource(root: string): void {
    copyNodeSource(join(Deno.cwd(), 'cno', 'src', 'node'), join(root, 'cno', 'src', 'node'));
}

function seedCachedPackage(cacheDir: string, name: string, version: string, main = 'index.js'): string {
    const dir = joinPaths(cacheDir, 'npm', `${name}@${version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, main), 'module.exports = 1;\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name,
        version,
        main,
    }));
    return dir;
}

async function runCacheCommand(root: string, cacheDir: string, entries: string[] = []): Promise<{ code: number; output: string }> {
    prepareLocalSetupSource(root);
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(execPath, {
        args: [
            'cache',
            '--silent',
            '--no-oxc',
            `--cache-dir=${cacheDir}`,
            `--lock-dir=${root}`,
            ...entries,
        ],
        cwd: root,
        env: {
            ALL_PROXY: '',
            HTTPS_PROXY: '',
            HTTP_PROXY: '',
            all_proxy: '',
            https_proxy: '',
            http_proxy: '',
            NO_PROXY: '*',
            no_proxy: '*',
        },
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    return {
        code: output.code,
        output: decoder.decode(output.stdout) + decoder.decode(output.stderr),
    };
}

Deno.test('cache command: buildCacheConfig forces writable lock and applies cache flags', () => {
    const fileCfg: Partial<ConfigOptions> = {
        disableLock: true,
        persistLock: false,
        silent: false,
        enableOxc: true,
        ignoreScripts: false,
        nodeModulesMode: 'soft',
        cacheDir: '/old-cache',
        lockDir: '/old-lock',
    };

    const cfg = buildCacheConfig(fileCfg, {
        silent: true,
        'no-oxc': true,
        'ignore-scripts': true,
        'npm-mode': 'hard',
        'cache-dir': '/new-cache',
        'lock-dir': '/new-lock',
    });

    strictEqual(cfg.disableLock, false);
    strictEqual(cfg.persistLock, true);
    strictEqual(cfg.silent, true);
    strictEqual(cfg.enableOxc, false);
    strictEqual(cfg.ignoreScripts, true);
    strictEqual(cfg.nodeModulesMode, 'hard');
    strictEqual(cfg.cacheDir, '/new-cache');
    strictEqual(cfg.lockDir, '/new-lock');
});

Deno.test('cache command: invalid npm-mode flag does not clobber file config', () => {
    const cfg = buildCacheConfig({ nodeModulesMode: 'soft' }, { 'npm-mode': 'linked' });
    strictEqual(cfg.nodeModulesMode, 'soft');
    strictEqual(cfg.disableLock, false);
    strictEqual(cfg.persistLock, true);
});

Deno.test('cache command: collectSpecifiers merges deno imports and package dependency groups', () => {
    const root = makePosixTempDir('cache-specs');
    try {
        writeFileSync(join(root, 'deno.jsonc'), `{
            // comments are accepted
            "imports": {
                "std/": "https://deno.land/std@0.224.0/",
                "local": "./local.ts",
                "blank": "   ",
                "bad": { "target": "./bad.ts" }
            }
        }`);
        writeFileSync(join(root, 'package.json'), JSON.stringify({
            dependencies: {
                alpha: '^1.0.0',
                alias: 'npm:real-package@^5.0.0',
                localWorkspace: 'workspace:./packages/local',
                localFile: 'file:../local-file',
                gitDep: 'https://github.com/example/pkg.git',
                ignored: false,
            },
            devDependencies: {
                beta: '2.0.0',
            },
            optionalDependencies: {
                '@scope/gamma': '~3.1.0',
            },
            peerDependencies: {
                peer: '4.0.0',
            },
        }));

        deepStrictEqual([...collectSpecifiers(root)].sort(), [
            './local.ts',
            'https://deno.land/std@0.224.0/',
            'npm:@scope/gamma@~3.1.0',
            'npm:alpha@^1.0.0',
            'npm:beta@2.0.0',
            'npm:real-package@^5.0.0',
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cache command: entry-mode specifier collection can exclude deno import-map aliases', () => {
    const root = makePosixTempDir('cache-entry-specs');
    try {
        writeFileSync(join(root, 'deno.json'), JSON.stringify({
            imports: {
                '@std/assert': 'jsr:@std/assert@1',
            },
        }));
        writeFileSync(join(root, 'package.json'), JSON.stringify({
            devDependencies: {
                tsx: '^4.0.0',
            },
        }));

        deepStrictEqual([...collectSpecifiers(root, { denoImports: false })], [
            'npm:tsx@^4.0.0',
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'cache command: remote entry targets do not seed project package dependencies', timeout: 30000 }, async () => {
    const root = makePosixTempDir('cache-remote-entry-only');
    try {
        const cacheDir = joinPaths(root, 'cache');
        seedCachedPackage(cacheDir, 'remote-entry-fixture', '1.0.0');
        seedCachedPackage(cacheDir, 'project-only-fixture', '1.0.0');
        writeFileSync(join(root, 'package.json'), JSON.stringify({
            dependencies: {
                'project-only-fixture': '1.0.0',
            },
        }));

        const result = await runCacheCommand(root, cacheDir, ['npm:remote-entry-fixture@1.0.0']);

        strictEqual(result.code, 0, result.output);
        const lock = new LockStore(root, true);
        try {
            strictEqual(lock.getModule('npm:remote-entry-fixture@1.0.0/index.js') !== undefined, true);
            strictEqual(lock.getModule('npm:project-only-fixture@1.0.0/index.js'), undefined);
        } finally {
            lock.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'cache command: executes lifecycle scripts for cached npm packages', timeout: 30000 }, async () => {
    const root = makePosixTempDir('cache-lifecycle-run');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const pkgDir = joinPaths(cacheDir, 'npm', 'native-fixture@1.0.0');
        const marker = joinPaths(pkgDir, 'lifecycle-marker.txt');
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, 'index.js'), 'module.exports = 1;\n');
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
            name: 'native-fixture',
            version: '1.0.0',
            main: 'index.js',
            scripts: {
                install: `node -e "import.meta.use('fs').writeFile('${marker}', import.meta.use('engine').encodeString('ran'))"`,
            },
        }));
        writeFileSync(join(root, 'package.json'), JSON.stringify({
            dependencies: { 'native-fixture': '1.0.0' },
        }));
        const lock = new LockStore(root, false);
        lock.setModule({
            specPath: 'npm:native-fixture@1.0.0',
            localPath: joinPaths(pkgDir, 'index.js'),
            format: 'cjs',
            fileKind: 'source',
        });
        lock.flush();
        lock.close();

        const result = await runCacheCommand(root, cacheDir);

        strictEqual(result.code, 0, result.output);
        strictEqual(existsSync(marker), true);
        strictEqual(readFileSync(marker, 'utf8'), 'ran');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'cache command: retries missing native build outputs after lifecycle scripts', timeout: 30000 }, async () => {
    const root = makePosixTempDir('cache-lifecycle-native-output');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const pkgDir = joinPaths(cacheDir, 'npm', 'native-output-fixture@1.0.0');
        const buildDir = joinPaths(pkgDir, 'build', 'Release');
        const addon = joinPaths(buildDir, 'native_output.node');
        mkdirSync(buildDir, { recursive: true });
        writeFileSync(join(pkgDir, 'index.js'), `module.exports = require('./build/Release/native_output.node');\n`);
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
            name: 'native-output-fixture',
            version: '1.0.0',
            main: 'index.js',
            scripts: {
                install: `node -e "import.meta.use('fs').writeFile('${addon}', import.meta.use('engine').encodeString('node'))"`,
            },
        }));
        writeFileSync(join(root, 'package.json'), JSON.stringify({
            dependencies: { 'native-output-fixture': '1.0.0' },
        }));

        const result = await runCacheCommand(root, cacheDir);

        strictEqual(result.code, 0, result.output);
        strictEqual(existsSync(addon), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'cache command: fails when a lifecycle script exits non-zero', timeout: 30000 }, async () => {
    const root = makePosixTempDir('cache-lifecycle-fail');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const pkgDir = joinPaths(cacheDir, 'npm', 'native-failure@1.0.0');
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, 'index.js'), 'module.exports = 1;\n');
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
            name: 'native-failure',
            version: '1.0.0',
            main: 'index.js',
            scripts: {
                install: `node -e "import.meta.use('os').exit(7)"`,
            },
        }));
        writeFileSync(join(root, 'package.json'), JSON.stringify({
            dependencies: { 'native-failure': '1.0.0' },
        }));

        const result = await runCacheCommand(root, cacheDir);

        strictEqual(result.code, 1, result.output);
        strictEqual(/install native-failure@1\.0\.0 exited with code 7/.test(result.output), true, result.output);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'cache command: fails when dependency scanning reports errors', timeout: 30000 }, async () => {
    const root = makePosixTempDir('cache-scan-fail');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const entry = join(root, 'entry.ts');
        writeFileSync(entry, `import './missing.ts';\n`);

        const result = await runCacheCommand(root, cacheDir, [entry]);

        strictEqual(result.code, 1, result.output);
        strictEqual(/Precache failed with 1 dependency error\(s\)/.test(result.output), true, result.output);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'cache command: scans every provided entry file', timeout: 30000 }, async () => {
    const root = makePosixTempDir('cache-multi-entry');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const first = join(root, 'first.ts');
        const second = join(root, 'second.ts');
        writeFileSync(first, `export const ok = true;\n`);
        writeFileSync(second, `import './missing-from-second.ts';\n`);

        const result = await runCacheCommand(root, cacheDir, [first, second]);

        strictEqual(result.code, 1, result.output);
        strictEqual(result.output.includes('missing-from-second.ts'), true, result.output);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
