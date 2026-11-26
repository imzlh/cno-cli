import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { createHook } from 'node:async_hooks';
import { once } from 'node:events';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
    createReadStream,
    createReadStreamFromHandle,
    createWriteStream,
    createWriteStreamFromHandle,
    ReadStream,
    WriteStream,
} from '../../cno/src/node/fs/streams.ts';

const engine = import.meta.use('engine');
const asyncfs = import.meta.use('asyncfs');
const nativeError = import.meta.use('error');

function assertClosedDescriptor(fd: number): void {
    throws(() => fs.fstatSync(fd), (error: unknown) => {
        strictEqual((error as NodeJS.ErrnoException).code, 'EBADF');
        return true;
    });
}

Deno.test('fs streams: null path is valid only when an fd supplies the source', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-fd-' });
    fs.writeFileSync(file, 'descriptor-backed');
    const fd = fs.openSync(file, 'r');
    const stream = createReadStreamFromHandle(
        { fd, close: async () => { fs.closeSync(fd); } },
        { autoClose: false },
    );

    try {
        strictEqual(stream.path, undefined);
        const contents = await new Promise<string>((resolve, reject) => {
            let value = '';
            stream.on('data', (chunk: Uint8Array) => { value += Buffer.from(chunk).toString(); });
            stream.on('end', () => resolve(value));
            stream.on('error', reject);
        });
        strictEqual(contents, 'descriptor-backed');
    } finally {
        const closed = once(stream, 'close');
        stream.destroy();
        await closed;
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: null path without an fd fails synchronously', () => {
    throws(
        () => createReadStream(null as never),
        (error: unknown) => {
            strictEqual((error as NodeJS.ErrnoException).code, 'ERR_INVALID_ARG_TYPE');
            return true;
        },
    );
});

Deno.test('fs streams: fd values are validated synchronously', () => {
    for (const create of [createReadStream, createWriteStream]) {
        for (const fd of [-1, 1.5, NaN, 2147483648]) {
            throws(
                () => create(null as never, { fd }),
                (error: unknown) => {
                    strictEqual((error as NodeJS.ErrnoException).code, 'ERR_OUT_OF_RANGE');
                    return true;
                },
            );
        }
    }
});

Deno.test('fs streams: invalid path values fail synchronously', () => {
    for (const create of [createReadStream, createWriteStream]) {
        throws(
            () => create({} as never),
            (error: unknown) => {
                strictEqual((error as NodeJS.ErrnoException).code, 'ERR_INVALID_ARG_TYPE');
                return true;
            },
        );
    }
});

