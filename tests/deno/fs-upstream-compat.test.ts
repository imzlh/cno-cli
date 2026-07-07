// Derived from Deno upstream unit/write_file_test.ts public API cases.
import { deepStrictEqual, ok, strictEqual, throws, rejects } from 'node:assert';
import { Buffer } from 'node:buffer';
import { basename, join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

Deno.test('deno fs upstream: writeFileSync honors create createNew append and URL paths', async () => {
    await withTempDir('deno-upstream-fs', (root) => {
        const file = join(root, 'sync.txt');
        const fileUrl = new URL(`file://${file}`);

        throws(() => {
            Deno.writeFileSync(file, Buffer.from('missing'), { create: false });
        }, Deno.errors.NotFound);

        Deno.writeFileSync(fileUrl, Buffer.from('Hello'), { create: true });
        strictEqual(Deno.readTextFileSync(file), 'Hello');

        Deno.writeFileSync(file, Buffer.from('!'), { append: true });
        strictEqual(Deno.readTextFileSync(file), 'Hello!');

        Deno.writeFileSync(file, Buffer.from('Reset'), { append: false, create: false });
        strictEqual(Deno.readTextFileSync(fileUrl), 'Reset');

        throws(() => {
            Deno.writeFileSync(file, Buffer.from('again'), { createNew: true });
        }, Deno.errors.AlreadyExists);
    });
});

Deno.test('deno fs upstream: writeFile honors create createNew append and URL paths', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const file = join(root, 'async.txt');
        const fileUrl = new URL(`file://${file}`);

        await rejects(async () => {
            await Deno.writeFile(file, Buffer.from('missing'), { create: false });
        }, Deno.errors.NotFound);

        await Deno.writeFile(fileUrl, Buffer.from('Hello'), { create: true });
        strictEqual(await Deno.readTextFile(file), 'Hello');

        await Deno.writeFile(file, Buffer.from('Hello'), { append: true });
        strictEqual(await Deno.readTextFile(file), 'HelloHello');

        await Deno.writeFile(file, Buffer.from('Reset'), { append: false, create: false });
        strictEqual(await Deno.readTextFile(fileUrl), 'Reset');

        await rejects(async () => {
            await Deno.writeFile(file, Buffer.from('again'), { createNew: true });
        }, Deno.errors.AlreadyExists);
    });
});

Deno.test('deno fs upstream: writeTextFile mirrors byte write options', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const file = join(root, 'text.txt');

        throws(() => {
            Deno.writeTextFileSync(file, 'missing', { create: false });
        }, Deno.errors.NotFound);

        await Deno.writeTextFile(file, 'a', { create: true });
        await Deno.writeTextFile(file, 'b', { append: true });
        strictEqual(Deno.readTextFileSync(file), 'ab');

        Deno.writeTextFileSync(file, 'c', { create: false });
        strictEqual(await Deno.readTextFile(file), 'c');

        await rejects(async () => {
            await Deno.writeTextFile(file, 'd', { createNew: true });
        }, Deno.errors.AlreadyExists);
    });
});

Deno.test('deno fs upstream: non-file URLs are rejected before filesystem access', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const file = join(root, 'remote-path.txt');
        await Deno.writeTextFile(file, 'local-data');
        const remoteUrl = new URL(`https://example.com${file}`);

        throws(() => Deno.readTextFileSync(remoteUrl), TypeError);
        await rejects(() => Deno.readTextFile(remoteUrl), TypeError);
        throws(() => Deno.writeTextFileSync(remoteUrl, 'bad'), TypeError);
        await rejects(() => Deno.writeTextFile(remoteUrl, 'bad'), TypeError);
        strictEqual(await Deno.readTextFile(file), 'local-data');
    });
});

Deno.test('deno fs upstream: writeFile and writeTextFile consume web streams', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const bytesFile = join(root, 'stream-bytes.txt');
        const byteStream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(Buffer.from('hello '));
                controller.enqueue(Buffer.from('stream'));
                controller.close();
            },
        });
        await Deno.writeFile(bytesFile, byteStream);
        strictEqual(await Deno.readTextFile(bytesFile), 'hello stream');

        const textFile = join(root, 'stream-text.txt');
        const textStream = new ReadableStream<string>({
            start(controller) {
                controller.enqueue('alpha');
                controller.enqueue('-beta');
                controller.close();
            },
        });
        await Deno.writeTextFile(textFile, textStream);
        strictEqual(Deno.readTextFileSync(textFile), 'alpha-beta');
    });
});

