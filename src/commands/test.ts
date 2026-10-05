import { joinPaths, normalizePath, isAbsolute, cwd, toPosixPath, isWindows } from '../../cts/src/api';
import { parseArgv, type ParsedCli } from '../cli';
import { CliExit } from '../command-error';
import { C } from '../help';
import { readTestChildResult, type TestChildMessage } from './test-result-pipe';
import { readEnv } from '../env';

const os = import.meta.use('os');
const console = import.meta.use('console');
const process = import.meta.use('process');
const fs = import.meta.use('fs');
const timers = import.meta.use('timers');
const sysError = import.meta.use('error');

// A test module that exits before opening its result pipe (or inherits fd 3 into
// a daemon) must not leave `cno test` waiting forever. Keep this configurable
// for slow CI machines while retaining a finite default for accidental hangs.
const DEFAULT_CHILD_TIMEOUT_MS = 60_000;

function childTimeoutMs(): number {
    const raw = readEnv('CNO_TEST_CHILD_TIMEOUT_MS');
    if (raw) {
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    }
    return DEFAULT_CHILD_TIMEOUT_MS;
}

// Env sentinel selecting testChildEntry() in src/main.ts (unset on entry,
// so it never leaks into a grandchild the test file spawns itself).
export const TEST_CHILD_ENV = '__CNO_TEST_CHILD';

// Matches: foo.test.ts, foo_test.ts, foo.test.js, foo_test.js (and .tsx/.jsx)
const TEST_RE = /[._]test\.[jt]sx?$/;
// Directories to skip while walking
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'build_release']);

// ─── File discovery ──────────────────────────────────────────────────────────

function isNotFound(error: unknown): boolean {
    if (error === null || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    return code === sysError.errno.ENOENT || code === 'ENOENT';
}

function readDirOrNull(dir: string): string[] | null {
    try {
        return fs.readdir(dir);
    } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
    }
}

function statOrNull(path: string): CModuleFS.Stats | null {
    try {
        return fs.stat(path);
    } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
    }
}

function killChildQuietly(child: { kill(): void }): void {
    try {
        child.kill();
    } catch {
        // The child may already have exited after its result pipe closed.
    }
}

async function settleChild(
    child: { kill(): void },
    waitPromise: Promise<CModuleProcess.ExitInfo>,
): Promise<CModuleProcess.ExitInfo | undefined> {
    let timer: number | undefined;
    let info: CModuleProcess.ExitInfo | undefined;
    const exited = await Promise.race([
        waitPromise.then((value) => { info = value; return true; }, () => true),
        new Promise<boolean>((resolve) => {
            timer = timers.setTimeout(() => resolve(false), 500);
        }),
    ]);
    if (timer !== undefined) timers.clearTimeout(timer);
    if (exited) return info;
    killChildQuietly(child);
    return waitPromise.catch(() => undefined);
}

function pathKey(path: string): string {
    let value = path;
    try { value = fs.realpath(path); } catch { /* use the lexical path */ }
    value = normalizePath(toPosixPath(value));
    return isWindows ? value.toLowerCase() : value;
}

function* walkSync(dir: string, visited = new Set<string>()): Generator<string> {
    // stat() follows symlinks/junctions. Without an identity set a project
    // containing `test/loop -> .` recurses until the native stack is exhausted.
    const identity = pathKey(dir);
    if (visited.has(identity)) return;
    visited.add(identity);

    const entries = readDirOrNull(dir);
    if (!entries) return;
    for (const e of entries.sort()) {
        if (SKIP_DIRS.has(e)) continue;
        const full = joinPaths(dir, e);
        const s = statOrNull(full);
        if (!s) continue;
        if (s.isDirectory) {
            yield* walkSync(full, visited);
        } else if (s.isFile && TEST_RE.test(e)) {
            yield full;
        }
    }
}

