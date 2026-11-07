import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import Bun, { file, write } from 'bun';
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withTempDir } from '../_helpers/temp.ts';

function stagingFiles(): string[] {
    return [...Deno.readDirSync(tmpdir())]
        .map(entry => entry.name)
        .filter(name => name.startsWith(`cno-bun-write-${Deno.pid}-`))
        .sort();
}

const positiveSizePseudoFile = (() => {
    if (Deno.build.os !== 'linux') return undefined;
    for (const path of [
        '/sys/devices/system/cpu/online',
        '/sys/devices/system/node/online',
        '/sys/kernel/mm/lru_gen/enabled',
        '/sys/kernel/uevent_seqnum',
    ]) {
        try {
            const stat = Deno.statSync(path);
            const bytes = Deno.readFileSync(path);
            if (stat.isFile && stat.size > 0 && bytes.byteLength > 1 && bytes.byteLength !== stat.size) {
                return { path, bytes };
            }
        } catch {
            // Sysfs layout varies by kernel; try the next small candidate.
        }
    }
    return undefined;
})();

function readFromCurrentOffset(fd: number): string {
    const chunks: Uint8Array[] = [];
    while (true) {
        const buffer = new Uint8Array(32);
        const count = readSync(fd, buffer, 0, buffer.byteLength, null);
        if (count === 0) break;
        chunks.push(buffer.slice(0, count));
    }
    return chunks.map(chunk => new TextDecoder().decode(chunk)).join('');
}

Deno.test({ name: 'bun: file lazily reads paths and local file URLs', timeout: 10000 }, async () => {
    await withTempDir('bun-file-read', async (root) => {
        const path = join(root, 'message.txt');
        await write(path, 'héllo');

        const fromPath = file(path);
        const fromUrl = file(pathToFileURL(path), { type: 'text/plain' });
        strictEqual(Bun.file, file);
        strictEqual(fromPath.name, path);
        strictEqual(fromUrl.name, path);
        deepStrictEqual(Object.keys(fromPath), []);
        deepStrictEqual(Reflect.ownKeys(fromPath), []);
        Reflect.set(fromPath, 'path', join(root, 'not-the-source.txt'));
        Reflect.set(fromPath, 'rangeStart', 999);
        Reflect.set(fromPath, 'contentType', 'text/wrong');
        strictEqual(fromPath.size, 6);
        strictEqual(fromPath.type, 'text/plain;charset=utf-8');
        strictEqual(fromUrl.type, 'text/plain;charset=utf-8');
        strictEqual(await fromPath.exists(), true);
        strictEqual(await fromPath.text(), 'héllo');
        deepStrictEqual(Array.from(await fromPath.bytes()), [104, 195, 169, 108, 108, 111]);
        strictEqual((await fromPath.arrayBuffer()).byteLength, 6);
        strictEqual(await new Response(fromPath).text(), 'héllo');
    });
});

Deno.test('bun: file borrows descriptors and consumes their shared read offset', async () => {
    await withTempDir('bun-file-fd-read', async (root) => {
        const path = join(root, 'source.txt');
        writeFileSync(path, '0123456789');
        const fd = openSync(path, 'r+');
        try {
            const prefix = new Uint8Array(2);
            strictEqual(readSync(fd, prefix, 0, 2, null), 2);
            const source = file(fd, { type: 'text/custom' });
            strictEqual(source.name, undefined);
            strictEqual(source.type, 'text/custom');
            strictEqual(file(fd).type, 'application/octet-stream');
            strictEqual(file(fd, { type: '' }).type, 'application/octet-stream');
            strictEqual(source.size, 10);
            strictEqual(source.lastModified, Deno.statSync(path).mtime!.getTime());
            strictEqual(await source.exists(), true);
            strictEqual((await source.stat()).size, 10);
            strictEqual(await source.text(), '23456789');
            strictEqual(await source.text(), '');
            strictEqual(fstatSync(fd).size, 10);

            const cloneFd = openSync(path, 'r');
            try {
                strictEqual(readSync(cloneFd, new Uint8Array(2), 0, 2, null), 2);
                const clone = structuredClone(file(cloneFd));
                strictEqual(await clone.text(), '23456789');
                strictEqual(readFromCurrentOffset(cloneFd), '');
                strictEqual(fstatSync(cloneFd).size, 10);
            } finally {
                closeSync(cloneFd);
            }
        } finally {
            closeSync(fd);
        }
    });
});

