// bin.ts — `cno exec <binary>` entry point

import { uname, LockStore, BinResolver, log } from '../../cts/src/api';

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
    const lockStore = new LockStore(cwd, true);
    try {
        const resolver = new BinResolver(lockStore, { cacheDir });
        const resolved = resolver.resolve(binName, cwd, { global: true });
        if (!resolved) {
            console.error(resolver.explain(binName) ?? `Command '${binName}' could not be resolved.`);
            return 1;
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
    } finally {
        lockStore.close();
    }
}

async function rawExec(argv: string[], env: Record<string, string>, cwd: string): Promise<number> {
    const child = process.spawn(argv, {
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
        env, cwd,
    });
    const info = await child.wait();
    return info.exit_status ?? 0;
}
