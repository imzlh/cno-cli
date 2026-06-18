// bin.ts — `cno run <binary>` entry point

import { uname } from '../../cts/src/utils';
import { LockStore } from '../../cts/src/lock';
import { BinResolver } from '../../cts/src/task';

const os = import.meta.use('os');
const console = import.meta.use('console');
const process = import.meta.use('process');
const asyncfs = import.meta.use('asyncfs');

export async function spawnBinary(binName: string, args: string[], env: Record<string, string>, cwd: string): Promise<number> {
    const lockStore = new LockStore(cwd, true);
    try {
        const resolver = new BinResolver(lockStore);
        const resolved = resolver.resolve(binName, cwd);
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
        }

        // Run the JS entry through the same CLI path as user files.
        return rawExec([os.exePath, 'run', resolved.entry, ...args], mergedEnv, cwd);
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
