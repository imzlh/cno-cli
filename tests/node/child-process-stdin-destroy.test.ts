/**
 * child_process: the child's stdin must be DESTROYED when the child exits.
 *
 * Node's `onexit` handler calls `this.stdin.destroy()` before it emits 'exit'
 * (node/lib/internal/child_process.js). cno never did, so the Writable stayed
 * alive forever and `finished(subprocess.stdin)` never settled. execa awaits
 * exactly that promise as one member of a `Promise.all`, so `await execa(cmd)`
 * with no stdin input hung forever and the process then exited 0 with no output
 * and no error — a CLI shelling out would silently report success.
 *
 * Every expectation here was measured against real Node v24.18.0 on Windows 11
 * first; the node column is quoted in the comment above each assertion.
 *
 * Each wait is raced against a bounded timer so a regression is a definite
 * FAILURE rather than a stalled test run.
 */
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { Buffer } from 'node:buffer';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve to 'RESOLVED' | 'REJECTED:<code>' | 'NEVER_SETTLED' within `ms`. */
function settle(promise: Promise<unknown>, ms: number): Promise<string> {
    let timer: ReturnType<typeof setTimeout>;
    const bounded = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('NEVER_SETTLED'), ms);
    });
    return Promise.race([
        promise.then(
            () => 'RESOLVED',
            (err: unknown) => 'REJECTED:' + String((err as { code?: unknown })?.code ?? (err as Error)?.message),
        ),
        bounded,
    ]).finally(() => clearTimeout(timer!));
}

function waitClose(child: ReturnType<typeof spawn>): Promise<void> {
    return new Promise<void>((resolve) => child.once('close', () => resolve()));
}

// ── the hang itself ─────────────────────────────────────────────────────────

// This is the execa shape: `finished()` is attached right after spawn, before
// the child exits, and nobody ever writes to or ends stdin. Node v24.18:
// REJECTED:ERR_STREAM_PREMATURE_CLOSE. Pre-fix cno: NEVER_SETTLED.
Deno.test({ name: 'child_process: finished(child.stdin) settles after the child exits', timeout: 30000 }, async () => {
    const child = spawn(process.execPath, ['-e', "console.log('x')"], { stdio: ['pipe', 'pipe', 'pipe'] });
    // Attach before exit, exactly as execa does.
    const pending = settle(finished(child.stdin!, { cleanup: true }), 10000);
    child.stdout!.resume();
    const outcome = await pending;
    ok(outcome !== 'NEVER_SETTLED', `finished(child.stdin) never settled: ${outcome}`);
    strictEqual(outcome, 'REJECTED:ERR_STREAM_PREMATURE_CLOSE');
});

// Node's `Promise.all` of all three stdio `finished()` promises resolves once the
// child is gone (measured: RESOLVED). This is the literal execa `stdioAll`
// member set; pre-fix cno hung here forever.
Deno.test({ name: 'child_process: all three stdio finished() promises settle together', timeout: 30000 }, async () => {
    const child = spawn(process.execPath, ['-e', "console.log('y')"], { stdio: ['pipe', 'pipe', 'pipe'] });
    const all = Promise.all([
        finished(child.stdin!, { cleanup: true }).catch(() => 'stdin'),
        finished(child.stdout!, { cleanup: true }).catch(() => 'stdout'),
        finished(child.stderr!, { cleanup: true }).catch(() => 'stderr'),
    ]);
    child.stdout!.resume();
    child.stderr!.resume();
    strictEqual(await settle(all, 12000), 'RESOLVED');
});

// ── the ordering contract ───────────────────────────────────────────────────

