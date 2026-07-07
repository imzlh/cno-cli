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

import { createResourceManager, cwd, errMsg, fatal, isAbsolute, isParseWorker, joinPaths, log, runParseWorker, toPosixPath } from '../cts/src/api';
import type { ConfigOptions } from '../cts/src/api';

const processResources = createResourceManager();

import type { Args } from '../cno/src/utils/args';
import setArgs from '../cno/src/utils/args';
import { registerExtensions } from './bootstrap';
import { parseArgv, readArgv, warnUnknownFlags } from './cli';
import { spawnBinary } from './commands/bin';
import { runCache } from './commands/cache';
import { runEval } from './commands/eval';
import { runRepl } from './commands/repl';
import { runFile } from './commands/run';
import { runSetup } from './commands/setup';
import { printTaskList, runTask, taskExists } from './commands/task';
import { parseTestChildFlags, runTest, TEST_CHILD_ENV, type TestChildMessage } from './commands/test';
import { C, showHelp, showVersion } from './help';
import { disableCertVerify, startProxy, stopNetwork } from './network';

import '../cno/src/main';   // main polyfill(cno) entry

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

function isEvalEntry(entry: string): boolean {
    return entry.startsWith('eval:');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isNodeWorkerData(value: unknown): value is Record<string, unknown> {
    return isRecord(value) && '__node_workerData' in value;
}

function isWorkerCloseError(value: unknown): boolean {
    return (isRecord(value) && value.__cno_worker_close === true)
        || (value instanceof Error && value.name === 'WorkerCloseError' && value.message === 'Worker closed');
}

function workerRuntimeConfig(value: unknown): Partial<ConfigOptions> | undefined {
    if (!isRecord(value)) return undefined;
    const cfg: Partial<ConfigOptions> = {};
    if (typeof value.cacheDir === 'string') cfg.cacheDir = value.cacheDir;
    if (typeof value.lockDir === 'string') cfg.lockDir = value.lockDir;
    if (typeof value.polyfill === 'string') cfg.polyfill = value.polyfill;
    if (typeof value.baseUrl === 'string') cfg.baseUrl = value.baseUrl;
    for (const key of ['enableHttp', 'enableJsr', 'enableNode', 'enableCache', 'cachedOnly', 'enableOxc', 'frozen', 'disableLock', 'ignoreScripts'] as const) {
        if (typeof value[key] === 'boolean') cfg[key] = value[key];
    }
    if (Array.isArray(value.conditions) && value.conditions.every((item) => typeof item === 'string')) {
        cfg.conditions = value.conditions.slice();
    }
    return Object.keys(cfg).length > 0 ? cfg : undefined;
}

function nodeWorkerErrorInfo(error: unknown): { name: string; message: string; stack?: string } {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: typeof error.stack === 'string' ? error.stack : undefined,
        };
    }
    return { name: 'Error', message: String(error) };
}

async function runEntry(
    entry: string,
    args: string[],
    flags: Record<string, string | boolean>,
    rawArgs: Args,
    config?: Partial<ConfigOptions>,
): Promise<void> {
    if (isEvalEntry(entry)) {
        return runEval({ code: entry.slice(5), flags });
    }

    return runFile({
        file: entry, args, flags,
        rawArgs,
        config,
    });
}

function listTasks(flags: Record<string, string | boolean>): void {
    if (!printTaskList(flags)) {
        console.log('  \x1b[2mNo tasks defined.\x1b[0m');
    }
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
        const { LockStore } = await import('../cts/src/api');
        cleanupLocks = () => LockStore.closeAll();
        cleanupLocksFast = () => LockStore.closeAllFast();
    }
}

async function dispatch(): Promise<void> {
    const cli = warnUnknownFlags(parseArgv(readArgv()));

    // Set runtime argv for EVERY command (eval/repl/task/test/cache/…), not just
    // run — otherwise those paths fall back to the cno submodule's naive parser
    // and Deno.args / process.argv come out wrong.
    setArgs(cli.rawArgs);

    // common setup
    await installProcessCleanup();
    if (cli.flags['system-proxy']) {
        try {
            startProxy();
        } catch (e) {
            console.warn(`${C.warn('!')} Configure proxy failed: ${errMsg(e)}`);
        }
    }
    if (cli.flags['skip-cert-verify']) disableCertVerify();

    try {
        switch (cli.cmd) {
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
            return runCache(cli.positional, cli.flags);
        case 'task':
            return runTask(cli.positional, cli.flags);
        case 'exec': {
            const bin = cli.rawArgs.entry;
            const args = cli.rawArgs.args;
            if (!bin) {
                console.error(`Usage: ${C.cyan('cno exec')} ${C.cyan('<command>')} [args…]`);
                os.exit(1);
            }
            const cacheDir = typeof cli.flags['cache-dir'] === 'string' ? cli.flags['cache-dir'] : undefined;
            const code = await spawnBinary(bin, args, {}, os.cwd, cacheDir);
            if (code !== 0) os.exit(code);
            return;
        }
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
                return listTasks(cli.flags);
            }
            if (file === 'task') return runTask(args, cli.flags);
            if (cli.cmd === 'run' && !looksLikeFileTarget(file) && taskExists(file, cli.flags)) {
                return runTask([file, ...args], cli.flags);
            }
            return runEntry(file, args, cli.flags, cli.rawArgs);
        }
        default:
            showHelp();
            os.exit(1);
        }
    } finally {
        stopNetwork();
    }
}

