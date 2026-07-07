import { ok, rejects, strictEqual, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

Deno.test('deno FsFile upstream: stdio keeps legacy rid descriptors', () => {
    // @ts-ignore Deno 2 soft-removed rid from the public types, but Deno still tests it.
    strictEqual(Deno.stdin.rid, 0);
    // @ts-ignore Deno 2 soft-removed rid from the public types, but Deno still tests it.
    strictEqual(Deno.stdout.rid, 1);
    // @ts-ignore Deno 2 soft-removed rid from the public types, but Deno still tests it.
    strictEqual(Deno.stderr.rid, 2);
});

Deno.test('deno FsFile: openSync read write seek stat and truncate', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'file.txt');
        const fh = Deno.openSync(file, { read: true, write: true, create: true, truncate: true });
        try {
            strictEqual(fh.writeSync(Buffer.from('abcdef')), 6);
            strictEqual(fh.seekSync(0, Deno.SeekMode.Start), 0);

            const first = new Uint8Array(3);
            strictEqual(fh.readSync(first), 3);
            strictEqual(decodeUtf8(first), 'abc');

            strictEqual(fh.seekSync(2, Deno.SeekMode.Start), 2);
            strictEqual(fh.writeSync(Buffer.from('Z')), 1);
            strictEqual(fh.statSync().size, 6);

            await fh.truncate(4);
        } finally {
            fh.close();
        }

        strictEqual(Deno.readTextFileSync(file), 'abZd');
    });
});

Deno.test('deno FsFile upstream: open defaults to read and accepts file URL create paths', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const existing = join(dir, 'default-read.txt');
        Deno.writeTextFileSync(existing, 'default read');

        const defaultOpen = await Deno.open(existing);
        try {
            const buf = new Uint8Array(12);
            strictEqual(await defaultOpen.read(buf), 12);
            strictEqual(decodeUtf8(buf), 'default read');
        } finally {
            defaultOpen.close();
        }

        const syncUrl = new URL(`file://${join(dir, 'sync-url.txt')}`);
        const syncFile = Deno.openSync(syncUrl, { write: true, createNew: true, mode: 0o626 });
        syncFile.close();
        strictEqual(Deno.statSync(syncUrl).isFile, true);
        if (Deno.build.os !== 'windows') {
            strictEqual(Deno.statSync(syncUrl).mode! & 0o777, 0o626 & ~Deno.umask());
        }

        const asyncUrl = new URL(`file://${join(dir, 'async-url.txt')}`);
        const asyncFile = await Deno.open(asyncUrl, { write: true, createNew: true, mode: 0o626 });
        asyncFile.close();
        strictEqual((await Deno.stat(asyncUrl)).isFile, true);
        if (Deno.build.os !== 'windows') {
            strictEqual((await Deno.stat(asyncUrl)).mode! & 0o777, 0o626 & ~Deno.umask());
        }
    });
});

Deno.test('deno FsFile: async read write seek sync and stat', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'async.txt');
        const fh = await Deno.open(file, { read: true, write: true, create: true, truncate: true });
        try {
            strictEqual(await fh.write(Buffer.from('hello')), 5);
            strictEqual(await fh.seek(0, Deno.SeekMode.Start), 0);

            const buf = new Uint8Array(5);
            strictEqual(await fh.read(buf), 5);
            strictEqual(decodeUtf8(buf), 'hello');

            const info = await fh.stat();
            strictEqual(info.isFile, true);
            strictEqual(info.size, 5);
            await fh.sync();
            await fh.syncData();
        } finally {
            fh.close();
        }
    });
});

Deno.test('deno FsFile upstream: write-only mode rejects reads and truncate clears existing file', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'write-only.txt');
        Deno.writeTextFileSync(file, 'old contents');

        const writeOnly = await Deno.open(file, { write: true, truncate: true });
        try {
            strictEqual((await Deno.stat(file)).size, 0);
            strictEqual(await writeOnly.write(Buffer.from('new')), 3);
            await rejects(async () => {
                await writeOnly.read(new Uint8Array(1));
            });
        } finally {
            writeOnly.close();
        }

        strictEqual(await Deno.readTextFile(file), 'new');
    });
});

