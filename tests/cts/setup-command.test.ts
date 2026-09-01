import { ok, strictEqual } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { makePosixTempDir } from '../_helpers/temp.ts';

Deno.test('setup: staged command installs local node polyfills without transaction artifacts', async () => {
    const root = makePosixTempDir('setup-command');
    const cacheDir = join(root, 'cache');
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');

    try {
        const output = await new Deno.Command(execPath, {
            args: ['setup', `--cache-dir=${cacheDir}`],
            cwd: Deno.cwd(),
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const stdout = decodeUtf8(output.stdout);
        const stderr = decodeUtf8(output.stderr);

        strictEqual(output.code, 0, stderr);
        ok(stdout.includes('Node polyfills ready at:'), stdout);
        ok(existsSync(join(cacheDir, 'node', 'fs', 'index.ts')));
        strictEqual(
            readdirSync(join(cacheDir, 'node')).some(name => name.includes('.tmp-') || name.includes('.old-')),
            false,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('setup: staged command does not replace a destination directory', async () => {
    const root = makePosixTempDir('setup-directory-target');
    const cacheDir = join(root, 'cache');
    const destination = join(cacheDir, 'node', 'fs', 'index.ts');
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');

    try {
        const initial = await new Deno.Command(execPath, {
            args: ['setup', `--cache-dir=${cacheDir}`],
            cwd: Deno.cwd(),
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        strictEqual(initial.code, 0, decodeUtf8(initial.stderr));

        rmSync(destination);
        mkdirSync(destination);

        const result = await new Deno.Command(execPath, {
            args: ['setup', `--cache-dir=${cacheDir}`],
            cwd: Deno.cwd(),
            stdout: 'piped',
            stderr: 'piped',
        }).output();

        ok(result.code !== 0);
        ok(statSync(destination).isDirectory());
        strictEqual(
            readdirSync(join(cacheDir, 'node', 'fs')).some(name => name.includes('index.ts.old-')),
            false,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('setup: refresh prunes stale managed files and bytecode', async () => {
    const root = makePosixTempDir('setup-refresh');
    const cacheDir = join(root, 'cache');
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');

    try {
        const initial = await new Deno.Command(execPath, {
            args: ['setup', `--cache-dir=${cacheDir}`],
            cwd: Deno.cwd(),
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        strictEqual(initial.code, 0, decodeUtf8(initial.stderr));

        const nodeDir = join(cacheDir, 'node');
        const staleNode = join(nodeDir, '__setup_stale__.ts');
        const keptNodeFile = join(nodeDir, '__setup_kept__.txt');
        const retainedBytecode = join(nodeDir, 'fs', 'index.ts.jsc');
        writeFileSync(staleNode, 'stale source');
        writeFileSync(staleNode + '.jsc', 'stale bytecode');
        writeFileSync(staleNode + '.jsc.mt', 'stale metadata');
        writeFileSync(keptNodeFile, 'not managed by setup');
        writeFileSync(retainedBytecode, 'bytecode for unchanged source');

        const httpStore = readdirSync(join(cacheDir, 'npm', '@cnojs')).find(name => name.startsWith('http@'));
        ok(httpStore, 'setup must install the workspace HTTP package');
        const staleHttp = join(cacheDir, 'npm', '@cnojs', httpStore, '__setup_stale__.ts');
        writeFileSync(staleHttp, 'stale source');
        writeFileSync(staleHttp + '.jsc', 'stale bytecode');
        writeFileSync(staleHttp + '.jsc.mt', 'stale metadata');

        const refreshed = await new Deno.Command(execPath, {
            args: ['setup', `--cache-dir=${cacheDir}`],
            cwd: Deno.cwd(),
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        strictEqual(refreshed.code, 0, decodeUtf8(refreshed.stderr));

        for (const path of [staleNode, staleNode + '.jsc', staleNode + '.jsc.mt', staleHttp, staleHttp + '.jsc', staleHttp + '.jsc.mt']) {
            strictEqual(existsSync(path), false, path);
        }
        strictEqual(existsSync(keptNodeFile), true);
        strictEqual(existsSync(retainedBytecode), true, 'unchanged source bytecode should remain cached');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('setup: a failed refresh clears completion state so a later setup retries it', async () => {
    const root = makePosixTempDir('setup-retry');
    const cacheDir = join(root, 'cache');
    const nodeSrc = join(root, 'cno', 'src', 'node');
    const entry = join(root, 'entry.ts');
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');

    try {
        mkdirSync(join(nodeSrc, 'fs'), { recursive: true });
        mkdirSync(join(nodeSrc, 'z'), { recursive: true });
        writeFileSync(join(nodeSrc, 'fs', 'index.ts'), 'export const fsReady = true;\n');
        writeFileSync(join(nodeSrc, 'z', 'index.ts'), 'export const zReady = true;\n');
        writeFileSync(entry, 'export {};\n');

        const initial = await new Deno.Command(execPath, {
            args: ['setup', `--cache-dir=${cacheDir}`], cwd: root, stdout: 'piped', stderr: 'piped',
        }).output();
        strictEqual(initial.code, 0, decodeUtf8(initial.stderr));

        const marker = join(cacheDir, 'node', '.cno-setup-ready');
        const blocked = join(cacheDir, 'node', 'z', 'index.ts');
        ok(existsSync(marker));
        rmSync(blocked);
        mkdirSync(blocked);

        const failed = await new Deno.Command(execPath, {
            args: ['setup', `--cache-dir=${cacheDir}`], cwd: root, stdout: 'piped', stderr: 'piped',
        }).output();
        ok(failed.code !== 0, decodeUtf8(failed.stderr));
        strictEqual(existsSync(marker), false, 'failed setup must not retain a ready marker');
        strictEqual(statSync(join(cacheDir, 'node', 'fs', 'index.ts')).isFile(), true);

        rmSync(blocked, { recursive: true });
        const recovered = await new Deno.Command(execPath, {
            args: ['setup', `--cache-dir=${cacheDir}`], cwd: root, stdout: 'piped', stderr: 'piped',
        }).output();
        strictEqual(recovered.code, 0, decodeUtf8(recovered.stderr));
        strictEqual(statSync(blocked).isFile(), true, 'ensureNodePolyfills must repair the interrupted setup');
        ok(existsSync(marker));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('setup: skips directory symlink loops in a local source tree', async () => {
    const root = makePosixTempDir('setup-symlink-loop');
    const cacheDir = join(root, 'cache');
    const nodeSrc = join(root, 'cno', 'src', 'node');
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');

    try {
        mkdirSync(join(nodeSrc, 'fs'), { recursive: true });
        writeFileSync(join(nodeSrc, 'fs', 'index.ts'), 'export const fsReady = true;\n');
        try {
            symlinkSync(nodeSrc, join(nodeSrc, 'loop'), 'junction');
        } catch {
            // Creating links can be prohibited by the host policy.
            return;
        }

        const result = await new Deno.Command(execPath, {
            args: ['setup', `--cache-dir=${cacheDir}`], cwd: root, stdout: 'piped', stderr: 'piped',
        }).output();
        strictEqual(result.code, 0, decodeUtf8(result.stderr));
        strictEqual(statSync(join(cacheDir, 'node', 'fs', 'index.ts')).isFile(), true);
        strictEqual(existsSync(join(cacheDir, 'node', 'loop')), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
