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
import { disableRawCertVerify } from '../cno/src/utils/http';
import { resolveObjectURLBytes } from '../cno/src/webapi/url';
import { registerExtensions } from './bootstrap';
import { CliExit, commandErrorInfo } from './command-error';
import { missingFlagValues, parseArgv, readArgv, unknownFlags } from './cli';
import { spawnBinary } from './commands/bin';
import { runCache } from './commands/cache';
import { decodeWorkerRuntimeConfig } from './commands/config-flags';
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

/** Flags whose values runFile reads back out of `actionArgs` (Deno-style run options). */
const ACTION_TOKEN_FLAGS = ['env', 'env-file', 'preload'] as const;
/** Flags whose values runFile reads back out of `internalArgs` (node-style preloads). */
const INTERNAL_TOKEN_FLAGS = ['require', 'import', 'loader', 'conditions', 'max-old-space-size'] as const;

function flagName(token: string): string | undefined {
    if (token === '-C') return 'conditions';
    if (!token.startsWith('--')) return undefined;
    const equals = token.indexOf('=');
    return token.slice(2, equals < 0 ? undefined : equals);
}

function selectFlagTokens(tokens: string[], names: readonly string[]): string[] {
    const selected = new Set<string>(names);
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === undefined) continue;
        const name = flagName(token);
        if (name === undefined || !selected.has(name)) continue;
        out.push(token);
        if (!token.includes('=')) {
            const value = tokens[i + 1];
            if (value !== undefined) {
                out.push(value);
                i++;
            }
        }
    }
    return out;
}

