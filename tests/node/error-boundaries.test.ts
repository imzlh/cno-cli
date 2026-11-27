import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { generateKeyPair } from 'node:crypto';
import { Socket } from 'node:net';
import { runInNewContext } from 'node:vm';
import { toListenError } from '../../cno/src/node/net/_shared.ts';
import { ReadStream, WriteStream } from '../../cno/src/node/tty/mod.ts';
import { TLSSocket } from '../../cno/src/node/tls/socket.ts';

const nativeError = import.meta.use('error');

function applicationError(foreign: boolean, coded: boolean, frozen: boolean): Error {
    const error: Error = foreign ? runInNewContext('new Error("policy denied")') : new Error('policy denied');
    Object.defineProperty(error, 'stack', { value: 'original stack', configurable: true, writable: true });
    Object.assign(error, { cause: { policy: true } }, coded ? { code: 'ERR_POLICY_REJECTED' } : {});
    return frozen ? Object.freeze(error) : error;
}

Deno.test('net errors use native codes and leave application errors untouched', () => {
    let stackReads = 0;
    for (const foreign of [false, true]) {
        for (const code of [undefined, 'EADDRINUSE', 'ERR_POLICY_REJECTED', 42, -424242]) {
            const original = applicationError(foreign, false, false);
            if (code !== undefined) Object.assign(original, { code });
            Object.defineProperty(original, 'stack', { get() { stackReads++; throw new Error('stack read'); } });
            const keys = Object.keys(original);
            Object.freeze(original);
            strictEqual(toListenError(original, '127.0.0.1', 1234), original);
            strictEqual(original.message, 'policy denied');
            deepStrictEqual(Object.keys(original), keys);
        }
        const original = applicationError(foreign, false, false);
        Object.defineProperty(original, 'code', { get() { throw new Error('code read'); } });
        strictEqual(toListenError(original, '127.0.0.1', 1234), original);
    }
    const native = nativeError.Error(nativeError.errno.EADDRINUSE);
    Object.defineProperty(native, 'stack', { get() { stackReads++; throw new Error('stack read'); } });
    Object.freeze(native);
    const shaped = toListenError(native, '127.0.0.1', 1234) as NodeJS.ErrnoException & { address: string; port: number };
    strictEqual(shaped === native, false);
    strictEqual(shaped.code, 'EADDRINUSE');
    strictEqual(shaped.errno, nativeError.errno.EADDRINUSE);
    strictEqual(shaped.syscall, 'listen');
    strictEqual(shaped.address, '127.0.0.1');
    strictEqual(shaped.port, 1234);
    strictEqual(shaped.message, 'listen EADDRINUSE: address already in use 127.0.0.1:1234');
    strictEqual(stackReads, 0);
});

Deno.test('TCP options tolerate only the native zero-delay keepalive error', () => {
    const socket = new Socket();
    const calls: unknown[][] = [];
    let failure: Error | undefined;
    const tcp = {
        setNoDelay(enabled: boolean) {
            calls.push(['noDelay', enabled]);
            if (failure) throw failure;
        },
        setKeepAlive(enabled: boolean, delay: number) {
            calls.push(['keepAlive', enabled, delay]);
            if (failure) throw failure;
        },
    };
    Object.assign(socket, { _tcp: tcp });
    try {
        strictEqual(socket.setNoDelay(), socket);
        strictEqual(socket.setNoDelay(false), socket);
        strictEqual(socket.setKeepAlive(true, 1), socket);
        deepStrictEqual(calls, [['noDelay', true], ['noDelay', false], ['keepAlive', true, 1]]);
        for (const error of [
            new Error('Not implemented: application policy'),
            new Error('EINVAL application policy'),
            Object.assign(new Error('symbolic application error'), { code: 'EINVAL' }),
            applicationError(true, true, true),
        ]) {
            failure = error;
            throws(() => socket.setNoDelay(), caught => caught === error);
            throws(() => socket.setKeepAlive(true, 0), caught => caught === error);
        }
        failure = nativeError.Error(nativeError.errno.EINVAL);
        strictEqual(socket.setKeepAlive(true, 0), socket);
        throws(() => socket.setKeepAlive(true, 1), error => error === failure);
        throws(() => socket.setKeepAlive(false, 0), error => error === failure);
        throws(() => socket.setNoDelay(), error => error === failure);
    } finally {
        Object.assign(socket, { _tcp: null });
        socket.destroy();
    }
});

type ReadProbe = {
    handle: { read(buffer: Uint8Array): Promise<never> };
    ttyClosed: boolean;
    readPending: boolean;
    retryRead(): void;
    destroy(error: Error): void;
};

