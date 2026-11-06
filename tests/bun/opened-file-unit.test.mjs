// @cno-host: false
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let native = {
    os: { platform: process.platform, getenv: name => process.env[name] },
    asyncfs: {},
};
globalThis.__openedFileUse = name => native[name];
const bundled = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['cno/src/bun/opened-file.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    write: false,
    define: { 'import.meta.use': 'globalThis.__openedFileUse' },
});
const openedFile = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const asyncfs = native.asyncfs;

function fileStat(size, dev = 1, ino = 1) {
    return { isFile: true, size, dev, ino, mtim: new Date(0) };
}

function mockHandle(bytes, stat = fileStat(bytes.length), options = {}) {
    let offset = 0;
    let closes = 0;
    let reads = 0;
    const handle = {
        async stat() { return stat; },
        async read(buffer, position) {
            reads++;
            if (position !== undefined && options.rejectPositional) throw new Error('pread unsupported');
            if (options.failAtZero && position === 0) throw new Error('read failed');
            const start = position ?? offset;
            if (start >= bytes.length) return null;
            const count = Math.min(buffer.byteLength, bytes.length - start);
            buffer.set(bytes.subarray(start, start + count));
            if (position === undefined) offset += count;
            return count;
        },
        async close() { closes++; },
    };
    return {
        handle,
        get closes() { return closes; },
        get reads() { return reads; },
    };
}

async function streamBytes(stream) {
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

test('opened file probes normal and fictional positive sizes on the same handle', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const normal = mockHandle(bytes);
    const known = await openedFile.adoptReadableFile(normal.handle);
    assert.equal(known.sizeKnown, true);
    assert.equal(known.positional, true);
    assert.deepEqual(await streamBytes(known.stream()), bytes);
    assert.equal(normal.closes, 1);

    const pseudo = mockHandle(bytes, fileStat(64));
    const unknown = await openedFile.adoptReadableFile(pseudo.handle);
    assert.equal(unknown.sizeKnown, false);
    assert.equal(unknown.positional, true);
    assert.equal(await unknown.measure(), 4);
    assert.deepEqual(await streamBytes(unknown.stream(2, 4)), bytes.slice(2));
    assert.equal(pseudo.closes, 1);
});

test('opened file falls back to sequential reads when positional reads fail', async () => {
    const bytes = new Uint8Array([10, 11, 12, 13]);
    const mock = mockHandle(bytes, fileStat(4), { rejectPositional: true });
    const opened = await openedFile.adoptReadableFile(mock.handle);
    assert.equal(opened.sizeKnown, false);
    assert.equal(opened.positional, false);
    assert.deepEqual(await streamBytes(opened.stream(1, 3)), bytes.slice(1, 3));
    assert.equal(mock.closes, 1);
});

test('validated open rejects identity changes and closes once', async () => {
    const mock = mockHandle(new Uint8Array([1, 2, 3]), fileStat(3, 7, 11));
    let opens = 0;
    asyncfs.realPath = async () => '/root/file.txt';
    asyncfs.open = async () => { opens++; return mock.handle; };
    asyncfs.stat = async () => fileStat(3, 7, 12);
    assert.equal(await openedFile.openValidatedReadableFile('/root', '/root/file.txt'), undefined);
    assert.equal(opens, 1);
    assert.equal(mock.closes, 1);
});

test('validated open keeps serving its descriptor after the pathname changes', async () => {
    const original = new Uint8Array([65, 66, 67]);
    const replacement = new Uint8Array([88, 89, 90]);
    const mock = mockHandle(original, fileStat(3, 7, 11));
    let current = original;
    let opens = 0;
    asyncfs.realPath = async () => '/root/file.txt';
    asyncfs.open = async () => { opens++; return mock.handle; };
    asyncfs.stat = async () => fileStat(current.length, 7, current === original ? 11 : 12);
    const opened = await openedFile.openValidatedReadableFile('/root', '/root/file.txt');
    assert.ok(opened);
    current = replacement;
    assert.deepEqual(await streamBytes(opened.stream()), original);
    assert.equal(opens, 1);
    assert.equal(mock.closes, 1);
});

test('opened file closes exactly once on stream errors and cancellation', async () => {
    const failing = mockHandle(new Uint8Array([1, 2, 3, 4]), fileStat(4), { failAtZero: true });
    const failed = await openedFile.adoptReadableFile(failing.handle);
    await assert.rejects(() => streamBytes(failed.stream()), /read failed/);
    await failed.close();
    assert.equal(failing.closes, 1);

    const bytes = new Uint8Array(2 * openedFile.OPENED_FILE_CHUNK_SIZE).fill(1);
    const cancellable = mockHandle(bytes);
    const opened = await openedFile.adoptReadableFile(cancellable.handle);
    const reader = opened.stream().getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    await opened.close();
    assert.equal(cancellable.closes, 1);
});

test('unknown-size measurement observes cancellation without retaining input', async () => {
    const mock = mockHandle(new Uint8Array(3 * openedFile.OPENED_FILE_CHUNK_SIZE), fileStat(999999));
    const opened = await openedFile.adoptReadableFile(mock.handle);
    let checks = 0;
    await assert.rejects(() => opened.measure(() => ++checks > 2), /cancelled/);
    assert.equal(mock.reads < 8, true);
    assert.equal(mock.closes, 1);
});
