import { joinPaths, normalizePath, isAbsolute, cwd, toPosixPath } from '../../cts/src/api';
import { IPCChannel } from '../../cno/src/node/ipc_channel/mod';
import { C } from '../help';

const os = import.meta.use('os');
const console = import.meta.use('console');
const process = import.meta.use('process');
const fs = import.meta.use('fs');

// Hidden argv sentinel that selects testChildEntry() in src/main.ts instead
// of normal CLI dispatch — each test file runs as its own real child process
// (not a worker thread) so signal handling works inside test files.
export const TEST_CHILD_FLAG = '--__cno-test-child';

// Matches: foo.test.ts, foo_test.ts, foo.test.js, foo_test.js (and .tsx/.jsx)
const TEST_RE = /[._]test\.[jt]sx?$/;
// Directories to skip while walking
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'build_release']);

// ─── File discovery ──────────────────────────────────────────────────────────

function* walkSync(dir: string): Generator<string> {
    let entries: string[];
    try { entries = fs.readdir(dir); } catch { return; }
    for (const e of entries) {
        if (SKIP_DIRS.has(e)) continue;
        const full = joinPaths(dir, e);
        let s: CModuleAsyncFS.StatResult;
        try { s = fs.stat(full); } catch { continue; }
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
        let s: CModuleAsyncFS.StatResult;
        try { s = fs.stat(r); } catch { continue; }
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
    error?:       any;
    failedTests:  FailedTest[];
}

async function runOne(file: string): Promise<TestResult> {
    const start = performance.now();
    const child = process.spawn([os.exePath, TEST_CHILD_FLAG, file], {
        stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', ipc: true,
    });
    const channel = new IPCChannel(child.ipc!);
    try {
        let received: any;
        channel.once('message', (m: any) => { received = m; });
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
        const failedTests: FailedTest[] = (received.failedTests ?? []).map((t: any) => ({
            name: t.name ?? String(t),
            error: t.error ? String(t.error) : undefined,
        }));
        return { file, passed: received.passed === true, duration: performance.now() - start, error: received.error, failedTests };
    } catch (e) {
        return { file, passed: false, duration: performance.now() - start, error: e, failedTests: [] };
    } finally {
        channel.close();
        try { child.kill(); } catch {}
        await child.wait().catch(() => {});
    }
}

async function runAll(files: string[], concurrency: number): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const queue = [...files];
    const workers: Promise<void>[] = [];

    async function worker(): Promise<void> {
        while (queue.length) {
            const file = queue.shift()!;
            results.push(await runOne(file));
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
        console.log(`${C.warn('⚠')} No test files found.`);
        console.log(`  Looking for files matching ${C.cyan('[._]test.[jt]sx?')}`);
        os.exit(0);
    }

    const concurrency = Math.min(files.length,
        typeof flags['concurrency'] === 'string'
            ? parseInt(flags['concurrency'] as string, 10) || 4
            : 4
    );

    console.log(`${C.dim('Running')} ${files.length} test file${files.length === 1 ? '' : 's'} (concurrency=${concurrency})`);
    console.log('');

    const results = await runAll(files, concurrency);

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
