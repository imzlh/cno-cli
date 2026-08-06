/**
 * Pins the fs error-code contract against real Node on Windows.
 *
 * Background: the native *sync* fs layer (circu.js/src/mod_fs.c, the
 * `tjs_syncfs_*` family) used to feed a CRT `errno` into
 * `uv_translate_sys_error()`, which expects a Win32 error code, so sync errors
 * surfaced with an unrelated `code`. That has been fixed in C (`fs_errno2uv`),
 * so the raw values are now real UV codes. What remains is *classification*:
 * Windows returns one coarse error (usually EACCES) where Node reports a
 * specific one, and the sync C layer throws a bare TypeError with no errno for
 * the reparse-point / copy family. `cno/src/node/fs/errno-fix.ts` closes that
 * gap by probing the filesystem; these assertions lock in the result.
 *
 * Note that a correction keyed on the *old* mangled value silently stops firing
 * once the C layer is fixed — that is exactly how `readFileSync(dir)` regressed
 * from EISDIR to EACCES. If mod_fs.c changes again, re-measure the raw errno
 * rather than assuming these still hold.
 *
 * `asyncfs` goes through libuv and does its own translation, so it is unaffected.
 *
 * Every expectation below was measured against real Node v24.18.0 on
 * Windows 11, not recalled.
 */
import { strictEqual } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

