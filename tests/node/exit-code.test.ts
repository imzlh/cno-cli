/**
 * Natural-exit status: `process.exitCode` and unhandled async errors.
 *
 * Three defects, all in the same family — the process exited 0 where node exits
 * nonzero. Every row below was MEASURED against real node v24.18.0 before being
 * written down; where cno deliberately deviates from node it is called out.
 *
 * 1. `process.exitCode` was read exactly ONCE, in src/main.ts immediately after
 *    `dispatch()` resolved and therefore before the loop drained. Anything
 *    assigned from a timer or an IO callback landed after that read and was
 *    silently dropped.
 *      assigned at top level  node 3  cno 3   (matched: completes before the read)
 *      assigned in microtask  node 3  cno 3   (matched: same)
 *      assigned in setTimeout node 3  cno 0   DROPPED
 *      assigned in fs callback node 3 cno 0   DROPPED
 *      3 then 5 (last wins)   node 5  cno 0   DROPPED
 *      3 then 0 (explicit 0)  node 0  cno 3   WRONG
 *
 * 2. An unhandled job exception (async throw, no 'uncaughtException' handler)
 *    printed a diagnostic and exited 0; node exits 1.
 *
 * 3. An unhandled promise rejection (no 'unhandledRejection' listener) likewise
 *    exited 0; node exits 1. `cno eval 'Promise.reject(new Error("REJ"))'`
 *    diagnosed the failure and then reported success.
 *
 * DELIBERATE DEVIATION FROM NODE, for 2 and 3. Node stops the event loop as
 * well as setting the status — a `MARK` scheduled after the throw never runs.
 * cno takes the status only and keeps the loop running. Stopping it means
 * returning `false` from the cts diagnostics receiver, which reaches TJS_Stop
 * (circu.js/src/utils.c:180, and vm.c:932-938 forces exit_code 1 there) and
 * would kill an entire `cno test` file mid-suite on any async throw in any test.
 * The rows below therefore assert BOTH the nonzero status AND that later work
 * still ran.
 *
 * The status is carried by src/main.ts, which is baked into cno.exe, so these
 * spawn the binary under test rather than importing anything.
 */
import { ok, strictEqual } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

interface RunResult {
    status: number | null;
    stdout: string;
    stderr: string;
    /** Contents of the marker file the fixture writes, or null if never written. */
    marker: string | null;
}

/**
 * Run a fixture as a real child process and report its status.
 *
 * The fixture records "the loop was still running" by writing a marker FILE, not
 * by printing. That is not fastidiousness: os.exit() is libc exit() and does not
 * drain a queued pipe write, so a `console.log` from the last callback before
 * exit is lost when stdout is a pipe — OBSERVED, `MARK: drained` printed on a
 * TTY and captured as empty output from the same program. writeFileSync is
 * synchronous, so the marker cannot be lost that way.
 */
