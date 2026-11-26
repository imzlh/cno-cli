import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { correctSyncErrno, fixSyncError, toSyncErrnoException, wrapSync } from '../../cno/src/node/fs/errno-fix.ts';
import { flockSync } from '../../cno/src/node/fs/sync.ts';
import { withTempDir } from '../_helpers/temp.ts';

const nativeFs = import.meta.use('fs');
const nativeError = import.meta.use('error');
const { errno } = nativeError;
const windows = Deno.build.os === 'windows';
const bogusFd = 0x7fffffff;

type FdCall = [string, (fd: number) => unknown];

const nativeFdCalls: FdCall[] = [
    ['fstat', fd => nativeFs.fstat(fd)],
    ['read', fd => nativeFs.read(fd, new Uint8Array(1))],
    ['pread', fd => nativeFs.pread(fd, new Uint8Array(1), 0)],
    ['write', fd => nativeFs.write(fd, new Uint8Array([1]))],
    ['pwrite', fd => nativeFs.pwrite(fd, new Uint8Array([1]), 0)],
    ['close', fd => nativeFs.close(fd)],
    ['flock', fd => nativeFs.flock(fd, nativeFs.LOCK_EX | nativeFs.LOCK_NB)],
    ['fchmod', fd => nativeFs.fchmod(fd, 0o600)],
    ['futimes', fd => nativeFs.futimes(fd, 0, 0)],
    ['fsync', fd => nativeFs.fsync(fd)],
    ['fdatasync', fd => nativeFs.fdatasync(fd)],
    ['ftruncate', fd => nativeFs.ftruncate(fd, 0)],
];
if (!windows) nativeFdCalls.push(['fchown', fd => nativeFs.fchown(fd, 0, 0)]);

Deno.test('native fs fd errors: closed descriptors report numeric EBADF independently of previous failures', async () => {
    await withTempDir('native-fd-errors', dir => {
        const file = join(dir, 'file');
        const missing = join(dir, 'missing');
        const closedFd = nativeFs.open(file, 'w+');
        nativeFs.close(closedFd);
        const preceding: Array<() => unknown> = [
            () => undefined,
            () => nativeFs.stat(missing),
            () => nativeFs.open(missing, 'r'),
            () => nativeFs.close(closedFd),
            () => nativeFs.readdir(file),
        ];

        for (const fd of [closedFd, bogusFd]) {
            for (const run of preceding) {
                for (const [name, invoke] of nativeFdCalls) {
                    try { run(); } catch { /* Seed a different native error. */ }
                    throws(() => invoke(fd), { code: errno.EBADF }, `${name}(${fd})`);
                }
            }
        }
    });
});

type Callback = (error: NodeJS.ErrnoException | null) => void;

const syncFdCalls: Array<[string, string, (fd: number) => unknown]> = [
    ['fstatSync', 'fstat', fd => fs.fstatSync(fd)],
    ['readSync', 'read', fd => fs.readSync(fd, Buffer.alloc(1), 0, 1, null)],
    ['preadSync', 'read', fd => fs.readSync(fd, Buffer.alloc(1), 0, 1, 0)],
    ['readvSync', 'read', fd => fs.readvSync(fd, [Buffer.alloc(1)])],
    ['preadvSync', 'read', fd => fs.readvSync(fd, [Buffer.alloc(1)], 0)],
    ['writeSync', 'write', fd => fs.writeSync(fd, Buffer.of(1), 0, 1, null)],
    ['pwriteSync', 'write', fd => fs.writeSync(fd, Buffer.of(1), 0, 1, 0)],
    ['writevSync', 'write', fd => fs.writevSync(fd, [Buffer.of(1)])],
    ['pwritevSync', 'write', fd => fs.writevSync(fd, [Buffer.of(1)], 0)],
    ['closeSync', 'close', fd => fs.closeSync(fd)],
    ['flockSync', 'flock', fd => flockSync(fd, nativeFs.LOCK_EX | nativeFs.LOCK_NB)],
    ['fchmodSync', 'fchmod', fd => fs.fchmodSync(fd, 0o600)],
    ['futimesSync', 'futime', fd => fs.futimesSync(fd, 0, 0)],
    ['fsyncSync', 'fsync', fd => fs.fsyncSync(fd)],
    ['fdatasyncSync', 'fdatasync', fd => fs.fdatasyncSync(fd)],
    ['ftruncateSync', 'ftruncate', fd => fs.ftruncateSync(fd, 0)],
    ['readFileSync', 'fstat', fd => fs.readFileSync(fd)],
    ['writeFileSync', 'write', fd => fs.writeFileSync(fd, 'x')],
    ['appendFileSync', 'write', fd => fs.appendFileSync(fd, 'x')],
];

