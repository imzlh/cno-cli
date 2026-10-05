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

import { LockStore, cwd, errMsg, fatal, isAbsolute, isParseWorker, joinPaths, log, runParseWorker, toPosixPath } from '../cts/src/api';
import type { ConfigOptions } from '../cts/src/api';
import { EV, installEventReceiver, PRIORITY_FALLBACK } from '../cts/src/runtime/event-mux';
import { resources as processResources } from '../cts/src/runtime/resources';

import type { Args } from '../cno/src/utils/args';
import setArgs, { normalizeArgs } from '../cno/src/utils/args';
import { disableRawCertVerify } from '../cno/src/utils/http';
import { resolveObjectURLBytes } from '../cno/src/webapi/url';
import { registerExtensions } from './bootstrap';
import { CliExit, commandErrorInfo } from './command-error';
import { missingFlagValues, parseArgv, readArgv, unknownFlags, type ParsedCli } from './cli';
import { effectiveRuntimeFlags, prepareKernel, type KernelContext } from './kernel';
import { spawnBinary } from './commands/bin';
import { runCache } from './commands/cache';
import { decodeWorkerRuntimeConfig } from './config';
import { readEnv } from './env';
import { runEval } from './commands/eval';
import { runPack } from './commands/pack';
import { runRepl } from './commands/repl';
import { runFile } from './commands/run';
import { runServe } from './commands/serve';
import { runSetup } from './commands/setup';
import { printTaskList, runTask, taskExists } from './commands/task';
import { parseTestChildArgs, runTest, TEST_CHILD_ENV } from './commands/test';
import { writeTestChildResult, type TestChildMessage } from './commands/test-result-pipe';
import { C, showHelp, showVersion } from './help';
import { disableCertVerify, startProxy, stopNetwork } from './network';

import '../cno/src/main';   // main polyfill(cno) entry

Reflect.set(globalThis, '__cno_resolve_blob_url', resolveObjectURLBytes);

const fs = import.meta.use('fs');
const console = import.meta.use('console');
const worker = import.meta.use('worker');
const os = import.meta.use('os');

function looksLikeFileTarget(raw: string): boolean {
    const normalized = toPosixPath(raw);
    if (raw.startsWith('.') || normalized.includes('/') || isAbsolute(raw)) return true;
    if (!isAbsolute(raw) && /^[a-z][a-z0-9+\-.]*:/i.test(raw)) return true;
    if (/\.(?:mjs|cjs|js|jsx|ts|tsx|json)$/i.test(raw)) return true;

    return fs.exists(raw) || fs.exists(joinPaths(cwd(), normalized));
}

function makeRunArgs(
    file: string,
    args: string[] = [],
    invocation: Pick<ParsedCli, 'kernelArgs' | 'commandArgs'> = { kernelArgs: [], commandArgs: [] },
): Args {
    return normalizeArgs({
        binary: os.args[0],
        internalArgs: invocation.kernelArgs,
        action: 'run',
        actionArgs: invocation.commandArgs,
        entry: file,
        args,
    });
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
    kernel: KernelContext,
    config?: Partial<ConfigOptions>,
): Promise<void> {
    if (isEvalEntry(entry)) {
        return runEval({
            code: entry.slice(5),
            flags,
            kernel,
            rawArgs: normalizeArgs({ ...rawArgs, action: 'eval', entry: entry.slice(5) }),
            config,
        });
    }

    return runFile({
        file: entry, args, flags,
        rawArgs,
        kernel,
        config,
    });
}

function listTasks(flags: Record<string, string | boolean>, prefixArgs: string[] = []): void {
    if (!printTaskList(flags, prefixArgs)) {
        console.log('  \x1b[2mNo tasks defined.\x1b[0m');
    }
}

let cleanupStarted = false;
let requestedExitCode = 0;
const REQUEST_EXIT_CODE_SLOT = Symbol.for('cno.runtime.requestExitCode');

/** Terminal cleanup runs after user exit/unload handlers, never after entry evaluation. */
function runProcessCleanup(): void {
    if (cleanupStarted) return;
    cleanupStarted = true;
    stopNetwork();
    try { LockStore.closeAll(); }
    catch (e) { log.debug('cleanup', () => `lock cleanup failed: ${e}`); }
    processResources.release();
}

function exitWithCode(code: number): never {
    os.exit(code);
    throw new Error('unreachable');
}

function currentProcessExitCode(): number | undefined {
    try {
        const code = Reflect.get(globalThis, 'process')?.exitCode;
        return typeof code === 'number' ? code : undefined;
    } catch {
        return undefined;
    }
}

