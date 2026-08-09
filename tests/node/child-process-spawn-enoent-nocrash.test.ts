/**
 * child_process: an async spawn of a MISSING BARE-NAME binary must not crash
 * the runtime.
 *
 * Measured on real Node v24.18.0 on Windows 11: the child exits 0 in every case
 * below. cno exited 139 (SIGSEGV) for the bare-name case only.
 *
 * Why the bare name specifically. A path-like missing command
 * ("D:/nope/missing.exe") is pre-flighted in JS by getImmediateSpawnError and
 * never reaches native spawn, so it exited 0 already. A BARE name is handed to
 * the native `proc.spawn` (mod_process.c: TJS_CFUNC_DEF("spawn", 2, tjs_spawn)),
 * which fails. Both routes then run the identical JS `_failSpawn` teardown, so
 * the crash was in the native failure path, not in JS.
 *
 * Root cause (circu.js/src/mod_process.c, tjs_spawn): uv_spawn()'s first
 * statement is uv__process_init(), which runs uv__handle_init() and inserts
 * &p->process into loop->handle_queue. No uv_spawn error path unlinks it again
 * -- on Windows `goto done` skips straight to the local-free block, and on Unix
 * the `exec_errorno != 0 -> goto error` jump sits inside an `#if 0`. p->process
 * is EMBEDDED in the TJSProcess allocation, so the old `fail:` path's
 * tjs__free(p) left loop->handle_queue holding a node inside freed memory; the
 * next uv__handle_init() writes through queue->prev->next into that block.
 * libuv's own test-spawn.c TEST_IMPL(spawn_fails) covers exactly this case and
 * requires uv_close() on the handle rather than a bare free.
 *
 * These MUST run the failure in a CHILD process: an in-process test cannot
 * survive a segfault, so the assertion has to be on the child's exit code.
 *
 * NOTE: the fix is in compiled C. This test can only pass once the pending
 * rebuild picks up circu.js/src/mod_process.c. Against the currently shipped
 * binary the bare-name case is expected to fail with status 139.
 */
import { strictEqual, ok } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { withTempDir } from '../_helpers/temp.ts';

/** A name that cannot resolve on PATH, and is not path-like. */
const MISSING_BARE = 'definitely-not-a-real-binary-xyz';
/** Path-like missing command: the JS-pre-flighted route, kept as a comparison. */
const MISSING_PATHLIKE = 'D:/definitely/not/a/real/path/nope-missing.exe';

function scriptIn(dir: string, name: string, body: string): string {
    const p = join(dir, name);
    fs.writeFileSync(p, body + '\n');
    return p;
}

/** Run `script` in a child cno/node and report how it terminated. */
function runChild(script: string): { status: number | null; signal: string | null; out: string; err: string } {
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000 });
    return {
        status: r.status,
        signal: r.signal ?? null,
        out: String(r.stdout ?? ''),
        err: String(r.stderr ?? ''),
    };
}

/**
 * The two ways this crash is reported, depending on who observes the exit:
 *   139        = 128+SIGSEGV, what a POSIX-style shell reports.
 *   3221225477 = 0xC0000005 = STATUS_ACCESS_VIOLATION, the raw NTSTATUS that
 *                spawnSync sees on Windows.
 * Both are checked so the failure message names a CRASH rather than merely a
 * nonzero exit.
 */
const CRASH_STATUS = new Set<number>([139, 3221225477]);

function detail(label: string, r: ReturnType<typeof runChild>): string {
    return `${label}: status=${r.status} signal=${r.signal}\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}`;
}

/**
 * The reproducer, deliberately containing ZERO `await`. The awaited-close /
 * libuv-aliveness defect was separately ruled out for this crash (a >=50ms
 * keepalive timer rescues that one but not this), so keeping this free of any
 * await stops that mechanism from being confused with this one.
 *
 * The 'error' handler is required for a 0 exit: an unhandled 'error' is a throw
 * in Node too, which would exit nonzero for a reason unrelated to the crash.
 */
const CHILD_BARE = [
    "const cp = require('child_process');",
    `const c = cp.spawn(${JSON.stringify(MISSING_BARE)}, ['a', 'b']);`,
    "c.on('error', (e) => { console.log('ERRCODE:' + e.code); });",
    "c.on('close', () => { console.log('CLOSED'); });",
].join('\n');

const CHILD_PATHLIKE = [
    "const cp = require('child_process');",
    `const c = cp.spawn(${JSON.stringify(MISSING_PATHLIKE)}, ['a', 'b']);`,
    "c.on('error', (e) => { console.log('ERRCODE:' + e.code); });",
].join('\n');

/** Positive control: a spawn that SUCCEEDS. Proves the harness itself works. */
const CHILD_OK = [
    "const cp = require('child_process');",
    "const c = cp.spawn(process.execPath, ['-e', '0']);",
    "c.on('error', (e) => { console.log('UNEXPECTED:' + e.code); });",
    "c.on('close', (code) => { console.log('CHILD_CLOSED:' + code); });",
].join('\n');

// ── the crash ───────────────────────────────────────────────────────────────

// THE regression. Node v24.18 measured: status 0. Pre-fix cno: status 139.
// 139 == 128+11 == SIGSEGV, i.e. the freed-handle-still-in-handle_queue UAF.
Deno.test({
    name: 'child_process: async spawn of a missing BARE name must not crash the child runtime',
    timeout: 60000,
}, async () => {
    await withTempDir('cp-enoent', async (dir) => {
        const r = runChild(scriptIn(dir, 'bare.js', CHILD_BARE));
        ok(!CRASH_STATUS.has(r.status ?? -1), detail('bare-name spawn failure CRASHED the child runtime', r));
        ok(r.signal === null, detail('child was killed by a signal', r));
        strictEqual(r.status, 0, detail('expected node-identical status 0', r));
        // Prove the child actually reached the native spawn failure path, so a
        // 0 that came from never getting there cannot pass this test.
        ok(r.out.includes('ERRCODE:ENOENT'), detail("child never emitted 'error' with ENOENT", r));
    });
});

// ── controls ────────────────────────────────────────────────────────────────

// Positive control for the harness. If THIS is red the harness is broken and the
// test above tells you nothing, so a failure here must be read first.
Deno.test({
    name: 'child_process: control -- a successful async spawn exits the child 0',
    timeout: 60000,
}, async () => {
    await withTempDir('cp-enoent-ok', async (dir) => {
        const r = runChild(scriptIn(dir, 'ok.js', CHILD_OK));
        strictEqual(r.status, 0, detail('control: successful spawn did not exit 0', r));
        ok(r.out.includes('CHILD_CLOSED:0'), detail('control: grandchild did not close cleanly', r));
    });
});

// The other route, kept as a discriminator: this one is pre-flighted in JS and
// never reaches native spawn, so it passed even before the fix. If this goes red
// while the bare-name test is green, the JS pre-flight regressed, not the C.
Deno.test({
    name: 'child_process: control -- a missing PATH-LIKE command also exits the child 0',
    timeout: 60000,
}, async () => {
    await withTempDir('cp-enoent-path', async (dir) => {
        const r = runChild(scriptIn(dir, 'pathlike.js', CHILD_PATHLIKE));
        ok(!CRASH_STATUS.has(r.status ?? -1), detail('path-like route crashed', r));
        strictEqual(r.status, 0, detail('expected node-identical status 0', r));
        ok(r.out.includes('ERRCODE:ENOENT'), detail("path-like route did not emit ENOENT", r));
    });
});