Deno.test('deno FsFile: empty reads return zero and EOF returns null', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'eof.txt');
        Deno.writeTextFileSync(file, 'xy');

        const syncFile = Deno.openSync(file, { read: true });
        try {
            strictEqual(syncFile.readSync(new Uint8Array(0)), 0);
            const buf = new Uint8Array(2);
            strictEqual(syncFile.readSync(buf), 2);
            strictEqual(decodeUtf8(buf), 'xy');
            strictEqual(syncFile.readSync(new Uint8Array(1)), null);
        } finally {
            syncFile.close();
        }

        const asyncFile = await Deno.open(file, { read: true });
        try {
            strictEqual(await asyncFile.read(new Uint8Array(0)), 0);
            const buf = new Uint8Array(2);
            strictEqual(await asyncFile.read(buf), 2);
            strictEqual(decodeUtf8(buf), 'xy');
            strictEqual(await asyncFile.read(new Uint8Array(1)), null);
        } finally {
            asyncFile.close();
        }
    });
});

Deno.test('deno FsFile: create helpers truncate and expose FsFile constructor shape', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'create.txt');
        Deno.writeTextFileSync(file, 'old-content');

        strictEqual(typeof Deno.FsFile, 'function');
        throws(() => new (Deno.FsFile as unknown as new () => Deno.FsFile)(), TypeError);

        const syncFile = Deno.createSync(file);
        try {
            ok(syncFile instanceof Deno.FsFile);
            strictEqual(Deno.statSync(file).size, 0);
            strictEqual(syncFile.writeSync(Buffer.from('sync')), 4);
            strictEqual(syncFile.seekSync(0, Deno.SeekMode.Start), 0);
            const buf = new Uint8Array(4);
            strictEqual(syncFile.readSync(buf), 4);
            strictEqual(decodeUtf8(buf), 'sync');
        } finally {
            syncFile.close();
        }

        const asyncFile = await Deno.create(new URL(`file://${file}`));
        try {
            ok(asyncFile instanceof Deno.FsFile);
            strictEqual((await Deno.stat(file)).size, 0);
            strictEqual(await asyncFile.write(Buffer.from('async')), 5);
            strictEqual(await asyncFile.seek(0, Deno.SeekMode.Start), 0);
            const buf = new Uint8Array(5);
            strictEqual(await asyncFile.read(buf), 5);
            strictEqual(decodeUtf8(buf), 'async');
        } finally {
            asyncFile.close();
        }
    });
});

Deno.test('deno FsFile: readable and writable streams use the file pointer', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'stream.txt');
        const writerFile = await Deno.open(file, { read: true, write: true, create: true, truncate: true });
        try {
            const writer = writerFile.writable.getWriter();
            await writer.write(Buffer.from('stream-data'));
            await writer.close();
        } finally {
            writerFile.close();
        }

        const readerFile = await Deno.open(file, { read: true });
        try {
            const reader = readerFile.readable.getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            strictEqual(Buffer.concat(chunks).toString(), 'stream-data');
        } finally {
            readerFile.close();
        }
    });
});

Deno.test('deno FsFile: readable and writable streams take ownership of the handle', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'stream-close.txt');
        Deno.writeTextFileSync(file, 'stream-close');

        const readableFile = await Deno.open(file, { read: true });
        const text = await new Response(readableFile.readable).text();
        strictEqual(text, 'stream-close');
        await rejects(async () => {
            await readableFile.stat();
        }, Deno.errors.BadResource);
        readableFile.close();

        const writableFile = await Deno.open(file, { write: true, truncate: true });
        const writer = writableFile.writable.getWriter();
        await writer.write(Buffer.from('closed-by-stream'));
        await writer.close();
        await rejects(async () => {
            await writableFile.write(Buffer.from('x'));
        }, Deno.errors.BadResource);
        writableFile.close();

        strictEqual(Deno.readTextFileSync(file), 'closed-by-stream');
    });
});

Deno.test('deno FsFile: sync maintenance methods and unsupported terminal methods', async () => {
    await withTempDir('deno-fsfile', (dir) => {
        const file = join(dir, 'unsupported.txt');
        Deno.writeTextFileSync(file, 'x');
        const fh = Deno.openSync(file, { read: true, write: true });
        try {
            fh.truncateSync(0);
            strictEqual(Deno.statSync(file).size, 0);
            fh.syncSync();
            fh.syncDataSync();
            fh.utimeSync(new Date(1000), new Date(2000));
            ok(Math.abs((fh.statSync().mtime?.getTime() ?? 0) - 2000) < 1000);
            strictEqual(fh.isTerminal(), false);
            throws(() => fh.setRaw(true), Deno.errors.NotSupported);
        } finally {
            fh.close();
        }
    });
});

