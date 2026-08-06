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
import { missingFlagValues, parseArgv, readArgv, unknownFlags } from './cli';
import { spawnBinary } from './commands/bin';
import { runCache } from './commands/cache';
import { runEval } from './commands/eval';
import { runPack } from './commands/pack';
import { runRepl } from './commands/repl';
import { runFile } from './commands/run';
import { runSetup } from './commands/setup';
import { printTaskList, runTask, taskExists } from './commands/task';
import { parseTestChildArgs, runTest, TEST_CHILD_ENV, type TestChildMessage } from './commands/test';
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

/**
 * Rebuild the `--flag=value` tokens runFile re-parses out of rawArgs.
 *
 * runFile does not read these from `flags`; it re-scans `rawArgs.actionArgs`
 * (loadEnvFiles / runDenoPreloads) and `rawArgs.internalArgs`
 * (nodeExecArgv → collectNodePreloads). A test child gets its flags via
 * flagsToArgs → parseTestChildArgs, but makeRunArgs used to hand runFile empty
 * token lists, so every one of these was silently dropped under `cno test`
 * while working under `cno run`. OBSERVED: `cno test --env-file=.env` printed
 * FOO=undefined where `cno run --env-file=.env` printed FOO=from_env_file.
 *
 * The child's flags are a flat record, so a repeated flag has already collapsed
 * to its last value before reaching here — `--env-file a --env-file b` loads
 * only b under `cno test`. Fixing that needs the child protocol to carry a
 * list, which is a wider change than this.
 */
function tokensFromFlags(flags: Record<string, string | boolean>, names: readonly string[]): string[] {
    const tokens: string[] = [];
    for (const name of names) {
        const value = flags[name];
        if (typeof value === 'string' && value.length > 0) tokens.push(`--${name}=${value}`);
    }
    return tokens;
}

