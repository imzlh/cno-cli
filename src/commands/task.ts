import { loadTasks, LockStore, joinPaths, normalizePath, isAbsolute, toPosixPath, dirname } from '../../cts/src/api';
import { runTaskChild, taskShellArgv, taskShellEnv } from '../../cts/src/task';
import { CliCommandError, CliExit } from '../command-error';
import { C } from '../help';

const os = import.meta.use('os');
const console = import.meta.use('console');

function resolveFlagPath(value: string | boolean | undefined, base: string): string | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const path = toPosixPath(value);
    return isAbsolute(path) ? normalizePath(path) : normalizePath(joinPaths(base, path));
}

function taskLookup(flags: Record<string, string | boolean>): {
    invocationCwd: string;
    requestedConfigPath: string | undefined;
    runCwd: string | undefined;
    startDir: string;
} {
    const invocationCwd = os.cwd;
    const requestedConfigPath = resolveFlagPath(flags.config, invocationCwd);
    const runCwd = resolveFlagPath(flags.cwd, invocationCwd);
    const startDir = requestedConfigPath ? dirname(requestedConfigPath) : (runCwd ?? invocationCwd);
    return { invocationCwd, requestedConfigPath, runCwd, startDir };
}

export async function runTask(
    args: string[],
    flags: Record<string, string | boolean> = {},
    kernelArgs: string[] = [],
): Promise<void> {
    const { invocationCwd, requestedConfigPath, runCwd, startDir } = taskLookup(flags);
    const evalFlag = flags['eval'];
    const forwardedArgs = kernelArgs.slice();

    // specs/task/eval: `cno task --eval <shell-cmd>` runs ad-hoc shell.
    if (evalFlag !== undefined) {
        if (evalFlag === true || evalFlag === 'true' || evalFlag === '') {
            console.error('error: [TASK] must be specified when using --eval');
            console.error('');
            console.error(`Usage: ${C.cyan('cno task')} [OPTIONS] [TASK]`);
            throw new CliExit(1);
        }
        if (typeof evalFlag !== 'string') {
            console.error('error: [TASK] must be specified when using --eval');
            throw new CliExit(1);
        }
        const lockStore = new LockStore(startDir, true);
        try {
            const result = loadTasks(startDir, lockStore, {
                forwardedArgs,
                configPath: requestedConfigPath,
                runCwd,
                initCwd: invocationCwd,
            });
            if (result) {
                const code = await result.runner.runEval(evalFlag, args);
                if (code !== 0) throw new CliExit(code);
                return;
            }
            // No tasks config: still run ad-hoc shell (Deno allows task --eval without named tasks).
            let isWin = false;
            try { isWin = /win/i.test(os.uname().sysname); } catch { /* */ }
            const argv = isWin ? ['cmd.exe', '/c', evalFlag] : taskShellArgv(evalFlag, forwardedArgs);
            const cwd = runCwd ?? startDir;
            console.log(`Task  ${evalFlag}`);
            const code = await runTaskChild(
                argv,
                { ...os.environ(), ...taskShellEnv({ INIT_CWD: invocationCwd }, cwd) },
                cwd,
            );
            if (code !== 0) throw new CliExit(code);
        } finally {
            lockStore.close();
        }
        return;
    }

    const lockStore = new LockStore(startDir, true);
    try {
        const result = loadTasks(startDir, lockStore, {
            forwardedArgs,
            configPath: requestedConfigPath,
            runCwd,
            initCwd: invocationCwd,
        });
        if (!result) {
            throw new CliCommandError(new Error(
                'Cannot find tasks everywhere. Please add some in package.json or deno.json'
            ), 'cno task');
        }
        const { runner, configPath: loadedConfigPath } = result;
        if (!args.length || args[0] === '--list') {
            console.log(`${C.dim('Tasks from')} ${loadedConfigPath}`);
            runner.list();
            return;
        }
        const [name, ...rest] = args;
        if (name === undefined) return;
        // Deno-compatible task globs: `foo-*` runs every matching task once.
        const matched = runner.matchNames(name);
        if (!matched.length) {
            const code = await runner.run(name, rest);
            if (code !== 0) throw new CliExit(code);
            return;
        }
        for (const taskName of matched) {
            const code = await runner.run(taskName, rest);
            if (code !== 0) throw new CliExit(code);
        }
    } finally {
        lockStore.close();
    }
}

export function taskExists(
    name: string,
    flags: Record<string, string | boolean> = {},
    kernelArgs: string[] = [],
): boolean {
    const { invocationCwd, requestedConfigPath, runCwd, startDir } = taskLookup(flags);
    const lockStore = new LockStore(startDir, true);
    try {
        const result = loadTasks(startDir, lockStore, {
            forwardedArgs: kernelArgs.slice(),
            configPath: requestedConfigPath,
            runCwd,
            initCwd: invocationCwd,
        });
        if (!result) return false;
        return result.runner.matchNames(name).length > 0 || result.runner.has(name);
    } finally {
        lockStore.close();
    }
}

export function printTaskList(
    flags: Record<string, string | boolean> = {},
    kernelArgs: string[] = [],
): boolean {
    const { invocationCwd, requestedConfigPath, runCwd, startDir } = taskLookup(flags);
    const lockStore = new LockStore(startDir, true);
    try {
        const result = loadTasks(startDir, lockStore, {
            forwardedArgs: kernelArgs.slice(),
            configPath: requestedConfigPath,
            runCwd,
            initCwd: invocationCwd,
        });
        if (!result) return false;
        console.log(`${C.dim('Tasks from')} ${result.configPath}`);
        result.runner.list();
        return true;
    } finally {
        lockStore.close();
    }
}