function makeRunArgs(
    file: string,
    args: string[] = [],
    flags: Record<string, string | boolean> = {},
    flagArgs?: string[],
): Args {
    const rawTokens = flagArgs ?? Object.entries(flags).flatMap(([name, value]) => {
        if (value === true) return [`--${name}`];
        return typeof value === 'string' ? [`--${name}=${value}`] : [];
    });
    return {
        binary: os.args[0],
        internalArgs: selectFlagTokens(rawTokens, INTERNAL_TOKEN_FLAGS),
        action: 'run',
        actionArgs: selectFlagTokens(rawTokens, ACTION_TOKEN_FLAGS),
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

/** os.exit() never unwinds JS, so the finally-based cleanup must run first. */
function exitAfterCleanup(code: number): never {
    stopNetwork();
    runProcessCleanup();
    os.exit(code);
    throw new Error('unreachable');
}

/* ------------------------------------------------------------------ *
 * Natural-exit status
 * ------------------------------------------------------------------ */

/**
 * First nonzero code requested by the runtime itself (not by user code).
 *
 * Fed by REQUEST_EXIT_CODE_SLOT below, whose only caller today is the cts
 * diagnostics receiver reporting an unhandled job exception / promise rejection
 * with no handler installed. Kept separate from `process.exitCode` so the two
 * can be composed with different precedence rules — see resolveExitCode().
 */
let requestedExitCode = 0;

/** Read `process.exitCode` defensively; anything exotic reads as undefined. */
function currentProcessExitCode(): number | undefined {
    try {
        const proc = Reflect.get(globalThis, 'process');
        if (!isRecord(proc)) return undefined;
        const code = Reflect.get(proc, 'exitCode');
        return typeof code === 'number' ? code : undefined;
    } catch {
        return undefined;
    }
}

/** Explicit process.exitCode wins; otherwise use the first runtime request. */
function resolveExitCode(): number {
    const explicit = currentProcessExitCode();
    if (typeof explicit === 'number') return explicit;
    return requestedExitCode;
}

/**
 * Is a teardown dispatch ('beforeExit' or 'exit') currently running?
 *
 * Published by cno/src/node/process/mod.ts on a `Symbol.for()` slot; see the
 * comment there for why arming the poll inside that window spins forever.
 */
const IN_TEARDOWN_SLOT = Symbol.for('cno.runtime.inTeardown');

function inTeardown(): boolean {
    try {
        return (globalThis as unknown as Record<symbol, unknown>)[IN_TEARDOWN_SLOT] === true;
    } catch {
        return false;
    }
}

/**
 * Hand a nonzero status to the runtime and report whether it stuck.
 *
 * `os.setExitCode()` writes the field TJS_Run resolves its return value from, so
 * once this succeeds the status no longer depends on calling `os.exit()` — which
 * matters because that call is immediate and skips the natural-drain teardown
 * (both 'beforeExit' and 'beforeunload'). Returns false on a core that predates
 * the binding, where the forced exit remains the only way the status is carried.
 *
 * `requestedExitCode` reaches the runtime only here: unlike `process.exitCode` it
 * is not an assignment the process object's setter can intercept.
 */
function pushRuntimeExitCode(code: number): boolean {
    const setExitCode = (os as unknown as Record<string, unknown>).setExitCode;
    if (typeof setExitCode !== 'function') return false;
    try {
        (setExitCode as (v?: number) => void)(code);
        return true;
    } catch {
        return false;
    }
}

/**
 * Ask for a nonzero status without stopping the loop. First nonzero wins, and an
 * already-set `process.exitCode` is never clobbered.
 */
function requestExitCode(code: number): void {
    if (!Number.isInteger(code) || code === 0) return;
    if (requestedExitCode !== 0) return;             // first nonzero wins
    const explicit = currentProcessExitCode();
    if (typeof explicit === 'number' && explicit !== 0) return;  // don't clobber
    requestedExitCode = code;
    armExitWhenIdle();
}

/**
 * Slot the cts runtime reaches for to report "this run failed" without killing
 * the loop.
 *
 * A Symbol slot rather than an import because the dependency runs the wrong way:
 * cts is a library that must not import the CLI entry, and only the CLI entry
 * owns the exit machinery. Absent slot = no-op, which is what a worker, a test
 * child, and cts-as-a-library all want.
 */
const REQUEST_EXIT_CODE_SLOT = Symbol.for('cno.runtime.requestExitCode');

let idleExitArmed = false;

/** Consecutive zero handle counts required before treating the loop as idle. */
const IDLE_CONFIRMATIONS = 3;

/** Apply the latest nonzero exit status after timers and IO drain. */
function armExitWhenIdle(): void {
    if (idleExitArmed) return;
    idleExitArmed = true;
    const timers = import.meta.use('timers');
    let idleSeen = 0;
    const tick = () => {
        // Confirm idle across several turns to avoid transient zero counts.
        if (os.refHandleCount() === 0) idleSeen++;
        else idleSeen = 0;
        if (idleSeen < IDLE_CONFIRMATIONS) {
            timers.setTimeout(tick, idleSeen > 0 ? 1 : 5);
            return;
        }
        const code = resolveExitCode();
        if (code === 0) {
            // A withdrawn status must drain naturally so beforeunload still fires.
            idleExitArmed = false;
            runProcessCleanup();
            return;
        }
        // Prefer natural drain; older cores fall back to a forced exit.
        if (pushRuntimeExitCode(code)) {
            idleExitArmed = false;
            runProcessCleanup();
            return;
        }
        exitAfterCleanup(code);
    };
    timers.setTimeout(tick, 0);
}

/** Arm exit polling lazily after a successful nonzero exitCode assignment. */
function watchProcessExitCode(): void {
    try {
        const proc = Reflect.get(globalThis, 'process');
        if (!isRecord(proc)) return;
        const desc = Object.getOwnPropertyDescriptor(proc, 'exitCode');
        if (!desc || desc.configurable !== true) return;
        if (typeof desc.get !== 'function' || typeof desc.set !== 'function') return;
        const { get, set } = desc;
        Object.defineProperty(proc, 'exitCode', {
            configurable: true,
            enumerable: desc.enumerable === true,
            get,
            set(this: unknown, value: unknown) {
                // Throws (non-integer) propagate to the assigning code, as before.
                Reflect.apply(set, this, [value]);
                const code = currentProcessExitCode();
                // Re-arming during teardown would recursively dispatch beforeExit.
                if (typeof code === 'number' && code !== 0 && !inTeardown()) armExitWhenIdle();
            },
        });
    } catch {
        // Frozen/exotic process object: leave it alone. The post-dispatch read
        // in mainEntry still covers everything assigned before the drain.
    }
}

async function installProcessCleanup(): Promise<void> {
    if (!cleanupLocks) {
        const { LockStore } = await import('../cts/src/api');
        cleanupLocks = () => LockStore.closeAll();
        cleanupLocksFast = () => LockStore.closeAllFast();
    }
}

async function dispatch(): Promise<void> {
    const cli = parseArgv(readArgv());

    // Pack owns its command-scoped help so it can document pack-only flags.
    if (cli.cmd !== 'pack' && (cli.flags.help === true || cli.flags.h === true)) {
        showHelp();
        return;
    }
    if (cli.flags.version === true || cli.flags.v === true) {
        showVersion();
        return;
    }

    // Validate after help/version and before side effects.
    const unknown = unknownFlags(cli);
    if (unknown.length > 0) {
        for (const name of unknown) {
            console.error(`error: unexpected argument '${name}' found`);
        }
        exitAfterCleanup(1);
    }

    // A value flag with no value reaches its consumer as `true` and is then
    // type-guarded away, silently ignoring what the user asked for.
    const missing = missingFlagValues(cli);
    if (missing.length > 0) {
        for (const name of missing) {
            console.error(`error: a value is required for '--${name}' but none was supplied`);
        }
        exitAfterCleanup(1);
    }

    // Every command shares the same Deno.args/process.argv source.
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
    // Fetch and raw TLS maintain separate verification state.
    if (cli.flags['skip-cert-verify']) {
        disableCertVerify();
        disableRawCertVerify();
    }

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
                exitAfterCleanup(1);
            }
            return runEval({ code, flags: cli.flags });
        }
        case 'cache':
            return runCache(cli.positional, cli.flags);
        case 'pack':
            return runPack(cli.positional, cli.flags);
        case 'task':
            return runTask(cli.positional, cli.flags);
        case 'exec': {
            // `rawArgs.entry` defaults to `repl` for commands without an
            // entry, so validate the actual exec positional explicitly.
            const [bin, ...args] = cli.positional;
            if (!bin) {
                console.error(`Usage: ${C.cyan('cno exec')} ${C.cyan('<command>')} [args…]`);
                exitAfterCleanup(1);
            }
            const cacheDir = typeof cli.flags['cache-dir'] === 'string' ? cli.flags['cache-dir'] : undefined;
            const code = await spawnBinary(bin, args, {}, os.cwd, cacheDir);
            if (code !== 0) exitAfterCleanup(code);
            return;
        }
        case 'repl':
            return runRepl(cli.flags);
        case 'test':
            return runTest(
                cli.positional,
                cli.flags,
                [...cli.rawArgs.internalArgs, ...cli.rawArgs.actionArgs],
            );
        case 'setup':
            return runSetup(cli.flags);
        case 'serve': {
            const [file, ...args] = cli.positional;
            if (!file) {
                console.error(`Usage: ${C.cyan('cno serve')} ${C.cyan('<file>')} [args…]`);
                exitAfterCleanup(1);
            }
            return runServe(file, args, cli.flags, cli.rawArgs);
        }
        case 'run':
        case null: {
            // Bare cno opens the REPL; cno run without a target lists tasks.
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
            exitAfterCleanup(1);
        }
    } finally {
        stopNetwork();
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

// Shared test execution; transports differ only in the result sender.
async function runTestFileAndReport(
    file: string,
    flags: Record<string, string | boolean>,
    flagArgs: string[],
    scriptArgs: string[],
    send: (msg: TestChildMessage) => void | Promise<void>,
): Promise<void> {
    let message: TestChildMessage;
    try {
        // Deno test modules are not "main"; import.meta.main is false under `deno test`.
        await runFile({ file, args: scriptArgs, flags, rawArgs: makeRunArgs(file, scriptArgs, flags, flagArgs), asMain: false });
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
    await send(message);
}

async function testChildEntry(
    file: string,
    flags: Record<string, string | boolean>,
    flagArgs: string[],
    scriptArgs: string[],
): Promise<void> {
    await runTestFileAndReport(file, flags, flagArgs, scriptArgs, writeTestChildResult);
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
        await runTestFileAndReport(String(testEntry), {}, [], [], (msg) => pipe.postMessage(msg));
        return;
    }

    // Web Worker: new Worker(url) passes __cts_entry in workerData (see cno/src/webapi/worker.ts)
    const entry = workerData?.__cts_entry;
    if (entry) {
        const file = String(entry);
        const isNodeWorker = isNodeWorkerData(workerData);
        if (isNodeWorker) worker.pipe?.unref();
        try {
            await runEntry(file, [], {}, makeRunArgs(file), decodeWorkerRuntimeConfig(workerData?.__cts_runtime_config));
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
    let deferredExit = false;
    try {
        let isTestChild = false;
        try { isTestChild = !!os.getenv(TEST_CHILD_ENV); } catch { /* not set */ }
        if (isTestChild) os.unsetenv(TEST_CHILD_ENV); // must not leak to grandchildren

        if (worker.isWorker) await workerEntry();
        else if (isTestChild) {
            // Test children open a LockStore too; without this the finally
            // below is a no-op and the SQLite handle leaks (cts.lock EINVAL).
            await installProcessCleanup();
            const invocation = parseTestChildArgs(os.args.slice(2));
            await testChildEntry(os.args[1], invocation.flags, invocation.flagArgs, invocation.scriptArgs);
        }
        else {
            // Install exit tracking before user code runs.
            Reflect.set(globalThis, REQUEST_EXIT_CODE_SLOT, requestExitCode);
            watchProcessExitCode();

            await dispatch();

            // Re-read in case the process accessor could not be wrapped.
            const code = resolveExitCode();
            if (code !== 0) {
                deferredExit = true;
                armExitWhenIdle();
            } else if (idleExitArmed) {
                // The armed watcher owns cleanup while the loop drains.
                deferredExit = true;
            }
        }
    } finally {
        // The deferred exit path owns cleanup; running it now would close
        // locks while pending timers/IO are still executing.
        if (!deferredExit) runProcessCleanup();
    }
}

// start main app
mainEntry().catch(e => {
    runProcessCleanup();
    if (e instanceof CliExit) exitAfterCleanup(e.code);
    if (worker.isWorker && isWorkerCloseError(e)) return;
    const { error: cause, context } = commandErrorInfo(e);
    if (worker.isWorker && isNodeWorkerData(worker.workerData)) {
        worker.pipe?.postMessage({ __cno_node_worker_error__: nodeWorkerErrorInfo(cause) });
        return;
    }
    fatal(cause, context);
});