Deno.test('bun: descriptor streams and nonnegative slices use positional reads', async () => {
    await withTempDir('bun-file-fd-stream', async (root) => {
        const path = join(root, 'source.txt');
        writeFileSync(path, '0123456789');
        const fd = openSync(path, 'r');
        try {
            const prefix = new Uint8Array(4);
            strictEqual(readSync(fd, prefix, 0, 4, null), 4);
            strictEqual(await new Response(file(fd).stream()).text(), '0123456789');
            strictEqual(await new Response(file(fd).slice(2, 5).stream()).text(), '234');
            strictEqual(await new Response(file(fd).slice(-Infinity, 3).stream()).text(), '012');
            strictEqual(readFromCurrentOffset(fd), '456789');
            throws(() => file(fd).slice(-1), /Negative slices/);
            await rejects(() => file(fd).slice(1, 3).text(), /cannot seek a borrowed descriptor/);
        } finally {
            closeSync(fd);
        }
    });
});

Deno.test('bun: descriptor writes and writers advance the shared offset without closing', async () => {
    await withTempDir('bun-file-fd-write', async (root) => {
        const path = join(root, 'target.txt');
        writeFileSync(path, '0123456789');
        const fd = openSync(path, 'r+');
        try {
            const prefix = new Uint8Array(3);
            strictEqual(readSync(fd, prefix, 0, 3, null), 3);
            const target = file(fd);
            strictEqual(await target.write('AB'), 2);
            strictEqual(await write(target, new Response('CD')), 2);
            const writer = target.writer();
            strictEqual(writer.write('E'), 1);
            strictEqual(writer.end(), 1);
            strictEqual(readFileSync(path, 'utf8'), '012ABCDE89');
            strictEqual(readFromCurrentOffset(fd), '89');
            strictEqual(fstatSync(fd).size, 10);
        } finally {
            closeSync(fd);
        }
    });
});

Deno.test('bun: write accepts numeric descriptor destinations', async () => {
    await withTempDir('bun-write-fd', async (root) => {
        const path = join(root, 'target.txt');
        writeFileSync(path, '0123456789');
        const fd = openSync(path, 'r+');
        try {
            strictEqual(readSync(fd, new Uint8Array(3), 0, 3, null), 3);
            strictEqual(await write(fd, new Uint8Array([88, 65, 66, 89]).subarray(1, 3)), 2);
            strictEqual(await write(fd, new Response('CD')), 2);
            strictEqual(await write(fd, new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('E'));
                    controller.close();
                },
            }), { createPath: false, mode: 0o600 }), 1);
            strictEqual(readFileSync(path, 'utf8'), '012ABCDE89');
            strictEqual(readFromCurrentOffset(fd), '89');
            strictEqual(fstatSync(fd).size, 10);
        } finally {
            closeSync(fd);
        }

        for (const value of [-1, 1.5, NaN, Infinity, 2 ** 31]) {
            await rejects(() => write(value, 'x'), { code: 'ERR_OUT_OF_RANGE' });
        }
        const closed = openSync(path, 'r+');
        closeSync(closed);
        await rejects(() => write(closed, 'x'), { code: 'EBADF' });
        strictEqual(readFileSync(path, 'utf8'), '012ABCDE89');
    });
});