/** Run `fn`, return the thrown error's `code`, or 'NO-THROW'. */
function codeOf(fn: () => unknown): string {
    try {
        fn();
        return 'NO-THROW';
    } catch (e) {
        const c = (e as NodeJS.ErrnoException)?.code;
        return c === undefined ? 'code=undefined' : String(c);
    }
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string> {
    try {
        await fn();
        return 'NO-THROW';
    } catch (e) {
        const c = (e as NodeJS.ErrnoException)?.code;
        return c === undefined ? 'code=undefined' : String(c);
    }
}

Deno.test('fs errno: sync ENOENT family matches Node', async () => {
    await withTempDir('fserrno-enoent', (dir) => {
        const missing = join(dir, 'nope');
        strictEqual(codeOf(() => fs.readFileSync(missing)), 'ENOENT');
        strictEqual(codeOf(() => fs.openSync(missing, 'r')), 'ENOENT');
        strictEqual(codeOf(() => fs.statSync(missing)), 'ENOENT');
        strictEqual(codeOf(() => fs.truncateSync(missing, 0)), 'ENOENT');
        strictEqual(codeOf(() => fs.chmodSync(missing, 0o644)), 'ENOENT');
        strictEqual(codeOf(() => fs.realpathSync(missing)), 'ENOENT');
        strictEqual(codeOf(() => fs.utimesSync(missing, 0, 0)), 'ENOENT');
        strictEqual(codeOf(() => fs.copyFileSync(missing, join(dir, 'cp'))), 'ENOENT');
        strictEqual(codeOf(() => fs.renameSync(missing, join(dir, 'dst'))), 'ENOENT');
    });
});

Deno.test('fs errno: sync EISDIR when a directory is used as a file', async () => {
    await withTempDir('fserrno-eisdir', (dir) => {
        const sub = join(dir, 'sub');
        fs.mkdirSync(sub);
        strictEqual(codeOf(() => fs.readFileSync(sub)), 'EISDIR');
        strictEqual(codeOf(() => fs.openSync(sub, 'w')), 'EISDIR');
    });
});

Deno.test('fs errno: sync EEXIST / ENOTEMPTY / EPERM match Node', async () => {
    await withTempDir('fserrno-eexist', (dir) => {
        const sub = join(dir, 'sub');
        fs.mkdirSync(sub);
        strictEqual(codeOf(() => fs.mkdirSync(sub)), 'EEXIST');

        const file = join(dir, 'f.txt');
        fs.writeFileSync(file, 'x');
        strictEqual(codeOf(() => fs.linkSync(file, sub)), 'EEXIST');

        const nonEmpty = join(dir, 'ne');
        fs.mkdirSync(nonEmpty);
        fs.writeFileSync(join(nonEmpty, 'child'), 'x');
        strictEqual(codeOf(() => fs.rmdirSync(nonEmpty)), 'ENOTEMPTY');

        // unlink of a directory is EPERM on Windows, per Node.
        strictEqual(codeOf(() => fs.unlinkSync(sub)), 'EPERM');
    });
});

Deno.test('fs errno: sync ENOTDIR when a directory op targets a file', async () => {
    await withTempDir('fserrno-enotdir', (dir) => {
        const file = join(dir, 'f.txt');
        fs.writeFileSync(file, 'x');
        strictEqual(codeOf(() => fs.readdirSync(file)), 'ENOTDIR');
        // Node reports ENOENT (not ENOTDIR) when traversing *through* a file.
        strictEqual(codeOf(() => fs.readFileSync(join(file, 'sub'))), 'ENOENT');
    });
});

Deno.test('fs errno: sync EBADF on fd syscalls with a bogus descriptor', () => {
    const BOGUS = 99999;
    strictEqual(codeOf(() => fs.fstatSync(BOGUS)), 'EBADF');
    strictEqual(codeOf(() => fs.readSync(BOGUS, Buffer.alloc(4), 0, 4, 0)), 'EBADF');
    strictEqual(codeOf(() => fs.closeSync(BOGUS)), 'EBADF');
});

Deno.test('fs errno: sync and async agree on code for the same failure', async () => {
    await withTempDir('fserrno-parity', async (dir) => {
        const missing = join(dir, 'nope');
        const sub = join(dir, 'sub');
        fs.mkdirSync(sub);

        // Cases where Node itself reports the same code from both paths.
        strictEqual(codeOf(() => fs.readFileSync(missing)), await asyncCodeOf(() => fsp.readFile(missing)));
        strictEqual(codeOf(() => fs.statSync(missing)), await asyncCodeOf(() => fsp.stat(missing)));
        strictEqual(codeOf(() => fs.readFileSync(sub)), await asyncCodeOf(() => fsp.readFile(sub)));
        strictEqual(codeOf(() => fs.mkdirSync(sub)), await asyncCodeOf(() => fsp.mkdir(sub)));
        strictEqual(codeOf(() => fs.unlinkSync(sub)), await asyncCodeOf(() => fsp.unlink(sub)));
    });
});

Deno.test('fs errno: sync readonly-attribute write is EPERM', async () => {
    await withTempDir('fserrno-ro', (dir) => {
        const ro = join(dir, 'ro.txt');
        fs.writeFileSync(ro, 'ro');
        fs.chmodSync(ro, 0o444);
        try {
            // Windows denies the write with ERROR_ACCESS_DENIED -> EACCES, but Node
            // reports EPERM for the read-only attribute specifically.
            strictEqual(codeOf(() => fs.writeFileSync(ro, 'z')), 'EPERM');
            strictEqual(codeOf(() => fs.openSync(ro, 'w')), 'EPERM');
            strictEqual(codeOf(() => fs.appendFileSync(ro, 'z')), 'EPERM');
            strictEqual(codeOf(() => fs.truncateSync(ro, 0)), 'EPERM');
            // A read-only open of the same file still succeeds.
            fs.closeSync(fs.openSync(ro, 'r'));
        } finally {
            fs.chmodSync(ro, 0o666);
        }
    });
});

Deno.test('fs errno: sync rmdir on a non-directory is ENOENT', async () => {
    await withTempDir('fserrno-rmdir', (dir) => {
        const file = join(dir, 'f.txt');
        fs.writeFileSync(file, 'x');
        // Windows reports "not a directory"; Node reports ENOENT, because there is
        // no *directory* by that name.
        strictEqual(codeOf(() => fs.rmdirSync(file)), 'ENOENT');
        strictEqual(codeOf(() => fs.rmdirSync(join(dir, 'missing'))), 'ENOENT');
    });
});

Deno.test('fs errno: sync readlink on a non-symlink is EINVAL', async () => {
    await withTempDir('fserrno-readlink', (dir) => {
        const file = join(dir, 'f.txt');
        fs.writeFileSync(file, 'x');
        const sub = join(dir, 'sub');
        fs.mkdirSync(sub);
        const nonEmpty = join(dir, 'ne');
        fs.mkdirSync(nonEmpty);
        fs.writeFileSync(join(nonEmpty, 'child'), 'x');

        // The native sync layer throws a bare TypeError with a localized message
        // and no errno for these; errno-fix classifies by probing the filesystem.
        strictEqual(codeOf(() => fs.readlinkSync(file)), 'EINVAL');
        strictEqual(codeOf(() => fs.readlinkSync(sub)), 'EINVAL');
        strictEqual(codeOf(() => fs.readlinkSync(nonEmpty)), 'EINVAL');
        strictEqual(codeOf(() => fs.readlinkSync(join(dir, 'missing'))), 'ENOENT');
    });
});

Deno.test('fs errno: sync EPERM when a directory blocks the destination', async () => {
    await withTempDir('fserrno-blocked', (dir) => {
        const file = join(dir, 'f.txt');
        fs.writeFileSync(file, 'x');
        const sub = join(dir, 'sub');
        fs.mkdirSync(sub);
        const nonEmpty = join(dir, 'ne');
        fs.mkdirSync(nonEmpty);
        fs.writeFileSync(join(nonEmpty, 'child'), 'x');

        // Node distinguishes by WHAT is in the way: a directory is EPERM, a plain
        // file is EEXIST. Empty vs non-empty makes no difference.
        strictEqual(codeOf(() => fs.copyFileSync(file, sub)), 'EPERM');
        strictEqual(codeOf(() => fs.copyFileSync(file, nonEmpty)), 'EPERM');
        strictEqual(codeOf(() => fs.renameSync(file, nonEmpty)), 'EPERM');
        // link is the exception: an existing directory destination is EEXIST.
        strictEqual(codeOf(() => fs.linkSync(file, nonEmpty)), 'EEXIST');

        // Only assert symlink where the host actually grants the privilege.
        const probe = join(dir, 'probe-link');
        let maySymlink = true;
        try { fs.symlinkSync(file, probe); } catch { maySymlink = false; }
        if (maySymlink) {
            strictEqual(codeOf(() => fs.symlinkSync(file, sub)), 'EPERM');
            strictEqual(codeOf(() => fs.symlinkSync(file, nonEmpty)), 'EPERM');
            strictEqual(codeOf(() => fs.symlinkSync(file, file)), 'EEXIST');
        }
    });
});

Deno.test('fs errno: sync truncate of a directory is EINVAL, not EISDIR', async () => {
    await withTempDir('fserrno-trunc', (dir) => {
        const sub = join(dir, 'sub');
        fs.mkdirSync(sub);
        // Deliberately not EISDIR: measured EINVAL on real Node for truncate.
        strictEqual(codeOf(() => fs.truncateSync(sub, 0)), 'EINVAL');
    });
});

Deno.test('fs errno: promises errors expose a string code, never a raw UV number', async () => {
    await withTempDir('fserrno-ptrunc', async (dir) => {
        const sub = join(dir, 'sub');
        fs.mkdirSync(sub);

        // `fsp.truncate` opens then ftruncates. The ftruncate step used to reject
        // unwrapped, so `code` arrived as the raw UV number (-4071) with errno and
        // syscall undefined — every `err.code === 'EINVAL'` check failed silently.
        strictEqual(await asyncCodeOf(() => fsp.truncate(sub, 0)), 'EINVAL');

        // Same class of bug on the FileHandle: a closed handle used to reject with a
        // bare Error carrying no `code` at all. Node reports EBADF.
        const fh = await fsp.open(join(dir, 'f.txt'), 'w');
        await fh.close();
        strictEqual(await asyncCodeOf(() => fh.stat()), 'EBADF');
    });
});

/*
 * ---------------------------------------------------------------------------
 * fd-syscall determinism.
 *
 * `mod_fs.c`'s fd entry points fail inside `_get_osfhandle(fd)`, a CRT call that
 * sets CRT `errno` and leaves the Win32 last-error untouched. `THROW2` then
 * formats `GetLastError()`, so the reported code was whatever the *previous*
 * unrelated Win32 call happened to leave behind. Measured before the fix, the
 * same `fsyncSync(99999)` call reported four different codes depending only on
 * what ran before it:
 *
 *   preceding call        cno (before)      real Node v24.18.0
 *   (none)                UNKNOWN errno=0   EBADF
 *   statSync(missing)     ENOENT            EBADF
 *   closeSync(bogus)      ENOENT            EBADF
 *   openSync(missing)     ENOENT            EBADF
 *
 * A plausible-but-wrong ENOENT is worse than UNKNOWN: retry logic keyed on
 * ENOENT acts on a path that is perfectly fine. `errno-fix.ts` now probes the
 * descriptor with `fstat` (the one fd call that reports EBADF correctly) and
 * returns EBADF whenever the fd is provably closed.
 * ---------------------------------------------------------------------------
 */
Deno.test('fs errno: fd-syscall code does not depend on the preceding call', () => {
    const BOGUS = 99999;
    const preceding: Array<[string, () => unknown]> = [
        ['none', () => undefined],
        ['statSync(missing)', () => fs.statSync('D:/tmp/fserrno-no-such-path')],
        ['closeSync(bogus)', () => fs.closeSync(BOGUS)],
        ['openSync(missing)', () => fs.openSync('D:/tmp/fserrno-no-such-path', 'r')],
        ['readdirSync(missing)', () => fs.readdirSync('D:/tmp/fserrno-no-such-path')],
    ];

    for (const [label, run] of preceding) {
        codeOf(run); // prime the Win32 last-error, ignore its own outcome
        strictEqual(codeOf(() => fs.fsyncSync(BOGUS)), 'EBADF', `fsync after ${label}`);
        codeOf(run);
        strictEqual(codeOf(() => fs.fdatasyncSync(BOGUS)), 'EBADF', `fdatasync after ${label}`);
    }
});

Deno.test('fs errno: errno-less fd throws still report EBADF', () => {
    const BOGUS = 99999;
    // These reach C paths that throw a bare TypeError with no errno at all
    // ("futimes: invalid file descriptor", "fchmod not supported on Windows"), so
    // `code` arrived as UNKNOWN and no `err.code === 'EBADF'` check could match.
    strictEqual(codeOf(() => fs.futimesSync(BOGUS, new Date(), new Date())), 'EBADF');
    strictEqual(codeOf(() => fs.ftruncateSync(BOGUS, 0)), 'EBADF');
    strictEqual(codeOf(() => fs.fstatSync(BOGUS)), 'EBADF');
});

Deno.test('fs errno: fd-syscall messages quote no synthetic path', () => {
    // fd errors carry `path` as the internal `fd:N` form. Node never prints that:
    // measured v24.18.0, `fsyncSync(99999)` reports exactly
    // "EBADF: bad file descriptor, fsync". A rebuilt message used to append
    // ", fsync 'fd:99999'", inventing a path string no real Node ever emits.
    let message = '';
    try { fs.fsyncSync(99999); } catch (e) { message = (e as Error).message; }
    strictEqual(message.includes('fd:'), false, `message leaked the fd: form: ${message}`);
});

/*
 * ---------------------------------------------------------------------------
 * chown/fchown are no-ops on Windows.
 *
 * libuv's `fs__chown`, `fs__fchown` and `fs__lchown` (deps/libuv/src/win/fs.c)
 * are each a bare `SET_REQ_RESULT(req, 0)` — a deliberate no-op, because Windows
 * has no POSIX uid/gid. Node therefore *succeeds* on Windows for any target,
 * including a missing path and a bogus fd (measured v24.18.0). The sync C layer
 * instead threw a bare TypeError "chown not supported on Windows" with no errno,
 * so cno reported code UNKNOWN where Node reported success.
 * ---------------------------------------------------------------------------
 */
Deno.test('fs errno: chown family matches libuv no-op on Windows', async () => {
    await withTempDir('fserrno-chown', (dir) => {
        const file = join(dir, 'f.txt');
        fs.writeFileSync(file, 'x');
        strictEqual(codeOf(() => fs.chownSync(file, 0, 0)), 'NO-THROW');
        strictEqual(codeOf(() => fs.chownSync(join(dir, 'missing'), 0, 0)), 'NO-THROW');
        strictEqual(codeOf(() => fs.lchownSync(file, 0, 0)), 'NO-THROW');
        strictEqual(codeOf(() => fs.fchownSync(99999, 0, 0)), 'NO-THROW');

        const fd = fs.openSync(file, 'r');
        const verdict = codeOf(() => fs.fchownSync(fd, 0, 0));
        fs.closeSync(fd);
        strictEqual(verdict, 'NO-THROW');
    });
});

Deno.test('fs errno: no fs error exposes a numeric code', async () => {
    // The dangerous class: a numeric `code` silently fails every
    // `err.code === 'EXXX'` comparison in the wild, so it cannot be caught by a
    // test that only asserts the expected code. Assert the *type* across a broad
    // spread of failures instead. Found `-4083` leaking from FileHandle.write on
    // a read-only handle this way.
    await withTempDir('fserrno-numeric', async (dir) => {
        const sub = join(dir, 'sub');
        fs.mkdirSync(sub);
        const file = join(dir, 'f.txt');
        fs.writeFileSync(file, 'hello');
        const missing = join(dir, 'nope');
        const BOGUS = 99999;

        const checkType = (label: string, e: unknown): void => {
            if (e === undefined) return;
            const code = (e as NodeJS.ErrnoException).code;
            strictEqual(
                typeof code,
                'string',
                `${label} exposed a ${typeof code} code (${String(code)}) — string comparisons fail silently`,
            );
        };

        const syncCases: Array<[string, () => unknown]> = [
            ['readFileSync(dir)', () => fs.readFileSync(sub)],
            ['truncateSync(dir)', () => fs.truncateSync(sub, 0)],
            ['unlinkSync(dir)', () => fs.unlinkSync(sub)],
            ['readlinkSync(file)', () => fs.readlinkSync(file)],
            ['copyFileSync(dir)', () => fs.copyFileSync(sub, join(dir, 'out'))],
            ['renameSync(file,dir)', () => fs.renameSync(file, sub)],
            ['rmdirSync(file)', () => fs.rmdirSync(file)],
            ['readdirSync(file)', () => fs.readdirSync(file)],
            ['fsyncSync(bogus)', () => fs.fsyncSync(BOGUS)],
            ['futimesSync(bogus)', () => fs.futimesSync(BOGUS, new Date(), new Date())],
            ['statSync(missing)', () => fs.statSync(missing)],
            ['mkdirSync(existing)', () => fs.mkdirSync(sub)],
            ['symlinkSync(onto dir)', () => fs.symlinkSync(file, sub)],
            ['openSync(dir,w)', () => fs.openSync(sub, 'w')],
        ];
        for (const [label, run] of syncCases) {
            let caught: unknown;
            try { run(); } catch (e) { caught = e; }
            checkType(label, caught);
        }

        const asyncCases: Array<[string, () => Promise<unknown>]> = [
            ['fsp.truncate(dir)', () => fsp.truncate(sub, 0)],
            ['fsp.readFile(dir)', () => fsp.readFile(sub)],
            ['fsp.copyFile(dir)', () => fsp.copyFile(sub, join(dir, 'out2'))],
            ['fsp.readlink(file)', () => fsp.readlink(file)],
            ['fsp.opendir(file)', () => fsp.opendir(file)],
        ];
        for (const [label, run] of asyncCases) {
            let caught: unknown;
            try { await run(); } catch (e) { caught = e; }
            checkType(label, caught);
        }

        // FileHandle: on a live read-only handle, then on every method after
        // close. `write` on a handle opened 'r' rejected with the raw number
        // -4083 rather than 'EBADF'.
        const ro = await fsp.open(file, 'r');
        let caught: unknown;
        try { await ro.write(Buffer.from('x')); } catch (e) { caught = e; }
        checkType('FileHandle.write on read-only handle', caught);
        await ro.close();

        const handleCases: Array<[string, () => Promise<unknown>]> = [
            ['read', () => ro.read(Buffer.alloc(4), 0, 4, 0)],
            ['write', () => ro.write(Buffer.from('x'))],
            ['stat', () => ro.stat()],
            ['sync', () => ro.sync()],
            ['datasync', () => ro.datasync()],
            ['truncate', () => ro.truncate(0)],
            ['chmod', () => ro.chmod(0o644)],
            ['readFile', () => ro.readFile()],
            ['readv', () => ro.readv([Buffer.alloc(4)])],
            ['writev', () => ro.writev([Buffer.from('x')])],
            ['utimes', () => ro.utimes(new Date(), new Date())],
        ];
        for (const [label, run] of handleCases) {
            let e2: unknown;
            try { await run(); } catch (e) { e2 = e; }
            checkType(`closed FileHandle.${label}`, e2);
        }
    });
});

/*
 * ---------------------------------------------------------------------------
 * Formerly KNOWN-FAILING, both un-skipped 2026-08-04 after the mod_fs.c fixes
 * landed in the 15:59 build. Kept as regression canaries: each one failed for a
 * DIFFERENT reason, so they cover two independent C mechanisms.
 *
 *   operation                   Node        cno before      cno after
 *   unlinkSync(readonly file)   NO-THROW    EACCES          NO-THROW
 *   openSync(dir, 'r')          returns fd  EACCES          returns fd
 *
 * 1. unlink: `_wunlink` is DeleteFileW, which refuses a readonly file and any
 *    DIRECTORY reparse point. tjs_syncfs_unlink now delegates to uv_fs_unlink
 *    (mod_fs.c:1564), which deletes with
 *    FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE.
 * 2. open: tjs__wopen_shared now sets FILE_FLAG_BACKUP_SEMANTICS
 *    (mod_fs.c:85), which is what makes a directory handle obtainable at all.
 *
 * The old note here claimed cno reported EISDIR for openSync(dir,'r') as a
 * "deliberate trade" against readFileSync(dir). That trade no longer exists and
 * was not what the code did: measured EACCES, not EISDIR. Both now match Node
 * simultaneously — openSync(dir,'r') yields a usable fd whose fstatSync()
 * .isDirectory() is true, while readFileSync(dir) still gives EISDIR, because
 * the EISDIR verdict is decided by the O_CREAT/ERROR_FILE_EXISTS arm at
 * mod_fs.c:114 rather than by refusing the open.
 * ---------------------------------------------------------------------------
 */
Deno.test('fs errno: unlink of a readonly file succeeds', async () => {
    await withTempDir('fserrno-known', (dir) => {
        const ro = join(dir, 'ro.txt');
        fs.writeFileSync(ro, 'ro');
        fs.chmodSync(ro, 0o444);
        strictEqual(codeOf(() => fs.unlinkSync(ro)), 'NO-THROW');
    });
});

Deno.test('fs errno: openSync(dir, r) returns a directory fd', async () => {
    await withTempDir('fserrno-known2', (dir) => {
        const sub = join(dir, 'sub');
        fs.mkdirSync(sub);
        const fd = fs.openSync(sub, 'r');
        try {
            // The fd must be a real directory handle, not merely non-negative.
            strictEqual(fs.fstatSync(fd).isDirectory(), true);
        } finally {
            fs.closeSync(fd);
        }
        // readFileSync must still report EISDIR even though the open succeeds.
        strictEqual(codeOf(() => fs.readFileSync(sub)), 'EISDIR');
    });
});

/*
 * ---------------------------------------------------------------------------
 * PENDING REBUILD — the mod_fs.c change is applied but not yet compiled.
 *
 * fchmod: libuv's fs__fchmod (deps/libuv/src/win/fs.c:2567) implements this on
 * Windows with ReOpenFile(FILE_WRITE_ATTRIBUTES) + NtSetInformationFile, so Node
 * succeeds. tjs_syncfs_fchmod used to return a bare
 * JS_ThrowInternalError("fchmod not supported on Windows") — errno-less, so it
 * surfaced as code UNKNOWN — and the mode was left untouched. It now delegates
 * to uv_fs_fchmod (mod_fs.c:2733).
 *
 * Measured 2026-08-04 vs node v24.18.0, mode read back with statSync:
 *
 *   route                      node          cno (pre-rebuild)
 *   fs.fchmodSync(fd, 0o444)   OK, 666->444  UNKNOWN, stays 666
 *   fs.fchmod(fd, 0o444, cb)   OK, 666->444  UNKNOWN, stays 666
 *   FileHandle.chmod(0o444)    OK, 666->444  OK, 666->444  <- already correct
 *
 * The async row is the tell: uv_fs_fchmod already produced the right result
 * in-process, so this was never a Windows limitation.
 *
 * Contrast the chown family above, which is genuinely a no-op on Windows —
 * libuv's fs__fchown (:3105) is a bare SET_REQ_RESULT(req, 0). Only fchmod was
 * misgrouped.
 *
 * ACTION: drop `ignore: true` after the next rebuild. Asserting the mode is
 * actually applied, not merely that the call does not throw, is deliberate — the
 * old code could have been "fixed" into a silent no-op and still passed a
 * throw-only check.
 * ---------------------------------------------------------------------------
 */
Deno.test({
    name: 'fs errno: fchmodSync applies the mode (needs rebuild)',
    ignore: true,
    fn: async () => {
        await withTempDir('fserrno-fchmod', (dir) => {
            const f = join(dir, 'f.txt');
            fs.writeFileSync(f, 'x');
            fs.chmodSync(f, 0o666);
            const fd = fs.openSync(f, 'r+');
            try {
                strictEqual(codeOf(() => fs.fchmodSync(fd, 0o444)), 'NO-THROW');
                strictEqual((fs.fstatSync(fd).mode & 0o777).toString(8), '444');
            } finally {
                fs.closeSync(fd);
            }
            strictEqual((fs.statSync(f).mode & 0o777).toString(8), '444');
            fs.chmodSync(f, 0o666);
        });
    },
});

/*
 * A closed fd must give EBADF, not UNKNOWN. Pre-rebuild this passed for the
 * wrong reason: the errno-less InternalError was rewritten to EBADF by
 * errno-fix.ts's failedOnBadFd rule. Post-rebuild it must pass because
 * uv_fs_fchmod's VERIFY_FD reports UV_EBADF directly. Ungated: correct either
 * way, so it is the canary that the JS fallback removal did not regress.
 */
Deno.test('fs errno: fchmodSync on a closed fd is EBADF', async () => {
    await withTempDir('fserrno-fchmod-bad', (dir) => {
        const f = join(dir, 'f.txt');
        fs.writeFileSync(f, 'x');
        const fd = fs.openSync(f, 'r');
        fs.closeSync(fd);
        strictEqual(codeOf(() => fs.fchmodSync(fd, 0o444)), 'EBADF');
    });
});
