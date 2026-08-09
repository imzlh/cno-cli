/**
 * Pins `err.syscall` on fs errors to the **libuv operation name**, which is what
 * real Node reports — not the JS function you called.
 *
 * This existed as a measured defect: cno reported the JS API name, so
 * `readFileSync(missing)` said `syscall: 'readFileSync'` where Node says
 * `'open'`, and `readdirSync` said `'readdirSync'` where Node says `'scandir'`.
 * Real packages branch on this field — `graceful-fs`, `rimraf`, `fs-extra` and
 * `chokidar` all test `err.syscall === 'open'` / `=== 'scandir'` — so every one
 * of those checks silently took the wrong branch.
 *
 * The cases below are deliberately weighted toward the names that are NOT
 * derivable from the JS name, because those are the ones a well-meaning
 * "simplification" to `name.replace(/Sync$/, '')` would break:
 *
 *     readdir  -> scandir     realpath -> lstat (sync/cb only!)
 *     copyFile -> copyfile    utimes   -> utime  (singular)
 *     rm, cp   -> lstat       truncate -> open
 *
 * Every expectation was measured against real Node v24.18.0 on Windows 11 by
 * triggering the failure and reading `err.syscall`, not recalled. Where Node is
 * internally inconsistent (`realpathSync` says 'lstat' but `realpathSync.native`
 * and `fs.promises.realpath` say 'realpath'; module-level `futimes` says 'futime'
 * but `FileHandle.utimes` says 'futimes') the measured value is pinned as-is
 * rather than normalised — matching Node is the whole point.
 *
 * See `cno/src/node/fs/syscall-names.ts` for the table these assert against.
 */
import { strictEqual } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

/** Run `fn`; return the thrown error's `syscall`, or a marker if it did not throw. */
function syscallOf(fn: () => unknown): string {
    try {
        fn();
        return 'NO-THROW';
    } catch (e) {
        const s = (e as NodeJS.ErrnoException).syscall;
        return s === undefined ? 'UNDEFINED' : s;
    }
}

/** Async form of `syscallOf`, for the callback and promise APIs. */
async function syscallOfAsync(fn: () => Promise<unknown>): Promise<string> {
    try {
        await fn();
        return 'NO-THROW';
    } catch (e) {
        const s = (e as NodeJS.ErrnoException).syscall;
        return s === undefined ? 'UNDEFINED' : s;
    }
}

/** Promisify a callback-style fs function so the same assertion shape applies. */
function cb(fn: (...a: never[]) => void, ...args: unknown[]): () => Promise<unknown> {
    return () => new Promise((resolve, reject) => {
        (fn as unknown as (...a: unknown[]) => void)(
            ...args,
            (err: unknown, v: unknown) => (err ? reject(err) : resolve(v)),
        );
    });
}

/**
 * The four names no one would guess. `scandir` and `copyfile` are libuv spellings
 * with no camel hump; `lstat` is the *probe step* rather than the operation; and
 * `utime` is singular where the JS API is plural.
 */