Deno.test('deno fs upstream: writeFile honors pre-aborted signals before creating files', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const file = join(root, 'aborted.txt');
        const controller = new AbortController();
        controller.abort(new DOMException('stop', 'AbortError'));

        await rejects(async () => {
            await Deno.writeTextFile(file, 'nope', { signal: controller.signal });
        }, DOMException);
        throws(() => Deno.statSync(file), Deno.errors.NotFound);
    });
});

Deno.test('deno fs upstream: writeFile propagates queued abort reasons', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const file = join(root, 'queued-abort.txt');

        const reasonAbort = new AbortController();
        const reason = new Error('stop writing');
        queueMicrotask(() => reasonAbort.abort(reason));
        await rejects(async () => {
            await Deno.writeFile(file, Buffer.from('nope'), { signal: reasonAbort.signal });
        }, (error) => error === reason);

        const primitiveAbort = new AbortController();
        queueMicrotask(() => primitiveAbort.abort('write primitive'));
        try {
            await Deno.writeTextFile(file, 'nope', { signal: primitiveAbort.signal });
            throw new Error('expected writeTextFile to reject with primitive abort reason');
        } catch (error) {
            strictEqual(error, 'write primitive');
        }
    });
});

Deno.test('deno fs upstream: readFile and readTextFile propagate abort reasons', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const file = join(root, 'read-abort.txt');
        Deno.writeTextFileSync(file, 'abort me');

        const defaultAbort = new AbortController();
        queueMicrotask(() => defaultAbort.abort());
        await rejects(async () => {
            await Deno.readFile(file, { signal: defaultAbort.signal });
        }, (error) => error instanceof DOMException && error.name === 'AbortError');

        const reasonAbort = new AbortController();
        const reason = new Error('stop reading');
        queueMicrotask(() => reasonAbort.abort(reason));
        await rejects(async () => {
            await Deno.readTextFile(file, { signal: reasonAbort.signal });
        }, (error) => error === reason);

        const primitiveAbort = new AbortController();
        queueMicrotask(() => primitiveAbort.abort('plain reason'));
        try {
            await Deno.readFile(file, { signal: primitiveAbort.signal });
            throw new Error('expected readFile to reject with primitive abort reason');
        } catch (error) {
            strictEqual(error, 'plain reason');
        }
    });
});

Deno.test('deno fs upstream: writeFile mode and temp naming are observable', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const file = join(root, 'mode.txt');
        Deno.writeFileSync(file, Buffer.from('mode'), { mode: 0o755 });
        ok((Deno.statSync(file).mode! & 0o777) === 0o755);

        if (Deno.build.os !== 'windows') {
            Deno.writeFileSync(file, Buffer.from('mode'), { mode: 0o666 });
            strictEqual(Deno.statSync(file).mode! & 0o777, 0o666);

            await Deno.writeTextFile(file, 'mode', { mode: 0o640 });
            strictEqual(Deno.statSync(file).mode! & 0o777, 0o640);
        }

        const tempFile = await Deno.makeTempFile({ dir: root, prefix: 'pre-', suffix: '.tmp' });
        ok(basename(tempFile).startsWith('pre-'));
        ok(basename(tempFile).endsWith('.tmp'));
        strictEqual((await Deno.stat(tempFile)).isFile, true);
    });
});

Deno.test('deno fs upstream: copyFile preserves source and overwrites destination', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const from = join(root, 'from.txt');
        const to = join(root, 'to.txt');
        Deno.writeTextFileSync(from, 'Hello world!');
        Deno.writeTextFileSync(to, 'Goodbye!');

        Deno.copyFileSync(new URL(`file://${from}`), new URL(`file://${to}`));
        strictEqual(Deno.readTextFileSync(from), 'Hello world!');
        strictEqual(Deno.readTextFileSync(to), 'Hello world!');

        await Deno.writeTextFile(to, 'old');
        await Deno.copyFile(from, to);
        strictEqual(await Deno.readTextFile(to), 'Hello world!');
        strictEqual(await Deno.readTextFile(from), 'Hello world!');
    });
});

