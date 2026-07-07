import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import { O_APPEND, O_CREAT, O_EXCL, O_RDWR, O_TRUNC, O_WRONLY } from 'node:constants';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { withTempDir } from '../_helpers/temp.ts';

function readFile(path: fs.PathLike, options?: Parameters<typeof fs.readFile>[1]): Promise<string | Buffer> {
    return new Promise((resolve, reject) => {
        fs.readFile(path, options as any, (err, data) => err ? reject(err) : resolve(data as string | Buffer));
    });
}

function writeFile(path: fs.PathLike, data: string | Uint8Array, options?: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.writeFile(path, data, options as any, (err) => err ? reject(err) : resolve());
    });
}

function appendFile(path: fs.PathLike, data: string | Uint8Array, options?: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.appendFile(path, data, options as any, (err) => err ? reject(err) : resolve());
    });
}

function openFile(path: fs.PathLike, flags: string | number): Promise<number> {
    return new Promise((resolve, reject) => {
        fs.open(path, flags, (err, fd) => err ? reject(err) : resolve(fd));
    });
}

function mkdtemp(path: string, options?: Parameters<typeof fs.mkdtemp>[1]): Promise<string | Buffer> {
    return new Promise((resolve, reject) => {
        if (options === undefined) {
            fs.mkdtemp(path, (err, dir) => err ? reject(err) : resolve(dir));
            return;
        }
        fs.mkdtemp(path, options, (err, dir) => err ? reject(err) : resolve(dir));
    });
}

function fsync(fd: number): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.fsync(fd, (err) => err ? reject(err) : resolve());
    });
}

function fdatasync(fd: number): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.fdatasync(fd, (err) => err ? reject(err) : resolve());
    });
}

function close(fd: number): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.close(fd, (err) => err ? reject(err) : resolve());
    });
}

function fstat(fd: number, options?: { bigint?: boolean }): Promise<fs.Stats | fs.BigIntStats> {
    return new Promise((resolve, reject) => {
        if (options === undefined) {
            fs.fstat(fd, (err, stats) => err ? reject(err) : resolve(stats));
            return;
        }
        fs.fstat(fd, options, (err, stats) => err ? reject(err) : resolve(stats));
    });
}

function ftruncate(fd: number, len?: number): Promise<void> {
    return new Promise((resolve, reject) => {
        if (len === undefined) {
            fs.ftruncate(fd, (err) => err ? reject(err) : resolve());
            return;
        }
        fs.ftruncate(fd, len, (err) => err ? reject(err) : resolve());
    });
}

function futimes(fd: number, atime: string | number | Date, mtime: string | number | Date): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.futimes(fd, atime, mtime, (err) => err ? reject(err) : resolve());
    });
}

function isEexist(err: unknown): true {
    strictEqual((err as NodeJS.ErrnoException).code, 'EEXIST');
    return true;
}

function assertStatFs(statFs: fs.StatsFs, options: { bigint?: boolean } = {}): void {
    strictEqual(statFs.constructor.name, 'StatFs');
    const expectedType = options.bigint ? 'bigint' : 'number';
    strictEqual(typeof statFs.type, expectedType);
    strictEqual(typeof statFs.bsize, expectedType);
    strictEqual(typeof statFs.blocks, expectedType);
    strictEqual(typeof statFs.bfree, expectedType);
    strictEqual(typeof statFs.bavail, expectedType);
    strictEqual(typeof statFs.files, expectedType);
    strictEqual(typeof statFs.ffree, expectedType);
}

