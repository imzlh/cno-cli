import { joinPaths, normalizePath, isAbsolute, cwd, toPosixPath } from '../../cts/src/api';
import { C } from '../help';

const os = import.meta.use('os');
const console = import.meta.use('console');
const process = import.meta.use('process');
const fs = import.meta.use('fs');

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

function* walkSync(dir: string): Generator<string> {
    const entries = readDirOrNull(dir);
    if (!entries) return;
    for (const e of entries) {
        if (SKIP_DIRS.has(e)) continue;
        const full = joinPaths(dir, e);
        const s = statOrNull(full);
        if (!s) continue;
        if (s.isDirectory) {
            yield* walkSync(full);
        } else if (s.isFile && TEST_RE.test(e)) {
            yield full;
        }
    }
}

function collectTests(rawPaths: string[]): string[] {
    const posixCwd = cwd();
    const roots = rawPaths.length
        ? rawPaths.map(p => {
            const norm = toPosixPath(p);
            return isAbsolute(norm) ? norm : joinPaths(posixCwd, norm);
        })
        : [posixCwd];

    const out: string[] = [];
    for (const r of roots) {
        const s = statOrNull(r);
        if (!s) continue;
        if (s.isFile) {
            out.push(r);
        } else if (s.isDirectory) {
            out.push(...walkSync(r));
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

function parseFailedTests(value: unknown): FailedTest[] {
    if (!Array.isArray(value)) return [];
    return value.map((t): FailedTest => {
        if (!isRecord(t)) return { name: String(t) };
        return {
            name: typeof t.name === 'string' ? t.name : String(t),
            error: t.error ? String(t.error) : undefined,
        };
    });
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

function parseConcurrency(value: string | boolean | undefined): number {
    if (typeof value !== 'string') return 4;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return 4;
    return parsed;
}

async function runOne(file: string, flags: Record<string, string | boolean>): Promise<TestResult> {
    const start = performance.now();
    applyCacheDirEnv(flags);
    const { IPCChannel } = await import('../../cno/src/node/ipc_channel/mod');
    let child: ReturnType<typeof process.spawn>;
    try {
        child = process.spawn([os.exePath, file, ...flagsToArgs(flags)], {
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
    if (!child.ipc) {
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
        channel.once('message', (m: unknown) => { received = isRecord(m) ? m : { error: `invalid test worker message: ${String(m)}` }; });
        await new Promise<void>((resolve, reject) => {
            channel.once('close', () => resolve());
            channel.once('error', reject);
        });
        // A pipe only reaches EOF/close after all previously-written bytes
        // are delivered, so a message sent just before exit is guaranteed to
        // have arrived here already — no need to race against child.wait().
        if (received === undefined) {
            const info = await child.wait();
            throw new Error(`test worker exited (code=${info.exit_status}, signal=${info.term_signal ?? 'none'}) without reporting a result`);
        }
        const failedTests = parseFailedTests(received.failedTests);
        return { file, passed: received.passed === true, duration: performance.now() - start, error: received.error, failedTests };
    } catch (e) {
        return { file, passed: false, duration: performance.now() - start, error: e, failedTests: [] };
    } finally {
        channel.close();
        killChildQuietly(child);
        await child.wait().catch(() => {});
    }
}

async function runAll(files: string[], concurrency: number, flags: Record<string, string | boolean>): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const queue = [...files];
    const workers: Promise<void>[] = [];
    const failFast = flags['fail-fast'] === true;

    async function worker(): Promise<void> {
        while (queue.length) {
            const file = queue.shift();
            if (file === undefined) continue;
            const result = await runOne(file, flags);
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
    return results;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runTest(
    paths: string[],
    flags: Record<string, string | boolean>,
): Promise<void> {
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
    const concurrency = flags['fail-fast'] === true ? 1 : Math.min(files.length,
        requestedConcurrency
    );

    console.log(`${C.dim('Running')} ${files.length} test file${files.length === 1 ? '' : 's'} (concurrency=${concurrency})`);
    console.log('');

    const results = await runAll(files, concurrency, flags);

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
        if (r.failedTests.length) allFailed.push({ file: rel, tests: r.failedTests });
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