Deno.test({
    name: 'deno fs upstream: copyFile preserves executable mode bits',
    ignore: Deno.build.os === 'windows',
}, async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const syncFrom = join(root, 'sync-from.txt');
        const syncTo = join(root, 'sync-to.txt');
        Deno.writeTextFileSync(syncFrom, 'Hello world!');
        Deno.chmodSync(syncFrom, 0o755);

        Deno.copyFileSync(syncFrom, syncTo);
        strictEqual(Deno.statSync(syncTo).mode! & 0o777, 0o755);

        const asyncFrom = join(root, 'async-from.txt');
        const asyncTo = join(root, 'async-to.txt');
        await Deno.writeTextFile(asyncFrom, 'Hello world!'.repeat(128 * 1024));
        await Deno.chmod(asyncFrom, 0o754);

        await Deno.copyFile(asyncFrom, asyncTo);
        strictEqual((await Deno.stat(asyncTo)).mode! & 0o777, 0o754);
    });
});

Deno.test('deno fs upstream: copyFile reports missing source', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const from = join(root, 'missing.txt');
        const to = join(root, 'to.txt');

        throws(() => {
            Deno.copyFileSync(from, to);
        }, Deno.errors.NotFound);

        await rejects(async () => {
            await Deno.copyFile(from, to);
        }, Deno.errors.NotFound);
    });
});

Deno.test('deno fs upstream: mkdir recursive accepts existing directories and URL paths', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const nested = join(root, 'nested');
        const dir = join(nested, 'dir');
        Deno.mkdirSync(dir, { recursive: true, mode: 0o737 });
        Deno.mkdirSync(dir, { recursive: true, mode: 0o731 });
        strictEqual(Deno.lstatSync(dir).isDirectory, true);
        strictEqual(Deno.lstatSync(dir).mode! & 0o777, 0o737 & ~Deno.umask());

        const urlDir = new URL(`file://${join(root, 'url-dir')}`);
        await Deno.mkdir(urlDir);
        strictEqual((await Deno.lstat(urlDir)).isDirectory, true);
    });
});

Deno.test('deno fs upstream: readDir yields stable entry shapes', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        Deno.writeTextFileSync(join(root, 'a.txt'), 'a');
        Deno.mkdirSync(join(root, 'b'));

        const iterator = Deno.readDirSync(root) as unknown as { map: unknown };
        strictEqual(typeof iterator.map, 'function');

        const syncEntries = [...Deno.readDirSync(root)]
            .map((entry) => [entry.name, entry.isFile, entry.isDirectory, entry.isSymlink])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        deepStrictEqual(syncEntries, [
            ['a.txt', true, false, false],
            ['b', false, true, false],
        ]);

        const asyncEntries: Array<[string, boolean, boolean, boolean]> = [];
        for await (const entry of Deno.readDir(root)) {
            asyncEntries.push([entry.name, entry.isFile, entry.isDirectory, entry.isSymlink]);
        }
        deepStrictEqual(asyncEntries.sort((a, b) => a[0].localeCompare(b[0])), [
            ['a.txt', true, false, false],
            ['b', false, true, false],
        ]);

        throws(() => [...Deno.readDirSync(join(root, 'a.txt'))], Error);
        throws(() => [...Deno.readDirSync(join(root, 'missing'))], Deno.errors.NotFound);
        await rejects(async () => {
            await Deno.readDir(join(root, 'missing'))[Symbol.asyncIterator]().next();
        }, Deno.errors.NotFound);
    });
});

Deno.test('deno fs upstream: readFile errors expose Deno error code fields', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const missing = join(root, 'missing.json');
        try {
            await Deno.readFile(missing);
            throw new Error('expected readFile to fail');
        } catch (error) {
            ok(error instanceof Deno.errors.NotFound);
            strictEqual((error as { code?: string }).code, 'ENOENT');
        }

        try {
            Deno.readTextFileSync(root);
            throw new Error('expected readTextFileSync to fail');
        } catch (error) {
            ok(error instanceof Deno.errors.IsADirectory);
            strictEqual((error as { code?: string }).code, 'EISDIR');
        }
    });
});

Deno.test('deno fs upstream: readTextFile replaces malformed utf8 bytes consistently', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const file = join(root, 'malformed-utf8.txt');
        const handle = await Deno.open(file, { write: true, create: true, truncate: true });
        try {
            await handle.write(Buffer.from('hello '));
            await handle.write(new Uint8Array([0xc0]));
        } finally {
            handle.close();
        }

        strictEqual(await Deno.readTextFile(file), 'hello \uFFFD');
        strictEqual(Deno.readTextFileSync(file), 'hello \uFFFD');
    });
});

