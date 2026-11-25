import { ok, strictEqual, throws } from 'node:assert';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
    correctSyncErrno, fixSyncError, toAsyncFsErrnoException, toSyncErrnoException, wrapSync,
} from '../../cno/src/node/fs/errno-fix.ts';
import { withTempDir } from '../_helpers/temp.ts';

const nativeFs = import.meta.use('fs');
const nativeError = import.meta.use('error');

Deno.test('fs errors: UV operations preserve the native error domain without filesystem probes', () => {
    for (const syscall of ['rename', 'copyFile', 'readlink', 'rmdir', 'unlink', 'rm', 'link', 'symlink', 'readdir', 'scandir', 'opendir']) {
        for (const code of [nativeError.errno.EXDEV, nativeError.errno.EEXIST, nativeError.errno.EACCES, nativeError.errno.UNKNOWN]) {
            const source = nativeError.Error(code);
            strictEqual(correctSyncErrno(code, syscall, '/unrelated', '/unrelated'), code);
            strictEqual(fixSyncError(source, syscall, '/unrelated', '/unrelated'), source);
            strictEqual(toSyncErrnoException(source, syscall).errno, code);
        }
    }
});

Deno.test('fs errors: ordinary failures at the native boundary are preserved', () => {
    const failure = new TypeError('capability denied');
    for (const syscall of ['rename', 'copyFile', 'readlink', 'rmdir', 'unlink', 'rm', 'link', 'symlink', 'readdir', 'scandir', 'opendir']) {
        strictEqual(fixSyncError(failure, syscall, '/missing'), failure);
        strictEqual(toSyncErrnoException(failure, syscall, '/missing'), failure);
        strictEqual(toAsyncFsErrnoException(failure, syscall, '/missing'), failure);
        throws(() => wrapSync(() => { throw failure; }, syscall, '/missing'), error => error === failure);
    }
    strictEqual(Reflect.get(failure, 'code'), undefined);
    strictEqual(Reflect.get(failure, 'syscall'), undefined);
});

Deno.test('fs errors: existing paths do not turn argument failures into EEXIST', async () => {
    await withTempDir('native-argument-errors', dir => {
        const failure = new TypeError('capability denied');
        for (const syscall of ['mkdirSync', 'linkSync']) {
            strictEqual(fixSyncError(failure, syscall, dir), failure);
            throws(() => wrapSync(() => { throw failure; }, syscall, dir), error => error === failure);
        }

        for (const path of [dir, join(dir, 'missing')]) {
            throws(() => fs.mkdirSync(path, { mode: Symbol('mode') as unknown as number }), error => {
                ok(error instanceof TypeError);
                strictEqual(Reflect.get(error, 'code'), undefined);
                strictEqual(Reflect.get(error, 'syscall'), undefined);
                return true;
            });
        }
        throws(() => fs.linkSync(dir, ''), error => {
            ok(error instanceof RangeError);
            strictEqual(Reflect.get(error, 'code'), undefined);
            strictEqual(Reflect.get(error, 'syscall'), undefined);
            return true;
        });
        ok(!fs.existsSync(join(dir, 'missing')));
    });
});

Deno.test('fs errors: symlink argument failures retain identity without probing the destination', () => {
    const descriptors = Object.getOwnPropertyDescriptors(nativeFs);
    let probes = 0;
    try {
        for (const key of ['stat', 'lstat'] as const) {
            Object.defineProperty(nativeFs, key, {
                ...descriptors[key],
                value: () => { probes++; return { isDirectory: false }; },
            });
        }
        for (const failure of [new RangeError('empty target'), new TypeError('capability denied'), new Error('application failure')]) {
            throws(() => wrapSync(() => { throw failure; }, 'symlinkSync', '/existing'), error => error === failure);
        }
        strictEqual(probes, 0);
    } finally {
        for (const key of ['stat', 'lstat'] as const) {
            Object.defineProperty(nativeFs, key, descriptors[key]);
        }
    }
});

