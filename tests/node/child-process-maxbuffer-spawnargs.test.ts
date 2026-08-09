/**
 * child_process: spawnSync maxBuffer semantics and spawn-failure `spawnargs`.
 *
 * Every expectation here was measured against real Node v24.18.0 on Windows 11
 * before being written down.
 *
 * Two defects are pinned:
 *
 * 1. maxBuffer. Node does NOT truncate captured output to `maxBuffer`. It reads
 *    64KiB chunks and keeps everything read, including the chunk that crossed
 *    the limit, so captured = min(total, (floor(maxBuffer/65536)+1)*65536).
 *    cno used to slice to exactly `maxBuffer`, report `signal: null` where Node
 *    reports 'SIGTERM', treat `maxBuffer: 0` as "capture nothing" (returning an
 *    EMPTY stdout plus a spurious ENOBUFS on what Node calls a success), and
 *    silently ignore a negative/NaN maxBuffer that Node rejects outright.
 *
 * 2. spawnargs. A failed spawn carries `spawnargs` in Node on every route.
 *    normalizeSpawnFailure's fall-through (used when the native error already
 *    has a usable `code`, which is the bare-command case) returned asError(),
 *    which takes no args, so the key was silently missing there while the
 *    pre-flighted path-like route had it. execa and cross-spawn both read
 *    `spawnargs` when formatting a failure.
 */
import { strictEqual, ok, throws, deepStrictEqual } from 'node:assert';
import { spawn, spawnSync, execSync, execFileSync } from 'node:child_process';
import { finished } from 'node:stream';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { withTempDir } from '../_helpers/temp.ts';

const CHUNK = 65536;

/** Child writing `n` deterministic bytes to stdout, where byte i = i % 256. */
const BIGOUT = 'const n=Number(process.argv[2]);const b=Buffer.alloc(n);'
    + 'for(let i=0;i<n;i++)b[i]=i%256;require("fs").writeSync(1,b);';

function scriptIn(dir: string, name: string, body: string): string {
    const p = join(dir, name);
    fs.writeFileSync(p, body + '\n');
    return p;
}

/** Node's measured capture length for a given limit and total output size. */
function nodeCaptureLen(maxBuffer: number, total: number): number {
    return Math.min(total, (Math.floor(maxBuffer / CHUNK) + 1) * CHUNK);
}

// ── maxBuffer: capture length is chunk-rounded, never sliced to maxBuffer ────

// Measured on v24.18: mb=1000/out=200000 -> 65536 bytes (NOT 1000);
// mb=65536 and mb=70000 and mb=100000 all -> 131072; mb=10/out=100000 -> 65536.
// The truncate-to-maxBuffer bug is invisible to a "did it report ENOBUFS?" test
// because ENOBUFS is reported correctly either way -- it is a silent data
// difference, which is why this asserts the exact length.
for (const [maxBuffer, total] of [[1000, 200000], [10, 100000], [65536, 200000], [70000, 200000]] as const) {
    Deno.test({
        name: `child_process: spawnSync maxBuffer=${maxBuffer} captures ${nodeCaptureLen(maxBuffer, total)} bytes of ${total}`,
        timeout: 30000,
    }, async () => {
        await withTempDir('cp-mb', async (dir) => {
            const script = scriptIn(dir, 'big.js', BIGOUT);
            const r = spawnSync(process.execPath, [script, String(total)], { maxBuffer });
            strictEqual(r.error?.code, 'ENOBUFS', 'overflow must report ENOBUFS');
            strictEqual(r.status, null, 'status is null when the child was killed');
            // Node kills the child once the limit is crossed and reports the signal.
            strictEqual(r.signal, 'SIGTERM', 'Node reports SIGTERM on a maxBuffer kill');
            strictEqual(r.stdout?.length, nodeCaptureLen(maxBuffer, total));
        });
    });
}

// Total output below one chunk: capture is the whole output, not `maxBuffer`.
// Measured: mb=1000/out=2000 -> 2000 bytes with ENOBUFS.
Deno.test({ name: 'child_process: spawnSync maxBuffer keeps a sub-chunk overflow whole', timeout: 30000 }, async () => {
    await withTempDir('cp-mb-sub', async (dir) => {
        const script = scriptIn(dir, 'big.js', BIGOUT);
        const r = spawnSync(process.execPath, [script, '2000'], { maxBuffer: 1000 });
        strictEqual(r.error?.code, 'ENOBUFS');
        strictEqual(r.stdout?.length, 2000, 'the full 2000 bytes survive, not 1000');
        strictEqual(r.signal, 'SIGTERM');
    });
});