Deno.test('deno fs upstream: remove handles files directories URL paths and recursive trees', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const file = join(root, 'file.txt');
        const fileUrl = new URL(`file://${file}`);
        Deno.writeTextFileSync(fileUrl, 'x');
        Deno.removeSync(fileUrl);
        throws(() => Deno.statSync(file), Deno.errors.NotFound);

        const dir = join(root, 'empty-dir');
        await Deno.mkdir(dir);
        await Deno.remove(dir);
        await rejects(async () => await Deno.stat(dir), Deno.errors.NotFound);

        const tree = join(root, 'tree', 'nested');
        Deno.mkdirSync(tree, { recursive: true });
        Deno.writeTextFileSync(join(tree, 'leaf.txt'), 'leaf');
        await Deno.remove(join(root, 'tree'), { recursive: true });
        throws(() => Deno.statSync(join(root, 'tree')), Deno.errors.NotFound);
    });
});

Deno.test({
    name: 'deno fs upstream: remove unlinks symlinks without following targets',
    ignore: Deno.build.os === 'windows',
}, async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const dirTarget = join(root, 'dir-target');
        const dirLink = join(root, 'dir-link');
        Deno.mkdirSync(dirTarget);
        Deno.symlinkSync(dirTarget, dirLink, { type: 'dir' });
        strictEqual(Deno.lstatSync(dirLink).isSymlink, true);
        await Deno.remove(dirLink);
        throws(() => Deno.lstatSync(dirLink), Deno.errors.NotFound);
        strictEqual(Deno.statSync(dirTarget).isDirectory, true);

        const dangling = join(root, 'dangling-link');
        Deno.symlinkSync(join(root, 'missing-target'), dangling);
        strictEqual(Deno.lstatSync(dangling).isSymlink, true);
        await Deno.remove(dangling);
        throws(() => Deno.lstatSync(dangling), Deno.errors.NotFound);

        const syncTarget = join(root, 'sync-dir-target');
        const syncLink = join(root, 'sync-dir-link');
        Deno.mkdirSync(syncTarget);
        Deno.symlinkSync(syncTarget, syncLink, { type: 'dir' });
        Deno.removeSync(syncLink);
        throws(() => Deno.lstatSync(syncLink), Deno.errors.NotFound);
        strictEqual(Deno.statSync(syncTarget).isDirectory, true);
    });
});

Deno.test('deno fs upstream: rename supports string and URL paths', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const oldFile = join(root, 'old.txt');
        const newFile = join(root, 'new.txt');
        Deno.writeTextFileSync(oldFile, 'file');
        Deno.renameSync(new URL(`file://${oldFile}`), new URL(`file://${newFile}`));
        strictEqual(Deno.readTextFileSync(newFile), 'file');
        throws(() => Deno.lstatSync(oldFile), Deno.errors.NotFound);

        const oldDir = join(root, 'old-dir');
        const newDir = join(root, 'new-dir');
        await Deno.mkdir(oldDir);
        await Deno.rename(oldDir, newDir);
        strictEqual((await Deno.lstat(newDir)).isDirectory, true);
        await rejects(async () => await Deno.lstat(oldDir), Deno.errors.NotFound);
    });
});

