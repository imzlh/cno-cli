import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import { O_APPEND, O_CREAT, O_EXCL, O_RDWR, O_TRUNC, O_WRONLY } from 'node:constants';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
        await new Promise<void>((resolve, reject) => {
            new fs.Dir(root).close((err) => {
                if (err) reject(err);
                else {
                    closeCalled = true;
                    resolve();
                }
            });
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
        ok(dirents.some((entry) => entry.name === 'file2.txt' && entry.parentPath === join(root, 'sub') && entry.isFile()));
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
    // URL.pathname keeps a leading slash before the drive letter on Windows
    // ("/D:/..."), which real Node also rejects with ENOENT — convert properly.
    const pathString = fileURLToPath(import.meta.url);

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
            // 'rename', not 'renameSync'. Node reports the libuv operation name
            // for every form (measured v24.18.0: all three of renameSync,
            // fs.rename and fsp.rename report syscall 'rename'), which is why the
            // callback and promise arms above already expect it. This arm used to
            // expect 'renameSync' and was pinning cno's JS-name defect in place.
            (err: unknown) => assertRenameError(err, 'rename'),
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
                // Measured Node v24.18.0: the rejection is Node's own AbortError
                // (a plain Error subclass), NOT a DOMException, carrying
                // code 'ABORT_ERR' with signal.reason on `.cause`. This
                // previously asserted `instanceof DOMException`, which only held
                // because makeAbortError returned signal.reason verbatim and so
                // exposed `code` as the number 20 instead of 'ABORT_ERR'.
                ok(err instanceof Error);
                strictEqual((err as Error).name, 'AbortError');
                strictEqual((err as NodeJS.ErrnoException).code, 'ABORT_ERR');
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

Deno.test({
    name: 'fs upstream: Windows sync stat preserves sub-second timestamps',
    ignore: Deno.build.os !== 'windows',
    async fn() {
        await withTempDir('fs-stat-subsecond', async (root) => {
            const file = join(root, 'stamp.txt');
            fs.writeFileSync(file, 'same-size');
            const stamp = new Date('2024-01-02T03:04:05.678Z');
            fs.utimesSync(file, stamp, stamp);

            const sync = fs.statSync(file);
            const async = await fsp.stat(file);
            strictEqual(sync.mtimeMs, stamp.getTime());
            strictEqual(sync.mtimeMs, async.mtimeMs);

            const fd = fs.openSync(file, 'r');
            try {
                strictEqual(fs.fstatSync(fd).mtimeMs, stamp.getTime());
            } finally {
                fs.closeSync(fd);
            }
        });
    },
});

Deno.test('fs upstream: rm force only ignores missing paths and rejects directories', async () => {
    await withTempDir('fs-rm-force', async (root) => {
        const empty = join(root, 'empty');
        const nonEmpty = join(root, 'non-empty');
        fs.mkdirSync(empty);
        fs.mkdirSync(nonEmpty);
        fs.writeFileSync(join(nonEmpty, 'file.txt'), 'x');

        throws(() => fs.rmSync(empty, { force: true }), (error: NodeJS.ErrnoException) => {
            strictEqual(error.code, 'ERR_FS_EISDIR');
            return true;
        });
        await rejects(fsp.rm(nonEmpty, { force: true }), (error: NodeJS.ErrnoException) => {
            strictEqual(error.code, 'ERR_FS_EISDIR');
            return true;
        });
        await new Promise<void>((resolve, reject) => {
            fs.rm(empty, { force: true }, (error) => {
                try {
                    strictEqual(error?.code, 'ERR_FS_EISDIR');
                    resolve();
                } catch (assertionError) {
                    reject(assertionError);
                }
            });
        });

        fs.rmSync(join(root, 'missing'), { force: true });
        await fsp.rm(join(root, 'missing-promise'), { force: true });
    });
});

Deno.test('fs upstream: numeric O_CREAT without O_TRUNC preserves existing data', async () => {
    await withTempDir('fs-numeric-create', async (root) => {
        const syncPath = join(root, 'sync.txt');
        fs.writeFileSync(syncPath, 'preserve');
        const syncFd = fs.openSync(syncPath, fs.constants.O_RDONLY | fs.constants.O_CREAT);
        fs.closeSync(syncFd);
        strictEqual(fs.readFileSync(syncPath, 'utf8'), 'preserve');

        const promisePath = join(root, 'promise.txt');
        await fsp.writeFile(promisePath, 'preserve');
        const handle = await fsp.open(promisePath, fs.constants.O_RDONLY | fs.constants.O_CREAT);
        await handle.close();
        strictEqual(await fsp.readFile(promisePath, 'utf8'), 'preserve');
    });
});

Deno.test('fs upstream: readv and writev support sync and callback forms', async () => {
    await withTempDir('fs-vector-io', async (root) => {
        const file = join(root, 'vectors.txt');
        fs.writeFileSync(file, 'abcdef');
        const fd = fs.openSync(file, 'r+');
        try {
            const syncFirst = Buffer.alloc(2);
            const syncSecondBytes = new Uint8Array(3);
            const syncSecond = new DataView(syncSecondBytes.buffer);
            strictEqual(fs.readvSync(fd, [syncFirst, syncSecond], 1), 5);
            strictEqual(syncFirst.toString(), 'bc');
            strictEqual(Buffer.from(syncSecondBytes).toString(), 'def');

            const syncWriteBytes = new Uint8Array([0x33, 0x34]);
            strictEqual(fs.writevSync(fd, [Buffer.from('12'), new DataView(syncWriteBytes.buffer)], 0), 4);

            const callbackFirst = Buffer.alloc(2);
            const callbackSecond = new Uint8Array(2);
            const callbackReadBuffers = [callbackFirst, callbackSecond];
            const callbackRead = await new Promise<{ bytesRead: number; buffers: readonly ArrayBufferView[] }>((resolve, reject) => {
                fs.readv(fd, callbackReadBuffers, 0, (err, bytesRead, buffers) => {
                    if (err) reject(err);
                    else resolve({ bytesRead, buffers });
                });
            });
            strictEqual(callbackRead.bytesRead, 4);
            strictEqual(callbackRead.buffers, callbackReadBuffers);
            strictEqual(callbackFirst.toString(), '12');
            strictEqual(Buffer.from(callbackSecond).toString(), '34');

            const callbackWriteBuffers = [Buffer.from('XY'), new Uint8Array([0x5a])];
            const callbackWrite = await new Promise<{ bytesWritten: number; buffers: readonly ArrayBufferView[] }>((resolve, reject) => {
                fs.writev(fd, callbackWriteBuffers, 2, (err, bytesWritten, buffers) => {
                    if (err) reject(err);
                    else resolve({ bytesWritten, buffers });
                });
            });
            strictEqual(callbackWrite.bytesWritten, 3);
            strictEqual(callbackWrite.buffers, callbackWriteBuffers);
        } finally {
            fs.closeSync(fd);
        }
        strictEqual(fs.readFileSync(file, 'utf8'), '12XYZf');
    });
});

Deno.test('fs upstream: cp honors overwrite options and callback timing', async () => {
    await withTempDir('fs-cp-options', async (root) => {
        const source = join(root, 'source.txt');
        const destination = join(root, 'destination.txt');
        fs.writeFileSync(source, 'new');
        fs.writeFileSync(destination, 'old');

        fs.cpSync(source, destination, { force: false });
        strictEqual(fs.readFileSync(destination, 'utf8'), 'old');
        throws(
            () => fs.cpSync(source, destination, { force: false, errorOnExist: true }),
            (error: NodeJS.ErrnoException) => {
                strictEqual(error.code, 'ERR_FS_CP_EEXIST');
                strictEqual(error.syscall, 'cp');
                strictEqual(error.path, destination);
                return true;
            },
        );

        let synchronous = true;
        await new Promise<void>((resolve, reject) => {
            fs.cp(source, destination, (error) => {
                try {
                    strictEqual(synchronous, false);
                    strictEqual(error, null);
                    resolve();
                } catch (assertionError) {
                    reject(assertionError);
                }
            });
            synchronous = false;
        });
        strictEqual(fs.readFileSync(destination, 'utf8'), 'new');

        const sourceDirectory = join(root, 'tree');
        const destinationDirectory = join(root, 'copied-tree');
        fs.mkdirSync(sourceDirectory);
        fs.writeFileSync(join(sourceDirectory, 'keep.txt'), 'keep');
        fs.writeFileSync(join(sourceDirectory, 'drop.txt'), 'drop');
        await fsp.cp(sourceDirectory, destinationDirectory, {
            recursive: true,
            async filter(path) { return !path.endsWith('drop.txt'); },
        });
        strictEqual(await fsp.readFile(join(destinationDirectory, 'keep.txt'), 'utf8'), 'keep');
        strictEqual(fs.existsSync(join(destinationDirectory, 'drop.txt')), false);

        await rejects(
            fsp.cp(sourceDirectory, join(sourceDirectory, 'nested'), { recursive: true }),
            (error: NodeJS.ErrnoException) => {
                strictEqual(error.code, 'ERR_FS_CP_EINVAL');
                strictEqual(error.syscall, 'cp');
                return true;
            },
        );
        await rejects(
            fsp.cp(sourceDirectory, join(root, 'not-recursive')),
            (error: NodeJS.ErrnoException) => {
                strictEqual(error.code, 'ERR_FS_EISDIR');
                return true;
            },
        );
    });
});

Deno.test({
    name: 'fs upstream: cp preserves timestamps and supports symlink modes',
    ignore: Deno.build.os === 'windows',
    async fn() {
        await withTempDir('fs-cp-symlink', async (root) => {
            const source = join(root, 'source.txt');
            const targetTime = new Date('2021-02-03T04:05:06.000Z');
            fs.writeFileSync(source, 'contents');
            fs.utimesSync(source, targetTime, targetTime);

            const preserved = join(root, 'preserved.txt');
            await fsp.cp(source, preserved, { preserveTimestamps: true });
            strictEqual(
                Math.trunc(fs.statSync(preserved).mtimeMs / 1000),
                Math.trunc(targetTime.getTime() / 1000),
            );

            const link = join(root, 'source-link');
            const copiedLink = join(root, 'copied-link');
            const dereferenced = join(root, 'dereferenced.txt');
            fs.symlinkSync('source.txt', link);
            fs.cpSync(link, copiedLink, { verbatimSymlinks: true });
            strictEqual(fs.lstatSync(copiedLink).isSymbolicLink(), true);
            strictEqual(fs.readlinkSync(copiedLink), 'source.txt');

            await fsp.cp(link, dereferenced, { dereference: true });
            strictEqual(fs.lstatSync(dereferenced).isFile(), true);
            strictEqual(fs.readFileSync(dereferenced, 'utf8'), 'contents');
        });
    },
});

Deno.test('fs upstream: glob supports sync callback and async iterator forms', async () => {
    await withTempDir('fs-glob', async (root) => {
        fs.mkdirSync(join(root, 'src', 'nested'), { recursive: true });
        fs.writeFileSync(join(root, 'src', 'a.ts'), 'a');
        fs.writeFileSync(join(root, 'src', 'b.js'), 'b');
        fs.writeFileSync(join(root, 'src', 'nested', 'c.ts'), 'c');
        fs.writeFileSync(join(root, '.hidden.ts'), 'hidden');

        deepStrictEqual(
            fs.globSync('src/**/*.{ts,js}', { cwd: root }).sort(),
            [join('src', 'a.ts'), join('src', 'b.js'), join('src', 'nested', 'c.ts')].sort(),
        );
        deepStrictEqual(
            fs.globSync(['src/*.ts', 'src/*.{ts,js}'], { cwd: pathToFileURL(`${root}/`) }).sort(),
            [join('src', 'a.ts'), join('src', 'b.js')].sort(),
        );
        deepStrictEqual(fs.globSync('src/!(a).js', { cwd: root }), [join('src', 'b.js')]);
        deepStrictEqual(fs.globSync('src/nested/../*.js', { cwd: root }), [join('src', 'b.js')]);
        deepStrictEqual(
            fs.globSync('**/*', { cwd: root, exclude: ['src/nested/**'] }).sort(),
            ['src', join('src', 'a.ts'), join('src', 'b.js'), join('src', 'nested')].sort(),
        );

        if (Deno.build.os !== 'windows') {
            fs.symlinkSync('src', join(root, 'source-link'));
            const withoutFollowing = fs.globSync('**/*.ts', { cwd: root });
            strictEqual(withoutFollowing.some(path => path.startsWith('source-link/')), false);
            const withFollowing = fs.globSync('**/*.ts', { cwd: root, followSymlinks: true });
            ok(withFollowing.includes(join('source-link', 'a.ts')));
            ok(withFollowing.includes(join('source-link', 'nested', 'c.ts')));
        }

        let synchronous = true;
        const callbackMatches = await new Promise<string[]>((resolve, reject) => {
            fs.glob('src/**/*.ts', { cwd: root }, (error, matches) => {
                try {
                    strictEqual(synchronous, false);
                    if (error) reject(error);
                    else resolve(matches as string[]);
                } catch (assertionError) {
                    reject(assertionError);
                }
            });
            synchronous = false;
        });
        deepStrictEqual(callbackMatches.sort(), [join('src', 'a.ts'), join('src', 'nested', 'c.ts')].sort());

        const iteratorMatches: string[] = [];
        for await (const match of fsp.glob('src/**/*.ts', { cwd: root })) {
            iteratorMatches.push(match as string);
        }
        deepStrictEqual(iteratorMatches.sort(), callbackMatches.sort());

        const typedMatches = fs.globSync('src/**/*', { cwd: root, withFileTypes: true });
        ok(typedMatches.every(entry => entry instanceof fs.Dirent));
        const nestedFile = typedMatches.find(entry => entry.name === 'c.ts');
        ok(nestedFile?.isFile());
        strictEqual(nestedFile?.parentPath, join(root, 'src', 'nested'));
    });
});

Deno.test('fs upstream: Dirent names honor readdir encoding', async () => {
    await withTempDir('fs-dirent-encoding', async (root) => {
        fs.writeFileSync(join(root, 'az'), 'x');
        const syncEntry = fs.readdirSync(root, { encoding: 'buffer', withFileTypes: true })[0]!;
        ok(Buffer.isBuffer(syncEntry.name));
        strictEqual(syncEntry.name.toString(), 'az');
        strictEqual(syncEntry.parentPath, root);

        const bufferPathEntry = fs.readdirSync(Buffer.from(root), {
            encoding: 'buffer',
            withFileTypes: true,
        })[0]!;
        ok(Buffer.isBuffer(bufferPathEntry.parentPath));
        strictEqual(Buffer.from(bufferPathEntry.parentPath).toString(), root);

        const promiseEntry = (await fsp.readdir(root, { encoding: 'hex', withFileTypes: true }))[0]!;
        strictEqual(promiseEntry.name, '617a');
        strictEqual(promiseEntry.parentPath, root);

        const callbackEntry = await new Promise<fs.Dirent<Buffer>>((resolve, reject) => {
            fs.readdir(root, { encoding: 'buffer', withFileTypes: true }, (error, entries) => {
                if (error) reject(error);
                else resolve(entries[0] as fs.Dirent<Buffer>);
            });
        });
        ok(Buffer.isBuffer(callbackEntry.name));
        strictEqual(callbackEntry.name.toString(), 'az');

        throws(
            () => fs.readdirSync(root, { encoding: 'bogus' as BufferEncoding }),
            (error: NodeJS.ErrnoException) => {
                strictEqual(error.code, 'ERR_INVALID_ARG_VALUE');
                return true;
            },
        );
        throws(
            () => fs.readdir(root, { encoding: 'bogus' as BufferEncoding }, () => {}),
            (error: NodeJS.ErrnoException) => {
                strictEqual(error.code, 'ERR_INVALID_ARG_VALUE');
                return true;
            },
        );
        await rejects(
            fsp.readdir(root, { encoding: 'bogus' as BufferEncoding }),
            (error: NodeJS.ErrnoException) => {
                strictEqual(error.code, 'ERR_INVALID_ARG_VALUE');
                return true;
            },
        );
    });
});

Deno.test('fs upstream: disposable temp directories remove recursively and idempotently', async () => {
    await withTempDir('fs-disposable-temp', async (root) => {
        const syncDisposable = fs.mkdtempDisposableSync(join(root, 'sync-'));
        fs.mkdirSync(join(syncDisposable.path, 'nested'));
        fs.writeFileSync(join(syncDisposable.path, 'nested', 'file.txt'), 'x');
        syncDisposable[Symbol.dispose]();
        strictEqual(fs.existsSync(syncDisposable.path), false);
        syncDisposable.remove();

        const asyncDisposable = await fsp.mkdtempDisposable(join(root, 'async-'));
        await fsp.writeFile(join(asyncDisposable.path, 'file.txt'), 'x');
        await asyncDisposable[Symbol.asyncDispose]();
        strictEqual(fs.existsSync(asyncDisposable.path), false);
        await asyncDisposable.remove();
    });
});

Deno.test('fs upstream: openAsBlob exposes file data and rejects reads after mutation', async () => {
    await withTempDir('fs-open-blob', async (root) => {
        const file = join(root, 'blob.txt');
        fs.writeFileSync(file, 'hello');
        const blob = await fs.openAsBlob(file, { type: 'TEXT/PLAIN' });
        ok(blob instanceof Blob);
        strictEqual(blob.size, 5);
        strictEqual(blob.type, 'TEXT/PLAIN');
        strictEqual(await blob.text(), 'hello');
        strictEqual(await blob.slice(1, 4).text(), 'ell');

        fs.writeFileSync(file, 'changed contents');
        await rejects(blob.text(), (error: DOMException) => {
            strictEqual(error.name, 'NotReadableError');
            return true;
        });
        throws(
            () => fs.openAsBlob(join(root, 'missing.txt')),
            (error: NodeJS.ErrnoException) => {
                strictEqual(error.code, 'ERR_INVALID_ARG_VALUE');
                return true;
            },
        );
    });
});
