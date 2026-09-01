// Windows `shell:true` quoting. Both paths pass quoted cmd.exe commands through
// CreateProcess verbatim, matching Node.
import { strictEqual, ok } from 'node:assert';
import { exec, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { withTempDir } from '../_helpers/temp.ts';

const isWindows = Deno.build.os === 'windows';

function shell(cmd: string, env?: Record<string, string>): Promise<{ code: number | string; out: string }> {
    return new Promise((resolve) => {
        exec(cmd, { env: { ...(env ?? {}) }, windowsHide: true }, (err, stdout) => {
            resolve({ code: err ? ((err as { code?: number }).code ?? 'ERR') : 0, out: String(stdout).trim() });
        });
    });
}

Deno.test({
    name: 'child_process: async shell keeps a quoted argument intact',
    ignore: !isWindows,
    timeout: 20000,
}, async () => {
    const r = await shell('echo "hello world"');
    strictEqual(r.code, 0);
    // Node echoes the quotes back rather than consuming them.
    strictEqual(r.out, '"hello world"');
});

Deno.test({
    name: 'child_process: async shell does not double a caret',
    ignore: !isWindows,
    timeout: 20000,
}, async () => {
    // The env-var indirection returned "a^^b" here: cmd re-parsed the value and
    // the caret escaped itself.
    const r = await shell('echo "a^b"');
    strictEqual(r.code, 0);
    strictEqual(r.out, '"a^b"');
});

Deno.test({
    name: 'child_process: async shell resolves a redirect through a variable',
    ignore: !isWindows,
    timeout: 20000,
}, async () => {
    await withTempDir('cp-shell-redirect', async (dir) => {
        const target = join(dir, 'out.txt');
        // This is the regression that mattered: the redirection target used to be
        // resolved before the variable was expanded, so the shell created a file
        // literally named "%SP_OUT%" in the cwd and reported success.
        const r = await shell('echo redir > "%SP_OUT%"', { SP_OUT: target });
        strictEqual(r.code, 0);
        ok(fs.existsSync(target), 'redirect must write the expanded path');
        strictEqual(fs.readFileSync(target, 'utf8').trim(), 'redir');
        ok(!fs.existsSync('%SP_OUT%'), 'must not create a literally named file');
    });
});

Deno.test({
    name: 'child_process: async shell leaks no internal variable to the child',
    ignore: !isWindows,
    timeout: 20000,
}, async () => {
    // A quoted command used to travel in CNO_INTERNAL_SHELL_COMMAND, which stayed
    // in the child's environment where a grandchild could read the command back.
    const r = await shell('cmd /c "echo [%CNO_INTERNAL_SHELL_COMMAND%]"');
    strictEqual(r.code, 0);
    // Unset variables come back as their own literal name in cmd.
    strictEqual(r.out, '[%CNO_INTERNAL_SHELL_COMMAND%]');
});

Deno.test({
    name: 'child_process: async shell expands a caller variable exactly once',
    ignore: !isWindows,
    timeout: 20000,
}, async () => {
    // One pass: %FOO% expands, and the %BAR% inside its value stays inert data.
    // A second pass would have turned a value into an operator.
    const nested = await shell('echo "[%FOO%]"', { FOO: '%BAR%', BAR: 'inner' });
    strictEqual(nested.code, 0);
    strictEqual(nested.out, '"[%BAR%]"');

    const plain = await shell('echo "[%FOO%]"', { FOO: 'fooval' });
    strictEqual(plain.out, '"[fooval]"');
});

Deno.test({
    name: 'child_process: async shell propagates an exit code through &&',
    ignore: !isWindows,
    timeout: 20000,
}, async () => {
    const r = await shell('cmd /c exit 9 && echo "unreachable"');
    strictEqual(r.code, 9);
});

Deno.test({
    name: 'child_process: sync shell resolves a redirect through a variable',
    ignore: !isWindows,
}, async () => {
    await withTempDir('cp-shell-sync-redirect', async (dir) => {
        const target = join(dir, 'out.txt');
        const r = spawnSync('echo redir > "%SP_OUT%"', [], {
            shell: true,
            env: { SP_OUT: target },
            windowsHide: true,
        });
        strictEqual(r.error, undefined);
        strictEqual(r.status, 0);
        ok(fs.existsSync(target), 'redirect must write the expanded path');
        strictEqual(fs.readFileSync(target, 'utf8').trim(), 'redir');
        ok(!fs.existsSync('%SP_OUT%'), 'must not create a literally named file');
    });
});

Deno.test({
    name: 'child_process: sync shell still runs a literal redirect target',
    ignore: !isWindows,
    timeout: 20000,
}, async () => {
    await withTempDir('cp-shell-sync-lit', async (dir) => {
        const target = join(dir, 'lit.txt');
        const r = spawnSync(`echo "sync lit" > "${target}"`, [], {
            shell: true, windowsHide: true,
        });
        strictEqual(r.error, undefined);
        strictEqual(r.status, 0);
        ok(fs.existsSync(target), 'literal redirect target must still be written');
    });
});

Deno.test({
    name: 'child_process: sync shell allows a variable outside a redirect',
    ignore: !isWindows,
    timeout: 20000,
}, () => {
    const r = spawnSync('echo "[%FOO%]"', [], {
        shell: true, env: { FOO: 'fooval' }, windowsHide: true, encoding: 'utf8',
    });
    strictEqual(r.error, undefined);
    strictEqual(r.status, 0);
    strictEqual(String(r.stdout).trim(), '"[fooval]"');
});

Deno.test({
    name: 'child_process: unquoted shell command is unaffected on both paths',
    ignore: !isWindows,
    timeout: 20000,
}, async () => {
    // The plain `/d /s /c` branch is shared and must not have moved.
    const a = await shell('echo plain && echo second');
    strictEqual(a.code, 0);
    ok(a.out.includes('plain') && a.out.includes('second'), a.out);

    const s = spawnSync('echo plain', [], { shell: true, windowsHide: true, encoding: 'utf8' });
    strictEqual(s.status, 0);
    strictEqual(String(s.stdout).trim(), 'plain');
});
