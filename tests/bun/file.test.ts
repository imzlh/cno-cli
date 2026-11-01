import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import Bun, { file, write } from 'bun';
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
        throws(() => file(path, { endings: 'native' } as BlobPropertyBag), /unsupported option "endings"/);
        await rejects(
            () => write(path, 'x', { unsupported: true } as never),
            /unsupported option "unsupported"/,
        );
        await rejects(
            () => write(path, new ReadableStream()),
            /ReadableStream input is not supported/,
        );
        // Bun.file().write accepts unknown options as forward-compatible hints.
        strictEqual(await file(path).write('x', { unsupported: true } as never), 1);
    });
});
