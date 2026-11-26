import { ok, rejects, strictEqual, throws } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

const nativeFs = import.meta.use('fs');
const nativeAsyncFs = import.meta.use('asyncfs');
const { errno } = import.meta.use('error');
const windows = Deno.build.os === 'windows';

Deno.test('cp preserves frozen application errors from sync and async filters', async () => {
    await withTempDir('copy-filter-error', async dir => {
        const source = join(dir, 'source');
        const dest = join(dir, 'dest');
        fs.writeFileSync(source, 'source data');
        for (const context of [{}, { syscall: 'cp', path: source, dest }]) {
            const error = Object.freeze(Object.assign(new Error('filter denied'), { code: 'EACCES', ...context }));
            const filter = () => { throw error; };
            throws(() => fs.cpSync(source, dest, { filter }), value => value === error);
            await rejects(fsp.cp(source, dest, { filter }), value => value === error);
            await rejects(new Promise<void>((resolve, reject) => {
                fs.cp(source, dest, { filter }, value => value ? reject(value) : resolve());
            }), value => value === error);
        }
        const canceled = new DOMException('filter canceled', 'AbortError');
        const filter = () => { throw canceled; };
        throws(() => fs.cpSync(source, dest, { filter }), value => value === canceled);
        await rejects(fsp.cp(source, dest, { filter }), value => value === canceled);
        await rejects(new Promise<void>((resolve, reject) => {
            fs.cp(source, dest, { filter }, value => value ? reject(value) : resolve());
        }), value => value === canceled);
        ok(!fs.existsSync(dest));
    });
});

for (const [name, binding, copy] of [
    ['fs.copy', nativeFs, nativeFs.copy],
    ['asyncfs.copyFile', nativeAsyncFs, nativeAsyncFs.copyFile],
] as const) {
    const { FS_COPYFILE_EXCL: excl, FS_COPYFILE_FICLONE: clone } = binding;

    Deno.test(`${name} owns copy flags and returns numeric UV errors`, async () => {
        await withTempDir('native-copy', async dir => {
            const source = join(dir, 'source');
            const dest = join(dir, 'dest');
            const folder = join(dir, 'folder');
            const fresh = join(dir, 'fresh');
            fs.writeFileSync(source, 'source data');
            fs.writeFileSync(dest, 'longer old destination data');
            fs.mkdirSync(folder);
            fs.writeFileSync(join(folder, 'child'), 'child');

            await copy(source, dest);
            strictEqual(fs.readFileSync(dest, 'utf8'), 'source data');
            await copy(source, source);
            await rejects(async () => copy(source, source, excl), { code: errno.EEXIST });
            strictEqual(fs.readFileSync(source, 'utf8'), 'source data');

            await rejects(async () => copy(join(dir, 'missing'), dest), { code: errno.ENOENT });
            await rejects(async () => copy(source, dest, 8), { code: errno.EINVAL });
            const directoryError = windows ? errno.EPERM : errno.EISDIR;
            await rejects(async () => copy(folder, fresh), { code: directoryError });
            await rejects(async () => copy(source, folder), { code: directoryError });
            strictEqual(fs.readFileSync(join(folder, 'child'), 'utf8'), 'child');
            ok(!fs.existsSync(fresh));

            await copy(source, fresh, excl | clone);
            fs.writeFileSync(source, 'changed');
            await rejects(async () => copy(source, fresh, excl | clone), { code: errno.EEXIST });
            strictEqual(fs.readFileSync(fresh, 'utf8'), 'source data');
        });
    });
}

function callbackCopy(source: string, dest: string, flags: number): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.copyFile(source, dest, flags, error => error ? reject(error) : resolve());
    });
}