Deno.test({
    name: 'deno fs upstream: rename overwrites files but preserves failing directory targets',
    ignore: Deno.build.os === 'windows',
}, async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const sourceFile = join(root, 'source-file.txt');
        const destinationFile = join(root, 'destination-file.txt');
        Deno.writeTextFileSync(sourceFile, 'new');
        Deno.writeTextFileSync(destinationFile, 'old');
        Deno.renameSync(sourceFile, destinationFile);
        strictEqual(Deno.readTextFileSync(destinationFile), 'new');
        throws(() => Deno.lstatSync(sourceFile), Deno.errors.NotFound);

        const asyncSourceFile = join(root, 'async-source-file.txt');
        const asyncDestinationFile = join(root, 'async-destination-file.txt');
        Deno.writeTextFileSync(asyncSourceFile, 'async-new');
        Deno.writeTextFileSync(asyncDestinationFile, 'async-old');
        await Deno.rename(asyncSourceFile, asyncDestinationFile);
        strictEqual(await Deno.readTextFile(asyncDestinationFile), 'async-new');

        const directorySource = join(root, 'directory-source');
        const existingFile = join(root, 'existing-file.txt');
        Deno.mkdirSync(directorySource);
        Deno.writeTextFileSync(existingFile, 'keep');
        throws(() => Deno.renameSync(directorySource, existingFile), Error);
        strictEqual(Deno.lstatSync(directorySource).isDirectory, true);
        strictEqual(Deno.readTextFileSync(existingFile), 'keep');

        const asyncDirectorySource = join(root, 'async-directory-source');
        const asyncExistingFile = join(root, 'async-existing-file.txt');
        Deno.mkdirSync(asyncDirectorySource);
        Deno.writeTextFileSync(asyncExistingFile, 'keep-async');
        await rejects(async () => {
            await Deno.rename(asyncDirectorySource, asyncExistingFile);
        }, Error);
        strictEqual((await Deno.lstat(asyncDirectorySource)).isDirectory, true);
        strictEqual(await Deno.readTextFile(asyncExistingFile), 'keep-async');

        const targetFile = join(root, 'target-file.txt');
        const fileLink = join(root, 'file-link');
        const targetDir = join(root, 'target-dir');
        const dirLink = join(root, 'dir-link');
        const danglingLink = join(root, 'dangling-link');
        Deno.writeTextFileSync(targetFile, 'linked');
        Deno.mkdirSync(targetDir);
        Deno.symlinkSync(targetFile, fileLink);
        Deno.symlinkSync(targetDir, dirLink, { type: 'dir' });
        Deno.symlinkSync(join(root, 'missing'), danglingLink);

        for (const target of [fileLink, dirLink, danglingLink]) {
            const source = join(root, `source-${basename(target)}`);
            Deno.mkdirSync(source);
            throws(() => Deno.renameSync(source, target), Error);
            strictEqual(Deno.lstatSync(source).isDirectory, true);
            strictEqual(Deno.lstatSync(target).isSymlink, true);
        }
    });
});

Deno.test({
    name: 'deno fs upstream: rename supports Unix replacement cases around symlinks',
    ignore: Deno.build.os === 'windows',
}, async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const oldDir = join(root, 'old-dir');
        const emptyDir = join(root, 'empty-dir');
        Deno.mkdirSync(oldDir);
        Deno.mkdirSync(emptyDir);

        Deno.renameSync(oldDir, emptyDir);
        strictEqual(Deno.lstatSync(emptyDir).isDirectory, true);
        throws(() => Deno.lstatSync(oldDir), Deno.errors.NotFound);

        const fileTarget = join(root, 'file-target.txt');
        const fileLink = join(root, 'file-link');
        Deno.writeTextFileSync(fileTarget, 'linked target');
        Deno.symlinkSync(fileTarget, fileLink);
        strictEqual(Deno.statSync(fileLink).isFile, true);
        strictEqual(Deno.lstatSync(fileLink).isSymlink, true);

        const oldFile = join(root, 'old-file.txt');
        const targetDir = join(root, 'target-dir');
        const dirLink = join(root, 'dir-link');
        const danglingLink = join(root, 'dangling-link');
        Deno.writeTextFileSync(oldFile, 'replacement');
        Deno.mkdirSync(targetDir);
        Deno.symlinkSync(targetDir, dirLink, { type: 'dir' });
        Deno.symlinkSync(join(root, 'missing-target'), danglingLink);

        Deno.renameSync(oldFile, dirLink);
        strictEqual(Deno.lstatSync(dirLink).isFile, true);
        strictEqual(Deno.readTextFileSync(dirLink), 'replacement');

        await Deno.rename(dirLink, danglingLink);
        strictEqual((await Deno.lstat(danglingLink)).isFile, true);
        strictEqual(await Deno.readTextFile(danglingLink), 'replacement');
    });
});

Deno.test('deno fs upstream: stat and lstat expose file directory and timestamp shape', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const file = join(root, 'stat.txt');
        Deno.writeTextFileSync(file, 'stat');

        const fileInfo = Deno.statSync(new URL(`file://${file}`));
        strictEqual(fileInfo.isFile, true);
        strictEqual(fileInfo.isDirectory, false);
        ok(fileInfo.mtime instanceof Date);
        ok(fileInfo.ctime instanceof Date);

        const dirInfo = await Deno.lstat(root);
        strictEqual(dirInfo.isDirectory, true);
        strictEqual(dirInfo.isFile, false);
        ok(dirInfo.atime instanceof Date);
    });
});