// Under the limit: clean success, no invented error.
Deno.test({ name: 'child_process: spawnSync under maxBuffer succeeds cleanly', timeout: 30000 }, async () => {
    await withTempDir('cp-mb-ok', async (dir) => {
        const script = scriptIn(dir, 'big.js', BIGOUT);
        const r = spawnSync(process.execPath, [script, '500'], { maxBuffer: 1000 });
        strictEqual(r.error, undefined);
        strictEqual(r.status, 0);
        strictEqual(r.signal, null);
        strictEqual(r.stdout?.length, 500);
    });
});

// maxBuffer: 0 means NO LIMIT in Node, not "capture nothing". Measured: 2MiB of
// output passes through with status 0 and no error. The old `maxBuffer >= 0`
// guard made this return an EMPTY stdout plus a spurious ENOBUFS -- total output
// loss on a call Node treats as a success.
Deno.test({ name: 'child_process: spawnSync maxBuffer 0 means unlimited', timeout: 60000 }, async () => {
    await withTempDir('cp-mb-zero', async (dir) => {
        const script = scriptIn(dir, 'big.js', BIGOUT);
        const total = 2 * 1024 * 1024;
        const r = spawnSync(process.execPath, [script, String(total)], { maxBuffer: 0 });
        strictEqual(r.error, undefined, 'maxBuffer 0 must not synthesise an error');
        strictEqual(r.status, 0);
        strictEqual(r.stdout?.length, total, 'all bytes must survive maxBuffer 0');
    });
});

Deno.test({ name: 'child_process: spawnSync maxBuffer Infinity means unlimited', timeout: 60000 }, async () => {
    await withTempDir('cp-mb-inf', async (dir) => {
        const script = scriptIn(dir, 'big.js', BIGOUT);
        const total = 200000;
        const r = spawnSync(process.execPath, [script, String(total)], { maxBuffer: Infinity });
        strictEqual(r.error, undefined);
        strictEqual(r.stdout?.length, total);
    });
});

// Node validates the range before spawning anything and throws ERR_OUT_OF_RANGE.
// Silently ignoring it lets a caller's typo disable the cap entirely.
for (const bad of [-1, NaN] as const) {
    Deno.test({ name: `child_process: spawnSync rejects maxBuffer ${bad} with ERR_OUT_OF_RANGE`, timeout: 20000 }, () => {
        throws(
            () => spawnSync(process.execPath, ['-e', 'null'], { maxBuffer: bad }),
            (err: NodeJS.ErrnoException) => {
                strictEqual(err.code, 'ERR_OUT_OF_RANGE');
                ok(err instanceof RangeError, 'must be a RangeError');
                return true;
            },
        );
    });
}

// ── spawn failure carries spawnargs on every route ───────────────────────────

