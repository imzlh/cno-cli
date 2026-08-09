// Regression: work started AFTER a server close must still complete.
//
// libuv runs its phases in the order
//   timers -> idle -> prepare -> io_poll -> check -> closing_handles
// and only then evaluates uv__loop_alive(). This runtime drains the JS job queue
// in the check phase (uv__check_cb, circu.js/src/vm.c) and that is also where it
// decides whether to keep the `jobs.idle` handle running -- the only handle that
// holds the loop open on account of pending microtasks.
//
// A handle's close callback is delivered in closing_handles, i.e. AFTER check. So
// a microtask enqueued from a close callback -- exactly what
// `await new Promise(r => server.close(r))` produces -- was invisible to uv's
// aliveness test whenever the closed server was the loop's last active handle:
// uv_run() returned 0 with that job still queued, and TJS_Run() only
// re-dispatched when uv_run() returned NON-zero, so it stopped instead.
//
// MEASURED on the pre-fix binary (build/stage/cno.exe, 2026-08-08):
//   - the continuation was drained only by TJS_FreeRuntime's uv_run(NOWAIT),
//     i.e. AFTER 'beforeunload'/'unload'/'exit' had already been dispatched, and
//     after tjs__destroy_timers(), so a setTimeout it registered could never fire
//     and a uv_getaddrinfo/connect it submitted could never complete;
//   - so the program abandoned pending work while reporting success (exit 0), or
//     tripped QuickJS's leak assertion at quickjs.c:2743 (exit 3) when the
//     abandoned work still held a promise. Which of the two, and a SIGSEGV third
//     mode, varied between runs on identical input -- one nondeterministic fault,
//     so these cases assert on the marker and never on a particular exit status.
//   - node v24.18.0 completes all three cases and exits 0.
//
// THREE THINGS HERE ARE LOAD-BEARING. Do not "simplify" them:
//
// 1. Each case runs in a SPAWNED CHILD. An in-process version of this file
//    passed 3/3 against the crashing binary, because the test runner's own
//    handles keep the loop alive and the closed server is then never the loop's
//    last live handle. A test that cannot fail is worse than no test: it would
//    certify this regression if it ever came back.
// 2. The child reports through a marker FILE, not stdout. os.exit() is libc
//    exit() and does not drain a queued pipe write, so a console.log from the
//    last callback before exit is lost when stdout is a pipe.
// 3. The child has NO `hold` interval. A ref'd interval spanning the close is
//    precisely the workaround that masks this defect (MEASURED: a 50ms timer
//    armed before the close rescues the job; a 0ms one does not, because it has
//    already fired by the time the close callback is delivered).
//
// The fix is in C (circu.js/src/vm.c, TJS_Run's dispatch loop: also re-dispatch
// when uv_run() returns 0 while JS jobs are still pending), so this file only
// passes against a binary rebuilt after that change.
import { strictEqual } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface RunResult {
    status: number | null;
    stdout: string;
    stderr: string;
    marker: string | null;
}

/**
 * Prologue every fixture shares: listen, then close and await a promise resolved
 * from the close callback. `finish()` races the awaited work against a guard
 * timer, so a loop that stays alive but never settles the work is a definite
 * failure (marker 'GUARD-WON') rather than a stall, while a loop that dies leaves
 * no marker at all.
 */
const PRELUDE = [
    "import { writeFileSync } from 'node:fs';",
    "import * as net from 'node:net';",
    "import * as dns from 'node:dns';",
    'const MARKER = process.argv[2];',
    'const finish = async (work) => {',
    "    const guard = new Promise((resolve) => setTimeout(() => resolve('GUARD-WON'), 4000));",
    '    writeFileSync(MARKER, await Promise.race([work, guard]));',
    '};',
    '(async () => {',
    '    const server = net.createServer();',
    "    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));",
    '    await new Promise((resolve) => server.close(() => resolve()));',
    '',
].join('\n');

const EPILOGUE = [
    '',
    "})().catch((err) => { try { writeFileSync(MARKER, 'THREW ' + String(err)); } catch {} });",
    '',
].join('\n');

function runFixture(name: string, ...tail: string[]): RunResult {
    const dir = mkdtempSync(join(tmpdir(), 'cno-loopalive-'));
    const file = join(dir, `${name}.mjs`);
    const marker = join(dir, 'marker.txt');
    try {
        writeFileSync(file, PRELUDE + tail.join('\n') + EPILOGUE, 'utf8');
        const r = spawnSync(process.execPath, ['run', file, marker], {
            encoding: 'utf8',
            timeout: 60_000,
        });
        return {
            status: r.status,
            stdout: String(r.stdout ?? ''),
            stderr: String(r.stderr ?? ''),
            marker: existsSync(marker) ? readFileSync(marker, 'utf8') : null,
        };
    } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

/** A missing marker means the child abandoned the work and exited. */
function assertSettled(label: string, r: RunResult, expected: string): void {
    const detail = r.marker === null
        ? ' No marker at all: work started after server.close() was abandoned and the process exited without running it.'
        : '';
    strictEqual(
        r.marker,
        expected,
        `${label}: expected marker ${JSON.stringify(expected)}, got ${JSON.stringify(r.marker)}`
        + ` (child status ${r.status}).${detail}`,
    );
}

Deno.test({ name: 'loop stays alive for a timer started after server.close()', timeout: 90000 }, () => {
    // The purest form: nothing but a timer, registered from the continuation of
    // an await whose promise was resolved by the close callback.
    const r = runFixture(
        'timer-after-close',
        "    await finish(new Promise((resolve) => setTimeout(() => resolve('timer-fired'), 150)));",
    );
    assertSettled('timer after close', r, 'timer-fired');
});

Deno.test({ name: 'loop stays alive for a socket connect started after server.close()', timeout: 90000 }, () => {
    // A libuv request rather than a timer. Port 1 on loopback refuses fast, so
    // this needs no network and no external host; either outcome settles.
    const r = runFixture(
        'connect-after-close',
        '    await finish(new Promise((resolve) => {',
        "        const socket = net.connect(1, '127.0.0.1');",
        "        socket.on('error', () => resolve('connect-settled'));",
        "        socket.on('connect', () => { socket.destroy(); resolve('connect-settled'); });",
        '    }));',
    );
    assertSettled('connect after close', r, 'connect-settled');
});

Deno.test({ name: 'loop stays alive for a dns.lookup started after server.close()', timeout: 90000 }, () => {
    // The originally reported shape. Only settlement is asserted, never the
    // resolver's answer, so this stays hermetic with respect to DNS behaviour.
    const r = runFixture(
        'dns-after-close',
        '    await finish(new Promise((resolve) =>',
        "        dns.lookup('no-such-host-xyz-abc-qq.invalid', () => resolve('dns-settled'))));",
    );
    assertSettled('dns.lookup after close', r, 'dns-settled');
});
