import { loadTasks } from '../../cts/src/task';
import { LockStore } from '../../cts/src/lock';
import { fatal } from '../../cts/src/errors';
import { C } from '../help';

const os = import.meta.use('os');
const console = import.meta.use('console');

export async function runTask(args: string[]): Promise<void> {
    const lockStore = new LockStore(os.cwd, true);
    try {
        const result = loadTasks(os.cwd, lockStore);
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