/** Native exit status does not keep the event loop alive or stop pending work. */
function syncExitCode(): void {
    const code = currentProcessExitCode() ?? (requestedExitCode || undefined);
    if (code !== undefined) os.setExitCode(code);
}

function requestExitCode(code: number): void {
    if (!Number.isInteger(code) || code === 0 || requestedExitCode !== 0) return;
    requestedExitCode = code;
    syncExitCode();
}

installEventReceiver('cli-lifecycle', (name) => {
    if (name === EV.BEFORE_EXIT) syncExitCode();
    if (name === EV.EXIT) runProcessCleanup();
    return undefined;
}, PRIORITY_FALLBACK);

function validateInvocation(cli: ParsedCli): void {
    const unknown = unknownFlags(cli);
    if (unknown.length > 0) {
        for (const name of unknown) {
            console.error(`error: unexpected argument '${name}' found`);
        }
        throw new CliExit(1);
    }

    // A value flag with no value reaches its consumer as `true` and is then
    // type-guarded away, silently ignoring what the user asked for.
    const missing = missingFlagValues(cli);
    if (missing.length > 0) {
        for (const name of missing) {
            console.error(`error: a value is required for '--${name}' but none was supplied`);
        }
        throw new CliExit(1);
    }
}

function applyNetworkFlags(flags: Record<string, string | boolean>): void {
    if (flags['system-proxy']) {
        try {
            startProxy();
        } catch (e) {
            console.warn(`${C.warn('!')} Configure proxy failed: ${errMsg(e)}`);
        }
    }
    // Fetch and raw TLS maintain separate verification state.
    if (flags['skip-cert-verify']) {
        disableCertVerify();
        disableRawCertVerify();
    }
}

async function dispatch(): Promise<void> {
    const cli = parseArgv(readArgv());

    // Help/version complete before runtime preparation or other side effects.
    if (cli.cmd === 'help' || (cli.cmd !== 'pack' && cli.flags.help === true)) return showHelp();
    if (cli.cmd === 'version' || cli.flags.version === true) return showVersion();
    if (cli.cmd === 'pack' && cli.flags.help === true) return runPack(cli.positional, cli.flags);
    validateInvocation(cli);

    // Every command shares the same Deno.args/process.argv source.
    setArgs(cli.rawArgs);
    const kernel = prepareKernel(cli);
    const flags = effectiveRuntimeFlags(kernel, cli.flags);
    applyNetworkFlags(flags);

    switch (cli.cmd) {
    case 'eval': {
        const code = cli.positional[0];
        if (code === undefined) {
            console.error(`Usage: ${C.cyan('cno eval')} ${C.cyan('"<code>"')}`);
            exitWithCode(1);
        }
        return runEval({ code, flags: cli.flags, kernel, rawArgs: cli.rawArgs });
    }
    case 'cache':
        return runCache(cli.positional, cli.flags, kernel);
    case 'pack':
        return runPack(cli.positional, cli.flags, kernel);
    case 'task':
        return runTask(cli.positional, flags, cli.kernelArgs);
    case 'exec': {
        // `rawArgs.entry` defaults to `repl` for commands without an
        // entry, so validate the actual exec positional explicitly.
        const [bin, ...args] = cli.positional;
        if (!bin) {
            console.error(`Usage: ${C.cyan('cno exec')} ${C.cyan('<command>')} [args…]`);
            exitWithCode(1);
        }
        const cacheDir = typeof flags['cache-dir'] === 'string' ? flags['cache-dir'] : undefined;
        // Only the cno prefix belongs to the child runtime. Anything after
        // `exec <bin>` is the bin's own argv and must stay untouched.
        const code = await spawnBinary(bin, args, {}, os.cwd, cacheDir, cli);
        if (code !== 0) exitWithCode(code);
        return;
    }
    case 'repl':
        return runRepl(cli.flags, kernel, cli.rawArgs);
    case 'test':
        return runTest(
            cli.positional,
            flags,
            { kernelArgs: cli.kernelArgs, commandArgs: cli.commandArgs },
            kernel.inspect !== null,
        );
    case 'setup':
        return runSetup(flags);
    case 'serve': {
        const [file, ...args] = cli.positional;
        if (!file) {
            console.error(`Usage: ${C.cyan('cno serve')} ${C.cyan('<file>')} [args…]`);
            exitWithCode(1);
        }
        return runServe(file, args, cli.flags, cli.rawArgs, kernel);
    }
    case 'run':
    case null: {
        // Bare cno opens the REPL; cno run without a target lists tasks.
        const [file, ...args] = cli.positional;
        if (!file) {
            if (cli.cmd === null) return runRepl(cli.flags, kernel, cli.rawArgs);
            return listTasks(flags, cli.kernelArgs);
        }
        if (file === 'task') return runTask(args, flags, cli.kernelArgs);
        if (cli.cmd === 'run' && !looksLikeFileTarget(file) && taskExists(file, flags, cli.kernelArgs)) {
            return runTask([file, ...args], flags, cli.kernelArgs);
        }
        return runEntry(file, args, cli.flags, cli.rawArgs, kernel);
    }
    default:
        showHelp();
        exitWithCode(1);
    }
}

