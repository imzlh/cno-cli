import { joinPaths, normalizePath, isAbsolute, cwd, toPosixPath, isWindows } from '../../cts/src/api';
import { C } from '../help';

const os = import.meta.use('os');
const console = import.meta.use('console');
const process = import.meta.use('process');
const fs = import.meta.use('fs');
const timers = import.meta.use('timers');

// A test module that exits before opening IPC (or inherits the descriptor into
// a daemon) must not leave `cno test` waiting forever. Keep this configurable
// for slow CI machines while retaining a finite default for accidental hangs.
const DEFAULT_CHILD_TIMEOUT_MS = 60_000;

function childTimeoutMs(): number {
    try {
        const raw = os.getenv('CNO_TEST_CHILD_TIMEOUT_MS');
        if (raw !== undefined && raw !== null && raw !== '') {
            const value = Number(raw);
            if (Number.isFinite(value) && value >= 0) return Math.floor(value);
        }
    } catch { /* environment access can be unavailable in a worker */ }
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

function readDirOrNull(dir: string): string[] | null {
    try {
        return fs.readdir(dir);
    } catch {
        return null;
    }
}

function statOrNull(path: string): CModuleFS.Stats | null {
    try {
        return fs.stat(path);
    } catch {
        return null;
    }
}

function killChildQuietly(child: { kill(): void }): void {
    try {
        child.kill();
    } catch {
        // The child may already have exited after IPC close.
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

function directoryKey(path: string): string {
    let value = path;
    try { value = fs.realpath(path); } catch { /* use the lexical path */ }
    value = normalizePath(toPosixPath(value));
    return isWindows ? value.toLowerCase() : value;
}

function fileKey(path: string): string {
    let value = path;
    try { value = fs.realpath(path); } catch { /* use the lexical path */ }
    value = normalizePath(toPosixPath(value));
    return isWindows ? value.toLowerCase() : value;
}

function* walkSync(dir: string, visited = new Set<string>()): Generator<string> {
    // stat() follows symlinks/junctions. Without an identity set a project
    // containing `test/loop -> .` recurses until the native stack is exhausted.
    const identity = directoryKey(dir);
    if (visited.has(identity)) return;
    visited.add(identity);

    const entries = readDirOrNull(dir);
    if (!entries) return;
    for (const e of entries) {
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
        const identity = fileKey(file);
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

export interface TestChildMessage {
    passed?: boolean;
    error?: unknown;
    failedTests?: unknown;
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
            // Objects that lost their prototype over JSON IPC stringify to
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

function flagsToArgs(flags: Record<string, string | boolean>): string[] {
    const args: string[] = [];
    for (const [key, value] of Object.entries(flags)) {
        if (value === true) args.push(`--${key}`);
        else if (typeof value === 'string') args.push(`--${key}=${value}`);
    }
    return args;
}

function childEnv(flags: Record<string, string | boolean>): Record<string, string> {
    // process.spawn's env replaces rather than merges, so we must carry the
    // full parent environment ourselves alongside the sentinel.
    const env: Record<string, string> = { ...os.environ(), [TEST_CHILD_ENV]: '1' };
    const cacheDir = flags['cache-dir'];
    if (typeof cacheDir === 'string') env.CTS_CACHE_DIR = cacheDir;
    return env;
}

function applyCacheDirEnv(flags: Record<string, string | boolean>): void {
    const cacheDir = flags['cache-dir'];
    if (typeof cacheDir !== 'string') return;
    try {
        os.setenv('CTS_CACHE_DIR', cacheDir);
    } catch {
        // Keep running; the child still receives an explicit env below.
    }
}

export function parseTestChildFlags(args: string[]): Record<string, string | boolean> {
    const flags: Record<string, string | boolean> = {};
    for (const arg of args) {
        if (!arg.startsWith('--')) continue;
        const eq = arg.indexOf('=');
        if (eq < 0) flags[arg.slice(2)] = true;
        else flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
    return flags;
}

export function parseTestChildArgs(args: string[]): {
    flags: Record<string, string | boolean>;
    scriptArgs: string[];
} {
    const separator = args.indexOf('--');
    if (separator < 0) return { flags: parseTestChildFlags(args), scriptArgs: [] };
    return {
        flags: parseTestChildFlags(args.slice(0, separator)),
        scriptArgs: args.slice(separator + 1),
    };
}

function parseConcurrency(value: string | boolean | undefined): number | null {
    if (value === undefined) return 4;
    // A garbage value silently falling back to 4 hides a typo in CI configs.
    if (typeof value !== 'string') return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    return parsed;
}

/** Inspect flags bind one fixed port, so parallel children fight over it. */
function usesInspector(flags: Record<string, string | boolean>): boolean {
    for (const key of ['inspect', 'inspect-brk', 'inspect-wait']) {
        const value = flags[key];
        if (value !== undefined && value !== false) return true;
    }
    return false;
}

async function runOne(file: string, flags: Record<string, string | boolean>, scriptArgs: string[]): Promise<TestResult> {
    const start = performance.now();
    applyCacheDirEnv(flags);
    const { IPCChannel } = await import('../../cno/src/node/ipc_channel/mod');
    let child: ReturnType<typeof process.spawn>;
    try {
        child = process.spawn([os.exePath, file, ...flagsToArgs(flags), '--', ...scriptArgs], {
            stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', ipc: true,
            env: childEnv(flags),
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
            error: 'test worker IPC channel was not created',
            failedTests: [],
        };
    }
    const channel = new IPCChannel(child.ipc);
    try {
        let received: TestChildMessage | undefined;
        let closeResolve!: () => void;
        const closePromise = new Promise<void>((resolve) => { closeResolve = resolve; });
        let errorReject!: (error: unknown) => void;
        const errorPromise = new Promise<never>((_resolve, reject) => { errorReject = reject; });
        channel.once('message', (m: unknown) => {
            received = isRecord(m) ? m : { error: `invalid test worker message: ${String(m)}` };
        });
        channel.once('close', () => { closeResolve(); });
        channel.once('error', (error: unknown) => { errorReject(error); });
        const timeout = childTimeoutMs();
        let timeoutId: number | undefined;
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
            timeoutId = timers.setTimeout(() => resolve('timeout'), timeout);
        });
        const outcome = await Promise.race([
            closePromise.then(() => 'closed' as const),
            waitPromise.then((info) => ({ kind: 'exit' as const, info }), (error) => ({ kind: 'wait-error' as const, error })),
            errorPromise.then(() => 'error' as const),
            timeoutPromise,
        ]);
        if (timeoutId !== undefined) timers.clearTimeout(timeoutId);

        if (outcome === 'timeout') {
            killChildQuietly(child);
            await settleChild(child, waitPromise);
            throw new Error(`test worker timed out after ${timeout}ms without reporting a result`);
        }
        if (outcome === 'error') {
            throw new Error('test worker IPC channel failed');
        }
        // A normal child closes the pipe after its final frame. If it exits
        // before the close event is delivered, give one short turn for queued
        // bytes; otherwise surface the exit status instead of waiting forever.
        if (received === undefined && outcome !== 'closed') {
            let graceTimer: number | undefined;
            await Promise.race([
                closePromise,
                new Promise<void>((resolve) => {
                    graceTimer = timers.setTimeout(resolve, 100);
                }),
            ]);
            if (graceTimer !== undefined) timers.clearTimeout(graceTimer);
        }
        if (received === undefined) {
            if (typeof outcome === 'object' && outcome.kind === 'wait-error') {
                throw new Error(`test worker wait failed: ${errorText(outcome.error) ?? String(outcome.error)}`);
            }
            const info = outcome === 'closed'
                ? await settleChild(child, waitPromise)
                : outcome.info;
            throw new Error(`test worker exited (code=${info?.exit_status ?? 'unknown'}, signal=${info?.term_signal ?? 'none'}) without reporting a result`);
        }
        const failedTests = parseFailedTests(received.failedTests);
        return { file, passed: received.passed === true, duration: performance.now() - start, error: received.error, failedTests };
    } catch (e) {
        return { file, passed: false, duration: performance.now() - start, error: e, failedTests: [] };
    } finally {
        channel.close();
        await settleChild(child, waitPromise);
    }
}

async function runAll(
    files: string[],
    concurrency: number,
    flags: Record<string, string | boolean>,
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
            const result = await runOne(file, flags, scriptArgs);
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

interface TestChildChannel {
    once(event: string, listener: (value?: unknown) => void): unknown;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runTest(
    rawPaths: string[],
    flags: Record<string, string | boolean>,
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
        os.exit(1);
    }

    const requestedConcurrency = parseConcurrency(flags['concurrency']);
    if (requestedConcurrency === null) {
        console.error(`error: --concurrency must be a positive integer, got ${String(flags['concurrency'])}`);
        os.exit(1);
        return;
    }
    // Each test file is a child process; `--inspect*` is forwarded to all of
    // them, so anything above 1 makes every child but the first die with
    // EADDRINUSE and report a spurious module failure.
    const serial = flags['fail-fast'] === true || usesInspector(flags);
    const concurrency = serial ? 1 : Math.min(files.length, requestedConcurrency);

    console.log(`${C.dim('Running')} ${files.length} test file${files.length === 1 ? '' : 's'} (concurrency=${concurrency})`);
    console.log('');

    const results = await runAll(files, concurrency, flags, scriptArgs);

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
        os.exit(1);
    } else {
        console.log(C.green(`✔ ${summary}`));
    }
}