const callbackFdCalls: Array<[string, string, (fd: number, callback: Callback) => void]> = [
    ['fstat', 'fstat', (fd, cb) => fs.fstat(fd, cb)],
    ['read', 'read', (fd, cb) => fs.read(fd, Buffer.alloc(1), 0, 1, null, cb)],
    ['pread', 'read', (fd, cb) => fs.read(fd, Buffer.alloc(1), 0, 1, 0, cb)],
    ['readv', 'read', (fd, cb) => fs.readv(fd, [Buffer.alloc(1)], cb)],
    ['preadv', 'read', (fd, cb) => fs.readv(fd, [Buffer.alloc(1)], 0, cb)],
    ['write', 'write', (fd, cb) => fs.write(fd, Buffer.of(1), 0, 1, null, cb)],
    ['pwrite', 'write', (fd, cb) => fs.write(fd, Buffer.of(1), 0, 1, 0, cb)],
    ['writev', 'write', (fd, cb) => fs.writev(fd, [Buffer.of(1)], cb)],
    ['pwritev', 'write', (fd, cb) => fs.writev(fd, [Buffer.of(1)], 0, cb)],
    ['close', 'close', (fd, cb) => fs.close(fd, cb)],
    ['fchmod', 'fchmod', (fd, cb) => fs.fchmod(fd, 0o600, cb)],
    ['futimes', 'futime', (fd, cb) => fs.futimes(fd, 0, 0, cb)],
    ['fsync', 'fsync', (fd, cb) => fs.fsync(fd, cb)],
    ['fdatasync', 'fdatasync', (fd, cb) => fs.fdatasync(fd, cb)],
    ['ftruncate', 'ftruncate', (fd, cb) => fs.ftruncate(fd, 0, cb)],
    ['readFile', 'fstat', (fd, cb) => fs.readFile(fd, cb)],
    ['writeFile', 'write', (fd, cb) => fs.writeFile(fd, 'x', cb)],
    ['appendFile', 'write', (fd, cb) => fs.appendFile(fd, 'x', cb)],
];
if (!windows) {
    syncFdCalls.push(['fchownSync', 'fchown', fd => fs.fchownSync(fd, 0, 0)]);
    callbackFdCalls.push(['fchown', 'fchown', (fd, cb) => fs.fchown(fd, 0, 0, cb)]);
}

function assertBadFd(error: unknown, syscall: string): true {
    const failure = error as NodeJS.ErrnoException;
    strictEqual(failure.code, 'EBADF');
    strictEqual(failure.errno, errno.EBADF);
    strictEqual(failure.syscall, syscall);
    strictEqual(failure.path, undefined);
    strictEqual(failure.message.includes('fd:'), false);
    return true;
}