for (const [name, copy, binding, method] of [
    ['copyFileSync', fs.copyFileSync, nativeFs, 'copy'],
    ['promises.copyFile', fsp.copyFile, nativeAsyncFs, 'copyFile'],
    ['callback copyFile', callbackCopy, nativeAsyncFs, 'copyFile'],
] as const) {
    Deno.test(`${name} forwards EXCL to the native copy without an exists probe`, async () => {
        await withTempDir('exclusive-copy', async dir => {
            const source = join(dir, 'source');
            const dest = join(dir, 'dest');
            fs.writeFileSync(source, 'source data');
            const copyDescriptor = Object.getOwnPropertyDescriptor(binding, method)!;
            const existsDescriptor = Object.getOwnPropertyDescriptor(nativeFs, 'exists')!;
            let submissions = 0;

            await rejects(async () => {
                try {
                    Object.defineProperty(nativeFs, 'exists', {
                        configurable: true,
                        get() { throw new Error('copyFile probed the destination'); },
                    });
                    Object.defineProperty(binding, method, {
                        configurable: true,
                        get() {
                            // A competing creator wins immediately before native submission.
                            submissions++;
                            fs.writeFileSync(dest, 'competitor data', { flag: 'wx' });
                            return copyDescriptor.value;
                        },
                    });
                    return copy(source, dest, fs.constants.COPYFILE_EXCL);
                } finally {
                    Object.defineProperty(binding, method, copyDescriptor);
                    Object.defineProperty(nativeFs, 'exists', existsDescriptor);
                }
            }, { code: 'EEXIST', errno: errno.EEXIST, syscall: 'copyfile', path: source, dest });

            strictEqual(submissions, 1);
            strictEqual(fs.readFileSync(dest, 'utf8'), 'competitor data');
        });
    });
}

Deno.test('callback copyFile validates mode before scheduling a callback', () => {
    throws(() => fs.copyFile('source', 'dest', 'invalid' as never, () => {
        throw new Error('invalid copy mode reached callback');
    }), { code: 'ERR_INVALID_ARG_TYPE' });
});

Deno.test('promises.copyFile normalizes native submission failures at the async boundary', async () => {
    await withTempDir('copy-submission-error', async dir => {
        const source = join(dir, 'source');
        const dest = join(dir, 'dest');
        fs.writeFileSync(source, 'source data');
        fs.writeFileSync(dest, 'unchanged');

        for (const flags of [8, -1]) {
            const pending = fsp.copyFile(source, dest, flags);
            strictEqual(typeof pending.then, 'function');
            await rejects(pending, (error: unknown) => {
                const failure = error as NodeJS.ErrnoException & { dest?: string };
                strictEqual(failure.code, 'EINVAL');
                strictEqual(failure.errno, errno.EINVAL);
                strictEqual(failure.syscall, 'copyfile');
                strictEqual(failure.path, source);
                strictEqual(failure.dest, dest);
                return true;
            });
            strictEqual(fs.readFileSync(dest, 'utf8'), 'unchanged');
        }

        const descriptor = Object.getOwnPropertyDescriptor(nativeAsyncFs, 'copyFile')!;
        const applicationError = Object.freeze(Object.assign(new Error('submission denied'), { code: 'EACCES' }));
        try {
            Object.defineProperty(nativeAsyncFs, 'copyFile', {
                ...descriptor,
                value() { throw applicationError; },
            });
            await rejects(fsp.copyFile(source, dest), error => {
                strictEqual(error, applicationError);
                return true;
            });
        } finally {
            Object.defineProperty(nativeAsyncFs, 'copyFile', descriptor);
        }
    });
});

Deno.test('copy and cp preserve forced-clone results from the filesystem', async () => {
    await withTempDir('forced-clone', async dir => {
        const source = join(dir, 'source');
        fs.writeFileSync(source, 'clone data');
        const mode = fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE_FORCE;
        const syncOracle = join(dir, 'native-sync');
        let expectedError: number | undefined;
        try {
            nativeFs.copy(source, syncOracle, mode);
        } catch (error) {
            expectedError = Reflect.get(Object(error), 'code');
            strictEqual(typeof expectedError, 'number');
            ok(expectedError! < 0);
            ok(!fs.existsSync(syncOracle));
        }
        if (windows) strictEqual(expectedError, errno.ENOSYS);

        const copies = [
            (dest: string) => nativeAsyncFs.copyFile(source, dest, mode),
            (dest: string) => fs.copyFileSync(source, dest, mode),
            (dest: string) => fsp.copyFile(source, dest, mode),
            (dest: string) => callbackCopy(source, dest, mode),
            (dest: string) => fs.cpSync(source, dest, { mode }),
            (dest: string) => fsp.cp(source, dest, { mode }),
        ];
        for (const [i, copy] of copies.entries()) {
            const dest = join(dir, `clone-${i}`);
            if (expectedError === undefined) {
                await copy(dest);
                strictEqual(fs.readFileSync(dest, 'utf8'), 'clone data');
            } else {
                const expected = i === 0 ? { code: expectedError } : { errno: expectedError };
                await rejects(async () => copy(dest), expected);
                ok(!fs.existsSync(dest));
            }
        }
    });
});
