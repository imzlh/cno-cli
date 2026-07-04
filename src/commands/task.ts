import { loadTasks, LockStore, fatal } from '../../cts/src/api';
import { C } from '../help';

const os = import.meta.use('os');
const console = import.meta.use('console');

function forwardedInspectArgs(flags: Record<string, string | boolean>): string[] {
    for (const key of ['inspect-brk', 'inspect-wait', 'inspect'] as const) {
        const value = flags[key];
        if (value === undefined || value === false) continue;
        if (value === true || value === 'true') return [`--${key}`];
        return [`--${key}=${value}`];
    }
    return [];
}

export async function runTask(args: string[], flags: Record<string, string | boolean> = {}): Promise<void> {
    const lockStore = new LockStore(os.cwd, true);
    try {
        const result = loadTasks(os.cwd, lockStore, { forwardedArgs: forwardedInspectArgs(flags) });
        if (!result) {
            fatal(new Error(
                'Cannot find tasks everywhere. Please add some in package.json or deno.json'
            ), 'cno task');
        }
        const { runner, configPath } = result!;
        if (!args.length || args[0] === '--list') {
            console.log(`${C.dim('Tasks from')} ${configPath}`);
            runner.list();
            return;
        }
        const [name, ...rest] = args;
        const code = await runner.run(name!, rest);
        if (code !== 0) os.exit(code);
    } finally {
        lockStore.close();
    }
}

export function taskExists(name: string): boolean {
    const lockStore = new LockStore(os.cwd, true);
    try {
        const result = loadTasks(os.cwd, lockStore);
        return result?.runner.has(name) ?? false;
    } finally {
        lockStore.close();
    }
}
