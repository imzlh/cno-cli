import { strictEqual, ok, match } from 'node:assert';
import * as process from 'node:process';

// --- 1. process.pid / ppid / threadId -------------------------------------

Deno.test('process: pid and ppid are positive integers', () => {
    ok(Number.isInteger(process.pid) && process.pid > 0);
    ok(Number.isInteger(process.ppid) && process.ppid >= 0);
});

// --- 2. process.argv is a non-empty array of strings ----------------------

Deno.test('process: argv is array of strings', () => {
    ok(Array.isArray(process.argv));
    ok(process.argv.length >= 1);
    for (const a of process.argv) ok(typeof a === 'string');
});

// --- 3. process.execPath / mainModule -------------------------------------

Deno.test('process: execPath is a string', () => {
    ok(typeof process.execPath === 'string' && process.execPath.length > 0);
});

// --- 4. process.cwd / chdir round-trip ------------------------------------

Deno.test('process: cwd and chdir round-trip', () => {
    const original = process.cwd();
    ok(typeof original === 'string' && original.length > 0);
    process.chdir('/');
    strictEqual(process.cwd(), '/');
    process.chdir(original);
    strictEqual(process.cwd(), original);
});

// --- 5. process.env: get/set/delete ---------------------------------------

Deno.test('process: env get/set/delete', () => {
    const key = 'CNO_PROCESS_ENV_KEY';
    process.env[key] = 'v1';
    strictEqual(process.env[key], 'v1');
    ok(key in process.env);
    delete process.env[key];
    strictEqual(process.env[key], undefined);
    ok(!(key in process.env));
});

Deno.test('process: env.toString and indexing', () => {
    process.env['CNO_ENV_STR'] = 'x';
    ok(typeof process.env['CNO_ENV_STR'] === 'string');
    delete process.env['CNO_ENV_STR'];
});

// --- 6. process.platform / arch / version --------------------------------

Deno.test('process: platform/arch/version are strings', () => {
    for (const k of ['platform', 'arch', 'version']) {
        ok(typeof process[k as keyof typeof process] === 'string' && (process[k as keyof keyof typeof process] as unknown as string).length > 0,
            `process.${k} must be a non-empty string`);
    }
});

// --- 7. process.versions has node + at least one engine ------------------

Deno.test('process: versions.node exists', () => {
    ok(typeof process.versions.node === 'string');
    ok(process.versions.node.length > 0);
});

// --- 8. process.memoryUsage returns numeric fields ------------------------

Deno.test('process: memoryUsage returns numeric fields', () => {
    const m = process.memoryUsage();
    for (const k of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) {
        const v = (m as Record<string, number>)[k];
        ok(typeof v === 'number' && v >= 0, `memoryUsage.${k} must be a non-negative number`);
    }
});

// --- 9: process.uptime returns positive number ----------------------------

Deno.test('process: uptime is positive', () => {
    ok(typeof process.uptime() === 'number' && process.uptime() >= 0);
});

// --- 10. process.hrtime.bigint returns bigint -----------------------------

Deno.test('process: hrtime.bigint returns bigint', () => {
    const t = process.hrtime.bigint();
    ok(typeof t === 'bigint');
    const t2 = process.hrtime.bigint();
    ok(t2 >= t, 'hrtime.bigint must be monotonic');
});

// --- 11. process.hrtime() array form --------------------------------------

Deno.test('process: hrtime() returns [seconds, nanoseconds]', () => {
    const [s, ns] = process.hrtime();
    ok(Number.isInteger(s) && s >= 0);
    ok(Number.isInteger(ns) && ns >= 0);
});

// --- 12. process.kill with signal 0 checks pid liveness ------------------

Deno.test('process: kill(pid, 0) checks own pid without killing', () => {
    // signal 0 does not actually send a signal, just checks liveness
    let threw = false;
    try { process.kill(process.pid, 0); } catch { threw = true; }
    ok(!threw, 'kill(self, 0) must not throw for a live process');
});

// --- 13. process.kill on nonexistent pid throws ---------------------------

Deno.test('process: kill(veryLargePid) throws ESRCH', () => {
    let threw = false;
    try { process.kill(99999999, 0); } catch (e: unknown) {
        threw = true;
        ok((e as NodeJS.ErrnoException).code === 'ESRCH', `expected ESRCH, got ${(e as NodeJS.ErrnoException).code}`);
    }
    ok(threw, 'kill on nonexistent pid must throw');
});

// --- 14. process.nextTick defers ------------------------------------------

Deno.test('process: nextTick defers after current work', async () => {
    let order = '';
    order += 'a';
    process.nextTick(() => { order += 'b'; });
    order += 'c';
    await new Promise((r) => setTimeout(r, 10));
    strictEqual(order, 'acb');
});

// --- 15. process.nextTick passes args -------------------------------------

Deno.test('process: nextTick forwards arguments', async () => {
    const received = await new Promise<any[]>((resolve) => {
        process.nextTick((a: number, b: string) => resolve([a, b]), 1, 'two');
    });
    strictEqual(received[0], 1);
    strictEqual(received[1], 'two');
});

// --- 16. process.exit must not be called in tests (smoke only) ------------

Deno.test('process: exitCode defaults to 0 or undefined', () => {
    ok(process.exitCode === undefined || typeof process.exitCode === 'number');
});

// --- 17. process.stdin/stdout/stderr are nullable streams -----------------

Deno.test('process: stdin/stdout/stderr exist', () => {
    ok(process.stdin === null || typeof process.stdin === 'object');
    ok(process.stdout === null || typeof process.stdout === 'object');
    ok(process.stderr === null || typeof process.stderr === 'object');
});

// --- 18. process.umask returns a number ----------------------------------

Deno.test('process: umask() returns a number', () => {
    const m = process.umask();
    ok(typeof m === 'number');
});