// Node v24.18 measured:
//   at 'exit':  destroyed=true  writable=false  writableEnded=false
//   events:     ["child_exit","child_close","stdin_close"]
// destroyed BEFORE 'exit' is emitted, so an 'exit' listener legitimately sees
// destroyed===true; and it is a destroy(), not an end(), so writableEnded stays
// false and pending writes are discarded rather than flushed.
Deno.test({ name: 'child_process: stdin is destroyed before exit, and its close follows the child close', timeout: 30000 }, async () => {
    const child = spawn(process.execPath, ['-e', "console.log('z')"], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout!.resume();

    const events: string[] = [];
    let atExit: { destroyed: boolean; writable: boolean; writableEnded: boolean } | null = null;

    child.stdin!.on('close', () => events.push('stdin_close'));
    child.on('exit', () => {
        events.push('child_exit');
        atExit = {
            destroyed: child.stdin!.destroyed,
            writable: child.stdin!.writable,
            writableEnded: child.stdin!.writableEnded,
        };
    });
    child.on('close', () => events.push('child_close'));

    await waitClose(child);
    await sleep(500);

    ok(atExit !== null, "'exit' was never emitted");
    // destroy() runs before 'exit'.
    strictEqual(atExit!.destroyed, true, "child.stdin was not destroyed by the time 'exit' was emitted");
    strictEqual(atExit!.writable, false);
    // A destroy(), NOT an end(): node leaves writableEnded false.
    strictEqual(atExit!.writableEnded, false, 'stdin was end()ed instead of destroy()ed');
    strictEqual(child.stdin!.writableEnded, false);
    // Node's order. stdin's 'close' is tick-deferred by destroy(), while the
    // child's 'close' is emitted synchronously in the same turn as 'exit'.
    deepStrictEqual(events, ['child_exit', 'child_close', 'stdin_close']);
    // A clean destroy must not invent an error on stdin.
    strictEqual(child.stdin!.errored, null);
});

// Node keeps `stdio[0]` and `stdin` the same object, so destroying one is
// observable through the other (measured: true).
Deno.test({ name: 'child_process: stdio[0] is the same object as stdin', timeout: 30000 }, async () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    strictEqual(child.stdio[0], child.stdin);
    child.stdout!.resume();
    await waitClose(child);
    await sleep(200);
    strictEqual((child.stdio[0] as Writable).destroyed, true);
});

// ── stdout/stderr must NOT be dragged into it ───────────────────────────────