Deno.test('TTY retries structured EAGAIN and preserves unrelated read and write errors', async () => {
    const read = ReadStream.prototype as unknown as { readFromFdAsync(this: ReadProbe, size: number): Promise<void> };
    const write = WriteStream.prototype as unknown as {
        writeToFd(this: { handle: { writeSync(): never } }, chunk: Uint8Array, encoding: string, callback: (error?: Error | null) => void): void;
    };
    for (const failure of [
        nativeError.Error(nativeError.errno.EAGAIN),
        Object.assign(new Error('would block'), { code: 'EAGAIN' }),
        Object.assign(runInNewContext('new Error("would block")'), { code: 'EWOULDBLOCK' }),
        new Error('EAGAIN policy denied'),
        applicationError(true, true, true),
        nativeError.Error(nativeError.errno.EIO),
    ]) {
        let retries = 0;
        let destroyed: Error | undefined;
        const receiver: ReadProbe = {
            handle: { read() { return Promise.reject(failure); } },
            ttyClosed: false,
            readPending: true,
            retryRead() { retries++; },
            destroy(error) { destroyed = error; },
        };
        await read.readFromFdAsync.call(receiver, 1);
        strictEqual(receiver.readPending, false);
        if (['EAGAIN', 'EWOULDBLOCK', nativeError.errno.EAGAIN].includes(Reflect.get(failure, 'code'))) {
            strictEqual(retries, 1);
            strictEqual(destroyed, undefined);
        } else if (Reflect.get(failure, 'code') === nativeError.errno.EIO) {
            strictEqual(retries, 0);
            strictEqual(Reflect.get(destroyed!, 'code'), 'EIO');
            strictEqual(Reflect.get(destroyed!, 'errno'), nativeError.errno.EIO);
            strictEqual(Reflect.get(destroyed!, 'syscall'), 'read');
        } else {
            strictEqual(retries, 0);
            strictEqual(destroyed, failure);
        }
    }
    for (const failure of [applicationError(true, true, true), nativeError.Error(nativeError.errno.EIO)]) {
        const errors: Array<Error | null | undefined> = [];
        write.writeToFd.call({ handle: { writeSync() { throw failure; } } }, new Uint8Array(1), 'buffer', error => errors.push(error));
        strictEqual(errors.length, 1);
        if (Reflect.get(failure, 'code') === nativeError.errno.EIO) {
            strictEqual(Reflect.get(errors[0]!, 'code'), 'EIO');
            strictEqual(Reflect.get(errors[0]!, 'syscall'), 'write');
        } else {
            strictEqual(errors[0], failure);
        }
    }
});

Deno.test('crypto callback errors preserve Error objects from every realm', async () => {
    for (const foreign of [false, true]) {
        for (const frozen of [false, true]) {
            const failure = applicationError(foreign, true, frozen);
            const cause = failure.cause;
            let calls = 0;
            await new Promise<void>((resolve, reject) => {
                generateKeyPair('rsa', { get modulusLength(): number { throw failure; } }, error => {
                    calls++;
                    try {
                        strictEqual(error, failure);
                        strictEqual(Reflect.get(error!, 'code'), 'ERR_POLICY_REJECTED');
                        strictEqual(error!.cause, cause);
                        strictEqual(error!.stack, 'original stack');
                        resolve();
                    } catch (caught) {
                        reject(caught);
                    }
                });
            });
            strictEqual(calls, 1);
        }
    }
});

Deno.test('TLS custom authorization preserves returned and thrown errors without adding a code', () => {
    for (const foreign of [false, true]) {
        for (const coded of [false, true]) {
            for (const frozen of [false, true]) {
                for (const throwing of [false, true]) {
                    const failure = applicationError(foreign, coded, frozen);
                    const keys = Object.keys(failure);
                    const cause = failure.cause;
                    const receiver = {
                        _sslPipe: { verifyResult: { ok: true } },
                        _isServer: false,
                        _servername: 'localhost',
                        _rejectUnauthorized: true,
                        getPeerCertificate() { return { subject: { CN: 'localhost' } }; },
                        _checkServerIdentity() {
                            if (throwing) throw failure;
                            return failure;
                        },
                        authorized: true,
                        authorizationError: null as Error | null,
                    };
                    const result = TLSSocket.prototype._settleAuthorization.call(receiver as unknown as TLSSocket);
                    strictEqual(result, failure);
                    strictEqual(receiver.authorized, false);
                    strictEqual(receiver.authorizationError, failure);
                    strictEqual(Reflect.get(failure, 'code'), coded ? 'ERR_POLICY_REJECTED' : undefined);
                    strictEqual(failure.cause, cause);
                    strictEqual(failure.stack, 'original stack');
                    deepStrictEqual(Object.keys(failure), keys);
                }
            }
        }
    }
});