Deno.test('deno FsFile upstream: syncData and sync preserve written bytes', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const syncPath = join(dir, 'sync-data-sync.txt');
        const syncFile = Deno.openSync(syncPath, { read: true, write: true, create: true });
        try {
            const bytes = Buffer.from('sync-data');
            strictEqual(syncFile.writeSync(bytes), bytes.byteLength);
            syncFile.syncDataSync();
            syncFile.syncSync();
            strictEqual(Deno.readTextFileSync(syncPath), 'sync-data');
        } finally {
            syncFile.close();
        }

        const asyncPath = join(dir, 'sync-data-async.txt');
        const asyncFile = await Deno.open(asyncPath, { read: true, write: true, create: true });
        try {
            const bytes = Buffer.from('async-data');
            strictEqual(await asyncFile.write(bytes), bytes.byteLength);
            await asyncFile.syncData();
            await asyncFile.sync();
            strictEqual(await Deno.readTextFile(asyncPath), 'async-data');
        } finally {
            asyncFile.close();
        }
    });
});

Deno.test('deno open: options require an explicit access mode and compatible create/truncate flags', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const existing = join(dir, 'existing.txt');
        Deno.writeTextFileSync(existing, 'existing');

        throws(() => Deno.openSync(existing, {}), /requires at least one option/);
        throws(() => Deno.openSync(existing, { write: false }), /requires at least one option/);
        throws(() => Deno.openSync(existing, { truncate: true, read: true }), /requires 'write' to be true/);
        throws(() => Deno.openSync(join(dir, 'created.txt'), { create: true, read: true }), /require 'write' or 'append'/);
        throws(() => Deno.openSync(join(dir, 'new.txt'), { createNew: true }), /require 'write' or 'append'/);

        await rejects(async () => {
            await Deno.open(existing, {});
        }, /requires at least one option/);
        await rejects(async () => {
            await Deno.open(existing, { truncate: true, append: true });
        }, /requires 'write' to be true/);
        await rejects(async () => {
            await Deno.open(join(dir, 'async-created.txt'), { createNew: true, read: true });
        }, /require 'write' or 'append'/);

        const fh = Deno.openSync(join(dir, 'new.txt'), { createNew: true, write: true });
        fh.close();
        throws(() => Deno.openSync(join(dir, 'new.txt'), { createNew: true, write: true }));
    });
});

Deno.test('deno FsFile: read and write reject null buffers', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'null-buffer.txt');
        const fh = await Deno.open(file, { read: true, write: true, create: true, truncate: true });
        try {
            await rejects(async () => {
                await fh.write(null as unknown as Uint8Array);
            }, TypeError);
            await rejects(async () => {
                await fh.read(null as unknown as Uint8Array);
            }, TypeError);
            throws(() => fh.writeSync(null as unknown as Uint8Array), TypeError);
            throws(() => fh.readSync(null as unknown as Uint8Array), TypeError);
        } finally {
            fh.close();
        }
    });
});

Deno.test('deno FsFile: seek follows Deno offsets from start current and end', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'seek.txt');
        Deno.writeTextFileSync(file, 'abcdef');

        const syncFile = Deno.openSync(file, { read: true, write: true });
        try {
            strictEqual(syncFile.seekSync(-2, Deno.SeekMode.End), 4);
            const tail = new Uint8Array(2);
            strictEqual(syncFile.readSync(tail), 2);
            strictEqual(decodeUtf8(tail), 'ef');

            strictEqual(syncFile.seekSync(10, Deno.SeekMode.Start), 10);
            strictEqual(syncFile.writeSync(Buffer.from('Z')), 1);
            strictEqual(syncFile.statSync().size, 11);
        } finally {
            syncFile.close();
        }

        const asyncFile = await Deno.open(file, { read: true, write: true });
        try {
            strictEqual(await asyncFile.seek(-1, Deno.SeekMode.End), 10);
            const last = new Uint8Array(1);
            strictEqual(await asyncFile.read(last), 1);
            strictEqual(decodeUtf8(last), 'Z');

            strictEqual(await asyncFile.seek(-20, Deno.SeekMode.Current), 0);
            strictEqual(await asyncFile.write(Buffer.from('Q')), 1);
            strictEqual(await Deno.readTextFile(file), 'Qbcdef\u0000\u0000\u0000\u0000Z');
        } finally {
            asyncFile.close();
        }
    });
});