Deno.test('bun: descriptor BunFiles stream as write sources and expose deletion errors as values', async () => {
    await withTempDir('bun-file-fd-source', async (root) => {
        const sourcePath = join(root, 'source.txt');
        const targetPath = join(root, 'target.txt');
        const samePath = join(root, 'same.txt');
        const largePath = join(root, 'large.bin');
        writeFileSync(sourcePath, 'abcdef');
        writeFileSync(targetPath, 'XXXXXXXX');
        const sourceFd = openSync(sourcePath, 'r');
        const targetFd = openSync(targetPath, 'r+');
        try {
            strictEqual(readSync(sourceFd, new Uint8Array(2), 0, 2, null), 2);
            strictEqual(readSync(targetFd, new Uint8Array(3), 0, 3, null), 3);
            strictEqual(await write(file(targetFd), file(sourceFd)), 4);
            strictEqual(readFileSync(targetPath, 'utf8'), 'XXXcdefX');
            strictEqual(readFromCurrentOffset(sourceFd), '');
            strictEqual(readFromCurrentOffset(targetFd), 'X');

            const deletion = await file(targetFd).delete() as unknown as Error & { code?: string };
            strictEqual(deletion instanceof TypeError, true);
            strictEqual(deletion.code, 'ERR_INVALID_ARG_TYPE');
            strictEqual(readFileSync(targetPath, 'utf8'), 'XXXcdefX');

            writeFileSync(samePath, '0123456789');
            const sameFd = openSync(samePath, 'r+');
            try {
                strictEqual(readSync(sameFd, new Uint8Array(2), 0, 2, null), 2);
                const same = file(sameFd);
                strictEqual(await write(same, same), 8);
                strictEqual(readFileSync(samePath, 'utf8'), '012345678923456789');
                strictEqual(fstatSync(sameFd).size, 18);
            } finally {
                closeSync(sameFd);
            }

            const directFd = openSync(samePath, 'r+');
            try {
                strictEqual(readSync(directFd, new Uint8Array(2), 0, 2, null), 2);
                strictEqual(await write(directFd, file(directFd)), 16);
                strictEqual(readFileSync(samePath, 'utf8'), '0123456789234567892345678923456789');
                strictEqual(fstatSync(directFd).size, 34);
            } finally {
                closeSync(directFd);
            }

            const large = new Uint8Array(70 * 1024);
            for (let index = 0; index < large.byteLength; index++) large[index] = index % 251;
            writeFileSync(largePath, large);
            const largeFd = openSync(largePath, 'r+');
            try {
                strictEqual(readSync(largeFd, new Uint8Array(17), 0, 17, null), 17);
                const same = file(largeFd);
                strictEqual(await write(same, same), large.byteLength - 17);
                const actual = readFileSync(largePath);
                strictEqual(actual.byteLength, large.byteLength * 2 - 17);
                deepStrictEqual(new Uint8Array(actual.subarray(0, large.byteLength)), large);
                deepStrictEqual(new Uint8Array(actual.subarray(large.byteLength)), large.subarray(17));
            } finally {
                closeSync(largeFd);
            }
        } finally {
            closeSync(sourceFd);
            closeSync(targetFd);
        }
    });
});