Deno.test({
    name: 'deno fs upstream: FileInfo exposes platform stat extension fields',
    ignore: Deno.build.os === 'windows',
}, async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const file = join(root, 'stat-fields.txt');
        Deno.writeFileSync(file, Buffer.from('Hello'), { mode: 0o666 });

        const syncInfo = Deno.statSync(file);
        ok(syncInfo.dev !== 0);
        ok(syncInfo.ino !== null);
        ok(syncInfo.nlink !== null);
        ok(syncInfo.uid !== null);
        ok(syncInfo.gid !== null);
        ok(syncInfo.rdev !== null);
        ok(syncInfo.blksize !== null);
        ok(syncInfo.blocks !== null);
        strictEqual(syncInfo.isBlockDevice, false);
        strictEqual(syncInfo.isCharDevice, false);
        strictEqual(syncInfo.isFifo, false);
        strictEqual(syncInfo.isSocket, false);

        const asyncInfo = await Deno.stat(file);
        strictEqual(asyncInfo.dev, syncInfo.dev);
        strictEqual(asyncInfo.ino, syncInfo.ino);
        strictEqual(asyncInfo.nlink, syncInfo.nlink);
        strictEqual(asyncInfo.uid, syncInfo.uid);
        strictEqual(asyncInfo.gid, syncInfo.gid);
        strictEqual(asyncInfo.rdev, syncInfo.rdev);
        strictEqual(asyncInfo.blksize, syncInfo.blksize);
        strictEqual(asyncInfo.blocks, syncInfo.blocks);
        strictEqual(asyncInfo.isBlockDevice, false);
        strictEqual(asyncInfo.isCharDevice, false);
        strictEqual(asyncInfo.isFifo, false);
        strictEqual(asyncInfo.isSocket, false);
    });
});

Deno.test('deno fs upstream: makeTempDir and makeTempFile create unique entries in existing dirs only', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const dir1 = Deno.makeTempDirSync({ dir: root, prefix: 'hello', suffix: 'world' });
        const dir2 = Deno.makeTempDirSync({ dir: root, prefix: 'hello', suffix: 'world' });
        ok(dir1 !== dir2);
        ok(basename(dir1).startsWith('hello'));
        ok(basename(dir1).endsWith('world'));
        strictEqual(Deno.statSync(dir1).isDirectory, true);
        strictEqual(Deno.statSync(dir1).mode! & 0o777, 0o700 & ~Deno.umask());

        const nestedDir = await Deno.makeTempDir({ dir: dir1 });
        ok(nestedDir.startsWith(dir1));
        strictEqual((await Deno.stat(nestedDir)).isDirectory, true);

        const file1 = Deno.makeTempFileSync({ dir: root, prefix: 'file-', suffix: '.tmp' });
        const file2 = await Deno.makeTempFile({ dir: root, prefix: 'file-', suffix: '.tmp' });
        ok(file1 !== file2);
        ok(basename(file1).startsWith('file-'));
        ok(basename(file1).endsWith('.tmp'));
        strictEqual(Deno.statSync(file1).mode! & 0o777, 0o600 & ~Deno.umask());

        throws(() => Deno.makeTempDirSync({ dir: join(root, 'missing') }), Deno.errors.NotFound);
        await rejects(async () => {
            await Deno.makeTempFile({ dir: join(root, 'missing') });
        }, Deno.errors.NotFound);
        for (const invalid of ['\0', '*', '\x9f']) {
            throws(() => Deno.makeTempFileSync({ dir: root, prefix: invalid }));
            throws(() => Deno.makeTempDirSync({ dir: root, suffix: invalid }));
            await rejects(async () => {
                await Deno.makeTempFile({ dir: root, suffix: invalid });
            });
            await rejects(async () => {
                await Deno.makeTempDir({ dir: root, prefix: invalid });
            });
        }
        if (Deno.build.os !== 'windows') {
            ok(Deno.statSync(Deno.makeTempFileSync({ dir: root, suffix: '.' })).isFile);
            ok(Deno.statSync(Deno.makeTempFileSync({ dir: root, suffix: ' ' })).isFile);
        }
    });
});

