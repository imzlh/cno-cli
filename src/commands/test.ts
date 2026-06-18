import { joinPaths, normalizePath, isAbsolute } from '../../cts/src/utils/path';
import { C } from '../help';

const os = import.meta.use('os');
const console = import.meta.use('console');
const workerApi = import.meta.use('worker');
const fs = import.meta.use('fs');
const timers = import.meta.use('timers');

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
    const cwd = normalizePath((os.cwd as string).replace(/\\/g, '/'));
    const roots = rawPaths.length
        ? rawPaths.map(p => {
            const norm = p.replace(/\\/g, '/');
            return isAbsolute(norm) ? norm : joinPaths(cwd, norm);
        })
        : [cwd];

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

/**
 * Yield control long enough for the worker's pending timers / I/O to drain.
 * Without this, `terminate()` kills the worker while it's still flushing
 * console output or running async test teardown, which makes the whole
 * process abort after a few files.
 */
function drain(ms: number): Promise<void> {
    return new Promise(resolve => timers.setTimeout(resolve, ms));
}

async function runOne(file: string): Promise<TestResult> {
    const start = Date.now();
    const w = new workerApi.Worker({ __cts_test: file });
    try {
        const msg = await new Promise<any>((resolve, reject) => {
            w.messagePipe.onmessage = resolve;
            w.messagePipe.onmessageerror = reject;
        });
        const failedTests: FailedTest[] = (msg?.failedTests ?? []).map((t: any) => ({
            name: t.name ?? String(t),
            error: t.error ? String(t.error) : undefined,
        }));
        return { file, passed: msg?.passed === true, duration: Date.now() - start, error: msg?.error, failedTests };
    } catch (e) {
        return { file, passed: false, duration: Date.now() - start, error: e, failedTests: [] };
    } finally {
        // Let the worker flush pending I/O before we pull the plug.
        try { await drain(50); } catch {}
        try { await w.terminate(); } catch {}
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
        const ms = C.dim(`${r.duration}ms`);
        // Show path relative to cwd
        const cwd = normalizePath((os.cwd as string).replace(/\\/g, '/')) + '/';
        const rel = r.file.startsWith(cwd) ? r.file.slice(cwd.length) : r.file;
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