// A bare command name is not pre-flighted (CreateProcess owns PATH lookup), so
// the failure arrives with a usable code and takes normalizeSpawnFailure's
// fall-through. That route dropped `spawnargs`. A path-like command takes the
// pre-flight route, which always had it -- so testing only one route hides the
// bug. Both are asserted here.
for (const [label, command] of [
    ['bare name', 'definitely-not-a-real-binary-xyz'],
    ['path-like', 'D:/definitely/not/a/real/path/nope-missing.exe'],
] as const) {
    Deno.test({ name: `child_process: spawn ENOENT carries spawnargs (${label})`, timeout: 20000 }, async () => {
        const err = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no 'error' event for ${label}`)), 15000);
            const child = spawn(command, ['a', 'b']);
            child.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(e); });
            child.on('close', () => { /* 'error' is what this asserts on */ });
        });
        strictEqual(err.code, 'ENOENT');
        strictEqual(err.syscall, `spawn ${command}`);
        strictEqual(err.path, command);
        // The whole point: execa/cross-spawn read this when formatting failures.
        deepStrictEqual(err.spawnargs, ['a', 'b'], 'spawnargs must survive both routes');
        deepStrictEqual(
            Object.keys(err).sort(),
            ['code', 'errno', 'path', 'spawnargs', 'syscall'],
            "Node's own-key set for a spawn ENOENT",
        );
    });
}

// spawnSync's ENOENT already carried spawnargs; pinned so a shared refactor of
// normalizeSpawnFailure cannot regress the sync route while fixing the async one.
Deno.test({ name: 'child_process: spawnSync ENOENT carries spawnargs', timeout: 20000 }, () => {
    const r = spawnSync('definitely-not-a-real-binary-xyz', ['a', 'b']);
    const err = r.error as NodeJS.ErrnoException;
    ok(err, 'spawnSync must report an error');
    strictEqual(err.code, 'ENOENT');
    deepStrictEqual(err.spawnargs, ['a', 'b']);
});

// ── failed spawn still exposes 'pipe' stdio streams ──────────────────────────

// A spawn that never started still hands back stream objects for every 'pipe'
// slot in Node, per slot -- not all-or-nothing null. Measured on v24.18/Windows:
//   'pipe' -> objects; 'ignore'/'inherit' -> null;
//   ['pipe','ignore','inherit'] -> stdin object, stdout null, stderr null;
//   ['pipe','pipe','pipe','pipe'] -> fd 3 an object, child.stdio.length 4.
// Returning null everywhere made the ordinary `child.stdout.on('data', …)`
// wiring throw "cannot read property 'on' of null" before the 'error' event
// could be delivered -- exactly what execa/cross-spawn-shaped code does.
const MISSING_CMD = 'definitely-not-a-real-binary-xyz';

Deno.test({ name: 'child_process: failed spawn exposes pipe stdio as objects', timeout: 20000 }, async () => {
    const child = spawn(MISSING_CMD, ['a', 'b'], { stdio: 'pipe' });
    const seen = await new Promise<{ err: string; wired: boolean }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no 'error' event")), 15000);
        let wired = false;
        // The whole point: this must not throw on a null stream.
        try {
            child.stdout!.on('data', () => {});
            child.stderr!.on('data', () => {});
            wired = true;
        } catch (e) {
            clearTimeout(timer);
            reject(new Error('wiring stdio threw: ' + (e as Error).message));
            return;
        }
        child.on('error', (e: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            resolve({ err: e.code ?? '', wired });
        });
    });
    strictEqual(seen.err, 'ENOENT');
    ok(seen.wired, 'stdout/stderr must be wireable on a failed spawn');
    ok(child.stdin !== null, 'stdin must be an object for a pipe slot');
    ok(child.stdout !== null, 'stdout must be an object for a pipe slot');
    ok(child.stderr !== null, 'stderr must be an object for a pipe slot');
});

// Non-pipe slots stay null, so the fix must be per slot rather than blanket.
Deno.test({ name: 'child_process: failed spawn leaves ignore/inherit stdio null', timeout: 20000 }, async () => {
    for (const stdio of ['ignore', 'inherit'] as const) {
        const child = spawn(MISSING_CMD, ['a'], { stdio });
        await new Promise<void>((resolve) => child.on('error', () => resolve()));
        strictEqual(child.stdin, null, `${stdio}: stdin must stay null`);
        strictEqual(child.stdout, null, `${stdio}: stdout must stay null`);
        strictEqual(child.stderr, null, `${stdio}: stderr must stay null`);
    }
});

Deno.test({ name: 'child_process: failed spawn honours a mixed stdio array per slot', timeout: 20000 }, async () => {
    const child = spawn(MISSING_CMD, ['a'], { stdio: ['pipe', 'ignore', 'inherit'] });
    await new Promise<void>((resolve) => child.on('error', () => resolve()));
    ok(child.stdin !== null, 'pipe slot 0 must be an object');
    strictEqual(child.stdout, null, 'ignore slot 1 must be null');
    strictEqual(child.stderr, null, 'inherit slot 2 must be null');
});

Deno.test({ name: 'child_process: failed spawn exposes extra pipe fds', timeout: 20000 }, async () => {
    const child = spawn(MISSING_CMD, ['a'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    await new Promise<void>((resolve) => child.on('error', () => resolve()));
    strictEqual(child.stdio.length, 4, 'stdio must keep the extra slot');
    ok(child.stdio[3] !== null && child.stdio[3] !== undefined, 'fd 3 must be an object');
});

// The streams must SETTLE or the fix would trade a TypeError for a hang.
// Measured on v24.18: stdout/stderr settle cleanly, stdin settles with
// ERR_STREAM_PREMATURE_CLOSE (it is destroyed, not ended).
Deno.test({ name: 'child_process: failed spawn stdio streams settle finished()', timeout: 30000 }, async () => {
    const child = spawn(MISSING_CMD, ['a'], { stdio: 'pipe' });
    child.on('error', () => {});
    const settle = (label: string, stream: unknown) => Promise.race([
        new Promise<string>((resolve) => finished(stream as Parameters<typeof finished>[0], (err) =>
            resolve(`${label}:${(err as NodeJS.ErrnoException | null)?.code ?? 'clean'}`))),
        new Promise<string>((resolve) => setTimeout(() => resolve(`${label}:NEVER-SETTLED`), 12000)),
    ]);
    const results = await Promise.all([
        settle('stdout', child.stdout),
        settle('stderr', child.stderr),
        settle('stdin', child.stdin),
    ]);
    deepStrictEqual(results, [
        'stdout:clean',
        'stderr:clean',
        'stdin:ERR_STREAM_PREMATURE_CLOSE',
    ]);
});

// ── extra stdio (fd >= 3) duplex streams ─────────────────────────────────────

// A Duplex built with no `destroy` option has NO `_destroy` method at all, and
// `final()` is skipped on the destroy path so the native pipe leaked. Measured on
// v24.18: node's fd-3 stream has a `_destroy` function, and destroying it settles
// 'close'. Without the hook cno's `_destroy` was undefined, so the
// `const {_destroy} = stream` + `_destroy.call(...)` pattern (execa's
// spyOnStdinDestroy) threw and 'close' never fired -- a silent never-settling
// promise for anyone awaiting stream close on an extra stdio fd.
Deno.test({ name: 'child_process: extra stdio fd 3 has _destroy and settles close', timeout: 30000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    try {
        const extra = child.stdio[3] as unknown as {
            _destroy?: unknown;
            destroy: () => void;
            on: (ev: string, fn: () => void) => void;
        };
        ok(extra, 'fd 3 must be present');
        strictEqual(typeof extra._destroy, 'function', 'fd-3 stream needs a _destroy method');

        // Exactly execa's spyOnStdinDestroy shape: destructure then .call().
        const original = extra._destroy as (...a: unknown[]) => void;
        let wrapperThrew: string | null = null;
        extra._destroy = (...a: unknown[]) => {
            try {
                original.call(extra, ...a);
            } catch (e) {
                wrapperThrew = (e as Error).message;
                throw e;
            }
        };

        const closed = await new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve('NEVER-SETTLED'), 10000);
            extra.on('close', () => { clearTimeout(timer); resolve('close'); });
            extra.destroy();
        });
        strictEqual(closed, 'close', 'destroying an fd-3 stream must settle close');
        strictEqual(wrapperThrew, null, 'the _destroy wrapper must not throw');
    } finally {
        try { child.kill(); } catch { /* already gone */ }
    }
});

// ── execSync/execFileSync failure message ────────────────────────────────────

// Node joins stderr onto the message with a newline ONLY when stderr is non-empty.
// Measured on v24.18: a silent non-zero exit gives exactly
// `Command failed: <cmd>` with no trailing newline. Building the message as
// `Command failed: ${cmd}\n${stderr}` unconditionally left a stray trailing "\n".
Deno.test({ name: 'child_process: execSync failure message has no trailing newline without stderr', timeout: 30000 }, () => {
    throws(
        () => execSync(`"${process.execPath}" -e "process.exit(3)"`, { stdio: 'pipe' }),
        (err: NodeJS.ErrnoException & { status?: number }) => {
            strictEqual(err.status, 3);
            strictEqual(err.message.endsWith('\n'), false, `message must not end with a newline: ${JSON.stringify(err.message)}`);
            ok(err.message.startsWith('Command failed: '), 'keeps Node\'s prefix');
            return true;
        },
    );
});

// The non-empty case keeps the newline separator, so the fix must not strip it.
Deno.test({ name: 'child_process: execSync failure message keeps stderr after a newline', timeout: 30000 }, () => {
    throws(
        () => execSync(`"${process.execPath}" -e "process.stderr.write('BOOM');process.exit(4)"`, { stdio: 'pipe' }),
        (err: NodeJS.ErrnoException & { status?: number }) => {
            strictEqual(err.status, 4);
            ok(err.message.endsWith('\nBOOM'), `stderr must follow a newline: ${JSON.stringify(err.message)}`);
            return true;
        },
    );
});

Deno.test({ name: 'child_process: execFileSync failure message has no trailing newline without stderr', timeout: 30000 }, () => {
    throws(
        () => execFileSync(process.execPath, ['-e', 'process.exit(5)'], { stdio: 'pipe' }),
        (err: NodeJS.ErrnoException & { status?: number }) => {
            strictEqual(err.status, 5);
            strictEqual(err.message.endsWith('\n'), false, `message must not end with a newline: ${JSON.stringify(err.message)}`);
            return true;
        },
    );
});