function runFixture(name: string, body: string): RunResult {
    const dir = mkdtempSync(join(tmpdir(), 'cno-exitcode-'));
    const file = join(dir, `${name}.mjs`);
    const marker = join(dir, 'marker.txt');
    try {
        writeFileSync(file, body, 'utf8');
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

/**
 * Prologue every fixture shares.
 *
 * `hold` is a ref'd interval that keeps the loop unambiguously alive until the
 * fixture explicitly releases it, so no row depends on how the timer polyfill
 * happens to arm its underlying handle. `done()` writes the marker and releases
 * the loop, and is the only way these fixtures finish.
 */
const PRELUDE = [
    "import { writeFileSync } from 'node:fs';",
    'const MARKER = process.argv[2];',
    'const hold = setInterval(() => {}, 10);',
    "const done = (text = 'ALIVE') => { writeFileSync(MARKER, text); clearInterval(hold); };",
    '',
].join('\n');

function fixture(...lines: string[]): string {
    return PRELUDE + lines.join('\n') + '\n';
}

// --- defect 1: where process.exitCode is assigned from ---------------------

Deno.test('exit status: process.exitCode assigned at top level (node rc=3)', () => {
    const r = runFixture('top', fixture(
        'process.exitCode = 3;',
        'setTimeout(done, 40);',
    ));
    strictEqual(r.status, 3, `stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE', 'later work must still run');
});

Deno.test('exit status: process.exitCode assigned from a microtask (node rc=3)', () => {
    const r = runFixture('micro', fixture(
        'Promise.resolve().then(() => { process.exitCode = 3; });',
        'setTimeout(done, 40);',
    ));
    strictEqual(r.status, 3, `stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE');
});

Deno.test('exit status: process.exitCode assigned from a setTimeout callback (node rc=3)', () => {
    // The headline defect. Assigned strictly after main.ts's single read.
    const r = runFixture('timer', fixture(
        'setTimeout(() => { process.exitCode = 3; }, 20);',
        'setTimeout(done, 60);',
    ));
    strictEqual(r.status, 3, `exitCode set from a timer was dropped; stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE');
});

Deno.test('exit status: process.exitCode assigned from an fs IO callback (node rc=3)', () => {
    const r = runFixture('io', fixture(
        "import { readFile } from 'node:fs';",
        "writeFileSync(MARKER + '.src', 'payload');",
        "readFile(MARKER + '.src', (err, buf) => {",
        "    if (err || String(buf) !== 'payload') return;",
        '    process.exitCode = 3;',
        '});',
        'setTimeout(done, 60);',
    ));
    strictEqual(r.status, 3, `exitCode set from an IO callback was dropped; stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE');
});

Deno.test('exit status: a later assignment overwrites an earlier one (node rc=5)', () => {
    // Node's contract is the FINAL value of process.exitCode at natural exit,
    // so 5 must win over 3 — which also proves the status is resolved when the
    // loop drains rather than captured when the exit was first scheduled.
    const r = runFixture('overwrite', fixture(
        'setTimeout(() => { process.exitCode = 3; }, 10);',
        'setTimeout(() => { process.exitCode = 5; }, 30);',
        'setTimeout(done, 60);',
    ));
    strictEqual(r.status, 5, `stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE');
});

Deno.test('exit status: an explicit later 0 clears an earlier nonzero (node rc=0)', () => {
    // The mirror of the row above, and the one that a naive "first nonzero wins"
    // implementation of the async-throw fix would break: an explicit 0 is a real
    // value, not "unset". OBSERVED node rc=0; the old cno exited 3 and dropped
    // the rest of the program.
    const r = runFixture('overwrite-zero', fixture(
        'process.exitCode = 3;',
        'setTimeout(() => { process.exitCode = 0; }, 20);',
        'setTimeout(done, 60);',
    ));
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE');
});

// --- defect 2: unhandled job exception -------------------------------------

Deno.test('exit status: async throw with no handler exits 1 and keeps the loop alive', () => {
    // Node: prints the error, rc=1, loop STOPS. cno: rc=1, loop CONTINUES —
    // see the deviation note at the top of this file.
    const r = runFixture('throw-nohandler', fixture(
        "setTimeout(() => { throw new Error('BOOM_TIMER'); }, 10);",
        'setTimeout(done, 80);',
    ));
    strictEqual(r.status, 1, `async throw must exit 1; stderr: ${r.stderr}`);
    ok(/BOOM_TIMER/.test(r.stderr), `the error must still be reported; stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE', 'cno deliberately does NOT stop the loop');
});

Deno.test('exit status: async throw WITH an uncaughtException handler exits 0 (node rc=0)', () => {
    const r = runFixture('throw-handler', fixture(
        "process.on('uncaughtException', (e) => { writeFileSync(MARKER + '.saw', e.message); });",
        "setTimeout(() => { throw new Error('BOOM_HANDLED'); }, 10);",
        'setTimeout(done, 80);',
    ));
    strictEqual(r.status, 0, `a handled exception must not set a status; stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE');
});

// --- defect 3: unhandled promise rejection ---------------------------------

Deno.test('exit status: unhandled rejection with no listener exits 1 and keeps the loop alive', () => {
    const r = runFixture('rej-nohandler', fixture(
        "Promise.reject(new Error('BOOM_REJ'));",
        'setTimeout(done, 80);',
    ));
    strictEqual(r.status, 1, `unhandled rejection must exit 1; stderr: ${r.stderr}`);
    ok(/BOOM_REJ/.test(r.stderr), `the rejection must still be reported; stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE', 'cno deliberately does NOT stop the loop');
});

Deno.test('exit status: unhandled rejection WITH a listener exits 0 (node rc=0)', () => {
    // Node exits 0 when a listener is present, so a HANDLED rejection must not
    // pick up the status. This is the row that a fix keyed off "a rejection
    // happened" rather than "nobody handled it" would break.
    const r = runFixture('rej-handler', fixture(
        "process.on('unhandledRejection', (reason) => { writeFileSync(MARKER + '.saw', String(reason)); });",
        "Promise.reject(new Error('BOOM_REJ_H'));",
        'setTimeout(done, 80);',
    ));
    strictEqual(r.status, 0, `a handled rejection must not set a status; stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE');
});

// --- precedence: the requested 1 must never clobber a real decision --------

Deno.test('exit status: an explicit process.exit(3) beats a pending requested 1', () => {
    // process.exit() is immediate (os.exit -> libc exit), so its precedence is
    // absolute by construction; this pins it against a regression that routed
    // the status through a shared slot instead.
    //
    // Node rc=1 here, but only because the throw already killed it before
    // process.exit(3) could run. cno keeps the loop alive, so exit(3) does run
    // and 3 is the right answer for cno's chosen semantics.
    const r = runFixture('exit3-wins', fixture(
        "setTimeout(() => { throw new Error('BOOM_BEFORE_EXIT'); }, 10);",
        'setTimeout(() => { done(); process.exit(3); }, 60);',
    ));
    strictEqual(r.status, 3, `explicit exit(3) must win; stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE');
});

Deno.test('exit status: an earlier process.exitCode is not clobbered by a later async throw', () => {
    // First nonzero wins: the throw asks for 1, but 7 was already set, so the
    // request must be declined rather than overwrite it.
    const r = runFixture('earlier-exitcode-wins', fixture(
        'process.exitCode = 7;',
        "setTimeout(() => { throw new Error('BOOM_AFTER_EXITCODE'); }, 10);",
        'setTimeout(done, 80);',
    ));
    strictEqual(r.status, 7, `an earlier exitCode must survive; stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE');
});

Deno.test('exit status: two unhandled throws still exit 1, not 2', () => {
    // Guards against any accumulate-or-count implementation of the request.
    const r = runFixture('two-throws', fixture(
        "setTimeout(() => { throw new Error('BOOM_ONE'); }, 10);",
        "setTimeout(() => { throw new Error('BOOM_TWO'); }, 30);",
        'setTimeout(done, 80);',
    ));
    strictEqual(r.status, 1, `stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE');
});

Deno.test('exit status: a clean run still exits 0', () => {
    // The control. The deferred-exit watcher must not be armed for a program
    // that never asks for a status — arming it unconditionally would make every
    // run exit through os.exit() and silently disable the natural-drain
    // EV_BEFORE_UNLOAD path (circu.js/src/vm.c:851) for the whole product.
    const r = runFixture('clean', fixture(
        'setTimeout(done, 40);',
    ));
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    strictEqual(r.marker, 'ALIVE');
});

Deno.test('exit status: cno eval with an unhandled rejection exits 1', () => {
    // The audit's exact reproduction: `cno eval 'Promise.reject(new Error("REJ"))'`
    // diagnosed the failure and then reported success. eval goes through the same
    // mainEntry branch as run, so it must pick up the same status.
    const r = spawnSync(process.execPath, ['eval', 'Promise.reject(new Error("REJ_EVAL"))'], {
        encoding: 'utf8',
        timeout: 60_000,
    });
    strictEqual(r.status, 1, `stderr: ${r.stderr}`);
    ok(/REJ_EVAL/.test(String(r.stderr)), `stderr: ${r.stderr}`);
});

Deno.test('exit status: cno eval with a clean program still exits 0', () => {
    const r = spawnSync(process.execPath, ['eval', 'console.log("EVAL_OK")'], {
        encoding: 'utf8',
        timeout: 60_000,
    });
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(/EVAL_OK/.test(String(r.stdout)), `stdout: ${r.stdout}`);
});

Deno.test('exit status: a clean run does not lose output written from its last callback', () => {
    // Pins the reason the deferred-exit watcher is armed lazily rather than for
    // every run. Arming it always would route every exit through os.exit(),
    // which is libc exit() and does NOT drain a queued pipe write — OBSERVED, a
    // program whose last timer logged `MARK: drained` printed it on a TTY and
    // produced an EMPTY capture when the same program exited via os.exit().
    // A natural drain keeps it. So this row goes red the moment the watcher
    // becomes unconditional, without depending on 'beforeunload' (whose bridge
    // is a separate, concurrently-landing change).
    const r = runFixture('clean-flush', fixture(
        "setTimeout(() => { console.log('LAST-LINE'); done(); }, 40);",
    ));
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(/LAST-LINE/.test(r.stdout), `output from the final callback was lost; stdout: ${r.stdout}`);
    strictEqual(r.marker, 'ALIVE');
});