Deno.test('deno fs upstream: truncate path and FsFile clamp negative lengths to zero', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const syncFile = join(root, 'truncate-sync.txt');
        Deno.writeFileSync(syncFile, Buffer.from('12345'));
        Deno.truncateSync(syncFile, 20);
        strictEqual(Deno.readFileSync(syncFile).byteLength, 20);
        Deno.truncateSync(syncFile, -5);
        strictEqual(Deno.readFileSync(syncFile).byteLength, 0);

        const asyncFile = join(root, 'truncate-async.txt');
        await Deno.writeFile(asyncFile, Buffer.from('12345'));
        await Deno.truncate(asyncFile, 3);
        strictEqual((await Deno.readFile(asyncFile)).byteLength, 3);
        await Deno.truncate(asyncFile, -1);
        strictEqual((await Deno.readFile(asyncFile)).byteLength, 0);

        const handleFile = join(root, 'truncate-handle.txt');
        const file = Deno.openSync(handleFile, { create: true, read: true, write: true });
        try {
            file.truncateSync(8);
            strictEqual(Deno.readFileSync(handleFile).byteLength, 8);
            file.truncateSync(-8);
            strictEqual(Deno.readFileSync(handleFile).byteLength, 0);
        } finally {
            file.close();
        }
    });
});

Deno.test('deno fs upstream: realPath follows symlinks and accepts file URLs', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const target = join(root, 'target');
        const link = join(root, 'symln');
        Deno.mkdirSync(target);
        Deno.symlinkSync(target, link, { type: 'dir' });

        strictEqual(Deno.realPathSync(new URL(`file://${link}`)), target);
        strictEqual(await Deno.realPath(link), target);

        throws(() => Deno.realPathSync(join(root, 'missing')), Deno.errors.NotFound);
        await rejects(async () => {
            await Deno.realPath(join(root, 'missing'));
        }, Deno.errors.NotFound);
    });
});

Deno.test('deno fs upstream: hard links share content and report exists or missing errors', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const oldName = join(root, 'oldname');
        const newName = join(root, 'newname');
        Deno.writeTextFileSync(oldName, 'Hardlink');

        Deno.linkSync(oldName, newName);
        strictEqual(Deno.readTextFileSync(newName), 'Hardlink');
        Deno.writeTextFileSync(newName, 'Modified');
        strictEqual(Deno.readTextFileSync(oldName), 'Modified');
        Deno.removeSync(oldName);
        strictEqual(Deno.statSync(newName).isFile, true);
        strictEqual(Deno.statSync(newName).isSymlink, false);

        const asyncOld = join(root, 'async-old');
        const asyncNew = join(root, 'async-new');
        await Deno.writeTextFile(asyncOld, 'AsyncHardlink');
        await Deno.link(asyncOld, asyncNew);
        strictEqual(await Deno.readTextFile(asyncNew), 'AsyncHardlink');

        throws(() => Deno.linkSync(asyncOld, asyncNew), Deno.errors.AlreadyExists);
        await rejects(async () => {
            await Deno.link(join(root, 'missing'), join(root, 'missing-new'));
        }, Deno.errors.NotFound);
    });
});

Deno.test('deno fs upstream: symlink and readLink support string and URL paths', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const target = join(root, 'target');
        const syncLink = join(root, 'sync-link');
        const asyncLink = join(root, 'async-link');
        Deno.mkdirSync(target);

        Deno.symlinkSync(new URL(`file://${target}`), new URL(`file://${syncLink}`), { type: 'dir' });
        strictEqual(Deno.lstatSync(syncLink).isSymlink, true);
        strictEqual(Deno.statSync(syncLink).isDirectory, true);
        strictEqual(Deno.readLinkSync(new URL(`file://${syncLink}`)), target);

        await Deno.symlink(target, asyncLink, { type: 'dir' });
        strictEqual((await Deno.lstat(asyncLink)).isSymlink, true);
        strictEqual(await Deno.readLink(asyncLink), target);

        throws(() => Deno.symlinkSync(target, syncLink), Deno.errors.AlreadyExists);
        await rejects(async () => {
            await Deno.readLink(join(root, 'missing-link'));
        }, Deno.errors.NotFound);
    });
});