Deno.test('fs streams: autoClose false closes the fd on explicit destroy during open or I/O', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-destroy-fd-' });
    fs.writeFileSync(file, 'descriptor-backed');

    try {
        for (const create of [createReadStream, createWriteStream]) {
            for (const boundary of ['opening', 'open', 'I/O'] as const) {
                const stream = create(file, { autoClose: false, flags: 'r+' });
                const events: string[] = [];
                let fd: number | undefined;
                const closed = new Promise<void>(resolve => stream.once('close', () => {
                    events.push('close');
                    resolve();
                }));
                stream.on('error', error => events.push(`error:${(error as NodeJS.ErrnoException).code}`));
                stream.on('end', () => events.push('end'));
                stream.on('finish', () => events.push('finish'));
                stream.once('open', (openedFd: number) => { fd = openedFd; });
                if (boundary !== 'opening') await once(stream, 'open');
                if (boundary === 'I/O') {
                    if (stream instanceof ReadStream) stream.read(1);
                    else stream.write('X');
                }
                stream.destroy();
                stream.destroy();
                await closed;
                strictEqual(typeof fd, 'number');
                assertClosedDescriptor(fd!);
                strictEqual(stream.fd, null);
                strictEqual(stream.autoClose, false);
                strictEqual(stream.closed, true);
                deepStrictEqual(events, boundary === 'I/O' && !(stream instanceof ReadStream)
                    ? ['error:ERR_STREAM_DESTROYED', 'close'] : ['close']);
            }
        }
    } finally {
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: promise init reentry waits for open before completing destroy', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-open-reentry-' });
    try {
        for (const Constructor of [ReadStream, WriteStream]) {
            for (const promiseIndex of [1, 2]) {
                for (const path of [file, `${file}-missing`]) {
                    const stream = Object.create(Constructor.prototype) as ReadStream | WriteStream;
                    let promises = 0;
                    let reentered = false;
                    const hook = createHook({
                        init(_id, type) {
                            if (type !== 'PROMISE' || ++promises !== promiseIndex) return;
                            hook.disable();
                            reentered = true;
                            stream.destroy();
                        },
                    });
                    hook.enable();
                    try {
                        Constructor.call(stream, path, { autoClose: false, flags: 'r+' });
                    } finally {
                        hook.disable();
                    }
                    const events: string[] = [];
                    let fd: number | undefined;
                    stream.on('open', (openedFd: number) => {
                        fd = openedFd;
                        events.push('open');
                    });
                    stream.on('ready', () => events.push('ready'));
                    stream.on('error', error => events.push(`error:${(error as NodeJS.ErrnoException).code}`));
                    const closed = new Promise<void>(resolve => stream.once('close', () => {
                        events.push('close');
                        resolve();
                    }));
                    try {
                        strictEqual(reentered, true);
                        strictEqual(stream.destroyed, true);
                        strictEqual(stream.closed, false);
                        strictEqual(stream.fd, null);
                        await closed;
                        strictEqual(stream.closed, true);
                        strictEqual(stream.fd, null);
                        if (path === file) {
                            deepStrictEqual(events, ['open', 'ready', 'close']);
                            strictEqual(typeof fd, 'number');
                            assertClosedDescriptor(fd!);
                        } else {
                            deepStrictEqual(events, ['error:ENOENT', 'close']);
                        }
                    } finally {
                        stream.destroy();
                        await closed;
                    }
                }
            }
        }
    } finally {
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: explicit destroy closes caller-supplied descriptors and preserves error ordering', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-destroy-owned-fd-' });
    try {
        for (const create of [createReadStream, createWriteStream]) {
            const fd = fs.openSync(file, 'r+');
            const stream = create(null as never, { fd, autoClose: false });
            const events: string[] = [];
            const failure = new Error('explicit destroy');
            stream.on('error', error => {
                strictEqual(error, failure);
                events.push('error');
            });
            const closed = new Promise<void>(resolve => stream.once('close', () => {
                events.push('close');
                resolve();
            }));
            stream.destroy(failure);
            stream.destroy();
            await closed;
            deepStrictEqual(events, ['error', 'close']);
            assertClosedDescriptor(fd);
            strictEqual(stream.fd, null);
            const replacement = fs.openSync(file, 'r');
            try {
                stream.destroy();
                engine.gc.run();
                strictEqual(fs.fstatSync(replacement).isFile(), true);
            } finally {
                fs.closeSync(replacement);
            }
        }
    } finally {
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: supplied numeric fds do not emit open or ready', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-preopened-fd-' });
    try {
        for (const create of [createReadStream, createWriteStream]) {
            const fd = fs.openSync(file, 'r+');
            const events: string[] = [];
            const stream = create(null as never, { fd, autoClose: false });
            stream.on('open', () => events.push('open'));
            stream.on('ready', () => events.push('ready'));
            stream.on('close', () => events.push('close'));
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            deepStrictEqual(events, []);
            strictEqual(fs.fstatSync(fd).isFile(), true);
            const closed = once(stream, 'close');
            stream.destroy();
            await closed;
            deepStrictEqual(events, ['close']);
            assertClosedDescriptor(fd);
        }
    } finally {
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: FileHandle close runs once and resolves before the close event', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-owned-handle-' });
    fs.writeFileSync(file, 'handle-backed');

    try {
        for (const create of [createReadStreamFromHandle, createWriteStreamFromHandle]) {
            for (const autoClose of [false, true]) {
                const handle = await fs.promises.open(file, 'r+');
                const fd = handle.fd;
                const events: string[] = [];
                let closeCalls = 0;
                let releaseClose!: () => void;
                const canClose = new Promise<void>(resolve => { releaseClose = resolve; });
                const stream = create({
                    get fd() { return handle.fd; },
                    async close() {
                        closeCalls++;
                        events.push('closing');
                        await canClose;
                        await handle.close();
                        events.push('closed');
                    },
                }, { autoClose });
                const terminalEvent = stream instanceof ReadStream ? 'end' : 'finish';
                stream.on(terminalEvent, () => events.push(terminalEvent));
                stream.on('close', () => events.push('close'));
                const closed = once(stream, 'close');
                try {
                    const completed = once(stream, terminalEvent);
                    if (stream instanceof ReadStream) stream.resume();
                    else stream.end('X');
                    await completed;
                    if (!autoClose) {
                        strictEqual(handle.fd, fd);
                        strictEqual(stream.destroyed, false);
                        stream.destroy();
                    }
                    stream.destroy();
                    await Promise.resolve();
                    strictEqual(closeCalls, 1);
                    strictEqual(stream.fd, null);
                    strictEqual(stream.closed, false);
                    strictEqual(fs.fstatSync(fd).isFile(), true);
                    deepStrictEqual(events, [terminalEvent, 'closing']);
                    releaseClose();
                    await closed;
                    strictEqual(handle.fd, -1);
                    throws(() => fs.fstatSync(fd), { code: 'EBADF' });
                    deepStrictEqual(events, [terminalEvent, 'closing', 'closed', 'close']);
                } finally {
                    releaseClose();
                    stream.destroy();
                    await closed;
                    await handle.close();
                }
            }
        }
    } finally {
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: close callbacks settle with FileHandle close results independently of emitClose', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-close-result-' });
    try {
        for (const create of [createReadStreamFromHandle, createWriteStreamFromHandle]) {
            for (const emitClose of [true, false]) {
                for (const rejects of [false, true]) {
                    const handle = await fs.promises.open(file, 'r+');
                    const fd = handle.fd;
                    const failure = Object.assign(new Error('FileHandle close failed'), { code: 'EIO' });
                    const events: string[] = [];
                    let closeCalls = 0;
                    let releaseClose!: () => void;
                    let markClosing!: () => void;
                    const canClose = new Promise<void>(resolve => { releaseClose = resolve; });
                    const closing = new Promise<void>(resolve => { markClosing = resolve; });
                    const stream = create({
                        get fd() { return handle.fd; },
                        async close() {
                            closeCalls++;
                            events.push('closing');
                            markClosing();
                            await canClose;
                            if (!rejects) await handle.close();
                            events.push('settled');
                            if (rejects) throw failure;
                        },
                    }, { autoClose: false, emitClose });
                    stream.on('error', error => {
                        strictEqual(error, failure);
                        events.push('error');
                    });
                    stream.on('close', () => events.push('close'));
                    const callbacks = Promise.all([1, 2].map(index => new Promise<Error | null | undefined>(resolve => {
                        stream.close(error => {
                            events.push(`callback:${index}`);
                            resolve(error);
                        });
                    })));
                    try {
                        await closing;
                        strictEqual(closeCalls, 1);
                        strictEqual(stream.closed, false);
                        strictEqual(stream.fd, null);
                        strictEqual(fs.fstatSync(fd).isFile(), true);
                        deepStrictEqual(events, ['closing']);
                        releaseClose();
                        const expectedCode = rejects
                            ? 'EIO'
                            : stream instanceof ReadStream ? 'ERR_STREAM_PREMATURE_CLOSE' : null;
                        const result = rejects ? failure : null;
                        const callbackResults = await callbacks;
                        deepStrictEqual(
                            callbackResults.map(error => error ? (error as NodeJS.ErrnoException).code : null),
                            [expectedCode, expectedCode],
                        );
                        if (rejects) strictEqual(callbackResults[0], failure);
                        strictEqual(stream.closed, true);
                        deepStrictEqual(events, rejects
                            ? ['closing', 'settled', 'error', 'callback:1', 'callback:2', ...(emitClose ? ['close'] : [])]
                            : ['closing', 'settled', ...(emitClose ? ['close'] : []), 'callback:1', 'callback:2']);
                        const secondResult = await new Promise<Error | null | undefined>(resolve => stream.close(resolve));
                        strictEqual(secondResult ? (secondResult as NodeJS.ErrnoException).code : null, expectedCode);
                        if (rejects) strictEqual(secondResult, failure);
                        strictEqual(closeCalls, 1);
                        strictEqual(stream.listenerCount('error'), 1);
                        if (!rejects) throws(() => fs.fstatSync(fd), { code: 'EBADF' });
                    } finally {
                        releaseClose();
                        stream.destroy();
                        await callbacks;
                        await handle.close();
                    }
                }
            }
        }
    } finally {
        Deno.removeSync(file);
    }
});

