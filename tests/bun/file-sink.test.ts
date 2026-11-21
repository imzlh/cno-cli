import { rejects, strictEqual, throws } from 'node:assert';
import Bun, { stderr, stdin, stdout } from 'bun';
import { join } from 'node:path';
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const nativeFs = import.meta.use('fs');

const fixtureRoot = fileURLToPath(new URL('../../build/bun-polyfill-VFyMWN5X/filesink-r5/tmp/', import.meta.url));
mkdirSync(fixtureRoot, { recursive: true });

async function withFileSinkFixture<T>(prefix: string, fn: (dir: string) => T | Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(fixtureRoot, `${prefix}-`));
    try {
        return await fn(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

Deno.test({ name: 'bun.file.writer: buffered writes flush through end()', timeout: 10000 }, async () => {
    await withFileSinkFixture('file-sink', (dir) => {
        const path = join(dir, 'sink.txt');
        const sink = Bun.file(path).writer();
        strictEqual(sink.write('hello '), 6);
        strictEqual(sink.write(new Uint8Array([119, 111])), 2); // "wo"
        strictEqual(sink.flush(), 8);
        // The file is readable before end(); end() contributes no more bytes.
        strictEqual(readFileSync(path, 'utf8'), 'hello wo');
        strictEqual(sink.write('rld'), 3);
        strictEqual(sink.end(), 3);
        strictEqual(readFileSync(path, 'utf8'), 'hello world');
        throws(() => sink.write(null as never), TypeError);
        strictEqual(sink.write('late'), true);
        strictEqual(sink.flush(), true);
        strictEqual(sink.end(), 0);
    });
});

Deno.test({ name: 'bun.file.writer: highWaterMark is an advisory hint and options are validated', timeout: 10000 }, async () => {
    await withFileSinkFixture('file-sink-hwm', (dir) => {
        const path = join(dir, 'eager.txt');
        const sink = Bun.file(path).writer({ highWaterMark: 4 });
        sink.write('abc');
        strictEqual(readFileSync(path, 'utf8'), '');
        sink.write('d');
        strictEqual(readFileSync(path, 'utf8'), '');
        strictEqual(sink.flush(), 4);
        strictEqual(readFileSync(path, 'utf8'), 'abcd');
        const chunk = new Uint8Array(1000).fill(65);
        for (let index = 0; index < 4; index++) strictEqual(sink.write(chunk), 1000);
        strictEqual(readFileSync(path).byteLength, 4);
        strictEqual(sink.write(chunk), 5000);
        chunk.fill(66);
        strictEqual(readFileSync(path, 'utf8'), 'abcd' + 'A'.repeat(5000));
        strictEqual(sink.write(new Uint8Array(4096).fill(67)), 4096);
        strictEqual(sink.write('tail'), 4);
        strictEqual(readFileSync(path).byteLength, 9100);
        strictEqual(sink.flush(), 4);
        strictEqual(sink.end(), 0);
        throws(() => Bun.file(path).writer('x' as never), TypeError);
        const permissive = Bun.file(join(dir, 'permissive.txt')).writer({ highWaterMark: -1 });
        permissive.start('ignored' as never);
        strictEqual(permissive.write('ok'), 2);
        strictEqual(permissive.end(), 2);
    });
});

Deno.test({ name: 'bun.file.writer: retries partial flushes without replay and preserves borrowed descriptors', timeout: 10000 }, async () => {
    await withFileSinkFixture('file-sink-retry', (dir) => {
        const originalPwrite = nativeFs.pwrite;
        for (const phase of ['buffer', 'pending'] as const) {
            const path = join(dir, `${phase}.txt`);
            const sink = Bun.file(path).writer();
            sink.write('prefix');
            const chunk = new Uint8Array(4096).fill(65);
            const failure = new Error(`partial ${phase} failure`);
            let calls = 0;
            Reflect.set(nativeFs, 'pwrite', (fd: number, bytes: Uint8Array, offset: number) => {
                calls++;
                if (calls === 1) {
                    return originalPwrite(fd, phase === 'buffer' ? bytes.subarray(0, 2) : bytes, offset);
                }
                if (calls === 2 && phase === 'pending') return originalPwrite(fd, bytes.subarray(0, 17), offset);
                throw failure;
            });
            try {
                throws(() => sink.write(chunk), failure);
            } finally {
                Reflect.set(nativeFs, 'pwrite', originalPwrite);
            }
            chunk.fill(66);
            if (phase === 'buffer') {
                strictEqual(sink.flush(), 4100);
                strictEqual(sink.end(), 0);
            } else {
                strictEqual(sink.write('!'), 4080);
                strictEqual(sink.end(), 1);
            }
            strictEqual(readFileSync(path, 'utf8'), 'prefix' + 'A'.repeat(4096) + (phase === 'pending' ? '!' : ''));
        }

        const path = join(dir, 'borrowed.txt');
        const fd = openSync(path, 'w+');
        try {
            const sink = Bun.file(fd).writer();
            strictEqual(sink.write(new Uint8Array(4096).fill(68)), 4096);
            strictEqual(sink.end(), 0);
            strictEqual(fstatSync(fd).size, 4096);
            strictEqual(readFileSync(path, 'utf8'), 'D'.repeat(4096));
        } finally {
            closeSync(fd);
        }
    });
});

Deno.test({ name: 'bun.file.writer: overwrites without truncation and end(error) flushes pending data', timeout: 10000 }, async () => {
    await withFileSinkFixture('file-sink-trunc', async (dir) => {
        const path = join(dir, 'trunc.txt');
        await Bun.write(path, 'previous content');
        const sink = Bun.file(path).writer();
        strictEqual(sink.flush(), 0);
        // Truncation happens on the first real flush.
        sink.write('new');
        sink.flush();
        strictEqual(readFileSync(path, 'utf8'), 'newvious content');

        const errorPath = join(dir, 'error.txt');
        const failing = Bun.file(errorPath).writer();
        strictEqual(existsSync(errorPath), true);
        failing.write('dropped');
        const error = new Error('sink failure');
        strictEqual(failing.end(error), 7);
        // Double end is an idempotent no-op, matching the subprocess FileSink.
        strictEqual(failing.end(new Error('again')), 0);
        strictEqual(readFileSync(errorPath, 'utf8'), 'dropped');
    });
});

Deno.test({ name: 'bun.file.writer: rejects Blob chunks and creates the target eagerly', timeout: 10000 }, async () => {
    await withFileSinkFixture('file-sink-inputs', (dir) => {
        const path = join(dir, 'created.txt');
        const sink = Bun.file(path).writer();
        strictEqual(existsSync(path), true);
        strictEqual(readFileSync(path, 'utf8'), '');
        throws(() => sink.write(new Blob(['not accepted']) as never), {
            name: 'TypeError',
            message: 'write() expects a string, ArrayBufferView, or ArrayBuffer',
        });
        strictEqual(sink.write(new DataView(new Uint8Array([1, 2]).buffer)), 2);
        strictEqual(sink.end(null as never), 2);
        strictEqual(readFileSync(path).toString('hex'), '0102');
    });
});

Deno.test({ name: 'bun.file.writer: binary chunks use cross-realm brands and intrinsic view slots', timeout: 10000 }, async () => {
    await withFileSinkFixture('file-sink-binary', (dir) => {
        const foreign = runInNewContext(`(() => {
            const buffer = new ArrayBuffer(8);
            new Uint8Array(buffer).set([10, 11, 12, 13, 14, 15, 16, 17]);
            const typed = new Uint16Array(buffer, 2, 2);
            const data = new DataView(buffer, 5, 2);
            const result = { buffer, typed, data };
            if (typeof SharedArrayBuffer === 'function') {
                const shared = new SharedArrayBuffer(4);
                new Uint8Array(shared).set([21, 22, 23, 24]);
                result.shared = shared;
                result.sharedView = new Uint8Array(shared, 1, 2);
            }
            for (const value of Object.values(result)) {
                for (const property of ['buffer', 'byteOffset', 'byteLength']) {
                    Object.defineProperty(value, property, {
                        configurable: true,
                        get() { throw new Error('shadowed ' + property + ' getter ran'); },
                    });
                }
            }
            return result;
        })()`);

        const path = join(dir, 'binary.bin');
        const sink = Bun.file(path).writer();
        strictEqual(sink.write(foreign.buffer), 8);
        strictEqual(sink.write(foreign.typed), 4);
        strictEqual(sink.write(foreign.data), 2);
        const expected = [10, 11, 12, 13, 14, 15, 16, 17, 12, 13, 14, 15, 15, 16];
        if (foreign.shared) {
            strictEqual(sink.write(foreign.shared), 4);
            strictEqual(sink.write(foreign.sharedView), 2);
            expected.push(21, 22, 23, 24, 22, 23);
        }

        const detached = new ArrayBuffer(4);
        const detachedTyped = new Uint8Array(detached, 1, 2);
        const detachedData = new DataView(detached, 1, 2);
        structuredClone(detached, { transfer: [detached] });
        strictEqual(sink.write(detached), 0);
        strictEqual(sink.write(detachedTyped), 0);
        strictEqual(sink.write(detachedData), 0);

        for (const value of [new Proxy(foreign.buffer, {}), new Proxy(foreign.typed, {})]) {
            throws(() => sink.write(value), {
                name: 'TypeError',
                message: 'write() expects a string, ArrayBufferView, or ArrayBuffer',
                code: 'ERR_INVALID_ARG_TYPE',
            });
        }
        strictEqual(sink.end(), expected.length);
        strictEqual(readFileSync(path).toString('hex'), Buffer.from(expected).toString('hex'));
    });
});

Deno.test({ name: 'bun.file.writer: built-in shape and receiver brands', timeout: 10000 }, async () => {
    await withFileSinkFixture('file-sink-shape', (dir) => {
        const sink = Bun.file(join(dir, 'shape.txt')).writer();
        const prototype = Object.getPrototypeOf(sink) as Record<string, Function>;
        strictEqual(Object.prototype.toString.call(sink), '[object FileSink]');
        strictEqual(sink.constructor.name, 'FileSink');

        for (const [name, length] of [['start', 1], ['write', 1], ['flush', 1], ['end', 0]] as const) {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
            strictEqual(descriptor.enumerable, true);
            strictEqual(descriptor.writable, false);
            strictEqual(descriptor.configurable, false);
            strictEqual(descriptor.value.length, length);
            throws(() => Reflect.apply(descriptor.value, {}, name === 'write' ? ['x'] : []), {
                name: 'TypeError',
                message: 'Expected FileSink',
                code: 'ERR_INVALID_THIS',
            });
        }

        throws(() => new (sink.constructor as new () => object)(), {
            name: 'TypeError',
            message: 'Illegal constructor',
            code: 'ERR_ILLEGAL_CONSTRUCTOR',
        });
        strictEqual(Reflect.apply(prototype.ref, null, []), undefined);
        strictEqual(Reflect.apply(prototype.unref, {}, []), undefined);
        strictEqual(sink.end(), 0);
    });
});

Deno.test({ name: 'bun.write accepts a ReadableStream body', timeout: 10000 }, async () => {
    await withFileSinkFixture('write-stream', async (dir) => {
        const path = join(dir, 'streamed.txt');
        const source = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of ['st', 'rea', 'm']) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
            },
        });
        const written = await Bun.write(path, source);
        strictEqual(written, 6);
        strictEqual(readFileSync(path, 'utf8'), 'stream');
    });
});

Deno.test({ name: 'bun.stdio.writer: incremental writes over the fixed descriptor', timeout: 5000 }, async () => {
    const sink = stdout.writer({ highWaterMark: 4 });
    strictEqual(sink.write('sink'), 4);
    strictEqual(sink.write('-probe'), 6);
    strictEqual(sink.flush(), 10);
    strictEqual(sink.end(), 0); // the fd stays open
    strictEqual(sink.end(), 0);
    throws(() => stdin.writer(), /not writable/);
    await rejects(() => stderr.text(), /not readable/);
});