Deno.test('fs errors: native symlink treats an undefined type as omitted', async (t) => {
    await withTempDir('native-symlink-type', async dir => {
        const file = join(dir, 'file.txt');
        fs.writeFileSync(file, 'content');
        const probe = join(dir, 'probe');
        let symlinksAvailable = true;
        try {
            fs.symlinkSync(file, probe, 'file');
        } catch (error) {
            if (!(Deno.build.os === 'windows' && (error as NodeJS.ErrnoException).code === 'EPERM')) throw error;
            symlinksAvailable = false;
        }
        await t.step({
            name: 'omitted and undefined types create file symlinks',
            ignore: !symlinksAvailable,
            fn() {
                for (const [index, create] of [
                    (link: string) => nativeFs.symlink(file, link),
                    (link: string) => nativeFs.symlink(file, link, undefined),
                    (link: string) => fs.symlinkSync(file, link),
                    (link: string) => fs.symlinkSync(file, link, undefined),
                ].entries()) {
                    const link = join(dir, `link-${index}`);
                    create(link);
                    strictEqual(fs.lstatSync(link).isSymbolicLink(), true);
                    strictEqual(fs.readFileSync(link, 'utf8'), 'content');
                }
            },
        });
    });
});

Deno.test('fs errors: native readlink carries UV codes before Node wrapping', async () => {
    await withTempDir('native-readlink-errors', dir => {
        const file = join(dir, 'file');
        fs.writeFileSync(file, 'content');
        for (const [path, code] of [[file, nativeError.errno.EINVAL], [join(dir, 'missing'), nativeError.errno.ENOENT]] as const) {
            throws(() => nativeFs.readlink(path), error => {
                strictEqual(Reflect.get(Object(error), 'code'), code);
                return true;
            });
        }
    });
});

Deno.test('fs errors: directory reads distinguish files from dangling directory links', async (t) => {
    await withTempDir('native-directory-errors', async dir => {
        const file = join(dir, 'file');
        const target = join(dir, 'target');
        const link = join(dir, 'directory-link');
        fs.writeFileSync(file, 'content');
        fs.mkdirSync(target);
        let linkCreated = false;
        try {
            fs.symlinkSync(target, link, Deno.build.os === 'windows' ? 'junction' : 'dir');
            linkCreated = true;
        } catch (error) {
            if (!(Deno.build.os === 'windows' && (error as NodeJS.ErrnoException).code === 'EPERM')) throw error;
        }
        fs.rmdirSync(target);
        for (const [path, code] of [[file, 'ENOTDIR'], [link, 'ENOENT']] as const) {
            await t.step({
                name: path === file ? 'ordinary file reports ENOTDIR' : 'dangling directory link reports ENOENT',
                ignore: path === link && !linkCreated,
                fn() {
                    throws(() => fs.readdirSync(path), error => {
                        strictEqual((error as NodeJS.ErrnoException).code, code);
                        strictEqual((error as NodeJS.ErrnoException).errno, nativeError.errno[code]);
                        return true;
                    });
                    throws(() => nativeFs.readdir(path), error => {
                        strictEqual(Reflect.get(Object(error), 'code'), nativeError.errno[code]);
                        return true;
                    });
                },
            });
        }
    });
});

const crossDeviceRoot = Deno.build.os === 'linux' && fs.existsSync('/dev/shm')
    && fs.statSync('/dev/shm').dev !== fs.statSync('/tmp').dev ? '/dev/shm' : undefined;

Deno.test({
    name: 'fs errors: real cross-device rename preserves EXDEV and both paths',
    ignore: crossDeviceRoot === undefined,
}, async () => {
    await withTempDir('cross-device-error', dir => {
        const other = fs.mkdtempSync(join(crossDeviceRoot!, 'cno-rename-'));
        const source = join(dir, 'source');
        const dest = join(other, 'dest');
        fs.writeFileSync(source, 'original');
        try {
            throws(() => fs.renameSync(source, dest), error => {
                const failure = error as NodeJS.ErrnoException & { dest?: string };
                strictEqual(failure.code, 'EXDEV');
                strictEqual(failure.errno, nativeError.errno.EXDEV);
                strictEqual(failure.path, source);
                strictEqual(failure.dest, dest);
                return true;
            });
            strictEqual(fs.readFileSync(source, 'utf8'), 'original');
            ok(!fs.existsSync(dest));
        } finally {
            fs.rmSync(other, { recursive: true, force: true });
        }
    });
});