for (const boundary of ['end', 'finish', 'empty finish'] as const) {
    Deno.test(`fs streams: autoClose false transfers fd ownership at ${boundary}`, async () => {
        const file = Deno.makeTempFileSync({ prefix: 'cno-stream-transfer-fd-' });
        fs.writeFileSync(file, 'caller-owned');
        let fd: number | undefined;
        let replacement: number | undefined;

        async function completeStream(): Promise<void> {
            const stream = boundary === 'finish' || boundary === 'empty finish'
                ? createWriteStream(file, { autoClose: false })
                : createReadStream(file, { autoClose: false });
            const completed = new Promise<void>((resolve, reject) => {
                stream.once('error', reject);
                const event = boundary === 'end' ? 'end' : 'finish';
                stream.once(event, resolve);
            });
            const events: string[] = [];
            stream.on('close', () => events.push('close'));
            if (stream instanceof ReadStream) stream.resume();
            else stream.end(boundary === 'empty finish' ? undefined : 'written');
            await completed;
            strictEqual(stream.destroyed, false);
            deepStrictEqual(events, []);
            fd = stream.fd ?? undefined;
        }

        try {
            await completeStream();
            strictEqual(typeof fd, 'number');
            engine.gc.run();
            strictEqual(fs.fstatSync(fd!).isFile(), true);
            fs.closeSync(fd!);
            fd = undefined;
            replacement = fs.openSync(file, 'r');
            engine.gc.run();
            strictEqual(fs.fstatSync(replacement).isFile(), true);
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
            if (replacement !== undefined) fs.closeSync(replacement);
            Deno.removeSync(file);
        }
    });
}

