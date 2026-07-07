import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { basename, join } from 'node:path';
import { Buffer } from 'node:buffer';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

Deno.test('deno permissions: query/request/revoke always return granted status', async () => {
    const syncStatus = Deno.permissions.querySync({ name: 'env' as Deno.PermissionName });
    strictEqual(syncStatus.state, 'granted');
    strictEqual(syncStatus.partial, false);

    const listener = () => {};
    syncStatus.onchange = listener;
    strictEqual(syncStatus.onchange, listener);

    strictEqual((await Deno.permissions.query({ name: 'read' as Deno.PermissionName })).state, 'granted');
    strictEqual((await Deno.permissions.request({ name: 'write' as Deno.PermissionName })).state, 'granted');
    strictEqual((await Deno.permissions.revoke({ name: 'run' as Deno.PermissionName })).state, 'granted');
    strictEqual(Deno.permissions.requestSync({ name: 'net' as Deno.PermissionName }).state, 'granted');
    strictEqual(Deno.permissions.revokeSync({ name: 'ffi' as Deno.PermissionName }).state, 'granted');
});

Deno.test('deno errors: extended error classes expose stable names', () => {
    for (const name of [
        'TimedOut',
        'WriteZero',
        'WouldBlock',
        'UnexpectedEof',
        'Http',
        'Busy',
        'NotSupported',
        'FilesystemLoop',
        'IsADirectory',
        'NetworkUnreachable',
        'NotADirectory',
    ]) {
        const Ctor = Deno.errors[name];
        ok(typeof Ctor === 'function', `Deno.errors.${name} must exist`);
        const err = new Ctor('message');
        ok(err instanceof Error);
        strictEqual(err.name, name);
        strictEqual(err.message, 'message');
    }
});

Deno.test('deno fs: sync text file operations accept string and file URL paths', () => {
    return withTempDir('deno-api', (root) => {
        const file = join(root, 'nested', 'file.txt');
        Deno.mkdirSync(join(root, 'nested'), { recursive: true });
        Deno.writeTextFileSync(file, 'hello');
        strictEqual(Deno.readTextFileSync(file), 'hello');

        const url = new URL(`file://${file}`);
        Deno.writeTextFileSync(url, 'url-data');
        strictEqual(Deno.readTextFileSync(url), 'url-data');

        const info = Deno.statSync(file);
        strictEqual(info.isFile, true);
        strictEqual(info.isDirectory, false);

        Deno.truncateSync(file, 3);
        strictEqual(Deno.readTextFileSync(file), 'url');
    });
});

Deno.test('deno fs: async write/copy/rename/readDir/remove round-trip', async () => {
    await withTempDir('deno-api', async (root) => {
        const a = join(root, 'a.txt');
        const b = join(root, 'b.txt');
        const c = join(root, 'c.txt');
        await Deno.writeFile(a, new Uint8Array([65, 66, 67]));
        deepStrictEqual([...await Deno.readFile(a)], [65, 66, 67]);

        await Deno.copyFile(a, b);
        strictEqual(await Deno.readTextFile(b), 'ABC');

        await Deno.rename(b, c);
        strictEqual(await Deno.readTextFile(c), 'ABC');

        const names: string[] = [];
        for await (const entry of Deno.readDir(root)) names.push(entry.name);
        deepStrictEqual(names.sort(), ['a.txt', 'c.txt']);

        await Deno.remove(c);
        ok(!names.includes('missing'));
        strictEqual(Deno.readDirSync(root).next().value?.isFile, true);
    });
});

Deno.test('deno fs: makeTempFile and makeTempDir honor prefix and suffix', async () => {
    await withTempDir('deno-api', async (root) => {
        const file = Deno.makeTempFileSync({ dir: root, prefix: 'pre-', suffix: '.tmp' });
        ok(basename(file).startsWith('pre-'));
        ok(basename(file).endsWith('.tmp'));
        strictEqual(Deno.statSync(file).isFile, true);

        const dir = await Deno.makeTempDir({ dir: root, prefix: 'dir-', suffix: '-end' });
        ok(basename(dir).startsWith('dir-'));
        ok(basename(dir).endsWith('-end'));
        strictEqual((await Deno.stat(dir)).isDirectory, true);

        const syncDir = Deno.makeTempDirSync({ dir: root, prefix: 'sync-', suffix: '-done' });
        ok(basename(syncDir).startsWith('sync-'));
        ok(basename(syncDir).endsWith('-done'));
        strictEqual(Deno.statSync(syncDir).isDirectory, true);
    });
});

Deno.test({ name: 'deno command: output captures stdout and stderr', timeout: 10000 }, async () => {
    const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', 'console.log("deno-command-out"); console.error("deno-command-err")'],
        stdout: 'piped',
        stderr: 'piped',
    }).output();

    strictEqual(output.success, true);
    strictEqual(output.code, 0);
    strictEqual(decodeUtf8(output.stdout).trim(), 'deno-command-out');
    strictEqual(decodeUtf8(output.stderr).trim(), 'deno-command-err');
});

Deno.test('deno command: outputSync captures stdout, stderr and status', () => {
    const output = new Deno.Command(new URL(`file://${Deno.execPath()}`), {
        args: ['eval', 'console.log("sync-out"); console.error("sync-err")'],
        stdout: 'piped',
        stderr: 'piped',
    }).outputSync();

    strictEqual(output.success, true);
    strictEqual(output.code, 0);
    strictEqual(output.signal, null);
    strictEqual(decodeUtf8(output.stdout).trim(), 'sync-out');
    strictEqual(decodeUtf8(output.stderr).trim(), 'sync-err');

    const failed = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'Deno.exit(7)'],
        stdout: 'piped',
        stderr: 'piped',
    }).outputSync();
    strictEqual(failed.success, false);
    strictEqual(failed.code, 7);
    strictEqual(failed.signal, null);
});

Deno.test({ name: 'deno command: spawn exposes readable streams and status', timeout: 10000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'console.log("spawn-out"); console.error("spawn-err")'],
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();

    const [stdout, stderr, status] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.status,
    ]);

    strictEqual(stdout.trim(), 'spawn-out');
    strictEqual(stderr.trim(), 'spawn-err');
    strictEqual(status.success, true);
    strictEqual(status.code, 0);
    strictEqual(status.signal, null);
});

Deno.test({ name: 'deno command: spawn supports piped stdin', timeout: 10000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            const buf = new Uint8Array(64);
            const n = await Deno.stdin.read(buf);
            await Deno.stdout.write(buf.subarray(0, n ?? 0));
        `],
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();

    const writer = child.stdin.getWriter();
    await writer.write(Buffer.from('stdin-data'));
    await writer.close();

    const [stdout, stderr, status] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.status,
    ]);
    strictEqual(stdout, 'stdin-data');
    strictEqual(stderr, '');
    strictEqual(status.success, true);
});

Deno.test({ name: 'deno command: cwd and env are visible in child process', timeout: 10000 }, async () => {
    await withTempDir('deno-command', async (root) => {
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['eval', `
                console.log(Deno.cwd());
                console.log(Deno.env.get('CNO_COMMAND_ENV'));
            `],
            cwd: root,
            env: { CNO_COMMAND_ENV: 'from-env' },
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const lines = decodeUtf8(output.stdout).trim().split(/\r?\n/);
        strictEqual(output.success, true);
        strictEqual(lines[0], root);
        strictEqual(lines[1], 'from-env');
        strictEqual(decodeUtf8(output.stderr), '');
    });
});