Deno.test('deno FsFile upstream: invalid seek mode rejects without closing file', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'seek-mode.txt');
        Deno.writeTextFileSync(file, 'Hello world!');
        const handle = await Deno.open(file);
        try {
            await rejects(async () => {
                await handle.seek(1, -1 as Deno.SeekMode);
            }, TypeError);

            const buf = new Uint8Array(1);
            strictEqual(await handle.read(buf), 1);
            strictEqual(decodeUtf8(buf), 'H');
        } finally {
            handle.close();
        }
    });
});

Deno.test('deno FsFile: append mode writes at EOF regardless of seek position', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'append.txt');
        Deno.writeTextFileSync(file, 'base');

        const syncFile = Deno.openSync(file, { write: true, append: true });
        try {
            strictEqual(syncFile.seekSync(0, Deno.SeekMode.Start), 0);
            strictEqual(syncFile.writeSync(Buffer.from('-sync')), 5);
            strictEqual(Deno.readTextFileSync(file), 'base-sync');
        } finally {
            syncFile.close();
        }

        const asyncFile = await Deno.open(file, { write: true, append: true });
        try {
            strictEqual(await asyncFile.seek(0, Deno.SeekMode.Start), 0);
            strictEqual(await asyncFile.write(Buffer.from('-async')), 6);
            strictEqual(await Deno.readTextFile(file), 'base-sync-async');
        } finally {
            asyncFile.close();
        }

        const streamFile = await Deno.open(file, { write: true, append: true });
        try {
            const writer = streamFile.writable.getWriter();
            await writer.write(Buffer.from('-stream'));
            await writer.close();
            strictEqual(await Deno.readTextFile(file), 'base-sync-async-stream');
        } finally {
            streamFile.close();
        }
    });
});

Deno.test('deno FsFile: lock tryLock unlock and disposal are callable', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'lock.txt');
        Deno.writeTextFileSync(file, 'lock');

        const syncFile = Deno.openSync(file, { read: true, write: true });
        try {
            syncFile.lockSync();
            syncFile.unlockSync();
            strictEqual(syncFile.tryLockSync(true), true);
            syncFile.unlockSync();
        } finally {
            syncFile.close();
        }

        const asyncFile = await Deno.open(file, { read: true, write: true });
        try {
            await asyncFile.lock(true);
            await asyncFile.unlock();
            strictEqual(await asyncFile.tryLock(), true);
            await asyncFile.unlock();
        } finally {
            asyncFile[Symbol.dispose]();
        }
    });
});

Deno.test('deno FsFile: closed handles reject further operations', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'closed.txt');
        Deno.writeTextFileSync(file, 'closed');

        const syncFile = Deno.openSync(file, { read: true, write: true });
        syncFile.close();
        throws(() => syncFile.readSync(new Uint8Array(1)), Deno.errors.BadResource);
        throws(() => syncFile.writeSync(Buffer.from('x')), Deno.errors.BadResource);
        throws(() => syncFile.statSync(), Deno.errors.BadResource);

        const asyncFile = await Deno.open(file, { read: true, write: true });
        asyncFile.close();
        await rejects(async () => {
            await asyncFile.read(new Uint8Array(1));
        }, Deno.errors.BadResource);
        await rejects(async () => {
            await asyncFile.write(Buffer.from('x'));
        }, Deno.errors.BadResource);
        await rejects(async () => {
            await asyncFile.stat();
        }, Deno.errors.BadResource);
    });
});

Deno.test('deno FsFile upstream: Symbol.dispose closes and repeated close is harmless', async () => {
    await withTempDir('deno-fsfile', async (dir) => {
        const file = join(dir, 'dispose.txt');
        Deno.writeTextFileSync(file, 'dispose');

        const disposed = await Deno.open(file, { read: true });
        disposed[Symbol.dispose]();
        throws(() => disposed.statSync(), Deno.errors.BadResource);
        disposed[Symbol.dispose]();

        const manuallyClosed = await Deno.open(file, { read: true });
        manuallyClosed.close();
        throws(() => manuallyClosed.statSync(), Deno.errors.BadResource);
        manuallyClosed[Symbol.dispose]();
    });
});