Deno.test('asyncfs: detach refuses pending I/O and invalidates the file handle', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-asyncfs-detach-' });
    const handle = await asyncfs.open(file, 'r');
    let fd: number | undefined;
    try {
        const pending = handle.stat();
        throws(() => handle.detach(), (error: unknown) => {
            strictEqual((error as { code: number }).code, nativeError.errno.EBUSY);
            return true;
        });
        await pending;
        fd = handle.detach();
        throws(() => handle.fileno(), (error: unknown) => {
            strictEqual((error as { code: number }).code, nativeError.errno.EBADF);
            return true;
        });
        throws(() => handle.detach());
        strictEqual(fs.fstatSync(fd).isFile(), true);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        else await handle.close();
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: explicit close releases the fd even with autoClose false', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-explicit-close-' });
    try {
        for (const create of [createReadStream, createWriteStream]) {
            const stream = create(file, { autoClose: false });
            await new Promise<void>((resolve, reject) => {
                stream.once('error', reject);
                stream.once('open', () => resolve());
            });
            const fd = stream.fd!;
            await new Promise<void>((resolve, reject) => {
                stream.once('error', reject);
                stream.close(() => resolve());
            });
            throws(() => fs.fstatSync(fd), (error: unknown) => {
                strictEqual((error as NodeJS.ErrnoException).code, 'EBADF');
                return true;
            });
            strictEqual(stream.fd, null);
            strictEqual(stream.autoClose, false);
        }
    } finally {
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: explicit close after EOF releases the detached read fd', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-close-after-eof-' });
    let fd: number | undefined;
    try {
        const stream = createReadStream(file, { autoClose: false });
        const ended = once(stream, 'end');
        stream.resume();
        await ended;
        fd = stream.fd!;
        strictEqual(fs.fstatSync(fd).isFile(), true);
        await new Promise<void>((resolve, reject) => stream.close(error => error ? reject(error) : resolve()));
        throws(() => fs.fstatSync(fd!), { code: 'EBADF' });
        fd = undefined;
        strictEqual(stream.fd, null);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: write stream snapshots its file URL before deferred open', async () => {
    const dir = Deno.makeTempDirSync({ prefix: 'cno-stream-url-' });
    try {
        const target = `${dir}/target`;
        const other = `${dir}/other`;
        fs.writeFileSync(other, 'keep');
        const url = pathToFileURL(target);
        const stream = createWriteStream(url);
        url.href = pathToFileURL(other).href;
        const closed = once(stream, 'close');
        stream.end('written');
        await closed;
        strictEqual(fs.readFileSync(other, 'utf8'), 'keep');
        strictEqual(fs.readFileSync(target, 'utf8'), 'written');

        const readUrl = pathToFileURL(target);
        const reader = createReadStream(readUrl);
        readUrl.href = pathToFileURL(other).href;
        let contents = '';
        reader.setEncoding('utf8');
        reader.on('data', chunk => { contents += chunk; });
        await once(reader, 'close');
        strictEqual(contents, 'written');

        const targetBuffer = Buffer.from(target);
        const writer = createWriteStream(targetBuffer);
        Buffer.from(other).copy(targetBuffer);
        const bufferWriteClosed = once(writer, 'close');
        writer.end('buffer-written');
        await bufferWriteClosed;
        strictEqual(fs.readFileSync(other, 'utf8'), 'keep');
        strictEqual(fs.readFileSync(target, 'utf8'), 'buffer-written');

        fs.writeFileSync(target, 'buffer-read');
        fs.writeFileSync(other, 'other-read');
        const readPath = Buffer.from(target);
        const bufferReader = createReadStream(readPath);
        Buffer.from(other).copy(readPath);
        let bufferContents = '';
        bufferReader.setEncoding('utf8');
        bufferReader.on('data', chunk => { bufferContents += chunk; });
        await once(bufferReader, 'close');
        strictEqual(bufferContents, 'buffer-read');
    } finally {
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test('fs streams: close after finish releases a detached write fd', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-close-after-finish-' });
    const stream = createWriteStream(file, { autoClose: false });
    let fd: number | undefined;
    let fdClosed = false;
    try {
        await new Promise<void>((resolve, reject) => {
            stream.once('error', reject);
            stream.once('open', () => resolve());
        });
        fd = stream.fd!;
        await new Promise<void>((resolve, reject) => {
            stream.once('error', reject);
            stream.end(resolve);
        });
        strictEqual(fs.fstatSync(fd).isFile(), true);
        await new Promise<void>((resolve, reject) => {
            stream.once('error', reject);
            stream.close(error => error ? reject(error) : resolve());
        });
        fdClosed = true;
        throws(() => fs.fstatSync(fd!), (error: unknown) => {
            strictEqual((error as NodeJS.ErrnoException).code, 'EBADF');
            return true;
        });
        strictEqual(stream.fd, null);
        strictEqual(stream.autoClose, false);
    } finally {
        if (fd !== undefined && !fdClosed) fs.closeSync(fd);
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: ReadStream.close reports premature close before EOF', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-premature-close-' });
    fs.writeFileSync(file, 'not consumed');
    try {
        const stream = createReadStream(file, { autoClose: false });
        const error = await new Promise<Error | null | undefined>(resolve => stream.close(resolve));
        strictEqual((error as NodeJS.ErrnoException | null | undefined)?.code, 'ERR_STREAM_PREMATURE_CLOSE');
        strictEqual(stream.closed, true);
    } finally {
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: mutable start stays observable and end controls subsequent reads', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-range-fields-' });
    fs.writeFileSync(file, 'abcdef');
    try {
        for (const start of [undefined, 1]) {
            const stream = createReadStream(file, { start, highWaterMark: 1, end: Infinity });
            strictEqual(stream.start, start);
            strictEqual(stream.end, Infinity);
            stream.start = 5;
            stream.end = 3;
            let contents = '';
            const closed = once(stream, 'close');
            stream.on('data', (chunk: Uint8Array) => {
                contents += Buffer.from(chunk).toString();
                stream.end = 2;
            });
            await closed;
            strictEqual(contents, start === undefined ? 'abc' : 'bc');
            strictEqual(stream.start, 5);
            strictEqual(stream.end, 2);
        }
        const fd = fs.openSync(file, 'r');
        fs.readSync(fd, Buffer.alloc(2), 0, 2, null);
        const stream = createReadStream(null as never, { fd, end: 2 });
        strictEqual(stream.flags, undefined);
        strictEqual(stream.mode, undefined);
        let contents = '';
        const closed = once(stream, 'close');
        stream.on('data', (chunk: Uint8Array) => { contents += Buffer.from(chunk).toString(); });
        await closed;
        strictEqual(contents, 'cde');
        throws(() => fs.fstatSync(fd), { code: 'EBADF' });
    } finally {
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: public flags and mode affect deferred open while start does not seek again', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-open-fields-' });
    const modeFile = `${file}-mode`;
    try {
        fs.writeFileSync(file, 'abcdef');
        const patcher = createWriteStream(file, { flags: 'r+', start: 1 });
        strictEqual(patcher.start, 1);
        patcher.start = 5;
        const patched = once(patcher, 'close');
        patcher.end('X');
        await patched;
        strictEqual(patcher.start, 5);
        strictEqual(fs.readFileSync(file, 'utf8'), 'aXcdef');

        const appender = createWriteStream(file);
        strictEqual(appender.flags, 'w');
        strictEqual(appender.mode, 0o666);
        appender.flags = 'a';
        const appended = once(appender, 'close');
        appender.end('Y');
        await appended;
        strictEqual(fs.readFileSync(file, 'utf8'), 'aXcdefY');

        const reader = createReadStream(file);
        strictEqual(reader.flags, 'r');
        strictEqual(reader.mode, 0o666);
        const readClosed = once(reader, 'close');
        reader.flags = 'r+';
        await once(reader, 'open');
        strictEqual(fs.writeSync(reader.fd!, 'Z', 0), 1);
        reader.destroy();
        await readClosed;
        strictEqual(fs.readFileSync(file, 'utf8'), 'ZXcdefY');

        const modeStream = createWriteStream(modeFile);
        modeStream.mode = 0o600;
        const modeClosed = once(modeStream, 'close');
        modeStream.end('private');
        await modeClosed;
        if (process.platform !== 'win32') {
            strictEqual(fs.statSync(modeFile).mode & 0o777, 0o600 & ~process.umask());
        }
    } finally {
        Deno.removeSync(file);
        if (fs.existsSync(modeFile)) Deno.removeSync(modeFile);
    }
});

