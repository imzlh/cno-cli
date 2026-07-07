import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { createConfig } from '../../cts/src/config.ts';
import { ErrorKind } from '../../cts/src/errors.ts';
import { LockStore } from '../../cts/src/lock.ts';
import { ModuleResolver } from '../../cts/src/resolve/index.ts';
import { TypeScriptRuntime } from '../../cts/src/runtime/index.ts';
import { BinResolver } from '../../cts/src/task.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';

Deno.test('cts lock: flush opens a fresh writable DB and persists pending entries', () => {
    const root = makePosixTempDir('lock-persist');
    try {
        const store = new LockStore(root, false);
        store.setModule({
            specPath: 'npm:pkg@1.0.0/mod.ts',
            localPath: joinPaths(root, 'cache', 'pkg', 'mod.ts'),
            format: 'esm',
            fileKind: 'source',
        });
        store.setSource('pkg', '/project/main.ts', 'npm:pkg@1.0.0/mod.ts');
        store.setSourceByKey('custom\0key', 'npm:custom@1.0.0/index.ts');
        store.addBin('pkg-cli', joinPaths(root, 'cache', 'pkg', 'cli.js'), 'pkg@1.0.0');
        strictEqual(store.dirtyCount, 4);
        store.flush();
        strictEqual(store.dirtyCount, 0);
        store.close();

        strictEqual(LockStore.existsAt(root), true);
        const read = new LockStore(root, true);
        try {
            deepStrictEqual(read.getModule('npm:pkg@1.0.0/mod.ts'), {
                specPath: 'npm:pkg@1.0.0/mod.ts',
                localPath: joinPaths(root, 'cache', 'pkg', 'mod.ts'),
                format: 'esm',
                fileKind: 'source',
            });
            strictEqual(read.getSource('pkg', '/project/main.ts'), 'npm:pkg@1.0.0/mod.ts');
            strictEqual(read.getSourceByKey('custom\0key'), 'npm:custom@1.0.0/index.ts');
            deepStrictEqual(read.getBin('pkg-cli'), {
                path: joinPaths(root, 'cache', 'pkg', 'cli.js'),
                pkg: 'pkg@1.0.0',
            });
            strictEqual(read.size, 1);
        } finally {
            read.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts lock: close persists pending entries before the DB is opened', () => {
    const root = makePosixTempDir('lock-close-persist');
    try {
        const store = new LockStore(root, false);
        store.setModule({
            specPath: 'npm:close@1.0.0/mod.ts',
            localPath: joinPaths(root, 'cache', 'close', 'mod.ts'),
            format: 'esm',
            fileKind: 'source',
        });
        strictEqual(store.dirtyCount, 1);
        store.close();

        const read = new LockStore(root, true);
        try {
            deepStrictEqual(read.getModule('npm:close@1.0.0/mod.ts'), {
                specPath: 'npm:close@1.0.0/mod.ts',
                localPath: joinPaths(root, 'cache', 'close', 'mod.ts'),
                format: 'esm',
                fileKind: 'source',
            });
        } finally {
            read.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts lock: removeBinsForPackage hides pending and persisted bins', () => {
    const root = makePosixTempDir('lock-remove-bins');
    try {
        const store = new LockStore(root, false);
        store.addBin('a', '/tmp/a.js', 'pkg');
        store.addBin('b', '/tmp/b.js', 'pkg');
        store.addBin('c', '/tmp/c.js', 'other');
        store.flush();
        store.removeBinsForPackage('pkg');
        strictEqual(store.getBin('a'), undefined);
        strictEqual(store.getBin('b'), undefined);
        deepStrictEqual(store.getBin('c'), { path: '/tmp/c.js', pkg: 'other' });
        store.close();

        const read = new LockStore(root, true);
        try {
            strictEqual(read.getBin('a'), undefined);
            strictEqual(read.getBin('b'), undefined);
            deepStrictEqual(read.getBin('c'), { path: '/tmp/c.js', pkg: 'other' });
        } finally {
            read.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts lock: findModuleSpecsByPrefix merges pending and persisted specs', () => {
    const root = makePosixTempDir('lock-prefix');
    try {
        const store = new LockStore(root, false);
        store.setModule({ specPath: 'npm:a@1.0.0/index.ts', localPath: '/a.ts', format: 'esm', fileKind: 'source' });
        store.flush();
        store.setModule({ specPath: 'npm:a@1.0.0/sub.ts', localPath: '/sub.ts', format: 'esm', fileKind: 'source' });
        store.setModule({ specPath: 'npm:b@1.0.0/index.ts', localPath: '/b.ts', format: 'esm', fileKind: 'source' });

        deepStrictEqual(store.findModuleSpecsByPrefix('npm:a@1.0.0/').sort(), [
            'npm:a@1.0.0/index.ts',
            'npm:a@1.0.0/sub.ts',
        ]);
        store.closeFast();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts runtime lock: discovers project lock read-only and --no-lock skips it', () => {
    const root = makePosixTempDir('lock-runtime-target');
    try {
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'lock-runtime-target' }));
        const store = new LockStore(root, false);
        store.setModule({ specPath: 'npm:a@1.0.0/index.ts', localPath: '/a.ts', format: 'esm', fileKind: 'source' });
        store.flush();
        store.close();

        const cfg = createConfig({
            cacheDir: joinPaths(root, 'cache'),
            enableOxc: false,
            silent: true,
        });
        const runtime = new TypeScriptRuntime(cfg, joinPaths(root, 'src'));
        try {
            strictEqual(runtime.resolver.lockPath, joinPaths(root, 'cts.lock'));
            strictEqual(runtime.resolver.lockStore.writable, false);
            ok(runtime.resolver.lockStore.getModule('npm:a@1.0.0/index.ts'));
        } finally {
            LockStore.closeAllFast();
        }

        const noLock = new TypeScriptRuntime(createConfig({
            cacheDir: joinPaths(root, 'cache'),
            disableLock: true,
            enableOxc: false,
            silent: true,
        }), joinPaths(root, 'src'));
        try {
            ok(noLock.resolver.lockPath !== joinPaths(root, 'cts.lock'));
            strictEqual(noLock.resolver.lockStore.getModule('npm:a@1.0.0/index.ts'), undefined);
        } finally {
            LockStore.closeAllFast();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver lock: frozen rejects modules missing from the lock', () => {
    const root = makePosixTempDir('lock-frozen');
    try {
        writeFileSync(join(root, 'main.ts'), 'import "./dep.ts";\n');
        writeFileSync(join(root, 'dep.ts'), 'export const value = 1;\n');
        const resolver = new ModuleResolver(createConfig({
            cacheDir: joinPaths(root, 'cache'),
            frozen: true,
            enableOxc: false,
            silent: true,
        }), root, true);

        throws(
            () => resolver.resolve('./dep.ts', joinPaths(root, 'main.ts')),
            (error: unknown) => {
                strictEqual((error as { kind?: unknown }).kind, ErrorKind.LockFrozen);
                ok(String((error as Error).message).includes('Module not in lock'));
                return true;
            },
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts bin resolver: prefers local node_modules bin over lock index', () => {
    const root = makePosixTempDir('bin-local-first');
    try {
        const localBin = joinPaths(root, 'node_modules', '.bin', 'tool');
        const localEntry = joinPaths(root, 'node_modules', 'tool', 'bin', 'tool.js');
        const lockedEntry = joinPaths(root, 'cache', 'locked.js');
        mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
        mkdirSync(join(root, 'node_modules', 'tool', 'bin'), { recursive: true });
        mkdirSync(join(root, 'cache'), { recursive: true });
        writeFileSync(localEntry, 'console.log("local");\n');
        writeFileSync(localBin, [
            '#!/bin/sh',
            'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
            'exec "$basedir/../tool/bin/tool.js" "$@"',
            '',
        ].join('\n'));
        writeFileSync(lockedEntry, 'console.log("locked");\n');

        const lock = new LockStore(root, false);
        try {
            lock.addBin('tool', lockedEntry, 'locked');
            lock.flush();
            const resolved = new BinResolver(lock).resolve('tool', root);
            ok(resolved);
            strictEqual(resolved!.entry, localEntry);
            strictEqual(resolved!.fallback, false);
            strictEqual(resolved!.reason, 'unix-shim-entry');
        } finally {
            lock.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts bin resolver: rejects path-like names and resolves direct JS lock bins', () => {
    const root = makePosixTempDir('bin-lock-direct');
    try {
        const entry = joinPaths(root, 'cache', 'cli.mjs');
        mkdirSync(join(root, 'cache'), { recursive: true });
        writeFileSync(entry, 'console.log("cli");\n');
        const lock = new LockStore(root, false);
        try {
            lock.addBin('cli', entry, 'pkg');
            lock.flush();
            const resolver = new BinResolver(lock);
            strictEqual(resolver.resolve('./cli', root), null);
            strictEqual(resolver.resolve('pkg/cli', root), null);
            strictEqual(resolver.resolve('--flag', root), null);
            deepStrictEqual(resolver.resolve('cli', root), {
                entry,
                binPath: entry,
                fallback: false,
                reason: 'direct-js',
            });
        } finally {
            lock.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts bin resolver: resolves npm specifier bins from an explicit cache dir', () => {
    const root = makePosixTempDir('bin-npm-spec-cache');
    const cacheDir = joinPaths(root, 'cache');
    try {
        const binDir = joinPaths(cacheDir, 'npm', '@denotest', 'bin@1.0.0');
        const singleDir = joinPaths(cacheDir, 'npm', '@denotest', 'single-bin@1.0.0');
        const specialDir = joinPaths(cacheDir, 'npm', '@denotest', 'special-chars-in-bin-name@1.0.0');
        const noBinDir = joinPaths(cacheDir, 'npm', '@denotest', 'esm-basic@1.0.0');
        mkdirSync(join(binDir), { recursive: true });
        mkdirSync(join(singleDir), { recursive: true });
        mkdirSync(join(specialDir), { recursive: true });
        mkdirSync(join(noBinDir), { recursive: true });
        writeFileSync(join(binDir, 'package.json'), JSON.stringify({
            name: '@denotest/bin',
            version: '1.0.0',
            bin: {
                'cli-esm': './cli.mjs',
                'cli-no-ext': './cli-no-ext',
                'cli-cjs': './cli-cjs.js',
            },
        }));
        writeFileSync(join(binDir, 'cli.mjs'), 'console.log("esm");\n');
        writeFileSync(join(binDir, 'cli-cjs.js'), 'console.log("cjs");\n');
        writeFileSync(join(binDir, 'cli-no-ext'), 'console.log("no-ext");\n');
        writeFileSync(join(singleDir, 'package.json'), JSON.stringify({
            name: '@denotest/single-bin',
            version: '1.0.0',
            bin: './main.mjs',
        }));
        writeFileSync(join(singleDir, 'main.mjs'), 'console.log("single");\n');
        writeFileSync(join(specialDir, 'package.json'), JSON.stringify({
            name: '@denotest/special-chars-in-bin-name',
            version: '1.0.0',
            type: 'module',
            bin: { '\\foo"': './main.mjs' },
        }));
        writeFileSync(join(specialDir, 'main.mjs'), 'console.log("special");\n');
        writeFileSync(join(noBinDir, 'package.json'), JSON.stringify({
            name: '@denotest/esm-basic',
            version: '1.0.0',
            type: 'module',
            main: './main.mjs',
        }));
        writeFileSync(join(noBinDir, 'main.mjs'), 'console.log("main");\n');

        const lock = new LockStore(root, true);
        try {
            const resolver = new BinResolver(lock, { cacheDir });
            strictEqual(resolver.resolve('npm:@denotest/bin@1.0.0/cli-cjs', root)?.entry, joinPaths(binDir, 'cli-cjs.js'));
            strictEqual(resolver.resolve('npm:@denotest/bin@1.0.0/cli-esm', root)?.entry, joinPaths(binDir, 'cli.mjs'));
            strictEqual(resolver.resolve('npm:@denotest/bin@1.0.0/cli-no-ext', root)?.entry, joinPaths(binDir, 'cli-no-ext'));
            strictEqual(resolver.resolve('npm:@denotest/single-bin@1.0.0', root)?.entry, joinPaths(singleDir, 'main.mjs'));
            strictEqual(resolver.resolve('npm:@denotest/special-chars-in-bin-name@1.0.0/\\foo"', root)?.entry, joinPaths(specialDir, 'main.mjs'));
            strictEqual(resolver.resolve('npm:@denotest/esm-basic@1.0.0', root), null);
            strictEqual(resolver.resolve('npm:@denotest/bin@1.0.0/missing', root), null);
        } finally {
            lock.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
