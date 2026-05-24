import { os, console } from '../../cts/src/utils';
import { loadTasks } from '../../cts/src/task';
import { fatal } from '../../cts/src/errors';
import { C } from '../help';

export async function runTask(args: string[]): Promise<void> {
    const result = loadTasks(os.cwd as string);
    if (!result) {
        fatal(new Error(
            'No deno.json with tasks found in current directory or any parent.\n' +
            'Create a deno.json with a "tasks" field.'
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
}
