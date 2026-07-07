import { loadTasks, LockStore, fatal, joinPaths, normalizePath, isAbsolute, toPosixPath, dirname } from '../../cts/src/api';
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

export async function runTask(args: string[], flags: Record<string, string | boolean> = {}): Promise<void> {
    const { invocationCwd, requestedConfigPath, runCwd, startDir } = taskLookup(flags);
    const lockStore = new LockStore(startDir, true);
    try {
        const result = loadTasks(startDir, lockStore, {
            forwardedArgs: forwardedInspectArgs(flags),
            configPath: requestedConfigPath,
            runCwd,
            initCwd: invocationCwd,
        });
        if (!result) {
            fatal(new Error(
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
        const code = await runner.run(name, rest);
        if (code !== 0) os.exit(code);
    } finally {
        lockStore.close();
    }
}

export function taskExists(name: string, flags: Record<string, string | boolean> = {}): boolean {
    const { invocationCwd, requestedConfigPath, runCwd, startDir } = taskLookup(flags);
    const lockStore = new LockStore(startDir, true);
    try {
        const result = loadTasks(startDir, lockStore, {
            forwardedArgs: forwardedInspectArgs(flags),
            configPath: requestedConfigPath,
            runCwd,
            initCwd: invocationCwd,
        });
        return result?.runner.has(name) ?? false;
    } finally {
        lockStore.close();
    }
}

export function printTaskList(flags: Record<string, string | boolean> = {}): boolean {
    const { invocationCwd, requestedConfigPath, runCwd, startDir } = taskLookup(flags);
    const lockStore = new LockStore(startDir, true);
    try {
        const result = loadTasks(startDir, lockStore, {
            forwardedArgs: forwardedInspectArgs(flags),
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