Deno.test('fs fd errors: sync and callback boundaries do not probe after a failed syscall', async () => {
    await withTempDir('fd-no-probes', async dir => {
        const closedFd = nativeFs.open(join(dir, 'file'), 'w+');
        nativeFs.close(closedFd);
        const descriptors = new Map<string, PropertyDescriptor>();
        let fstatCalls = 0;
        let pathProbes = 0;
        try {
            for (const name of ['fstat', 'stat', 'lstat', 'readdir', 'open']) {
                const descriptor = Object.getOwnPropertyDescriptor(nativeFs, name)!;
                descriptors.set(name, descriptor);
                Object.defineProperty(nativeFs, name, {
                    ...descriptor,
                    value(...args: unknown[]) {
                        if (name === 'fstat') {
                            fstatCalls++;
                            return descriptor.value(...args);
                        }
                        pathProbes++;
                        throw new Error(`fd error probed ${name}`);
                    },
                });
            }

            for (const [name, syscall, invoke] of syncFdCalls) {
                fstatCalls = 0;
                throws(() => invoke(closedFd), error => assertBadFd(error, syscall), name);
                strictEqual(fstatCalls, name === 'fstatSync' ? 1 : 0, `${name} probed the fd`);
            }
            for (const [name, syscall, invoke] of callbackFdCalls) {
                fstatCalls = 0;
                await new Promise<void>((resolve, reject) => {
                    invoke(closedFd, error => {
                        try {
                            assertBadFd(error, syscall);
                            resolve();
                        } catch (error) { reject(error); }
                    });
                });
                strictEqual(fstatCalls, name === 'fstat' ? 1 : 0, `${name} probed the fd`);
            }
            strictEqual(pathProbes, 0);
        } finally {
            for (const [name, descriptor] of descriptors) Object.defineProperty(nativeFs, name, descriptor);
        }
    });
});

Deno.test('fs fd errors: other UV codes and ordinary exceptions retain their identity and meaning', async () => {
    const codes = [errno.UNKNOWN, errno.EACCES, errno.EIO, errno.EINVAL, errno.EPERM, errno.EAGAIN];
    for (const [syscall] of nativeFdCalls) {
        for (const name of [syscall, `${syscall}Sync`]) {
            for (const code of codes) {
                const failure = nativeError.Error(code);
                strictEqual(correctSyncErrno(code, name), code);
                strictEqual(fixSyncError(failure, name), failure);
                strictEqual(toSyncErrnoException(failure, name).errno, code);
                throws(() => wrapSync(() => { throw failure; }, name), error => {
                    strictEqual((error as NodeJS.ErrnoException).errno, code);
                    strictEqual((error as NodeJS.ErrnoException).path, undefined);
                    return true;
                });
            }
            const ordinary = new TypeError('capability denied');
            strictEqual(fixSyncError(ordinary, name), ordinary);
            strictEqual(toSyncErrnoException(ordinary, name), ordinary);
            throws(() => wrapSync(() => { throw ordinary; }, name), error => error === ordinary);
            strictEqual(Reflect.get(ordinary, 'code'), undefined);
            strictEqual(Reflect.get(ordinary, 'syscall'), undefined);
        }
    }

    const descriptor = Object.getOwnPropertyDescriptor(nativeFs, 'fsync')!;
    const ordinary = new TypeError('capability denied');
    const applicationError = Object.assign(new Error('policy'), { code: 'ERR_CAPABILITY_DENIED' });
    try {
        for (const failure of [nativeError.Error(errno.EIO), nativeError.Error(errno.UNKNOWN), ordinary, applicationError]) {
            Object.defineProperty(nativeFs, 'fsync', { ...descriptor, value() { throw failure; } });
            const check = (error: unknown): true => {
                if (failure === ordinary || failure === applicationError) strictEqual(error, failure);
                else {
                    strictEqual((error as NodeJS.ErrnoException).errno, Reflect.get(failure, 'code'));
                    strictEqual((error as NodeJS.ErrnoException).syscall, 'fsync');
                }
                strictEqual((error as NodeJS.ErrnoException).path, undefined);
                return true;
            };
            throws(() => fs.fsyncSync(bogusFd), check);
            await new Promise<void>((resolve, reject) => {
                fs.fsync(bogusFd, error => {
                    try { check(error); resolve(); } catch (error) { reject(error); }
                });
            });
        }
    } finally { Object.defineProperty(nativeFs, 'fsync', descriptor); }
});