Deno.test('fs streams: autoClose assignments share the stream autoDestroy state', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-auto-close-field-' });
    fs.writeFileSync(file, 'caller-owned');
    try {
        for (const create of [createReadStream, createWriteStream]) {
            for (const initial of [false, true]) {
                const stream = create(file, { flags: 'r+', autoClose: initial });
                strictEqual(stream.autoClose, initial);
                await once(stream, 'open');
                const fd = stream.fd!;
                stream.autoClose = !initial;
                strictEqual(stream instanceof ReadStream
                    ? stream._readableState.autoDestroy : stream._writableState.autoDestroy, !initial);
                const terminalEvent = stream instanceof ReadStream ? 'end' : 'finish';
                const events: string[] = [];
                stream.on(terminalEvent, () => events.push(terminalEvent));
                stream.on('close', () => events.push('close'));
                const completed = once(stream, terminalEvent);
                const closed = once(stream, 'close');
                if (stream instanceof ReadStream) stream.resume();
                else stream.end('written');
                await completed;
                if (initial) {
                    strictEqual(stream.destroyed, false);
                    strictEqual(fs.fstatSync(fd).isFile(), true);
                    deepStrictEqual(events, [terminalEvent]);
                    stream.destroy();
                }
                await closed;
                strictEqual(stream.fd, null);
                strictEqual(stream.autoClose, !initial);
                assertClosedDescriptor(fd);
                deepStrictEqual(events, [terminalEvent, 'close']);
            }
        }
    } finally {
        Deno.removeSync(file);
    }
});