Deno.test('fs syscall: libuv names that the JS API name does not imply', async () => {
    await withTempDir('fs-syscall-uv', async (root) => {
        const missing = join(root, 'missing');
        const file = join(root, 'f.txt');
        fs.writeFileSync(file, 'hi');

        // readdir -> scandir, for a missing dir AND for a plain file (ENOTDIR).
        strictEqual(syscallOf(() => fs.readdirSync(missing)), 'scandir');
        strictEqual(syscallOf(() => fs.readdirSync(file)), 'scandir');
        strictEqual(await syscallOfAsync(cb(fs.readdir, missing)), 'scandir');
        strictEqual(await syscallOfAsync(() => fsp.readdir(missing)), 'scandir');

        // copyFile -> copyfile (lowercase f), on both the source and dest legs.
        strictEqual(syscallOf(() => fs.copyFileSync(missing, join(root, 'c'))), 'copyfile');
        strictEqual(await syscallOfAsync(cb(fs.copyFile, missing, join(root, 'c2'))), 'copyfile');
        strictEqual(await syscallOfAsync(() => fsp.copyFile(missing, join(root, 'c3'))), 'copyfile');

        // rm/cp lstat their target first, so a missing path fails in the probe.
        strictEqual(syscallOf(() => fs.rmSync(missing)), 'lstat');
        strictEqual(syscallOf(() => fs.cpSync(missing, join(root, 'x'))), 'lstat');
        strictEqual(await syscallOfAsync(() => fsp.rm(missing)), 'lstat');

        // utimes -> utime. Singular, and not a typo: libuv is uv_fs_utime.
        strictEqual(syscallOf(() => fs.utimesSync(missing, 0, 0)), 'utime');
        strictEqual(await syscallOfAsync(() => fsp.utimes(missing, 0, 0)), 'utime');
        strictEqual(syscallOf(() => fs.lutimesSync(missing, 0, 0)), 'lutime');
    });
});

/**
 * `realpath` is Node's own inconsistency and the reason the table cannot be keyed
 * on the API name alone: the plain sync/callback forms resolve by walking with
 * lstat and report that, while `.native` and the promise form call uv_fs_realpath.
 */
Deno.test('fs syscall: realpath reports lstat, but .native and promises report realpath', async () => {
    await withTempDir('fs-syscall-realpath', async (root) => {
        const missing = join(root, 'missing');

        strictEqual(syscallOf(() => fs.realpathSync(missing)), 'lstat');
        strictEqual(await syscallOfAsync(cb(fs.realpath, missing)), 'lstat');

        const nativeSync = (fs.realpathSync as unknown as { native: (p: string) => string }).native;
        strictEqual(syscallOf(() => nativeSync(missing)), 'realpath');
        strictEqual(await syscallOfAsync(() => fsp.realpath(missing)), 'realpath');
    });
});

/**
 * A single operation reports different steps depending on which one failed, so a
 * name-only mapping is not enough. Node opens then reads, and says so.
 */
Deno.test('fs syscall: the reported step follows the failure, not the API', async () => {
    await withTempDir('fs-syscall-step', async (root) => {
        const missing = join(root, 'missing');
        const dir = join(root, 'dir');
        fs.mkdirSync(dir);

        // readFile: the open failed vs the read failed.
        strictEqual(syscallOf(() => fs.readFileSync(missing)), 'open');
        strictEqual(syscallOf(() => fs.readFileSync(dir)), 'read');

        // writeFile refuses at the O_TRUNC open; appendFile opens fine and the
        // write is refused.
        strictEqual(syscallOf(() => fs.writeFileSync(dir, 'x')), 'open');
        strictEqual(syscallOf(() => fs.appendFileSync(dir, 'x')), 'write');

        // truncate(path) has no libuv equivalent: Node opens, then ftruncates.
        strictEqual(syscallOf(() => fs.truncateSync(missing, 0)), 'open');

        // All three forms of readFile agree on 'open' for a missing path.
        strictEqual(await syscallOfAsync(cb(fs.readFile, missing)), 'open');
        strictEqual(await syscallOfAsync(() => fsp.readFile(missing)), 'open');
    });
});

/**
 * FileHandle methods use a DIFFERENT name set from the module-level functions.
 * `fh.utimes` reports 'futimes' where module `futimesSync` reports 'futime', and
 * `fh.readv` reports 'readv' where module `readvSync` collapses onto 'read'. This
 * is why the FileHandle path deliberately bypasses the module-level table.
 */