Deno.test('deno fs upstream: chmod follows symlink targets and accepts file URLs', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const modeSync = Deno.build.os === 'windows' ? 0o666 : 0o640;
        const modeAsync = Deno.build.os === 'windows' ? 0o444 : 0o600;
        const file = join(root, 'chmod.txt');
        const link = join(root, 'chmod-link.txt');

        Deno.writeTextFileSync(file, 'Hello', { mode: 0o666 });
        Deno.chmodSync(new URL(`file://${file}`), modeSync);
        strictEqual(Deno.statSync(file).mode! & 0o777, modeSync);

        Deno.symlinkSync(file, link);
        const linkMode = Deno.lstatSync(link).mode! & 0o777;
        await Deno.chmod(link, modeAsync);
        strictEqual(Deno.statSync(file).mode! & 0o777, modeAsync);
        strictEqual(Deno.lstatSync(link).mode! & 0o777, linkMode);

        await rejects(async () => {
            await Deno.chmod(join(root, 'missing'), 0o777);
        }, Deno.errors.NotFound);
    });
});

Deno.test('deno fs upstream: utime accepts number seconds Date objects and URL paths', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const file = join(root, 'utime.txt');
        Deno.writeTextFileSync(file, 'time');

        const assertMtime = async (expectedMs: number) => {
            const info = await Deno.stat(file);
            ok(Math.abs((info.mtime?.getTime() ?? 0) - expectedMs) < 1500);
        };

        Deno.utimeSync(new URL(`file://${file}`), 1_700_000_000, 1_700_000_123);
        ok(Math.abs((Deno.statSync(file).mtime?.getTime() ?? 0) - 1_700_000_123_000) < 1500);

        await Deno.utime(file, new Date(2_000_000), new Date(3_000_000));
        await assertMtime(3_000_000);

        const handle = await Deno.open(file, { read: true, write: true });
        try {
            await handle.utime(4_000, 5_000);
            await assertMtime(5_000_000);
            handle.utimeSync(new Date(6_000_000), new Date(7_000_000));
            await assertMtime(7_000_000);
        } finally {
            handle.close();
        }
    });
});

Deno.test('deno fs upstream: utime accepts directories and large number seconds', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        const assertTimes = (info: Deno.FileInfo, atimeMs: number, mtimeMs: number) => {
            ok(Math.abs((info.atime?.getTime() ?? 0) - atimeMs) < 1500);
            ok(Math.abs((info.mtime?.getTime() ?? 0) - mtimeMs) < 1500);
        };

        Deno.utimeSync(root, 1_000, 50_000);
        assertTimes(Deno.statSync(root), 1_000_000, 50_000_000);

        await Deno.utime(root, new Date(100_000), new Date(5_000_000));
        assertTimes(Deno.statSync(root), 100_000, 5_000_000);

        const largeDir = join(root, 'large-time-dir');
        Deno.mkdirSync(largeDir);
        Deno.utimeSync(largeDir, 0x100000001, 0x100000002);
        assertTimes(Deno.statSync(largeDir), 0x100000001 * 1000, 0x100000002 * 1000);
    });
});

Deno.test('deno fs upstream: chown accepts current uid gid null sides and URL paths', async () => {
    await withTempDir('deno-upstream-fs', async (root) => {
        if (Deno.build.os === 'windows') return;

        const uid = Deno.uid();
        const gid = Deno.gid();
        ok(typeof uid === 'number' && uid >= 0);
        ok(typeof gid === 'number' && gid >= 0);

        const syncFile = join(root, 'chown-sync.txt');
        const syncUrl = new URL(`file://${syncFile}`);
        Deno.writeTextFileSync(syncUrl, 'sync');
        Deno.chownSync(syncUrl, uid, gid);
        Deno.chownSync(syncFile, null, gid);
        Deno.chownSync(syncFile, uid, null);
        strictEqual(Deno.statSync(syncFile).uid, uid);
        strictEqual(Deno.statSync(syncFile).gid, gid);

        const asyncFile = join(root, 'chown-async.txt');
        const asyncUrl = new URL(`file://${asyncFile}`);
        await Deno.writeTextFile(asyncUrl, 'async');
        await Deno.chown(asyncFile, uid, gid);
        await Deno.chown(asyncUrl, null, gid);
        await Deno.chown(asyncFile, uid, null);
        strictEqual((await Deno.stat(asyncFile)).uid, uid);
        strictEqual((await Deno.stat(asyncFile)).gid, gid);

        throws(() => Deno.chownSync(join(root, 'missing-sync'), uid, gid), Deno.errors.NotFound);
        await rejects(async () => {
            await Deno.chown(join(root, 'missing-async'), uid, gid);
        }, Deno.errors.NotFound);
    });
});