export function collectTests(rawPaths: string[]): string[] {
    const posixCwd = cwd();
    const roots = rawPaths.length
        ? rawPaths.map(p => {
            const norm = toPosixPath(p);
            return isAbsolute(norm) ? norm : joinPaths(posixCwd, norm);
        })
        : [posixCwd];

    // Overlapping roots (`cno test . a_test.ts`, or the same path twice) must
    // not run a file twice and inflate the tally — deno dedupes too.
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (file: string): void => {
        const identity = pathKey(file);
        if (seen.has(identity)) return;
        seen.add(identity);
        out.push(file);
    };
    for (const r of roots) {
        const s = statOrNull(r);
        if (!s) continue;
        if (s.isFile) {
            push(r);
        } else if (s.isDirectory) {
            for (const file of walkSync(r)) push(file);
        }
    }
    return out;
}

// ─── Runner ─────────────────────────────────────────────────────────────────

interface FailedTest {
    name: string;
    error?: string;
}

interface TestResult {
    file:         string;
    passed:       boolean;
    duration:     number;
    error?:       unknown;
    failedTests:  FailedTest[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failureText(error: unknown): string {
    if (typeof error === 'string') return error;
    if (isRecord(error)) {
        const stack = error.stack;
        if (typeof stack === 'string' && stack) return stack;
        const message = error.message;
        if (typeof message === 'string' && message) {
            const name = typeof error.name === 'string' ? error.name : 'Error';
            return `${name}: ${message}`;
        }
    }
    return String(error);
}

function parseFailedTests(value: unknown): FailedTest[] {
    if (!Array.isArray(value)) return [];
    return value.map((t): FailedTest => {
        if (!isRecord(t)) return { name: String(t) };
        return {
            name: typeof t.name === 'string' ? t.name : String(t),
            // Objects that lost their prototype over the JSON result frame stringify to
            // "[object Object]" — pull message/stack out instead.
            error: t.error ? failureText(t.error) : undefined,
        };
    });
}

function errorText(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (value instanceof Error) return String(value.stack ?? value.message);
    return String(value);
}

export interface TestInvocation {
    kernelArgs: string[];
    commandArgs: string[];
}

export interface TestChildArgs {
    cli: ParsedCli;
    /** User arguments exposed to the test module through Deno.args. */
    scriptArgs: string[];
}

function childEnv(flags: Record<string, string | boolean>, invocation: TestInvocation): Record<string, string> {
    // process.spawn's env replaces rather than merges, so we must carry the
    // full parent environment ourselves alongside the sentinel.
    const env: Record<string, string> = {
        ...os.environ(),
        [TEST_CHILD_ENV]: JSON.stringify({
            version: 1,
            kernelArgs: invocation.kernelArgs,
            commandArgs: invocation.commandArgs,
        }),
    };
    const cacheDir = flags['cache-dir'];
    if (typeof cacheDir === 'string') env.CTS_CACHE_DIR = cacheDir;
    return env;
}

export function parseTestChildArgs(scriptArgs: string[], serializedInvocation: string): TestChildArgs {
    let data: unknown;
    try {
        data = JSON.parse(serializedInvocation);
    } catch {
        throw new Error('Invalid test child argument protocol');
    }
    const stringArray = (value: unknown): value is string[] =>
        Array.isArray(value) && value.every(token => typeof token === 'string');
    if (!isRecord(data) || data.version !== 1 ||
        !stringArray(data.kernelArgs) || !stringArray(data.commandArgs)) {
        throw new Error('Invalid test child argument protocol');
    }
    const cli = parseArgv([...data.kernelArgs, 'test', ...data.commandArgs]);
    if (cli.cmd !== 'test' || cli.positional.length !== 0 ||
        cli.kernelArgs.length !== data.kernelArgs.length ||
        cli.commandArgs.length !== data.commandArgs.length) {
        throw new Error('Invalid test child argument regions');
    }
    return { cli, scriptArgs: scriptArgs.slice() };
}

function parseConcurrency(value: string | boolean | undefined): number | null {
    if (value === undefined) return 4;
    // A garbage value silently falling back to 4 hides a typo in CI configs.
    if (typeof value !== 'string') return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    return parsed;
}

async function runOne(
    file: string,
    flags: Record<string, string | boolean>,
    invocation: TestInvocation,
    scriptArgs: string[],
): Promise<TestResult> {
    const start = performance.now();
    let child: ReturnType<typeof process.spawn>;
    try {
        child = process.spawn([os.exePath, file, ...scriptArgs], {
            stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', ipc: true,
            env: childEnv(flags, invocation),
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const exeExists = fs.exists(os.exePath);
        const fileExists = fs.exists(file);
        return {
            file,
            passed: false,
            duration: performance.now() - start,
            error: `failed to spawn test worker: ${msg} (exe=${os.exePath}, exeExists=${exeExists}, file=${file}, fileExists=${fileExists})`,
            failedTests: [],
        };
    }
    const waitPromise = child.wait();
    if (!child.ipc) {
        killChildQuietly(child);
        await waitPromise.catch(() => {});
        return {
            file,
            passed: false,
            duration: performance.now() - start,
            error: 'test worker result pipe was not created',
            failedTests: [],
        };
    }
    const resultReader = readTestChildResult(child.ipc);
    try {
        const report = resultReader.outcome.then((value) => ({ kind: 'report' as const, value }));
        const toResult = (received: TestChildMessage): TestResult => {
            const failedTests = parseFailedTests(received.failedTests);
            return { file, passed: received.passed === true, duration: performance.now() - start, error: received.error, failedTests };
        };
        const timeout = childTimeoutMs();
        let timeoutId: number | undefined;
        const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolve) => {
            timeoutId = timers.setTimeout(() => resolve({ kind: 'timeout' }), timeout);
        });
        let outcome = await Promise.race([
            report,
            waitPromise.then((info) => ({ kind: 'exit' as const, info }), (error) => ({ kind: 'wait-error' as const, error })),
            timeoutPromise,
        ]);
        if (timeoutId !== undefined) timers.clearTimeout(timeoutId);

        if (outcome.kind === 'timeout') {
            killChildQuietly(child);
            await settleChild(child, waitPromise);
            throw new Error(`test worker timed out after ${timeout}ms without reporting a result`);
        }
        // A child can exit before libuv dispatches already-buffered result
        // bytes. Give the reader one short turn before treating that exit as a
        // missing report, while retaining the outer timeout for hung children.
        if (outcome.kind === 'exit' || outcome.kind === 'wait-error') {
            let graceTimer: number | undefined;
            const grace = await Promise.race([
                report,
                new Promise<{ kind: 'grace' }>((resolve) => {
                    graceTimer = timers.setTimeout(() => resolve({ kind: 'grace' }), 100);
                }),
            ]);
            if (graceTimer !== undefined) timers.clearTimeout(graceTimer);
            if (grace.kind === 'report') outcome = grace;
        }

        if (outcome.kind === 'report') {
            if (outcome.value.kind === 'result') {
                return toResult(outcome.value.message);
            }
            if (outcome.value.kind === 'error') {
                throw new Error(`test worker result pipe failed: ${errorText(outcome.value.error) ?? String(outcome.value.error)}`);
            }
            const info = await settleChild(child, waitPromise);
            throw new Error(`test worker exited (code=${info?.exit_status ?? 'unknown'}, signal=${info?.term_signal ?? 'none'}) without reporting a result`);
        }

        if (resultReader.message !== undefined) return toResult(resultReader.message);
        if (outcome.kind === 'wait-error') {
            throw new Error(`test worker wait failed: ${errorText(outcome.error) ?? String(outcome.error)}`);
        }
        throw new Error(`test worker exited (code=${outcome.info.exit_status}, signal=${outcome.info.term_signal ?? 'none'}) without reporting a result`);
    } catch (e) {
        return { file, passed: false, duration: performance.now() - start, error: e, failedTests: [] };
    } finally {
        resultReader.close();
        await settleChild(child, waitPromise);
    }
}

async function runAll(
    files: string[],
    concurrency: number,
    flags: Record<string, string | boolean>,
    invocation: TestInvocation,
    scriptArgs: string[],
): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const queue = [...files];
    const workers: Promise<void>[] = [];
    const failFast = flags['fail-fast'] === true;

    async function worker(): Promise<void> {
        while (queue.length) {
            const file = queue.shift();
            if (file === undefined) continue;
            const result = await runOne(file, flags, invocation, scriptArgs);
            results.push(result);
            if (failFast && !result.passed) {
                queue.length = 0;
                return;
            }
        }
    }

    for (let i = 0; i < Math.min(concurrency, files.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    // Workers finish in timing order, but reports should follow discovery
    // order so repeated runs and CI annotations remain stable.
    const order = new Map(files.map((file, index) => [file, index]));
    results.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));
    return results;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runTest(
    rawPaths: string[],
    flags: Record<string, string | boolean>,
    invocation: TestInvocation,
    inspectorEnabled = false,
): Promise<void> {
    const separator = rawPaths.indexOf('--');
    const paths = separator < 0 ? rawPaths : rawPaths.slice(0, separator);
    const scriptArgs = separator < 0 ? [] : rawPaths.slice(separator + 1);
    const files = collectTests(paths);

    if (!files.length) {
        if (flags['permit-no-files'] === true) {
            console.log(`${C.green('✔')} 0/0`);
            return;
        }
        console.error('error: No test modules found');
        throw new CliExit(1);
    }

    const requestedConcurrency = parseConcurrency(flags['concurrency']);
    if (requestedConcurrency === null) {
        console.error(`error: --concurrency must be a positive integer, got ${String(flags['concurrency'])}`);
        throw new CliExit(1);
    }
    // Each test file is a child process; `--inspect*` is forwarded to all of
    // them, so anything above 1 makes every child but the first die with
    // EADDRINUSE and report a spurious module failure.
    const serial = flags['fail-fast'] === true || inspectorEnabled;
    const concurrency = serial ? 1 : Math.min(files.length, requestedConcurrency);

    console.log(`${C.dim('Running')} ${files.length} test file${files.length === 1 ? '' : 's'} (concurrency=${concurrency})`);
    console.log('');

    const results = await runAll(files, concurrency, flags, invocation, scriptArgs);

    let passed = 0, failed = 0;
    const allFailed: Array<{ file: string; tests: FailedTest[] }> = [];

    for (const r of results) {
        const label = r.passed
            ? C.green('PASS')
            : C.red('FAIL');
        const ms = C.dim(`${r.duration.toFixed(2)}ms`);
        // Show path relative to cwd
        const cwdPrefix = cwd() + '/';
        const rel = r.file.startsWith(cwdPrefix) ? r.file.slice(cwdPrefix.length) : r.file;
        console.log(`  ${label}  ${rel}  ${ms}`);
        if (r.passed) passed++; else failed++;
        const fileError = errorText(r.error);
        const failures = fileError
            ? [{ name: 'test module failed', error: fileError }, ...r.failedTests]
            : r.failedTests;
        if (failures.length) allFailed.push({ file: rel, tests: failures });
    }

    // Aggregate "Failed tests:" on the main thread — matches Deno's output
    // style and avoids interleaved worker-side prints.
    if (allFailed.length) {
        console.log('');
        console.log(C.red('Failed tests:'));
        for (const { file, tests } of allFailed) {
            for (const t of tests) {
                console.error(`  ${C.dim(file)}  ${t.name}`);
                if (t.error) console.error(`    ${C.dim(t.error)}`);
            }
        }
    }

    console.log('');
    const total = results.length;
    const summary = `${passed}/${total}`;
    if (failed > 0) {
        console.log(C.red(`✖ ${summary}`));
        throw new CliExit(1);
    } else {
        console.log(C.green(`✔ ${summary}`));
    }
}