function makeRunArgs(file: string, args: string[] = [], flags: Record<string, string | boolean> = {}): Args {
    return {
        binary: os.args[0],
        internalArgs: tokensFromFlags(flags, INTERNAL_TOKEN_FLAGS),
        action: 'run',
        actionArgs: tokensFromFlags(flags, ACTION_TOKEN_FLAGS),
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
    // Resource limits must cross the Worker boundary too. A worker re-derives
    // its config from os.args, which does not carry the parent's CLI flags, so
    // without this the worker silently reverts to the memory-tier default.
    // See publishWorkerRuntimeConfig in src/commands/run.ts for the measurement.
    for (const key of ['memoryLimit', 'maxStackSize'] as const) {
        const n = value[key];
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) cfg[key] = n;
    }
    if (Array.isArray(value.conditions) && value.conditions.every((item) => typeof item === 'string')) {
        cfg.conditions = value.conditions.slice();
    }
    // publishWorkerRuntimeConfig has always SENT importMap/pathAliases, but this
    // reader never read them back, so both were silently dropped for BOTH worker
    // kinds. A worker re-derives them only from loadConfigFile(dir), and `dir` is
    // the worker script's own directory (src/utils.ts:22) — so a worker whose
    // script lives outside the project tree lost every bare-specifier mapping.
    //
    // OBSERVED (2026-08-02): parent with deno.json `imports: {mapped-canary: ...}`
    // resolved it; a worker under a config-less directory reported
    // `Cannot resolve "mapped-canary"` for node:worker_threads AND for the webapi
    // Worker given an equivalent bare path. The webapi Worker only *appeared* to
    // work when handed a file:// URL, because entryAndDir maps a URL entry to
    // dir=cwd() and it then re-read the parent's deno.json by luck of cwd.
    //
    // importMap values arrive already resolved to absolute paths, so they are
    // position-independent. pathAliases are relative and are interpreted against
    // baseUrl, which is inherited just above.
    if (isRecord(value.importMap)) {
        const map: Record<string, string> = {};
        for (const [k, v] of Object.entries(value.importMap)) {
            if (typeof v === 'string') map[k] = v;
        }
        if (Object.keys(map).length > 0) cfg.importMap = map;
    }
    if (isRecord(value.importMapScopes)) {
        const scopes: Record<string, Record<string, string>> = {};
        for (const [scope, entries] of Object.entries(value.importMapScopes)) {
            if (!isRecord(entries)) continue;
            const inner: Record<string, string> = {};
            for (const [k, v] of Object.entries(entries)) {
                if (typeof v === 'string') inner[k] = v;
            }
            if (Object.keys(inner).length > 0) scopes[scope] = inner;
        }
        if (Object.keys(scopes).length > 0) cfg.importMapScopes = scopes;
    }
    if (isRecord(value.pathAliases)) {
        const aliases: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(value.pathAliases)) {
            if (Array.isArray(v) && v.every((item) => typeof item === 'string')) aliases[k] = v.slice();
        }
        if (Object.keys(aliases).length > 0) cfg.pathAliases = aliases;
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

/** os.exit() never unwinds JS, so the finally-based cleanup must run first. */
function exitAfterCleanup(code: number): never {
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

/**
 * The status this process should exit with on a natural drain.
 *
 * Precedence, matching Node where Node has an opinion:
 *  - An explicit `process.exitCode` wins, INCLUDING an explicit 0. Node's
 *    contract is that the final value of `process.exitCode` at natural exit is
 *    the exit code, so last write wins for user assignments (OBSERVED against
 *    v24.18.0: `process.exitCode = 3` then `process.exitCode = 0` exits 0).
 *  - Otherwise a runtime-requested code (first nonzero wins).
 *  - Otherwise 0.
 *
 * `process.exit(N)` never reaches here at all: it is immediate (os.exit →
 * mod_os.c:89 libc exit), so its precedence is absolute by construction.
 */
function resolveExitCode(): number {
    const explicit = currentProcessExitCode();
    if (typeof explicit === 'number') return explicit;
    return requestedExitCode;
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

/**
 * Consecutive zero readings of `os.refHandleCount()` required before exiting.
 *
 * One reading is not enough, and this is a second pre-existing defect in this
 * function rather than a precaution. OBSERVED on the baked binary with
 * `process.exitCode = 3` at top level and timers at 5/10/20/30/40/60/80ms: the
 * callbacks logged refHandleCount 5,6,5,2,3,1 and then the 80ms timer never ran
 * at all — the poll caught a zero while JS timers were still pending and exited
 * through it. A `console.log` issued from the last callback that did run was
 * also lost when stdout was a pipe (empty capture, `MARK: drained` on a TTY),
 * because os.exit() is libc exit() and does not drain a queued pipe write.
 *
 * Requiring several readings on separate loop turns closes the window: a handle
 * that is merely between arms reappears on the next turn, whereas a genuinely
 * idle loop reads zero every time. It also buys queued writes a few more loop
 * passes to complete. This matters more after this change than before it,
 * because resolving the status at fire time means an early exit now returns the
 * WRONG code as well as truncating work — an assignment of 3 at 10ms followed by
 * 5 at 30ms must exit 5, as node does.
 */
const IDLE_CONFIRMATIONS = 3;

/**
 * Apply a nonzero exit code the way Deno does: after the loop drains.
 * os.exit() is immediate, so exiting straight after the entry module
 * resolved would kill still-pending timers/IO.
 *
 * The status is resolved at FIRE time, not at arm time. Reading it at arm time
 * was the defect: `mainEntry` read `process.exitCode` exactly once, immediately
 * after `dispatch()` resolved and therefore BEFORE the loop drained, so every
 * assignment made from a timer or an IO callback landed after the only read and
 * was lost (OBSERVED: `setTimeout(() => { process.exitCode = 3 })` exited 0
 * where node v24.18.0 exits 3; the top-level and microtask cases matched
 * because both complete before that read).
 */
function armExitWhenIdle(): void {
    if (idleExitArmed) return;
    idleExitArmed = true;
    const timers = import.meta.use('timers');
    let idleSeen = 0;
    const tick = () => {
        // The firing timer itself is inactive here, so 0 means nothing else
        // referenced is keeping the loop alive — but only if it stays 0 across
        // several turns; see IDLE_CONFIRMATIONS.
        if (os.refHandleCount() === 0) idleSeen++;
        else idleSeen = 0;
        if (idleSeen < IDLE_CONFIRMATIONS) {
            timers.setTimeout(tick, idleSeen > 0 ? 1 : 5);
            return;
        }
        const code = resolveExitCode();
        if (code === 0) {
            // The status was withdrawn — `process.exitCode = 3` and then an
            // explicit `= 0`, which node honours (rc 0). Stand down instead of
            // calling os.exit(0): a natural drain is what dispatches
            // EV_BEFORE_UNLOAD (vm.c:851), and forcing the exit here would
            // silently skip 'beforeunload' for that program. Clearing the flag
            // keeps it re-armable, so a 'beforeunload' listener that cancels
            // teardown and then assigns a code is still honoured.
            idleExitArmed = false;
            // mainEntry's finally deferred cleanup to this path, so it has to
            // happen here or the LockStore handle never closes. Idempotent, and
            // safe now: three consecutive idle turns mean nothing is pending.
            runProcessCleanup();
            return;
        }
        exitAfterCleanup(code);
    };
    timers.setTimeout(tick, 0);
}

/**
 * Arm the deferred exit lazily, on the first assignment to `process.exitCode`.
 *
 * Arming unconditionally would be simpler and is wrong twice over: the 5ms poll
 * would hold the loop open for every run that never sets a code, and — because
 * `exitAfterCleanup` goes through `os.exit()` — every run would then exit via
 * EV_EXIT and the natural-drain EV_BEFORE_UNLOAD (vm.c:851) would never fire,
 * silently disabling 'beforeunload' for the whole product. So the watcher is
 * armed only once something has actually asked for a nonzero status, which is
 * exactly the case that already bypassed beforeunload before this change.
 *
 * The property is a configurable accessor pair (process/mod.ts:1613-1619;
 * OBSERVED `{configurable: true, get: 'function', set: 'function'}` on the live
 * binary), so wrapping it keeps `exit()`'s own read of the module-scoped
 * binding, the TypeError on a non-integer, and the string coercion intact —
 * this only adds a notification after a successful set.
 */
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
                if (typeof code === 'number' && code !== 0) armExitWhenIdle();
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

    // A misspelled flag must not run the program with the intent dropped.
    // Checked after --help/--version so `cno --help` still works, and before
    // any side effect. Deno-compat no-ops are excluded inside unknownFlags.
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
    // Both halves are needed: disableCertVerify() reaches libcurl (fetch), while
    // disableRawCertVerify() reaches the raw path (wss:/WebSocket/EventSource and
    // direct https: sockets), which builds its own ssl.Context and now verifies by
    // default. Without the second call the flag was a no-op there.
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
                os.exit(1);
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
                os.exit(1);
                return;
            }
            const cacheDir = typeof cli.flags['cache-dir'] === 'string' ? cli.flags['cache-dir'] : undefined;
            const code = await spawnBinary(bin, args, {}, os.cwd, cacheDir);
            if (code !== 0) exitAfterCleanup(code);
            return;
        }
        case 'repl':
            return runRepl(cli.flags);
        case 'test':
            return runTest(cli.positional, cli.flags);
        case 'setup':
            return runSetup(cli.flags);
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

/** Flatten a test failure to text; Errors JSON-serialize to `{}` over IPC. */
function errorDetail(error: unknown): string | undefined {
    if (error === undefined || error === null) return undefined;
    if (error instanceof Error) return String(error.stack ?? `${error.name}: ${error.message}`);
    if (typeof error === 'string') return error;
    return errMsg(error);
}

// Runs one test file and reports its result via `send` — shared by both the
// worker-thread transport (workerEntry) and the child-process transport
// (testChildEntry) so the two only differ in how the result gets back.
async function runTestFileAndReport(
    file: string,
    flags: Record<string, string | boolean>,
    scriptArgs: string[],
    send: (msg: TestChildMessage) => void,
): Promise<void> {
    try {
        // Deno test modules are not "main"; import.meta.main is false under `deno test`.
        await runFile({ file, args: scriptArgs, flags, rawArgs: makeRunArgs(file, scriptArgs, flags), asMain: false });
        // Use the module-level startTest / getFailedTests exports directly
        const { startTest, getFailedTests } = await import('../cno/src/deno/index');
        const passed = await startTest(file, true, true, {
            filter: typeof flags.filter === 'string' ? flags.filter : undefined,
            failFast: flags['fail-fast'] === true,
        });
        // Error does not survive JSON IPC ({} → "[object Object]"); flatten first.
        send({
            passed,
            failedTests: getFailedTests().map((t) => ({ name: t.name, error: errorDetail(t.error) })),
        });
    } catch (e) {
        send({ passed: false, error: e instanceof Error ? String(e.stack ?? e.message) : String(e), failedTests: [] });
    }
}

async function testChildEntry(file: string, flags: Record<string, string | boolean>, scriptArgs: string[]): Promise<void> {
    const { IPCChannel } = await import('../cno/src/node/ipc_channel/mod');
    const streams = import.meta.use('streams');
    // fd 3 is where the native `process` module always hands a spawned child
    // its IPC endpoint when ipc:true (see child_process/mod.ts's own use of
    // this same convention).
    const pipe = new streams.Pipe();
    pipe.open(3);
    const channel = new IPCChannel(pipe);
    try {
        await runTestFileAndReport(file, flags, scriptArgs, (msg) => channel.send(msg));
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
        await runTestFileAndReport(String(testEntry), {}, [], (msg) => pipe.postMessage(msg));
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
            await testChildEntry(os.args[1], invocation.flags, invocation.scriptArgs);
        }
        else {
            // Publish the exit-code request slot and hook `process.exitCode`
            // BEFORE any user code can run, so an async throw or a timer
            // assignment during the very first tick is already covered.
            Reflect.set(globalThis, REQUEST_EXIT_CODE_SLOT, requestExitCode);
            watchProcessExitCode();

            await dispatch();

            // Re-read after dispatch as well as via the setter hook. The hook
            // covers the drain; this covers the case where the accessor could
            // not be wrapped at all (watchProcessExitCode bailing out), which
            // is the pre-existing behaviour and must not regress.
            const code = resolveExitCode();
            if (code !== 0) {
                deferredExit = true;
                armExitWhenIdle();
            } else if (idleExitArmed) {
                // Something already armed the watcher during dispatch (a
                // nonzero assignment, or a runtime request from a job
                // exception). It owns the exit; do not let the finally below
                // close locks underneath the still-draining loop.
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
    if (worker.isWorker && isWorkerCloseError(e)) return;
    if (worker.isWorker && isNodeWorkerData(worker.workerData)) {
        worker.pipe?.postMessage({ __cno_node_worker_error__: nodeWorkerErrorInfo(e) });
        return;
    }
    fatal(e);
});