// Test files use child processes because native signals are process-scoped.

/** Flatten a test failure to text; Errors JSON-serialize to `{}` in the result frame. */
function errorDetail(error: unknown): string | undefined {
    if (error === undefined || error === null) return undefined;
    if (error instanceof Error) return String(error.stack ?? `${error.name}: ${error.message}`);
    if (typeof error === 'string') return error;
    return errMsg(error);
}

async function runTestChild(
    file: string,
    cli: ParsedCli,
    scriptArgs: string[],
): Promise<void> {
    let message: TestChildMessage;
    try {
        validateInvocation(cli);
        const kernel = prepareKernel(cli);
        const flags = effectiveRuntimeFlags(kernel, cli.flags);
        applyNetworkFlags(flags);
        // Deno test modules are not "main"; import.meta.main is false under `deno test`.
        const rawArgs = makeRunArgs(file, scriptArgs, cli);
        await runFile({ file, args: scriptArgs, flags: cli.flags, rawArgs, kernel, asMain: false });
        // Use the module-level startTest / getFailedTests exports directly
        const { startTest, getFailedTests } = await import('../cno/src/deno/index');
        const passed = await startTest(file, true, true, {
            filter: typeof flags.filter === 'string' ? flags.filter : undefined,
            failFast: flags['fail-fast'] === true,
        });
        // Error does not survive the JSON result frame ({} → "[object Object]"); flatten first.
        message = {
            passed,
            failedTests: getFailedTests().map((t) => ({ name: t.name, error: errorDetail(t.error) })),
        };
    } catch (e) {
        const { error } = commandErrorInfo(e);
        message = {
            passed: false,
            error: error instanceof Error ? String(error.stack ?? error.message) : String(error),
            failedTests: [],
        };
    }
    await writeTestChildResult(message);
}

async function workerEntry(): Promise<void> {
    if (isParseWorker()) return runParseWorker();
    const workerData = isRecord(worker.workerData) ? worker.workerData : undefined;

    // Debug Worker
    if (workerData?.__cno_debug_worker) {
        await import('./inspector/worker/bootstrap');
        return;
    }

    // Web Worker: new Worker(url) passes __cts_entry in workerData (see cno/src/webapi/worker.ts)
    const entry = workerData?.__cts_entry;
    if (entry) {
        const file = String(entry);
        const isNodeWorker = isNodeWorkerData(workerData);
        if (isNodeWorker) worker.pipe?.unref();
        try {
            const kernel = prepareKernel({ kernelOptions: [], commandOptions: [] }, { inheritNodeOptions: false });
            await runEntry(file, [], {}, makeRunArgs(file), kernel, decodeWorkerRuntimeConfig(workerData?.__cts_runtime_config));
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
    const testInvocation = readEnv(TEST_CHILD_ENV);
    if (testInvocation !== null) os.unsetenv(TEST_CHILD_ENV);

    if (worker.isWorker) return workerEntry();
    if (testInvocation !== null) {
        const invocation = parseTestChildArgs(os.args.slice(2), testInvocation);
        return runTestChild(os.args[1], invocation.cli, invocation.scriptArgs);
    }
    Reflect.set(globalThis, REQUEST_EXIT_CODE_SLOT, requestExitCode);
    await dispatch();
    syncExitCode();
}

// start main app
mainEntry().catch(e => {
    if (e instanceof CliExit) exitWithCode(e.code);
    if (worker.isWorker && isWorkerCloseError(e)) return;
    const { error: cause, context } = commandErrorInfo(e);
    if (worker.isWorker && isNodeWorkerData(worker.workerData)) {
        worker.pipe?.postMessage({ __cno_node_worker_error__: nodeWorkerErrorInfo(cause) });
        return;
    }
    fatal(cause, context);
});