Deno.test('bun: descriptor construction validates eagerly but use stays lazy', async () => {
    for (const value of [-1, 2 ** 31]) {
        throws(() => file(value), { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' });
    }
    for (const value of [1.5, NaN, Infinity]) {
        throws(() => file(value), { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' });
    }

    await withTempDir('bun-file-fd-closed', async (root) => {
        const path = join(root, 'closed.txt');
        writeFileSync(path, 'closed');
        const fd = openSync(path, 'r');
        const source = file(fd);
        closeSync(fd);
        strictEqual(source.size, 0);
        strictEqual(source.lastModified, 2 ** 52 - 1);
        strictEqual(await source.exists(), false);
        await rejects(() => source.stat(), { code: 'EBADF' });
        await rejects(() => source.text(), { code: 'EBADF' });
        await rejects(() => source.write('x'), { code: 'EBADF' });
        await rejects(() => write(source, 'x'), { code: 'EBADF' });
    });
});

Deno.test('bun: file reports missing and empty files without fabricated contents', async () => {
    await withTempDir('bun-file-empty', async (root) => {
        const missing = file(join(root, 'missing.bin'));
        strictEqual(missing.size, 0);
        strictEqual(missing.lastModified, 2 ** 52 - 1);
        strictEqual(missing.type, 'application/octet-stream');
        strictEqual(await missing.exists(), false);
        await rejects(() => missing.text());

        const emptyPath = join(root, 'empty.txt');
        strictEqual(await write(emptyPath, ''), 0);
        const empty = file(emptyPath);
        strictEqual(empty.size, 0);
        strictEqual(await empty.text(), '');
        deepStrictEqual(Array.from(await empty.bytes()), []);
        const reader = empty.stream().getReader();
        deepStrictEqual(await reader.read(), { done: true, value: undefined });
        await reader.releaseLock();
    });
});

Deno.test('bun: file formData uses its content type and remains repeatable', async () => {
    await withTempDir('bun-file-formdata', async (root) => {
        const urlEncodedPath = join(root, 'values.data');
        await write(urlEncodedPath, 'a=1&b=hello+world&a=2');
        const source = file(urlEncodedPath, { type: 'application/x-www-form-urlencoded' });
        const expected = [['a', '1'], ['b', 'hello world'], ['a', '2']];

        deepStrictEqual([...await source.formData()], expected);
        deepStrictEqual([...await source.formData()], expected);
        deepStrictEqual([...await source.slice().formData()], expected);
        await rejects(() => source.slice('text/plain').formData(), /Unsupported content type/);

        const defaultTextPath = join(root, 'values.txt');
        await write(defaultTextPath, 'x=1');
        await rejects(() => file(defaultTextPath).formData(), /Unsupported content type/);

        for (const type of ['application/x-www-form-urlencoded', 'text/plain']) {
            await rejects(() => file(join(root, 'missing.data'), { type }).formData(), { code: 'ENOENT' });
        }

        const multipartPath = join(root, 'multipart.data');
        await write(multipartPath,
            '--b\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n' +
            '--b\r\nContent-Disposition: form-data; name="upload"; filename="x.txt"\r\n' +
            'Content-Type: text/plain\r\n\r\nxy\r\n--b--\r\n');
        const multipart = await file(multipartPath, { type: 'multipart/form-data; boundary=b' }).formData();
        strictEqual(multipart.get('field'), 'value');
        const upload = multipart.get('upload');
        ok(upload instanceof File);
        strictEqual(upload.name, 'x.txt');
        strictEqual(await upload.text(), 'xy');
    });
});

Deno.test('bun: file slices use byte bounds, including nested slices and negatives', async () => {
    await withTempDir('bun-file-slice', async (root) => {
        const path = join(root, 'letters.txt');
        await write(path, 'abcdef');
        const source = file(path);

        strictEqual(await source.slice(1, 4).text(), 'bcd');
        strictEqual(await source.slice(1, 4).slice(1).text(), 'cd');
        strictEqual(await source.slice(1, 5).slice(-3, -1).text(), 'cd');
        strictEqual(await source.slice(-5).slice(1, -1).text(), 'cde');
        strictEqual(await source.slice(-3, -1).text(), 'de');
        strictEqual(await source.slice(99).text(), '');
        strictEqual(await source.slice(4, 1).text(), '');
        // [Clamp] semantics: infinities saturate, NaN is 0.
        strictEqual(await source.slice(1, Infinity).text(), 'bcdef');
        strictEqual(await source.slice(-Infinity, 2).text(), 'ab');
        strictEqual(await source.slice(Infinity).text(), '');
        strictEqual(await source.slice(0, -Infinity).text(), '');
        strictEqual(await source.slice(NaN, 3).text(), 'abc');
        strictEqual(source.slice(1, 4, 'text/custom').type, 'text/custom');
    });
});

Deno.test('bun: slices stay lazy when files appear or change after slicing', async () => {
    await withTempDir('bun-file-lazy-slice', async (root) => {
        const path = join(root, 'later.txt');
        const source = file(path);
        strictEqual(source.size, 0);
        const bounded = source.slice(1, 5).slice(1, -1);
        const tail = source.slice(-3, -1);
        strictEqual(bounded.size, 0);
        await write(path, 'abcdef');
        strictEqual(bounded.size, 2);
        strictEqual(await bounded.text(), 'cd');
        strictEqual(await tail.text(), 'de');

        const unbounded = source.slice(2);
        await write(path, 'ABCDEFGHIJ');
        strictEqual(await unbounded.text(), 'CDEFGHIJ');
        strictEqual(await tail.text(), 'HI');
    });
});

Deno.test('bun: synchronous Blob consumers read file data and slice bounds', async () => {
    await withTempDir('bun-file-blob-bridge', async (root) => {
        const path = join(root, 'snapshot.txt');
        await write(path, 'abcdef');
        const source = file(path).slice(1, 5).slice(-3, -1);
        const getBytes = Reflect.get(source, Symbol.for('cno.blob.bytes'));
        deepStrictEqual(Array.from(Reflect.apply(getBytes, source, [])), [99, 100]);
        const clone = structuredClone(source);
        strictEqual(clone.size, 2);
        strictEqual(await clone.text(), 'cd');
        await write(path, 'uvwxyz');
        strictEqual(await clone.text(), 'cd');

        const url = URL.createObjectURL(source);
        try {
            strictEqual(await (await fetch(url)).text(), 'wx');
        } finally {
            URL.revokeObjectURL(url);
        }
    });
});

Deno.test({
    name: 'bun: zero-stat procfs files read through EOF, including slices',
    ignore: Deno.build.os !== 'linux',
}, async () => {
    const path = '/proc/self/cmdline';
    const expected = Deno.readFileSync(path);
    ok(expected.byteLength > 0);
    const source = file(path);
    strictEqual(source.size, 0);
    deepStrictEqual(await source.bytes(), expected);
    deepStrictEqual(await source.slice(1, 12).bytes(), expected.slice(1, 12));
    deepStrictEqual(await source.slice(-5, -1).bytes(), expected.slice(-5, -1));
    const bytes = Reflect.apply(Reflect.get(source, Symbol.for('cno.blob.bytes')), source, []);
    deepStrictEqual(bytes, expected);
});

Deno.test({
    name: 'bun: positive-size pseudo-files ignore fictional stat lengths',
    ignore: positiveSizePseudoFile === undefined,
}, async () => {
    const { path, bytes: expected } = positiveSizePseudoFile!;
    const source = file(path);
    deepStrictEqual(await source.bytes(), expected);
    deepStrictEqual(await source.slice(1, 3).bytes(), expected.slice(1, 3));
    deepStrictEqual(await source.slice(-2).bytes(), expected.slice(-2));
    const bytes = Reflect.apply(Reflect.get(source, Symbol.for('cno.blob.bytes')), source, []);
    deepStrictEqual(bytes, expected);
});

Deno.test({
    name: 'bun: FIFO reads use sequential chunks instead of zero stat length',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
}, async () => {
    await withTempDir('bun-file-fifo', async (root) => {
        const path = join(root, 'pipe');
        const created = await new Deno.Command('mkfifo', { args: [path] }).output();
        strictEqual(created.code, 0);
        const source = file(path);
        strictEqual(source.size, 0);
        const writer = new Deno.Command('/bin/sh', {
            args: ['-c', 'printf abcdef > "$1"', 'sh', path],
            stdout: 'null',
            stderr: 'null',
        }).spawn();
        try {
            strictEqual(await source.slice(1, 5).text(), 'bcde');
        } finally {
            strictEqual((await writer.status).code, 0);
        }
    });
});

Deno.test({ name: 'bun: write preserves typed-array offsets and accepts Blob/Response inputs', timeout: 10000 }, async () => {
    await withTempDir('bun-file-write-inputs', async (root) => {
        const path = join(root, 'output.bin');
        const source = new Uint8Array([0, 65, 66, 0]);
        strictEqual(await write(path, source.subarray(1, 3)), 2);
        deepStrictEqual(Array.from(await file(path).bytes()), [65, 66]);

        const data = new ArrayBuffer(5);
        new Uint8Array(data).set([0, 88, 89, 90, 0]);
        strictEqual(await write(path, new DataView(data, 1, 3)), 3);
        strictEqual(await file(path).text(), 'XYZ');

        strictEqual(await write(path, new Blob(['blob'])), 4);
        strictEqual(await file(path).text(), 'blob');
        const streamedBlob = new Blob(['streamed']);
        streamedBlob.arrayBuffer = async () => { throw new Error('must use Blob.stream'); };
        strictEqual(await write(path, streamedBlob), 8);
        strictEqual(await file(path).text(), 'streamed');
        strictEqual(await write(path, new Response('response')), 8);
        strictEqual(await file(path).text(), 'response');
        strictEqual(await write(path, new Response(null)), 0);
        strictEqual(await file(path).text(), '');
        strictEqual(await file(path).write('options', {}), 7);
        strictEqual(await file(path).write('hint', { highWaterMark: 1 }), 4);
        deepStrictEqual(stagingFiles(), []);
    });
});

Deno.test({ name: 'bun: write recognizes Blob inputs by intrinsic slots', timeout: 10000 }, async () => {
    await withTempDir('bun-file-write-blob-slots', async (root) => {
        const path = join(root, 'output.txt');
        const writeBoth = async (value: Blob, expected: string) => {
            strictEqual(await write(path, value), expected.length);
            strictEqual(await file(path).text(), expected);
            strictEqual(await file(path).write(value), expected.length);
            strictEqual(await file(path).text(), expected);
        };

        const blob = new Blob(['blob-slots']);
        Object.setPrototypeOf(blob, null);
        await writeBoth(blob, 'blob-slots');

        const inputFile = new File(['file-slots'], 'input.txt');
        Object.setPrototypeOf(inputFile, null);
        await writeBoth(inputFile, 'file-slots');

        let getterCalls = 0;
        const getters = new Blob(['intrinsic']);
        for (const name of ['arrayBuffer', 'stream', 'size'] as const) {
            Object.defineProperty(getters, name, { get() { getterCalls++; throw new Error(name); } });
        }
        await writeBoth(getters, 'intrinsic');
        strictEqual(getterCalls, 0);

        for (const value of [Object.create(Blob.prototype), new Proxy(new Blob(['proxy']), {})]) {
            strictEqual(await write(path, value), 13);
            strictEqual(await file(path).text(), '[object Blob]');
            strictEqual(await file(path).write(value), 13);
            strictEqual(await file(path).text(), '[object Blob]');
        }
        const custom = { toString: () => 'custom' };
        strictEqual(await write(path, custom as never), 6);
        strictEqual(await file(path).text(), 'custom');
        strictEqual(await file(path).write(custom as never), 6);
        strictEqual(await file(path).text(), 'custom');

        const blobDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Blob')!;
        const fileDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'File')!;
        const oldBlob = new Blob(['old-blob']);
        const oldFile = new File(['old-file'], 'input.txt');
        try {
            Reflect.set(globalThis, 'Blob', function ReplacementBlob() {});
            Reflect.set(globalThis, 'File', function ReplacementFile() {});
            await writeBoth(oldBlob, 'old-blob');
            await writeBoth(oldFile, 'old-file');
        } finally {
            Object.defineProperty(globalThis, 'Blob', blobDescriptor);
            Object.defineProperty(globalThis, 'File', fileDescriptor);
        }
    });
});

Deno.test('bun: write binary brands do not use a replaced ArrayBuffer.isView', async () => {
    await withTempDir('bun-file-write-brands', async (root) => {
        const path = join(root, 'output.bin');
        const originalIsView = ArrayBuffer.isView;
        let typedResult: Uint8Array;
        let dataResult: Uint8Array;
        try {
            ArrayBuffer.isView = (() => { throw new Error('replacement called'); }) as typeof ArrayBuffer.isView;

            const typed = new Uint8Array([65, 66, 67, 68]).subarray(1, 3);
            const data = new DataView(new Uint8Array([9, 69, 70, 9]).buffer, 1, 2);
            for (const view of [typed, data]) {
                for (const property of ['buffer', 'byteOffset', 'byteLength']) {
                    Object.defineProperty(view, property, {
                        get() { throw new Error(`shadowed ${property}`); },
                    });
                }
            }

            strictEqual(await write(path, typed), 2);
            typedResult = await file(path).bytes();
            strictEqual(await file(path).write(data), 2);
            dataResult = await file(path).bytes();
        } finally {
            ArrayBuffer.isView = originalIsView;
        }
        deepStrictEqual(typedResult!, new Uint8Array([66, 67]));
        deepStrictEqual(dataResult!, new Uint8Array([69, 70]));
    });
});

Deno.test({ name: 'bun: write creates parents, truncates, and is safe for same-file input', timeout: 10000 }, async () => {
    await withTempDir('bun-file-write-paths', async (root) => {
        const path = join(root, 'nested', 'value.txt');
        strictEqual(await write(path, 'longer'), 6);
        strictEqual(await write(path, 'x'), 1);
        strictEqual(await file(path).text(), 'x');

        strictEqual(await write(path, file(path)), 1);
        strictEqual(await file(path).text(), 'x');
        strictEqual(await write(path, 'hé'), 3);
        strictEqual(await write(path, file(path).slice(1)), 2);
        strictEqual(await file(path).text(), 'é');
        strictEqual(await write(path, new Response(file(path))), 2);
        strictEqual(await file(path).text(), 'é');

        const alias = join(root, 'same-file.txt');
        await Deno.link(path, alias);
        strictEqual(await write(alias, file(path).slice(1)), 1);
        deepStrictEqual(Array.from(await file(path).bytes()), [169]);
        deepStrictEqual([...Deno.readDirSync(dirname(path))].map(entry => entry.name).filter(name => name.includes('.cno-bun-write-')), []);
    });
});

Deno.test({ name: 'bun: Response writes stream without arrayBuffer materialization', timeout: 10000 }, async () => {
    await withTempDir('bun-file-response-stream', async (root) => {
        const path = join(root, 'output.bin');
        let chunks = 0;
        const response = new Response(new ReadableStream({
            pull(controller) {
                if (chunks === 24) {
                    controller.close();
                    return;
                }
                controller.enqueue(new Uint8Array(64 * 1024).fill(chunks++));
            },
        }));
        response.arrayBuffer = async () => { throw new Error('must not materialize a Response'); };
        strictEqual(await write(path, response), 24 * 64 * 1024);
        strictEqual(response.bodyUsed, true);
        const actual = await file(path).bytes();
        for (let chunk = 0; chunk < 24; chunk++) {
            strictEqual(actual[chunk * 64 * 1024], chunk);
            strictEqual(actual[(chunk + 1) * 64 * 1024 - 1], chunk);
        }
        await rejects(() => write(path, response), /already used or locked/);
    });
});

Deno.test('bun: failed Response streams preserve existing files and clean staging files', async () => {
    await withTempDir('bun-file-response-error', async (root) => {
        const path = join(root, 'output.bin');
        await write(path, 'original');
        let reads = 0;
        const response = new Response(new ReadableStream({
            pull(controller) {
                if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
                else controller.error(new Error('input failed'));
            },
        }));
        await rejects(() => write(path, response), /input failed/);
        strictEqual(await file(path).text(), 'original');
        deepStrictEqual([...Deno.readDirSync(root)].map(entry => entry.name), ['output.bin']);
        deepStrictEqual(stagingFiles(), []);
    });
});

Deno.test('bun: write validates parent creation, mode and locked Response bodies', async () => {
    await withTempDir('bun-file-write-options', async (root) => {
        const path = join(root, 'not-created', 'output.bin');
        await rejects(() => write(path, 'x', { createPath: false }));
        strictEqual(await file(path).exists(), false);
        await rejects(() => write(path, new Blob(['x']), { createPath: false }));
        strictEqual(await file(path).exists(), false);
        strictEqual(await write(path, new Blob(['secret']), { mode: 0o600 }), 6);
        if (Deno.build.os !== 'windows') strictEqual((Deno.statSync(path).mode ?? 0) & 0o777, 0o600);

        const response = new Response('locked');
        const reader = response.body!.getReader();
        try {
            await rejects(() => write(path, response), /already used or locked/);
            strictEqual(await file(path).text(), 'secret');
        } finally {
            await reader.cancel();
            reader.releaseLock();
        }
        deepStrictEqual(stagingFiles(), []);
    });
});

Deno.test({ name: 'bun: file stream cancellation releases its descriptor', timeout: 10000 }, async () => {
    await withTempDir('bun-file-stream', async (root) => {
        const path = join(root, 'stream.bin');
        await write(path, 'a'.repeat(128 * 1024));
        const reader = file(path).stream().getReader();
        const first = await reader.read();
        ok(first.done === false && first.value.byteLength > 0);
        await reader.cancel('test cancellation');
        await reader.releaseLock();

        strictEqual(await write(path, 'closed'), 6);
        strictEqual(await file(path).text(), 'closed');
    });
});

Deno.test('bun: file and write reject unsupported options and inputs', async () => {
    await withTempDir('bun-file-errors', async (root) => {
        const path = join(root, 'value.txt');
        throws(() => file(`${path}\0suffix`), { name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE' });
        throws(() => file(new URL(`${pathToFileURL(path).href}%00suffix`)), {
            name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE',
        });
        throws(() => file(path, { endings: 'native' } as BlobPropertyBag), /unsupported option "endings"/);
        await rejects(
            () => write(path, 'x', { unsupported: true } as never),
            /unsupported option "unsupported"/,
        );
        // Bare ReadableStream input streams like Response/Blob bodies.
        const source = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('streamed'));
                controller.close();
            },
        });
        strictEqual(await write(path, source), 8);
        strictEqual(await file(path).text(), 'streamed');
        // Bun.file().write accepts unknown options as forward-compatible hints.
        strictEqual(await file(path).write('x', { unsupported: true } as never), 1);
    });
});