// Measured on node v24.18: stdout/stderr reach EOF on their own, so their
// `finished()` RESOLVES (it does not reject the way stdin's does). cno already
// matched this and it must stay that way — a destroy() on the readable side
// would flip these to a premature-close rejection.
Deno.test({ name: 'child_process: stdout and stderr end rather than premature-close', timeout: 30000 }, async () => {
    const child = spawn(process.execPath, ['-e', "console.log('out')"], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout!.resume();
    child.stderr!.resume();
    await waitClose(child);
    strictEqual(await settle(finished(child.stdout!, { cleanup: true }), 8000), 'RESOLVED');
    strictEqual(await settle(finished(child.stderr!, { cleanup: true }), 8000), 'RESOLVED');
    strictEqual(child.stdout!.readableEnded, true);
});

// ── the cases with no stdin object, or no streams at all ────────────────────

// 'inherit' and 'ignore' leave stdin null (measured: null for both), so the exit
// path has nothing to destroy and must not throw. A `stdin.destroy()` without a
// null guard would turn every inherit/ignore child into an exit-path crash.
for (const mode of ['inherit', 'ignore'] as const) {
    Deno.test({ name: `child_process: stdio '${mode}' exits cleanly with no stdin to destroy`, timeout: 30000 }, async () => {
        const child = spawn(process.execPath, ['-e', '0'], { stdio: mode });
        strictEqual(child.stdin, null);
        strictEqual(child.stdio[0], null);
        const code = await new Promise<number | null>((resolve) => child.once('close', (c) => resolve(c)));
        strictEqual(code, 0);
    });
}

// spawnSync has no streams at all — nothing on the destroy path may touch it.
Deno.test({ name: 'child_process: spawnSync is unaffected and exposes no stdin stream', timeout: 30000 }, () => {
    const result = spawnSync(process.execPath, ['-e', "console.log('s')"], { encoding: 'utf8' });
    strictEqual(result.status, 0);
    strictEqual(String(result.stdout).trim(), 's');
    strictEqual('stdin' in (result as unknown as Record<string, unknown>), false);
});

// ── signal death and detached take the same path ────────────────────────────

// Measured on node v24.18: a SIGKILLed child destroys stdin just the same
// (destroyed=true at 'exit', writableEnded=false). The destroy must hang off
// process exit generally, not off a normal-exit-only branch.
Deno.test({ name: 'child_process: a signal-killed child still destroys stdin', timeout: 30000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout!.resume();
    const pending = settle(finished(child.stdin!, { cleanup: true }), 12000);
    let destroyedAtExit: boolean | null = null;
    child.on('exit', () => { destroyedAtExit = child.stdin!.destroyed; });
    await sleep(400);
    child.kill('SIGKILL');
    await waitClose(child);
    await sleep(300);
    strictEqual(destroyedAtExit, true, 'stdin was not destroyed for a signal-killed child');
    strictEqual(child.stdin!.writableEnded, false);
    ok(await pending !== 'NEVER_SETTLED', 'finished(stdin) never settled for a signal-killed child');
});

Deno.test({ name: 'child_process: a detached child destroys stdin the same way', timeout: 30000 }, async () => {
    const child = spawn(process.execPath, ['-e', "console.log('d')"], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stdout!.resume();
    const pending = settle(finished(child.stdin!, { cleanup: true }), 12000);
    await waitClose(child);
    await sleep(300);
    strictEqual(child.stdin!.destroyed, true);
    strictEqual(child.stdin!.writableEnded, false);
    ok(await pending !== 'NEVER_SETTLED', 'finished(stdin) never settled for a detached child');
});

// ── a write the child never reads ───────────────────────────────────────────

// Measured on node v24.18: the destroy DISCARDS the queued bytes rather than
// flushing them — writableLength drops to 0, writableEnded stays false, and the
// pending write callback is invoked with an error. An `end()` here would block on
// a child that is already gone.
Deno.test({ name: 'child_process: a write the child never reads is discarded, not flushed', timeout: 30000 }, async () => {
    const child = spawn(process.execPath, ['-e', "console.log('never-reads-stdin')"], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout!.resume();
    child.stdin!.on('error', () => { /* EOF on a dead child's pipe is expected */ });

    let writeCb: 'nocall' | 'ok' | 'err' = 'nocall';
    child.stdin!.write(Buffer.alloc(200_000, 0x61), (err) => { writeCb = err ? 'err' : 'ok'; });

    await waitClose(child);
    await sleep(600);

    strictEqual(child.stdin!.destroyed, true);
    strictEqual(child.stdin!.writableEnded, false, 'the unread write was flushed via end() instead of discarded');
    strictEqual(child.stdin!.writableLength, 0, 'bytes were left queued on a destroyed stdin');
    // Node reports the failed write to its callback rather than dropping it.
    ok(writeCb !== 'nocall', 'the pending write callback was never invoked');
});

// ── execa's stdin _destroy spy ──────────────────────────────────────────────

// execa's `spyOnStdinDestroy` (lib/resolve/wait-stream.js) does
// `const {_destroy} = subprocess.stdin` and later `_destroy.call(stdin, ...)`.
// A Writable built with no `destroy` option has no `_destroy` at all, so every
// execa child raised "cannot read property 'call' of undefined", which the
// stream layer then turned into a spurious 'error' on the child's stdin.
Deno.test({ name: 'child_process: child.stdin exposes a callable _destroy for wrappers to spy on', timeout: 30000 }, async () => {
    const child = spawn(process.execPath, ['-e', "console.log('spy')"], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout!.resume();
    const stdin = child.stdin! as Writable & { _destroy?: unknown };
    strictEqual(typeof stdin._destroy, 'function', 'child.stdin._destroy is missing; execa-style destroy spies throw');

    // Reproduce the spy exactly and make sure it survives the exit-path destroy.
    const original = stdin._destroy as (...a: unknown[]) => void;
    let spyCalls = 0;
    stdin._destroy = (...args: unknown[]) => { spyCalls++; original.call(stdin, ...args); };

    await waitClose(child);
    await sleep(400);
    strictEqual(spyCalls, 1, 'the exit path did not route through stdin._destroy exactly once');
    strictEqual(child.stdin!.destroyed, true);
    strictEqual(child.stdin!.errored, null, 'the destroy spy produced a spurious error on stdin');
});

// ── many children in a row ─────────────────────────────────────────────────

// Destroying stdin closes the native pipe. If that leaked a handle or kept the
// loop alive, a short sequential run is where it shows up first.
Deno.test({ name: 'child_process: twelve sequential children all settle their stdin', timeout: 60000 }, async () => {
    for (let i = 0; i < 12; i++) {
        const child = spawn(process.execPath, ['-e', `console.log(${i})`], { stdio: ['pipe', 'pipe', 'pipe'] });
        // Both waiters must be registered up front: stdin's 'close' now lands
        // AFTER the child's 'close', so attaching the child listener afterwards
        // would miss the event and wait forever.
        const closed = waitClose(child);
        const pending = settle(finished(child.stdin!, { cleanup: true }), 8000);
        child.stdout!.resume();
        await closed;
        const outcome = await pending;
        ok(outcome !== 'NEVER_SETTLED', `iteration ${i}: finished(child.stdin) never settled`);
    }
});