Deno.test('fs streams: autoClose false errors retain the fd until explicit destroy', async () => {
    const file = Deno.makeTempFileSync({ prefix: 'cno-stream-error-owner-' });
    try {
        for (const create of [createReadStream, createWriteStream]) {
            const stream = create(`${file}-missing`, { flags: 'r+', autoClose: false });
            const events: string[] = [];
            stream.on('close', () => events.push('close'));
            const errored = once(stream, 'error');
            if (stream instanceof ReadStream) stream.resume();
            else stream.end('X');
            const [error] = await errored;
            strictEqual((error as NodeJS.ErrnoException).code, 'ENOENT');
            strictEqual(stream.destroyed, false);
            strictEqual(stream.closed, false);
            deepStrictEqual(events, []);
            const closed = new Promise<void>(resolve => stream.once('close', resolve));
            stream.destroy();
            await closed;
            strictEqual(stream.fd, null);
            deepStrictEqual(events, ['close']);
        }
        const fd = fs.openSync(file, 'r');
        const stream = createWriteStream(null as never, { fd, autoClose: false });
        const events: string[] = [];
        stream.on('close', () => events.push('close'));
        const errored = once(stream, 'error');
        stream.end('X');
        const [error] = await errored;
        strictEqual((error as NodeJS.ErrnoException).code, 'EBADF');
        strictEqual(stream.destroyed, false);
        strictEqual(fs.fstatSync(fd).isFile(), true);
        deepStrictEqual(events, []);
        const closed = once(stream, 'close');
        stream.destroy();
        await closed;
        assertClosedDescriptor(fd);
    } finally {
        Deno.removeSync(file);
    }
});
