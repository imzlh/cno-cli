// bin.ts — `cno exec <binary>` entry point

import { uname, LockStore, BinResolver } from '../../cts/src/api';

const os = import.meta.use('os');
const console = import.meta.use('console');
const process = import.meta.use('process');
const asyncfs = import.meta.use('asyncfs');

export async function spawnBinary(binName: string, args: string[], env: Record<string, string>, cwd: string): Promise<number> {
    const lockStore = new LockStore(cwd, true);
    try {
        const resolver = new BinResolver(lockStore);
        const resolved = resolver.resolve(binName, cwd, { global: true });
        if (!resolved) {
            console.error(`[bin] Command '${binName}' not found in bin index or node_modules/.bin`);
            return 1;
        }

        const mergedEnv = { ...os.environ(), ...env };

        if (resolved.fallback) {
            // Couldn't parse the wrapper script — fall back to cmd.exe / sh
            if (resolved.binPath.toLowerCase().endsWith('.cmd') || resolved.binPath.toLowerCase().endsWith('.bat') || uname.sysname.includes('Windows')) {
                return rawExec(['cmd', '/c', resolved.binPath, ...args], mergedEnv, cwd);
            }
            // Unix fallback
            try { await asyncfs.chmod(resolved.binPath, 0o755); } catch {}
            return rawExec([resolved.binPath, ...args], mergedEnv, cwd);
        }

        // Run the JS entry through the same CLI path as user files.
        return rawExec([os.exePath, 'run', `--lock-dir=${cwd}`, resolved.entry, ...args], mergedEnv, cwd);
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