// Hidden sentinel: `cno test` spawns a real child process per test file
// (see src/commands/test.ts) instead of a worker thread, so signal handling
// (import.meta.use('signals')) works inside test files — it's unconditionally
// null in a worker thread by native-layer design (process-wide, not per-thread).

// Runs one test file and reports its result via `send` — shared by both the
// worker-thread transport (workerEntry) and the child-process transport
// (testChildEntry) so the two only differ in how the result gets back.
async function runTestFileAndReport(file: string, flags: Record<string, string | boolean>, send: (msg: TestChildMessage) => void): Promise<void> {
    try {
        await runFile({ file, args: [], flags, rawArgs: makeRunArgs(file) });
        // Use the module-level startTest / getFailedTests exports directly —
        // Deno.__startTest is the external Deno-compat API and prints the
        // "Failed tests:" summary as a side effect. We want the parent to
        // aggregate and print a single clean summary, so we call the raw
        // function and collect the failed list ourselves.
        const { startTest, getFailedTests } = await import('../cno/src/deno/index');
        const passed = await startTest(file, true, true, {
            filter: typeof flags.filter === 'string' ? flags.filter : undefined,
            failFast: flags['fail-fast'] === true,
        });
        send({ passed, failedTests: getFailedTests() });
    } catch (e) {
        send({ passed: false, error: e instanceof Error ? String(e.stack ?? e.message) : String(e), failedTests: [] });
    }
}

async function testChildEntry(file: string, flags: Record<string, string | boolean>): Promise<void> {
    const { IPCChannel } = await import('../cno/src/node/ipc_channel/mod');
    const streams = import.meta.use('streams');
    // fd 3 is where the native `process` module always hands a spawned child
    // its IPC endpoint when ipc:true (see child_process/mod.ts's own use of
    // this same convention).
    const pipe = new streams.Pipe();
    pipe.open(3);
    const channel = new IPCChannel(pipe);
    try {
        await runTestFileAndReport(file, flags, (msg) => channel.send(msg));
    } finally {
        channel.close();
    }
}

async function workerEntry(): Promise<void> {
    if (isParseWorker()) return runParseWorker();
    const workerData = isRecord(worker.workerData) ? worker.workerData : undefined;

    // Debug Worker
    if (workerData?.__cno_debug_worker) {
        await import('./inspector/worker/bootstrap');
        return;
    }

    // Test worker: runTest passes __cts_test in workerData (see runTestFileAndReport).
    const testEntry = workerData?.__cts_test;
    if (testEntry) {
        const pipe = worker.pipe;
        if (!pipe) throw new Error('test worker pipe was not created');
        await runTestFileAndReport(String(testEntry), {}, (msg) => pipe.postMessage(msg));
        return;
    }

    // Web Worker: new Worker(url) passes __cts_entry in workerData (see cno/src/webapi/worker.ts)
    const entry = workerData?.__cts_entry;
    if (entry) {
        const file = String(entry);
        const isNodeWorker = isNodeWorkerData(workerData);
        if (isNodeWorker) worker.pipe?.unref();
        try {
            await runEntry(file, [], {}, makeRunArgs(file), workerRuntimeConfig(workerData?.__cts_runtime_config));
        } catch (e) {
            if (!isWorkerCloseError(e)) throw e;
        }
        return;
    }

    log.debug('cno', () => 'worker: unknown role, dispatching on argv');
    return dispatch();
}

// Register native .so extensions before anything tries to use them.
try {
    registerExtensions();
} catch (e) {
    fatal(e, 'registerExtensions');
}

async function mainEntry(): Promise<void> {
    try {
        let isTestChild = false;
        try { isTestChild = !!os.getenv(TEST_CHILD_ENV); } catch { /* not set */ }
        if (isTestChild) os.unsetenv(TEST_CHILD_ENV); // must not leak to grandchildren

        if (worker.isWorker) await workerEntry();
        else if (isTestChild) await testChildEntry(os.args[1], parseTestChildFlags(os.args.slice(2)));
        else {
            await dispatch();
            let code: unknown;
            try {
                const proc = Reflect.get(globalThis, 'process');
                code = isRecord(proc) ? Reflect.get(proc, 'exitCode') : undefined;
            } catch {
                code = undefined;
            }
            if (typeof code === 'number' && code !== 0) os.exit(code);
        }
    } finally {
        runProcessCleanup();
    }
}

// start main app
mainEntry().catch(e => {
    runProcessCleanup();
    if (worker.isWorker && isWorkerCloseError(e)) return;
    if (worker.isWorker && isNodeWorkerData(worker.workerData)) {
        worker.pipe?.postMessage({ __cno_node_worker_error__: nodeWorkerErrorInfo(e) });
        return;
    }
    fatal(e);
});