Deno.test('native fs fd errors: positional failures preserve the error and current file position', async () => {
    await withTempDir('fd-position-errors', dir => {
        const file = join(dir, 'file');
        fs.writeFileSync(file, 'abcdef');
        const fd = nativeFs.open(file, 'r');
        const byte = new Uint8Array(1);
        try {
            strictEqual(nativeFs.read(fd, byte), 1);
            strictEqual(byte[0], 97);
            throws(() => nativeFs.pwrite(fd, new Uint8Array([120]), 0), { code: errno.EBADF });
            strictEqual(nativeFs.read(fd, byte), 1);
            strictEqual(byte[0], 98);

            const truncateError = windows ? errno.EPERM : errno.EINVAL;
            throws(() => nativeFs.ftruncate(fd, 0), { code: truncateError });
            throws(() => fs.ftruncateSync(fd, 0), { code: windows ? 'EPERM' : 'EINVAL', errno: truncateError });
            strictEqual(nativeFs.read(fd, byte), 1);
            strictEqual(byte[0], 99);

            strictEqual(nativeFs.pread(fd, byte, 100), 0);
            strictEqual(nativeFs.pread(fd, byte, 5), 1);
            strictEqual(byte[0], 102);
            strictEqual(nativeFs.read(fd, byte), 1);
            strictEqual(byte[0], 100);
            strictEqual(nativeFs.fstat(fd).size, 6);
        } finally { nativeFs.close(fd); }

        const writeOnly = nativeFs.open(file, 'a');
        try {
            throws(() => nativeFs.pread(writeOnly, byte, 0), { code: errno.EBADF });
            strictEqual(nativeFs.write(writeOnly, new Uint8Array([103])), 1);
        } finally { nativeFs.close(writeOnly); }
        strictEqual(fs.readFileSync(file, 'utf8'), 'abcdefg');
    });
});

Deno.test('fs fd errors: fchown platform semantics belong to the native call in every entry', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(nativeFs, 'fchown')!;
    let calls = 0;
    const invoke = descriptor.value as typeof nativeFs.fchown;
    try {
        Object.defineProperty(nativeFs, 'fchown', {
            ...descriptor,
            value(fd: number, uid: number, gid: number) {
                calls++;
                return invoke(fd, uid, gid);
            },
        });
        if (windows) {
            nativeFs.fchown(bogusFd, 0, 0);
            fs.fchownSync(bogusFd, 0, 0);
        } else {
            throws(() => nativeFs.fchown(bogusFd, 0, 0), { code: errno.EBADF });
            throws(() => fs.fchownSync(bogusFd, 0, 0), error => assertBadFd(error, 'fchown'));
        }
        await new Promise<void>((resolve, reject) => {
            fs.fchown(bogusFd, 0, 0, error => {
                try {
                    if (windows) strictEqual(error, null);
                    else assertBadFd(error, 'fchown');
                    resolve();
                } catch (error) { reject(error); }
            });
        });
        strictEqual(calls, 3);
    } finally { Object.defineProperty(nativeFs, 'fchown', descriptor); }
});

Deno.test('native fs fd errors: nonblocking lock contention remains EAGAIN and the caller owns the lock', async () => {
    await withTempDir('fd-lock-errors', dir => {
        const file = join(dir, 'file');
        const first = nativeFs.open(file, 'w+');
        const second = nativeFs.open(file, 'r+');
        const exclusive = nativeFs.LOCK_EX | nativeFs.LOCK_NB;
        try {
            nativeFs.flock(first, exclusive);
            throws(() => nativeFs.flock(second, exclusive), { code: errno.EAGAIN });
            throws(() => flockSync(second, exclusive), { code: 'EAGAIN', errno: errno.EAGAIN, syscall: 'flock' });
            ok(nativeFs.fstat(second).size === 0);
            nativeFs.flock(first, nativeFs.LOCK_UN);
            nativeFs.flock(second, exclusive);
            nativeFs.flock(second, nativeFs.LOCK_UN);
        } finally {
            nativeFs.close(second);
            nativeFs.close(first);
        }
    });
});

