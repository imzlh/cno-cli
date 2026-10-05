import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

async function fixture(root: string): Promise<{ cacheDir: string; preload: string }> {
    const cacheDir = join(root, 'cache');
    const packageDir = join(cacheDir, 'npm', 'args-probe@1.0.0');
    await Deno.mkdir(packageDir, { recursive: true });
    await Deno.writeTextFile(join(packageDir, 'package.json'), JSON.stringify({
        name: 'args-probe', version: '1.0.0', bin: { 'args-probe': './probe.cjs' },
    }));
    await Deno.writeTextFile(join(packageDir, 'probe.cjs'), `
        console.log('ARGS_PROBE:' + JSON.stringify({
            execArgv: process.execArgv,
            argv: process.argv.slice(2),
            deno: Deno.args,
            preloaded: globalThis.argsPreloaded,
        }));
    `);
    const preload = join(root, 'preload.cjs');
    await Deno.writeTextFile(preload, 'globalThis.argsPreloaded = true;\n');
    await Deno.writeTextFile(join(root, 'package.json'), JSON.stringify({
        dependencies: { 'args-probe': '1.0.0' },
    }));
    return { cacheDir, preload };
}

async function run(args: string[], root: string, cacheDir: string) {
    const output = await new Deno.Command(Deno.execPath(), {
        args, cwd: root, stdout: 'piped', stderr: 'piped',
        env: { CTS_CACHE_DIR: cacheDir, CTS_SILENT: 'true', NODE_OPTIONS: '' },
    }).output();
    const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
    strictEqual(output.code, 0, text);
    const rows = text.split(/\r?\n/).filter(line => line.startsWith('ARGS_PROBE:'));
    ok(rows.length > 0, text);
    return { text, probes: rows.map(line => JSON.parse(line.slice('ARGS_PROBE:'.length))) };
}

Deno.test({ name: 'args forwarding: exec preserves kernel options and ignores command inspector options', timeout: 20000 }, async () => {
    await withTempDir('args-exec-forward', async (root) => {
        const { cacheDir, preload } = await fixture(root);
        const kernelArgs = ['--conditions=first', '-C', 'second', '--require', preload];
        const scriptArgs = ['--inspect', '--require', 'user value', '--', ''];
        const ignored = await run([
            ...kernelArgs, 'exec', '--cache-dir', cacheDir,
            '--inspect-wait=127.0.0.1:0', 'args-probe', ...scriptArgs,
        ], root, cacheDir);
        deepStrictEqual(ignored.probes, [{
            execArgv: kernelArgs, argv: scriptArgs, deno: scriptArgs, preloaded: true,
        }]);
        ok(!ignored.text.includes('Debugger listening'), ignored.text);

        const inspectedKernel = ['--inspect=127.0.0.1:0', ...kernelArgs];
        const active = await run([
            ...inspectedKernel, 'exec', '--cache-dir', cacheDir, 'args-probe', ...scriptArgs,
        ], root, cacheDir);
        deepStrictEqual(active.probes[0].execArgv, inspectedKernel);
        ok(active.text.includes('Debugger listening'), active.text);
    });
});

Deno.test({ name: 'args forwarding: task preserves kernel options for cached bins and Windows pipelines', timeout: 20000 }, async () => {
    await withTempDir('args-task-forward', async (root) => {
        const { cacheDir, preload } = await fixture(root);
        await Deno.writeTextFile(join(root, 'relay.cjs'), `
            process.stdin.on('data', chunk => process.stdout.write(chunk));
        `);
        await Deno.writeTextFile(join(root, 'deno.json'), JSON.stringify({
            tasks: { direct: 'args-probe direct', piped: 'args-probe piped | node relay.cjs' },
        }));
        const lockDir = join(root, 'locks');
        await Deno.mkdir(lockDir);
        const kernelArgs = ['--lock-dir', lockDir, '--conditions=first', '-C', 'second', '--require', preload];
        // Windows pipelines use the CTS internal shell, with its own cached
        // bin dispatch. POSIX pipelines are delegated to the user's shell.
        const tasks = Deno.build.os === 'windows' ? ['direct', 'piped'] : ['direct'];
        for (const task of tasks) {
            const result = await run([
                ...kernelArgs, 'task', '--inspect-wait=127.0.0.1:0', task,
            ], root, cacheDir);
            strictEqual(result.probes.length, 1, result.text);
            const probe = result.probes[0];
            // The task runner supplies a default lock directory before user
            // kernel options; the explicit user value must remain last.
            deepStrictEqual(probe.execArgv.slice(1), kernelArgs);
            deepStrictEqual(probe.argv, [task]);
            deepStrictEqual(probe.deno, probe.argv);
            strictEqual(probe.preloaded, true);
            ok(!result.text.includes('Debugger listening'), result.text);
        }
    });
});

Deno.test({ name: 'args forwarding: exec preserves a leading script separator', timeout: 20000 }, async () => {
    await withTempDir('args-exec-separator', async (root) => {
        const { cacheDir } = await fixture(root);
        const scriptArgs = ['--', '--inspect', '--require', '', 'value'];
        const result = await run(['exec', '--cache-dir', cacheDir, 'args-probe', ...scriptArgs], root, cacheDir);
        deepStrictEqual(result.probes, [{ execArgv: [], argv: scriptArgs, deno: scriptArgs }]);
    });
});
