/**
 * CNO-cli entry
 * 
 * @copyright iz <himzlh@163.com>
 * @license MIT
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import { isCompilerWorker, runCompilerWorker } from '../cts/src/precompile';
import { fatal } from '../cts/src/errors';
import { log } from '../cts/src/utils/log';
import { isAbsolute, joinPaths, cwd, toPosixPath } from '../cts/src/utils/path';
import { createResourceManager } from '../cts/src/runtime/resources';

const processResources = createResourceManager();

import { parseArgv, readArgv, warnUnknownFlags } from './cli';
import { showHelp, showVersion, C } from './help';
import { registerExtensions } from './bootstrap';
import { runFile } from './commands/run';
import { runEval } from './commands/eval';
import { runCache } from './commands/cache';
import { runTask, taskExists } from './commands/task';
import { runRepl } from './commands/repl';
import { runTest } from './commands/test';
import { runSetup } from './commands/setup';
import { startProxy, disableCertVerify, stopNetwork } from './network';
import type { Args } from '../cno/src/utils/args';

import '../cno/src/main';
import { errMsg } from '../cts/src/utils';

const fs = import.meta.use('fs');
const console = import.meta.use('console');
const worker = import.meta.use('worker');
const os = import.meta.use('os');

function notImplemented(name: string): never {
    console.error(`${C.warn('!')} ${C.cyan('cno ' + name)} is not implemented yet.`);
    os.exit(2);
    throw new Error('unreachable');
}

function looksLikeFileTarget(raw: string): boolean {
    const normalized = toPosixPath(raw);
    if (raw.startsWith('.') || normalized.includes('/') || isAbsolute(raw)) return true;
    if (!isAbsolute(raw) && /^[a-z][a-z0-9+\-.]*:/i.test(raw)) return true;
    if (/\.(?:mjs|cjs|js|jsx|ts|tsx|json)$/i.test(raw)) return true;

    return fs.exists(raw) || fs.exists(joinPaths(cwd(), normalized));
}

function makeRunArgs(file: string, args: string[] = []): Args {
    return {
        binary: os.args[0],
        internalArgs: [],
        action: 'run',
        actionArgs: [],
        entry: file,
        args,
    };
}

async function listTasks(): Promise<void> {
    const { loadTasks } = await import('../cts/src/task');
    const { LockStore } = await import('../cts/src/lock');
    const store = new LockStore(os.cwd, true);
    const result = loadTasks(os.cwd, store);
    store.close();
    if (!result) {
        console.log('  \x1b[2mNo tasks defined.\x1b[0m');
        return;
    }
    console.log(`${C.dim('Tasks from')} ${result.configPath}`);
    result.runner.list();
}

let cleanupLocks: (() => void) | null = null;
let cleanupLocksFast: (() => void) | null = null;
let cleanupStarted = false;

function runProcessCleanup(fast = false): void {
    if (cleanupStarted) return;
    cleanupStarted = true;
    try { (fast ? cleanupLocksFast : cleanupLocks)?.(); }
    catch (e) { log.debug('cleanup', () => `lock cleanup failed: ${e}`); }
    if (fast) return;
    try { processResources.release(); }
    catch (e) { log.debug('cleanup', () => `resource cleanup failed: ${e}`); }
}

async function installProcessCleanup(): Promise<void> {
    if (!cleanupLocks) {
        const { LockStore } = await import('../cts/src/lock');
        cleanupLocks = () => LockStore.closeAll();
        cleanupLocksFast = () => LockStore.closeAllFast();
    }
}

async function dispatch(): Promise<void> {
    const cli = warnUnknownFlags(parseArgv(readArgv()));


    // common setup
    await installProcessCleanup();
    if (cli.flags['system-proxy']) try { startProxy(); } catch (e) {
        console.warn(`${C.warn('!')} Configure proxy failed: ${errMsg(e)}`);
    }
    if (cli.flags['skip-cert-verify']) disableCertVerify();

    try { switch (cli.cmd) {
        case 'help':
            return showHelp();
        case 'version':
            return showVersion();
        case 'eval': {
            const code = cli.positional[0];
            if (!code) {
                console.error(`Usage: ${C.cyan('cno eval')} ${C.cyan('"<code>"')}`);
                os.exit(1);
            }
            return runEval({ code, flags: cli.flags });
        }
        case 'cache':
            return runCache(cli.positional[0], cli.flags);
        case 'task':
            return runTask(cli.positional);
        case 'repl':
            return runRepl(cli.flags);
        case 'test':
            return runTest(cli.positional, cli.flags);
        case 'setup':
            return runSetup(cli.flags);
        case 'fmt':
        case 'lint':
        case 'upgrade':
            return notImplemented(cli.cmd);
        case 'run':
        case null: {
            // `cno run <file>` or `cno <file>` (implicit run).
            // `cno run task <name>` runs a task (like `deno run task`).
            // `cno run` (no args) lists available tasks.
            // Bare `cno` (no subcommand, no positional) drops into the REPL, like deno.
            const [file, ...args] = cli.positional;
            if (!file) {
                if (cli.cmd === null) return runRepl(cli.flags);
                return listTasks();
            }
            if (file === 'task') return runTask(args);
            if (cli.cmd === 'run' && !looksLikeFileTarget(file) && taskExists(file)) {
                return runTask([file, ...args]);
            }
            return runFile({
                file: file, args, flags: cli.flags,
                rawArgs: cli.rawArgs,
            });
        }
        default:
            showHelp();
            os.exit(1);
    } } finally { stopNetwork(); }
}

async function workerEntry(): Promise<void> {
    if (isCompilerWorker()) return runCompilerWorker();

    // Debug Worker
    if (worker.workerData?.__cno_debug_worker) {
        await import('./inspector/worker/bootstrap');
        return;
    }

    const { startTest, getFailedTests } = await import('../cno/src/deno/index');

    // Test worker: runTest passes __cts_test in workerData.
    // Use the module-level startTest / getFailedTests exports directly —
    // Deno.__startTest is the external Deno-compat API and prints the
    // "Failed tests:" summary as a side effect. We want the main thread to
    // aggregate and print a single clean summary, so we call the raw
    // function and collect the failed list ourselves.
    const testEntry = worker.workerData?.__cts_test;
    if (testEntry) {
        const pipe = worker.pipe!;
        try {
            const file = String(testEntry);
            await runFile({ file, args: [], flags: {}, rawArgs: makeRunArgs(file) });
            const passed = await startTest(String(testEntry), true, true);
            const failedTests = getFailedTests();
            pipe.postMessage({ passed, failedTests });
        } catch (e: any) {
            pipe.postMessage({ passed: false, error: String(e?.stack ?? e), failedTests: [] });
        }
        return;
    }

    // Web Worker: new Worker(url) passes __cts_entry in workerData (see cno/src/webapi/worker.ts)
    const entry = worker.workerData?.__cts_entry;
    if (entry) {
        const file = String(entry);
        return runFile({ file, args: [], flags: {}, rawArgs: makeRunArgs(file) });
    }

    log.debug('cno', () => 'worker: unknown role, dispatching on argv');
    return dispatch();
}

// Register native .so extensions before anything tries to use them.
try { registerExtensions(); } catch (e) { fatal(e, 'registerExtensions'); }

async function mainEntry(): Promise<void> {
    try {
        await (worker.isWorker ? workerEntry() : dispatch());
    } finally {
        runProcessCleanup();
    }
}

// start main app
mainEntry().catch(e => {
    runProcessCleanup();
    fatal(e);
});