Deno.test('fs callbacks finish closing owned handles before reporting results', async () => {
    const asyncfs = import.meta.use('asyncfs');
    const descriptor = Object.getOwnPropertyDescriptor(asyncfs, 'open')!;
    const calls: Array<[string, (callback: Callback) => void]> = [
        ['writeFile', callback => fs.writeFile('owned-path', 'data', callback)],
        ['appendFile', callback => fs.appendFile('owned-path', 'data', callback)],
        ['truncate', callback => fs.truncate('owned-path', 0, callback)],
    ];
    try {
        for (const [name, invoke] of calls) {
            for (const operationFails of [false, true]) {
                for (const closeFails of [false, true]) {
                    const operationError = Object.freeze(Object.assign(new Error('operation failed'), { code: 'EACCES' }));
                    const closeError = nativeError.Error(errno.EIO);
                    const events: string[] = [];
                    let startClose!: () => void;
                    let releaseClose!: () => void;
                    const closing = new Promise<void>(resolve => { startClose = resolve; });
                    const canClose = new Promise<void>(resolve => { releaseClose = resolve; });
                    Object.defineProperty(asyncfs, 'open', {
                        ...descriptor,
                        value: async () => ({
                            async write(bytes: Uint8Array) {
                                events.push('operation');
                                if (operationFails) throw operationError;
                                return bytes.length;
                            },
                            async truncate() {
                                events.push('operation');
                                if (operationFails) throw operationError;
                            },
                            async close() {
                                events.push('closing');
                                startClose();
                                await canClose;
                                events.push('closed');
                                if (closeFails) throw closeError;
                            },
                        }),
                    });
                    let callbackCalls = 0;
                    const completed = new Promise<NodeJS.ErrnoException | null>(resolve => {
                        invoke(error => {
                            callbackCalls++;
                            events.push('callback');
                            resolve(error);
                        });
                    });
                    try {
                        await closing;
                        strictEqual(callbackCalls, 0, name);
                        deepStrictEqual(events, ['operation', 'closing']);
                        releaseClose();
                        const result = await completed;
                        strictEqual(callbackCalls, 1, name);
                        deepStrictEqual(events, ['operation', 'closing', 'closed', 'callback']);
                        if (operationFails && closeFails) {
                            strictEqual(result instanceof AggregateError, true);
                            strictEqual(result!.code, 'EACCES');
                            const errors = (result as AggregateError).errors;
                            strictEqual(errors[0], operationError);
                            strictEqual(errors[1].code, 'EIO');
                            strictEqual(errors[1].errno, errno.EIO);
                            strictEqual(errors[1].syscall, 'close');
                        } else if (operationFails) strictEqual(result, operationError);
                        else if (closeFails) {
                            strictEqual(result!.code, 'EIO');
                            strictEqual(result!.errno, errno.EIO);
                            strictEqual(result!.syscall, 'close');
                        } else strictEqual(result, null);
                    } finally {
                        releaseClose();
                        await completed;
                    }
                }
            }
        }
    } finally {
        Object.defineProperty(asyncfs, 'open', descriptor);
    }
});

Deno.test({
    name: 'fs lchmod invokes a throwing callback exactly once',
    timeout: 10000,
    async fn() {
        const code = `
            const { strictEqual } = await import('node:assert');
            const fs = await import('node:fs');
            const native = import.meta.use('fs');
            const descriptor = Object.getOwnPropertyDescriptor(native, 'lstat');
            Object.defineProperty(native, 'lstat', { ...descriptor, value: () => ({ isSymbolicLink: true }) });
            const failure = new Error('callback failed');
            let calls = 0;
            const uncaught = [];
            process.on('uncaughtException', error => uncaught.push(error));
            try {
                await new Promise(resolve => fs.lchmod('ignored-path', 0o600, error => {
                    calls++;
                    strictEqual(error.code, 'ENOSYS');
                    setTimeout(resolve, 0);
                    throw failure;
                }));
                strictEqual(calls, 1);
                strictEqual(uncaught.length, 1);
                strictEqual(uncaught[0], failure);
            } finally {
                Object.defineProperty(native, 'lstat', descriptor);
            }
        `;
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), 8000);
        try {
            const result = await new Deno.Command(Deno.execPath(), {
                args: ['eval', '--no-lock', code],
                signal: controller.signal,
                stdout: 'piped',
                stderr: 'piped',
            }).output();
            strictEqual(result.code, 0, new TextDecoder().decode(result.stderr));
        } finally {
            clearTimeout(deadline);
        }
    },
});
