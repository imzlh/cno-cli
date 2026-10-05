// bin.ts — `cno exec <binary>` entry point

import { uname, LockStore, BinResolver } from '../../cts/src/api';
import { commandOptionTokensFor, type ParsedCli } from '../cli';
import { ensureNodePolyfills } from './setup';

const os = import.meta.use('os');
const console = import.meta.use('console');
const process = import.meta.use('process');
const asyncfs = import.meta.use('asyncfs');
const signals = import.meta.use('signals');

type BinaryInvocation = Pick<ParsedCli, 'kernelArgs' | 'kernelFlags' | 'flags' | 'commandOptions'>;

/** Map a native wait result to the shell exit-code convention. */
export function childExitCode(info: CModuleProcess.ExitInfo): number {
    if (info.term_signal === null) return info.exit_status;
    const signalNumber = signals?.signals[info.term_signal];
    return typeof signalNumber === 'number' ? 128 + signalNumber : 1;
}

async function chmodExecutableQuietly(path: string): Promise<void> {
    try {
        await asyncfs.chmod(path, 0o755);
    } catch {
        // Fallback execution will surface real permission errors.
    }
}

export async function spawnBinary(
    binName: string,
    args: string[],
    env: Record<string, string>,
    cwd: string,
    cacheDir?: string,
    invocation: BinaryInvocation = { kernelArgs: [], kernelFlags: {}, flags: {}, commandOptions: [] },
): Promise<number> {
    const flags = { ...invocation.kernelFlags, ...invocation.flags };
    const requestedCacheDir = cacheDir ?? (typeof flags['cache-dir'] === 'string' ? flags['cache-dir'] : undefined);
    const lockDir = typeof flags['lock-dir'] === 'string' ? flags['lock-dir'] : cwd;
    // --lock-dir controls lock persistence, not the user's working directory
    // or local .bin lookup. Resolve the executable from the invocation cwd.
    let resolved = resolveCachedBinary(binName, cwd, requestedCacheDir);
    if (!resolved) {
        const packageSpec = npmPackageSpecifier(binName, cwd, requestedCacheDir);
        if (!packageSpec) {
            console.error(`Command '${binName}' could not be resolved.`);
            return 1;
        }

        const cacheEnv = { ...os.environ(), ...env };
        const effectiveCacheDir = requestedCacheDir || cacheEnv.CTS_CACHE_DIR;
        if (effectiveCacheDir) cacheEnv.CTS_CACHE_DIR = effectiveCacheDir;
        // postinstall scripts need node: builtins from the cache polyfill tree
        await ensureNodePolyfills(effectiveCacheDir);
        const cacheArgs = [os.exePath, ...invocation.kernelArgs, 'cache'];
        if (effectiveCacheDir) cacheArgs.push(`--cache-dir=${effectiveCacheDir}`);
        cacheArgs.push(`--lock-dir=${lockDir}`);
        cacheArgs.push(...commandOptionTokensFor(invocation, 'cache'));
        cacheArgs.push(packageSpec);
        const cacheCode = await rawExec(cacheArgs, cacheEnv, os.tmpDir);
        if (cacheCode !== 0) return cacheCode;

        resolved = resolveCachedBinary(binName, cwd, requestedCacheDir);
        if (!resolved) {
            console.error(explainBinary(binName, cwd, requestedCacheDir) ?? `Command '${binName}' could not be resolved.`);
            return 1;
        }
    }

    const mergedEnv = { ...os.environ(), ...env };
    const childCacheDir = requestedCacheDir || mergedEnv.CTS_CACHE_DIR;
    if (childCacheDir) mergedEnv.CTS_CACHE_DIR = childCacheDir;

    if (resolved.fallback) {
        // Couldn't parse the wrapper script — fall back to cmd.exe / sh
        if (resolved.binPath.toLowerCase().endsWith('.cmd') || resolved.binPath.toLowerCase().endsWith('.bat') || uname.sysname.includes('Windows')) {
            return rawExec(['cmd', '/c', resolved.binPath, ...args], mergedEnv, cwd);
        }
        // Unix fallback
        await chmodExecutableQuietly(resolved.binPath);
        return rawExec([resolved.binPath, ...args], mergedEnv, cwd);
    }

    // Run the JS entry through the same CLI path as user files.
    const runArgs = [os.exePath, ...invocation.kernelArgs, 'run'];
    if (childCacheDir) runArgs.push(`--cache-dir=${childCacheDir}`);
    // Defaults come first so an explicitly supplied option retains normal CLI
    // last-one-wins behavior. Runtime options end before the resolved entry;
    // everything after the entry belongs to the npm bin.
    runArgs.push(`--lock-dir=${lockDir}`, ...commandOptionTokensFor(invocation, 'run'), resolved.entry, ...args);
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
    return childExitCode(info);
}