Deno.test('fs syscall: FileHandle names differ from the module-level names', async () => {
    await withTempDir('fs-syscall-fh', async (root) => {
        const file = join(root, 'f.txt');
        fs.writeFileSync(file, 'hi');

        const fh = await fsp.open(file, 'r+');
        await fh.close();

        // Plural here, singular at module level. Both measured.
        strictEqual(await syscallOfAsync(() => fh.utimes(0, 0)), 'futimes');
        strictEqual(syscallOf(() => fs.futimesSync(9999, 0, 0)), 'futime');

        // Not collapsed onto read/write, unlike readvSync/writevSync.
        strictEqual(await syscallOfAsync(() => fh.readv([Buffer.alloc(4)])), 'readv');
        strictEqual(await syscallOfAsync(() => fh.writev([Buffer.from('x')])), 'writev');
        strictEqual(syscallOf(() => fs.readvSync(9999, [Buffer.alloc(4)])), 'read');
        strictEqual(syscallOf(() => fs.writevSync(9999, [Buffer.from('x')])), 'write');

        // A JS-ish name, and appendFile reports 'writeFile' too.
        strictEqual(await syscallOfAsync(() => fh.readFile()), 'readFile');
        strictEqual(await syscallOfAsync(() => fh.writeFile('x')), 'writeFile');
        strictEqual(await syscallOfAsync(() => fh.appendFile('x')), 'writeFile');

        strictEqual(await syscallOfAsync(() => fh.stat()), 'fstat');
        strictEqual(await syscallOfAsync(() => fh.chown(0, 0)), 'fchown');
    });
});

/**
 * The plain cases, asserted as a block so a future table edit that breaks one of
 * the boring identity mappings is caught too. All measured on v24.18.0.
 */
Deno.test('fs syscall: identity mappings still hold', async () => {
    await withTempDir('fs-syscall-identity', async (root) => {
        const missing = join(root, 'missing');
        const file = join(root, 'f.txt');
        const dir = join(root, 'dir');
        fs.writeFileSync(file, 'hi');
        fs.mkdirSync(dir);
        fs.writeFileSync(join(dir, 'child.txt'), 'x');

        strictEqual(syscallOf(() => fs.statSync(missing)), 'stat');
        strictEqual(syscallOf(() => fs.lstatSync(missing)), 'lstat');
        strictEqual(syscallOf(() => fs.openSync(missing, 'r')), 'open');
        strictEqual(syscallOf(() => fs.accessSync(missing)), 'access');
        strictEqual(syscallOf(() => fs.mkdirSync(dir)), 'mkdir');
        strictEqual(syscallOf(() => fs.rmdirSync(dir)), 'rmdir');
        strictEqual(syscallOf(() => fs.unlinkSync(missing)), 'unlink');
        strictEqual(syscallOf(() => fs.renameSync(missing, join(root, 'r'))), 'rename');
        strictEqual(syscallOf(() => fs.readlinkSync(missing)), 'readlink');
        strictEqual(syscallOf(() => fs.chmodSync(missing, 0o644)), 'chmod');
        strictEqual(syscallOf(() => fs.mkdtempSync(join(missing, 'p-'))), 'mkdtemp');
        strictEqual(syscallOf(() => fs.opendirSync(missing)), 'opendir');
        strictEqual(syscallOf(() => fs.linkSync(missing, join(root, 'l'))), 'link');

        // fd operations on a never-opened descriptor.
        strictEqual(syscallOf(() => fs.readSync(9999, Buffer.alloc(4), 0, 4, null)), 'read');
        strictEqual(syscallOf(() => fs.fstatSync(9999)), 'fstat');
        strictEqual(syscallOf(() => fs.ftruncateSync(9999, 0)), 'ftruncate');
        strictEqual(syscallOf(() => fs.fsyncSync(9999)), 'fsync');
        strictEqual(syscallOf(() => fs.fdatasyncSync(9999)), 'fdatasync');
        strictEqual(syscallOf(() => fs.closeSync(9999)), 'close');

        // opendir keeps its own name in the promise form; it must not leak the
        // 'scandir' that the underlying readdir would report.
        strictEqual(await syscallOfAsync(() => fsp.opendir(missing)), 'opendir');
        strictEqual(await syscallOfAsync(() => fsp.mkdtemp(join(missing, 'p-'))), 'mkdtemp');
    });
});