async function assertCallbackThrowEscapesOnce(
    prelude: string,
    invocation: string,
): Promise<void> {
    const code = `${prelude}
await new Promise((resolve) => {
    ${invocation}(err) => {
        if (!err) {
            setTimeout(resolve, 0);
            throw new Error("callback-success-once");
        }
        resolve(undefined);
    });
});`;
    const execPath = Deno.execPath();
    const command = fs.existsSync(execPath) ? execPath : join(Deno.cwd(), 'build/stage/cno');
    const output = await new Deno.Command(command, {
        args: ['eval', code],
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    const stderr = new TextDecoder().decode(output.stderr);
    ok(stderr.includes('callback-success-once'), `missing callback marker for ${invocation}\n${stderr}`);
}

Deno.test('fs: readFile honors w+ flag and creates an empty file', async () => {
    await withTempDir('fs-readfile-flag', async (root) => {
        const callbackPath = join(root, 'callback.txt');
        const callbackData = await readFile(callbackPath, { flag: 'w+' });
        ok(Buffer.isBuffer(callbackData));
        strictEqual(callbackData.length, 0);
        ok(fs.existsSync(callbackPath));

        const syncPath = join(root, 'sync.txt');
        const syncData = fs.readFileSync(syncPath, { flag: 'w+' });
        ok(Buffer.isBuffer(syncData));
        strictEqual(syncData.length, 0);
        ok(fs.existsSync(syncPath));

        const promisePath = join(root, 'promise.txt');
        const promiseData = await fsp.readFile(promisePath, { flag: 'w+' });
        ok(Buffer.isBuffer(promiseData));
        strictEqual(promiseData.length, 0);
        ok(fs.existsSync(promisePath));
    });
});

Deno.test('fs: readFile decodes hex base64 and binary encodings', async () => {
    await withTempDir('fs-readfile-encoding', async (root) => {
        const file = join(root, 'data.txt');
        fs.writeFileSync(file, 'hello world');

        strictEqual(await readFile(file, 'hex'), '68656c6c6f20776f726c64');
        strictEqual(await readFile(file, { encoding: 'base64' }), 'aGVsbG8gd29ybGQ=');
        strictEqual(fs.readFileSync(file, { encoding: 'binary' }), 'hello world');
        strictEqual(await fsp.readFile(file, { encoding: 'hex' }), '68656c6c6f20776f726c64');
    });
});

Deno.test('fs: writeFile and appendFile honor string encodings', async () => {
    await withTempDir('fs-writefile-encoding', async (root) => {
        const callbackPath = join(root, 'callback.txt');
        await new Promise<void>((resolve, reject) => {
            fs.writeFile(callbackPath, '68656c6c6f', 'hex', (err) => err ? reject(err) : resolve());
        });
        await new Promise<void>((resolve, reject) => {
            fs.appendFile(callbackPath, '20776f726c64', { encoding: 'hex' }, (err) => err ? reject(err) : resolve());
        });
        strictEqual(fs.readFileSync(callbackPath, 'utf8'), 'hello world');

        const syncPath = join(root, 'sync.txt');
        fs.writeFileSync(syncPath, 'aGVsbG8=', 'base64');
        fs.appendFileSync(syncPath, 'IHdvcmxk', { encoding: 'base64' });
        strictEqual(fs.readFileSync(syncPath, 'utf8'), 'hello world');

        const promisePath = join(root, 'promise.txt');
        await fsp.writeFile(promisePath, '68656c6c6f', { encoding: 'hex' });
        await fsp.appendFile(promisePath, '20776f726c64', 'hex');
        strictEqual(await fsp.readFile(promisePath, 'utf8'), 'hello world');
    });
});

Deno.test('fs: writeFile and appendFile honor explicit flags', async () => {
    await withTempDir('fs-writefile-flags', async (root) => {
        const appendPath = join(root, 'append.txt');
        fs.writeFileSync(appendPath, 'base');

        await writeFile(appendPath, '-callback', { flag: 'a' });
        fs.writeFileSync(appendPath, '-sync', { flag: 'a' });
        await fsp.writeFile(appendPath, '-promise', { flag: 'a' });
        strictEqual(fs.readFileSync(appendPath, 'utf8'), 'base-callback-sync-promise');

        const exclusivePath = join(root, 'exclusive.txt');
        fs.writeFileSync(exclusivePath, 'exists');

        await rejects(appendFile(exclusivePath, 'x', { flag: 'ax' }), isEexist);
        throws(() => fs.appendFileSync(exclusivePath, 'x', { flag: 'ax' }), isEexist);
        await rejects(fsp.appendFile(exclusivePath, 'x', { flag: 'ax' }), isEexist);
        strictEqual(fs.readFileSync(exclusivePath, 'utf8'), 'exists');
    });
});

Deno.test('fs: numeric open flags preserve append read-write and exclusive semantics', async () => {
    await withTempDir('fs-open-numeric-flags', async (root) => {
        const syncAppend = join(root, 'sync-append.txt');
        const syncFd = fs.openSync(syncAppend, O_APPEND | O_CREAT | O_RDWR);
        try {
            fs.writeSync(syncFd, 'x');
            const out = Buffer.alloc(1);
            strictEqual(fs.readSync(syncFd, out, 0, 1, 0), 1);
            strictEqual(out.toString(), 'x');
        } finally {
            fs.closeSync(syncFd);
        }

        const callbackTruncate = join(root, 'callback-truncate.txt');
        fs.writeFileSync(callbackTruncate, 'old data');
        const callbackFd = await openFile(callbackTruncate, O_TRUNC | O_CREAT | O_RDWR);
        try {
            strictEqual(fs.readFileSync(callbackTruncate, 'utf8'), '');
            fs.writeSync(callbackFd, 'y');
            const out = Buffer.alloc(1);
            strictEqual(fs.readSync(callbackFd, out, 0, 1, 0), 1);
            strictEqual(out.toString(), 'y');
        } finally {
            fs.closeSync(callbackFd);
        }

        const promiseAppend = join(root, 'promise-append.txt');
        const handle = await fsp.open(promiseAppend, O_APPEND | O_CREAT | O_RDWR);
        try {
            await handle.write(Buffer.from('z'));
            const out = Buffer.alloc(1);
            const result = await handle.read(out, 0, 1, 0);
            strictEqual(result.bytesRead, 1);
            strictEqual(out.toString(), 'z');
        } finally {
            await handle.close();
        }

        const exclusivePath = join(root, 'exclusive-open.txt');
        fs.writeFileSync(exclusivePath, 'exists');
        throws(() => fs.openSync(exclusivePath, O_APPEND | O_CREAT | O_WRONLY | O_EXCL), isEexist);
        await rejects(openFile(exclusivePath, O_APPEND | O_CREAT | O_RDWR | O_EXCL), isEexist);
        await rejects(fsp.open(exclusivePath, O_TRUNC | O_CREAT | O_RDWR | O_EXCL), isEexist);
    });
});

Deno.test('fs: URL and Buffer path-like values work across sync and promises', async () => {
    await withTempDir('fs-pathlike', async (root) => {
        const file = join(root, 'pathlike.txt');
        const url = pathToFileURL(file);
        fs.writeFileSync(url, 'url-data');
        strictEqual(await fsp.readFile(url, 'utf8'), 'url-data');

        const bufferPath = Buffer.from(file);
        strictEqual(fs.existsSync(bufferPath), true);
        strictEqual(fs.readFileSync(bufferPath, 'utf8'), 'url-data');
        await fsp.writeFile(bufferPath, 'buffer-data');
        strictEqual(fs.readFileSync(file, 'utf8'), 'buffer-data');
    });
});

Deno.test('fs upstream: Buffer paths work for link readlink rename and unlink', async () => {
    await withTempDir('fs-buffer-paths', async (root) => {
        const source = join(root, 'source.txt');
        const hardLink = join(root, 'hard-link.txt');
        const symlink = join(root, 'symlink.txt');
        const renamed = join(root, 'renamed.txt');
        fs.writeFileSync(source, 'buffer-path');

        await new Promise<void>((resolve, reject) => {
            fs.link(Buffer.from(source), Buffer.from(hardLink), (err) => err ? reject(err) : resolve());
        });
        strictEqual(fs.readFileSync(hardLink, 'utf8'), 'buffer-path');

        fs.symlinkSync(Buffer.from(source), Buffer.from(symlink));
        const target = await new Promise<string | Buffer>((resolve, reject) => {
            fs.readlink(Buffer.from(symlink), (err, linkString) => err ? reject(err) : resolve(linkString));
        });
        strictEqual(String(target), source);
        strictEqual(String(fs.readlinkSync(Buffer.from(symlink))), source);

        await new Promise<void>((resolve, reject) => {
            fs.rename(Buffer.from(hardLink), Buffer.from(renamed), (err) => err ? reject(err) : resolve());
        });
        strictEqual(fs.readFileSync(renamed, 'utf8'), 'buffer-path');

        await new Promise<void>((resolve, reject) => {
            fs.unlink(Buffer.from(renamed), (err) => err ? reject(err) : resolve());
        });
        strictEqual(fs.existsSync(renamed), false);
        fs.unlinkSync(Buffer.from(symlink));
        strictEqual(fs.existsSync(symlink), false);
    });
});

Deno.test('fs upstream: exists uses boolean callbacks and custom promisify semantics', async () => {
    await withTempDir('fs-exists', async (root) => {
        const file = join(root, 'exists.txt');
        fs.writeFileSync(file, 'exists');

        strictEqual(await new Promise<boolean>((resolve) => fs.exists(file, resolve)), true);
        strictEqual(await new Promise<boolean>((resolve) => fs.exists(join(root, 'missing.txt'), resolve)), false);
        strictEqual(await promisify(fs.exists)(file), true);
        strictEqual(await promisify(fs.exists)(join(root, 'missing.txt')), false);

        if (Deno.build.os !== 'windows') {
            const dangling = join(root, 'dangling-link');
            fs.symlinkSync(join(root, 'missing-target'), dangling);
            strictEqual(await promisify(fs.exists)(dangling), false);
            strictEqual(fs.existsSync(dangling), false);
        }

        const code = `
            const { exists } = await import("node:fs");
            const tempFile = await Deno.makeTempFile();
            const events = [];
            exists(tempFile, (available) => {
                events.push(available);
                Deno.removeSync(tempFile);
                if (available) throw new Error("exists-success-once");
            });
            setTimeout(() => console.log("exists-events:" + JSON.stringify(events)), 20);
        `;
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['eval', code],
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const stderr = new TextDecoder().decode(output.stderr);
        const stdout = new TextDecoder().decode(output.stdout);
        ok(stderr.includes('exists-success-once'), stderr);
        ok(stdout.includes('exists-events:[true]'), stdout);
    });
});

Deno.test('fs: opendir reads entries for string URL and Buffer paths', async () => {
    await withTempDir('fs-opendir', async (root) => {
        fs.writeFileSync(join(root, 'a.txt'), 'a');
        fs.mkdirSync(join(root, 'dir'));

        const dir = fs.opendirSync(root);
        try {
            const names = [];
            for (;;) {
                const entry = dir.readSync();
                if (!entry) break;
                names.push(entry.name);
            }
            ok(names.includes('a.txt'));
            ok(names.includes('dir'));
        } finally {
            dir.closeSync();
        }

        const urlDir = await fsp.opendir(pathToFileURL(root));
        try {
            const first = await urlDir.read();
            ok(first && typeof first.name === 'string');
        } finally {
            await urlDir.close();
        }

        const bufferDir = fs.opendirSync(Buffer.from(root));
        try {
            ok(bufferDir.readSync());
        } finally {
            bufferDir.closeSync();
        }
    });
});

Deno.test('fs upstream: opendir validates options and reports missing or non-directory paths', async () => {
    await withTempDir('fs-opendir-invalid', async (root) => {
        const file = join(root, 'file.txt');
        fs.writeFileSync(file, 'file');

        const callbackInvalidEncoding = await new Promise<unknown>((resolve) => {
            fs.opendir(root, { encoding: 'invalid-encoding' as BufferEncoding }, (err) => resolve(err));
        });
        ok(callbackInvalidEncoding instanceof TypeError);

        const callbackInvalidBuffer = await new Promise<unknown>((resolve) => {
            fs.opendir(root, { bufferSize: -1 }, (err) => resolve(err));
        });
        ok(callbackInvalidBuffer instanceof RangeError);

        const callbackMissing = await new Promise<unknown>((resolve) => {
            fs.opendir(join(root, 'missing'), (err) => resolve(err));
        });
        ok(callbackMissing instanceof Error);

        const callbackFile = await new Promise<unknown>((resolve) => {
            fs.opendir(file, (err) => resolve(err));
        });
        ok(callbackFile instanceof Error);

        throws(() => fs.opendirSync(root, { encoding: 'invalid-encoding' as BufferEncoding }), TypeError);
        throws(() => fs.opendirSync(root, { bufferSize: 0 }), RangeError);
        throws(() => fs.opendirSync(file), Error);
        await rejects(() => fsp.opendir(root, { encoding: 'invalid-encoding' as BufferEncoding }), TypeError);
        await rejects(() => fsp.opendir(root, { bufferSize: 0 }), RangeError);
        await rejects(() => fsp.opendir(file), Error);
    });
});

Deno.test('fs upstream: callback exceptions escape instead of being converted into second callbacks', async () => {
    await withTempDir('fs-callback-throw', async (root) => {
        const source = join(root, 'source.txt');
        const dest = join(root, 'dest.txt');
        const unlinkPath = join(root, 'unlink.txt');
        const emptyDir = join(root, 'empty-dir');
        const renameSource = join(root, 'rename-source.txt');
        const renameDest = join(root, 'rename-dest.txt');
        const link = join(root, 'link.txt');
        const hardLink = join(root, 'hard-link.txt');
        const mkdirPath = join(root, 'created-dir');
        fs.writeFileSync(source, 'hello');
        fs.writeFileSync(unlinkPath, 'unlink');
        fs.mkdirSync(emptyDir);
        fs.writeFileSync(renameSource, 'rename');
        fs.symlinkSync(source, link);
        const importFs = `const {
            appendFile, copyFile, link, lstat, mkdir, open, readFile,
            readdir, readlink, realpath, rename, rmdir, stat, unlink,
        } = await import("node:fs");`;

        await assertCallbackThrowEscapesOnce(importFs, `readFile(${JSON.stringify(source)}, `);
        await assertCallbackThrowEscapesOnce(importFs, `open(${JSON.stringify(source)}, "r", `);
        await assertCallbackThrowEscapesOnce(importFs, `stat(${JSON.stringify(source)}, `);
        await assertCallbackThrowEscapesOnce(importFs, `realpath(${JSON.stringify(link)}, `);
        await assertCallbackThrowEscapesOnce(importFs, `copyFile(${JSON.stringify(source)}, ${JSON.stringify(dest)}, `);
        await assertCallbackThrowEscapesOnce(importFs, `appendFile(${JSON.stringify(source)}, " world", `);
        await assertCallbackThrowEscapesOnce(importFs, `unlink(${JSON.stringify(unlinkPath)}, `);
        await assertCallbackThrowEscapesOnce(importFs, `rmdir(${JSON.stringify(emptyDir)}, `);
        await assertCallbackThrowEscapesOnce(importFs, `rename(${JSON.stringify(renameSource)}, ${JSON.stringify(renameDest)}, `);
        await assertCallbackThrowEscapesOnce(importFs, `readlink(${JSON.stringify(link)}, `);
        await assertCallbackThrowEscapesOnce(importFs, `readdir(${JSON.stringify(root)}, `);
        await assertCallbackThrowEscapesOnce(importFs, `mkdir(${JSON.stringify(mkdirPath)}, `);
        await assertCallbackThrowEscapesOnce(importFs, `link(${JSON.stringify(source)}, ${JSON.stringify(hardLink)}, `);
        await assertCallbackThrowEscapesOnce(importFs, `lstat(${JSON.stringify(source)}, `);
    });
});

Deno.test('fs upstream: Dir constructor reads entries and supports callbacks iteration and close', async () => {
    await withTempDir('fs-dir-constructor', async (root) => {
        fs.writeFileSync(join(root, 'foo.txt'), 'foo');
        fs.writeFileSync(join(root, 'bar.txt'), 'bar');
        fs.mkdirSync(join(root, 'empty'));

        const emptyDir = new fs.Dir(join(root, 'empty'));
        strictEqual(await emptyDir.read(), null);
        strictEqual(emptyDir.readSync(), null);
        await emptyDir.close();

        let callbackRead = false;
        const callbackDir = new fs.Dir(join(root, 'empty'));
        const callbackEntry = await new Promise<fs.Dirent | null>((resolve, reject) => {
            callbackDir.read((err, entry) => {
                callbackRead = true;
                err ? reject(err) : resolve(entry);
            });
        });
        strictEqual(callbackEntry, null);
        strictEqual(callbackRead, true);
        await callbackDir.close();

        const syncDir = new fs.Dir(root);
        const syncNames = [
            syncDir.readSync()?.name,
            syncDir.readSync()?.name,
            syncDir.readSync()?.name,
            syncDir.readSync(),
        ];
        strictEqual(syncNames[3], null);
        deepStrictEqual(syncNames.slice(0, 3).sort(), ['bar.txt', 'empty', 'foo.txt']);
        syncDir.closeSync();

        const iterDir = new fs.Dir(root);
        const iterNames: string[] = [];
        for await (const entry of iterDir) iterNames.push(entry.name);
        deepStrictEqual(iterNames.sort(), ['bar.txt', 'empty', 'foo.txt']);

        let closeCalled = false;
        new fs.Dir(root).close((err) => {
            strictEqual(err, null);
            closeCalled = true;
        });
        strictEqual(closeCalled, true);
    });
});

Deno.test('fs upstream: readdir recursive returns relative paths for callback sync and promises', async () => {
    await withTempDir('fs-readdir-recursive', async (root) => {
        fs.writeFileSync(join(root, 'file1.txt'), 'hi');
        fs.mkdirSync(join(root, 'sub'));
        fs.writeFileSync(join(root, 'sub', 'file2.txt'), 'hi');
        const expected = ['file1.txt', 'sub', join('sub', 'file2.txt')].sort();
        const normalize = (entries: Array<string | Buffer>) => entries.map((entry) => entry.toString()).sort();

        const callbackEntries = await new Promise<Array<string | Buffer>>((resolve, reject) => {
            fs.readdir(root, { recursive: true }, (err, files) => err ? reject(err) : resolve(files as Array<string | Buffer>));
        });
        deepStrictEqual(normalize(callbackEntries), expected);

        const syncEntries = fs.readdirSync(root, { recursive: true, encoding: 'buffer' }) as Buffer[];
        deepStrictEqual(normalize(syncEntries), expected);

        const promiseEntries = await fsp.readdir(root, { recursive: true });
        deepStrictEqual(normalize(promiseEntries as Array<string | Buffer>), expected);

        const dirents = fs.readdirSync(root, { recursive: true, withFileTypes: true });
        ok(dirents.some((entry) => entry.name === 'sub' && entry.isDirectory()));
        ok(dirents.some((entry) => entry.name === join('sub', 'file2.txt') && entry.isFile()));
    });
});

Deno.test({
    name: 'fs upstream: rm removes symlink itself without deleting the target directory',
    ignore: Deno.build.os === 'windows',
    async fn() {
        await withTempDir('fs-rm-symlink', async (root) => {
            const target = join(root, 'target');
            fs.mkdirSync(target);

            const callbackLink = join(root, 'callback-link');
            fs.symlinkSync(target, callbackLink, 'dir');
            await new Promise<void>((resolve, reject) => {
                fs.rm(callbackLink, (err) => err ? reject(err) : resolve());
            });
            strictEqual(fs.existsSync(callbackLink), false);
            strictEqual(fs.lstatSync(target).isDirectory(), true);

            const syncLink = join(root, 'sync-link');
            fs.symlinkSync(target, syncLink, 'dir');
            fs.rmSync(syncLink);
            strictEqual(fs.existsSync(syncLink), false);
            strictEqual(fs.lstatSync(target).isDirectory(), true);

            const promiseLink = join(root, 'promise-link');
            fs.symlinkSync(target, promiseLink, 'dir');
            await fsp.rm(promiseLink);
            strictEqual(fs.existsSync(promiseLink), false);
            strictEqual(fs.lstatSync(target).isDirectory(), true);
        });
    },
});

Deno.test('fs upstream: mkdtemp honors buffer encoding and missing parent errors', async () => {
    await withTempDir('fs-mkdtemp', async (root) => {
        const callbackDir = await mkdtemp(join(root, 'callback-'), { encoding: 'buffer' });
        ok(Buffer.isBuffer(callbackDir));
        ok(fs.existsSync(callbackDir));

        const syncDir = fs.mkdtempSync(join(root, 'sync-'), { encoding: 'buffer' });
        ok(Buffer.isBuffer(syncDir));
        ok(fs.existsSync(syncDir));

        const promiseDir = await fsp.mkdtemp(join(root, 'promise-'), { encoding: 'buffer' });
        ok(Buffer.isBuffer(promiseDir));
        ok(fs.existsSync(promiseDir));

        await rejects(mkdtemp(join(root, 'missing', 'x-')), (err: unknown) => {
            strictEqual((err as NodeJS.ErrnoException).code, 'ENOENT');
            strictEqual((err as NodeJS.ErrnoException).syscall, 'mkdtemp');
            ok(String((err as NodeJS.ErrnoException).path).startsWith(join(root, 'missing', 'x-')));
            return true;
        });

        throws(() => fs.mkdtempSync(join(root, 'bad-'), { encoding: 'bogus' as BufferEncoding }));
    });
});

Deno.test('fs upstream: cp creates parent dirs and promises cp applies filters per entry', async () => {
    await withTempDir('fs-cp', async (root) => {
        const sourceFile = join(root, 'source.txt');
        fs.writeFileSync(sourceFile, 'copy me');
        const nestedDest = join(root, 'nested', 'child', 'out.txt');
        fs.cpSync(sourceFile, nestedDest);
        strictEqual(fs.readFileSync(nestedDest, 'utf8'), 'copy me');

        const srcDir = join(root, 'src-dir');
        const destDir = join(root, 'dest-dir');
        fs.mkdirSync(srcDir);
        fs.writeFileSync(join(srcDir, 'keep.txt'), 'keep');
        fs.writeFileSync(join(srcDir, 'drop.txt'), 'drop');

        await fsp.cp(srcDir, destDir, {
            recursive: true,
            filter(src) {
                return !src.endsWith('drop.txt');
            },
        });

        strictEqual(await fsp.readFile(join(destDir, 'keep.txt'), 'utf8'), 'keep');
        strictEqual(fs.existsSync(join(destDir, 'drop.txt')), false);
    });
});

Deno.test('fs upstream: promises cp can repeat recursive directory copy into same target', async () => {
    await withTempDir('fs-cp-repeat', async (root) => {
        const src = join(root, 'source');
        const target = join(root, 'dist');
        fs.mkdirSync(src);
        fs.writeFileSync(join(src, 'foo.txt'), 'foo');

        await fsp.cp(src, target, { recursive: true, force: true });
        await fsp.cp(src, target, { recursive: true, force: true });

        deepStrictEqual(await fsp.readdir(target), ['foo.txt']);
        strictEqual(await fsp.readFile(join(target, 'foo.txt'), 'utf8'), 'foo');
    });
});

Deno.test('fs upstream: fsync and fdatasync callback and sync APIs flush open fds', async () => {
    await withTempDir('fs-fsync', async (root) => {
        const file = join(root, 'sync.txt');
        const fd = fs.openSync(file, 'w+');
        try {
            fs.writeSync(fd, Buffer.alloc(16, 0x61));
            await fsync(fd);
            await fdatasync(fd);
            fs.fsyncSync(fd);
            fs.fdatasyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        strictEqual(fs.readFileSync(file).length, 16);
    });
});

Deno.test('fs upstream: close fstat ftruncate and futimes operate on numeric fds', async () => {
    await withTempDir('fs-fd-ops', async (root) => {
        const file = join(root, 'fd.txt');
        fs.writeFileSync(file, 'hello world');

        const statFd = fs.openSync(file, 'r');
        try {
            const callbackStats = await fstat(statFd);
            strictEqual(callbackStats.size, 11);
            ok(callbackStats.isFile());

            const callbackBigIntStats = await fstat(statFd, { bigint: true }) as fs.BigIntStats;
            strictEqual(typeof callbackBigIntStats.size, 'bigint');

            const syncStats = fs.fstatSync(statFd, { bigint: true });
            strictEqual(typeof syncStats.size, 'bigint');
        } finally {
            fs.closeSync(statFd);
        }

        const truncateFd = fs.openSync(file, 'r+');
        try {
            await ftruncate(truncateFd, 3);
            strictEqual(fs.statSync(file).size, 3);
            fs.ftruncateSync(truncateFd, 6);
            strictEqual(fs.statSync(file).size, 6);
            await ftruncate(truncateFd);
            strictEqual(fs.statSync(file).size, 0);
        } finally {
            fs.closeSync(truncateFd);
        }

        const timeFd = fs.openSync(file, 'r+');
        try {
            const atime = new Date('2020-01-02T03:04:05.000Z');
            const mtime = new Date('2020-09-13T12:26:40.000Z');
            await futimes(timeFd, atime, mtime);
            let stats = fs.statSync(file);
            strictEqual(Math.trunc(stats.atimeMs / 1000), Math.trunc(atime.getTime() / 1000));
            strictEqual(Math.trunc(stats.mtimeMs / 1000), Math.trunc(mtime.getTime() / 1000));

            const syncDate = new Date('2021-02-03T04:05:06.000Z');
            fs.futimesSync(timeFd, syncDate, syncDate);
            stats = fs.statSync(file);
            strictEqual(Math.trunc(stats.mtimeMs / 1000), Math.trunc(syncDate.getTime() / 1000));
        } finally {
            fs.closeSync(timeFd);
        }

        const closeFd = fs.openSync(file, 'r');
        await close(closeFd);
        throws(() => fs.closeSync(closeFd), Error);

        const defaultCallbackFd = fs.openSync(file, 'r');
        fs.close(defaultCallbackFd);
        await new Promise((resolve) => setTimeout(resolve, 20));
        throws(() => fs.closeSync(defaultCallbackFd), Error);

        throws(() => fs.closeSync(-1), RangeError);
        throws(() => fs.close(-1, () => {}), RangeError);
        throws(() => fs.futimesSync(123, Infinity, 0), Error);
        throws(() => fs.futimesSync(123, 'not a time', 0), Error);
        throws(() => fs.futimes(123, Infinity, 0, () => {}), Error);
        throws(() => fs.ftruncate(123, 0 as unknown as fs.NoParamCallback), Error);
    });
});

Deno.test('fs upstream: statfs works for callback sync promises Buffer paths and bigint', async () => {
    const filePath = new URL(import.meta.url);
    const pathString = filePath.pathname;

    const callbackStats = await new Promise<fs.StatsFs>((resolve, reject) => {
        fs.statfs(pathString, (err, stats) => err ? reject(err) : resolve(stats));
    });
    assertStatFs(callbackStats);

    const bufferStats = await new Promise<fs.StatsFs>((resolve, reject) => {
        fs.statfs(Buffer.from(pathString), (err, stats) => err ? reject(err) : resolve(stats));
    });
    assertStatFs(bufferStats);

    const callbackBigint = await new Promise<fs.StatsFs>((resolve, reject) => {
        fs.statfs(pathString, { bigint: true }, (err, stats) => err ? reject(err) : resolve(stats));
    });
    assertStatFs(callbackBigint, { bigint: true });

    assertStatFs(fs.statfsSync(pathString));
    assertStatFs(fs.statfsSync(Buffer.from(pathString)));
    assertStatFs(fs.statfsSync(pathString, { bigint: true }), { bigint: true });

    assertStatFs(await fsp.statfs(pathString));
    assertStatFs(await fsp.statfs(pathString, { bigint: true }), { bigint: true });
});

Deno.test('fs upstream: statfs reports ENOENT for missing paths', async () => {
    await withTempDir('fs-statfs-missing', async (root) => {
        const missing = join(root, 'missing');
        await rejects(fsp.statfs(missing), (err: unknown) => {
            strictEqual((err as NodeJS.ErrnoException).code, 'ENOENT');
            return true;
        });
        throws(() => fs.statfsSync(missing), (err: unknown) => {
            strictEqual((err as NodeJS.ErrnoException).code, 'ENOENT');
            return true;
        });
    });
});

Deno.test('fs upstream: Stats default constructor methods all return false', () => {
    const stats = new (fs.Stats as unknown as new () => fs.Stats)();
    strictEqual(stats.isFile(), false);
    strictEqual(stats.isDirectory(), false);
    strictEqual(stats.isBlockDevice(), false);
    strictEqual(stats.isCharacterDevice(), false);
    strictEqual(stats.isSymbolicLink(), false);
    strictEqual(stats.isFIFO(), false);
    strictEqual(stats.isSocket(), false);
});

Deno.test('fs upstream: stat rejects invalid path values with ERR_INVALID_ARG_TYPE', async () => {
    await rejects(
        () => new Promise<fs.Stats>((resolve, reject) => {
            fs.stat(undefined as unknown as fs.PathLike, (err, stats) => err ? reject(err) : resolve(stats));
        }),
        (err: unknown) => {
            ok(err instanceof TypeError);
            strictEqual((err as NodeJS.ErrnoException).code, 'ERR_INVALID_ARG_TYPE');
            return true;
        },
    );

    throws(
        () => fs.statSync(undefined as unknown as fs.PathLike),
        (err: unknown) => {
            ok(err instanceof TypeError);
            strictEqual((err as NodeJS.ErrnoException).code, 'ERR_INVALID_ARG_TYPE');
            return true;
        },
    );
});

Deno.test('fs upstream: rename errors include source path and destination', async () => {
    await withTempDir('fs-rename-errors', async (root) => {
        const oldPath = join(root, 'missing.txt');
        const newPath = join(root, 'new.txt');
        const assertRenameError = (err: unknown, syscall: string): true => {
            const nodeErr = err as NodeJS.ErrnoException & { dest?: string };
            strictEqual(nodeErr.code, 'ENOENT');
            strictEqual(nodeErr.syscall, syscall);
            strictEqual(nodeErr.path, oldPath);
            strictEqual(nodeErr.dest, newPath);
            return true;
        };

        await rejects(
            () => new Promise<void>((resolve, reject) => {
                fs.rename(oldPath, newPath, (err) => err ? reject(err) : resolve());
            }),
            (err: unknown) => assertRenameError(err, 'rename'),
        );

        throws(
            () => fs.renameSync(oldPath, newPath),
            (err: unknown) => assertRenameError(err, 'renameSync'),
        );

        await rejects(
            () => fsp.rename(oldPath, newPath),
            (err: unknown) => assertRenameError(err, 'rename'),
        );
    });
});

Deno.test('fs upstream: statSync maps missing jsr-style path to ENOENT', () => {
    throws(
        () => fs.statSync('jsr:@std/assert'),
        (err: unknown) => {
            strictEqual((err as NodeJS.ErrnoException).code, 'ENOENT');
            return true;
        },
    );
});

Deno.test('fs upstream: lstatSync throwIfNoEntry false returns undefined', () => {
    strictEqual(fs.lstatSync('definitely-missing-cno-path', { throwIfNoEntry: false }), undefined);
});

Deno.test('fs upstream: FileHandle.read respects explicit position', async () => {
    await withTempDir('fs-filehandle-read-position', async (root) => {
        const file = join(root, 'position.bin');
        await fsp.writeFile(file, new Uint8Array(16));
        const handle = await fsp.open(file, 'r+');
        try {
            for (let i = 0; i <= 5; i++) {
                await handle.write(new Uint8Array([i]), 0, 1, i + 10);
            }

            const values: number[] = [];
            for (let position = 10; position <= 15; position++) {
                const buffer = new Uint8Array(1);
                const result = await handle.read(buffer, 0, 1, position);
                strictEqual(result.bytesRead, 1);
                values.push(buffer[0]!);
            }
            deepStrictEqual(values, [0, 1, 2, 3, 4, 5]);
        } finally {
            await handle.close();
        }
    });
});

Deno.test('fs upstream: copyFile COPYFILE_EXCL preserves existing destination', async () => {
    await withTempDir('fs-copyfile-excl', async (root) => {
        const src = join(root, 'src.txt');
        const dest = join(root, 'dest.txt');
        const destSync = join(root, 'dest-sync.txt');
        fs.writeFileSync(src, 'new');
        fs.writeFileSync(dest, 'old');
        fs.writeFileSync(destSync, 'old-sync');

        await rejects(fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL), (err: unknown) => {
            strictEqual((err as NodeJS.ErrnoException).code, 'EEXIST');
            return true;
        });
        strictEqual(fs.readFileSync(dest, 'utf8'), 'old');

        throws(() => fs.copyFileSync(src, destSync, fs.constants.COPYFILE_EXCL), (err: unknown) => {
            strictEqual((err as NodeJS.ErrnoException).code, 'EEXIST');
            return true;
        });
        strictEqual(fs.readFileSync(destSync, 'utf8'), 'old-sync');

        const destCallback = join(root, 'dest-callback.txt');
        fs.writeFileSync(destCallback, 'old-callback');
        await new Promise<void>((resolve, reject) => {
            fs.copyFile(src, destCallback, fs.constants.COPYFILE_EXCL, (err) => {
                try {
                    strictEqual(err?.code, 'EEXIST');
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
        strictEqual(fs.readFileSync(destCallback, 'utf8'), 'old-callback');

        const fresh = join(root, 'fresh.txt');
        await fsp.copyFile(src, fresh, fs.constants.COPYFILE_EXCL);
        strictEqual(fs.readFileSync(fresh, 'utf8'), 'new');
    });
});

Deno.test('fs upstream: promises readFile rejects an already aborted signal', async () => {
    await withTempDir('fs-readfile-abort', async (root) => {
        const file = join(root, 'abort.txt');
        fs.writeFileSync(file, 'Hello');
        await rejects(
            fsp.readFile(file, { signal: AbortSignal.abort() }),
            (err: unknown) => {
                ok(err instanceof DOMException);
                strictEqual(err.name, 'AbortError');
                return true;
            },
        );
    });
});

Deno.test('fs upstream: selected constants match platform values', () => {
    strictEqual(fs.constants.R_OK, 4);
    strictEqual(fs.constants.UV_FS_O_FILEMAP, Deno.build.os === 'windows' ? 0x20000000 : 0);

    if (Deno.build.os === 'darwin') {
        strictEqual(fs.constants.O_CREAT, 0x200);
        strictEqual(fs.constants.O_DIRECT, undefined);
        strictEqual(fs.constants.O_NOATIME, undefined);
        strictEqual(fs.constants.O_SYMLINK, 0x200000);
    } else if (Deno.build.os === 'linux') {
        strictEqual(fs.constants.O_CREAT, 0x40);
        ok(fs.constants.O_DIRECT !== undefined);
        strictEqual(fs.constants.O_NOATIME, 0x40000);
        strictEqual(fs.constants.O_SYMLINK, undefined);
    } else if (Deno.build.os === 'windows') {
        strictEqual(fs.constants.O_CREAT, 0x100);
        strictEqual(fs.constants.O_DIRECT, undefined);
        strictEqual(fs.constants.O_NOATIME, undefined);
        strictEqual(fs.constants.O_SYMLINK, undefined);
    }
});
