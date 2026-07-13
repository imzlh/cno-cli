// bin.ts — `cno exec <binary>` entry point

import { uname, LockStore, BinResolver } from '../../cts/src/api';
import { ensureNodePolyfills } from './setup';

const os = import.meta.use('os');
const console = import.meta.use('console');
const process = import.meta.use('process');
const asyncfs = import.meta.use('asyncfs');

async function chmodExecutableQuietly(path: string): Promise<void> {
    try {
        await asyncfs.chmod(path, 0o755);
    } catch {
        // Fallback execution will surface real permission errors.
    }
}

export async function spawnBinary(binName: string, args: string[], env: Record<string, string>, cwd: string, cacheDir?: string): Promise<number> {
    const forwardedArgs = args[0] === '--' ? args.slice(1) : args;
    let resolved = resolveCachedBinary(binName, cwd, cacheDir);
    if (!resolved) {
        const packageSpec = npmPackageSpecifier(binName, cwd, cacheDir);
        if (!packageSpec) {
            console.error(`Command '${binName}' could not be resolved.`);
            return 1;
        }

        const cacheEnv = { ...os.environ(), ...env };
        const effectiveCacheDir = cacheDir || cacheEnv.CTS_CACHE_DIR;
        if (effectiveCacheDir) cacheEnv.CTS_CACHE_DIR = effectiveCacheDir;
        // postinstall scripts need node: builtins from the cache polyfill tree
        await ensureNodePolyfills(effectiveCacheDir);
        const cacheArgs = [os.exePath, 'cache'];
        if (effectiveCacheDir) cacheArgs.push(`--cache-dir=${effectiveCacheDir}`);
        cacheArgs.push(`--lock-dir=${cwd}`, packageSpec);
        const cacheCode = await rawExec(cacheArgs, cacheEnv, os.tmpDir);
        if (cacheCode !== 0) return cacheCode;

        resolved = resolveCachedBinary(binName, cwd, cacheDir);
        if (!resolved) {
            console.error(explainBinary(binName, cwd, cacheDir) ?? `Command '${binName}' could not be resolved.`);
            return 1;
        }
    }

    const mergedEnv = { ...os.environ(), ...env };
    const childCacheDir = cacheDir || mergedEnv.CTS_CACHE_DIR;
    if (childCacheDir) mergedEnv.CTS_CACHE_DIR = childCacheDir;

    if (resolved.fallback) {
        // Couldn't parse the wrapper script — fall back to cmd.exe / sh
        if (resolved.binPath.toLowerCase().endsWith('.cmd') || resolved.binPath.toLowerCase().endsWith('.bat') || uname.sysname.includes('Windows')) {
            return rawExec(['cmd', '/c', resolved.binPath, ...forwardedArgs], mergedEnv, cwd);
        }
        // Unix fallback
        await chmodExecutableQuietly(resolved.binPath);
        return rawExec([resolved.binPath, ...forwardedArgs], mergedEnv, cwd);
    }

    // Run the JS entry through the same CLI path as user files.
    const runArgs = [os.exePath, 'run'];
    if (childCacheDir) runArgs.push(`--cache-dir=${childCacheDir}`);
    runArgs.push(`--lock-dir=${cwd}`, resolved.entry, ...forwardedArgs);
    return rawExec(runArgs, mergedEnv, cwd);
}

function withBinResolver<T>(cwd: string, cacheDir: string | undefined, fn: (resolver: BinResolver) => T): T {
    const lockStore = new LockStore(cwd, true);
    try {
        return fn(new BinResolver(lockStore, { cacheDir }));
    } finally {
        lockStore.close();
    }
}

function resolveCachedBinary(binName: string, cwd: string, cacheDir?: string) {
    return withBinResolver(cwd, cacheDir, resolver => resolver.resolve(binName, cwd, { global: true }));
}

function npmPackageSpecifier(binName: string, cwd: string, cacheDir?: string): string | null {
    return withBinResolver(cwd, cacheDir, resolver => resolver.npmPackageSpecifier(binName));
}

function explainBinary(binName: string, cwd: string, cacheDir?: string): string | null {
    return withBinResolver(cwd, cacheDir, resolver => resolver.explain(binName));
}

async function rawExec(argv: string[], env: Record<string, string>, cwd: string): Promise<number> {
    const child = process.spawn(argv, {
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
        env, cwd,
    });
    const info = await child.wait();
    return info.exit_status ?? 0;
}
