import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

async function runCno(root: string, args: string[], env: Record<string, string> = {}) {
    const output = await new Deno.Command(Deno.execPath().replace(/ \(deleted\)$/, ''), {
        args, cwd: root, stdout: 'piped', stderr: 'piped',
        env: {
            CTS_CACHE_DIR: join(root, 'cache'), CTS_SILENT: 'true',
            NODE_OPTIONS: '', CNO_TEST_CHILD_TIMEOUT_MS: '8000', ...env,
        },
    }).output();
    return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
    };
}

function probe(result: Awaited<ReturnType<typeof runCno>>) {
    strictEqual(result.code, 0, result.stdout + result.stderr);
    const rows = result.stdout.split(/\r?\n/).filter(line => line.startsWith('KERNEL_PROBE:'));
    strictEqual(rows.length, 1, result.stdout + result.stderr);
    return JSON.parse(rows[0]!.slice('KERNEL_PROBE:'.length));
}

Deno.test({ name: 'kernel options: env files prepare conditions and preloads in region order', timeout: 15000 }, async () => {
    await withTempDir('kernel-env-options', async root => {
        await Deno.writeTextFile(join(root, 'prefix.env'), 'KERNEL_PROBE_VALUE=prefix\n');
        await Deno.writeTextFile(join(root, 'command.env'), [
            'KERNEL_PROBE_VALUE=command',
            'NODE_OPTIONS=--require "./node preload.cjs" --conditions=environment',
        ].join('\n'));
        for (const name of ['prefix', 'command', 'node preload', 'cli']) {
            await Deno.writeTextFile(join(root, `${name}.cjs`),
                `(globalThis.kernelOrder ??= []).push(${JSON.stringify(name)});\n`);
        }
        const packageDir = join(root, 'node_modules', 'kernel-probe');
        await Deno.mkdir(packageDir, { recursive: true });
        await Deno.writeTextFile(join(packageDir, 'package.json'), JSON.stringify({
            name: 'kernel-probe', version: '1.0.0', exports: {
                './environment': { environment: './selected.cjs', default: './default.cjs' },
                './prefix': { prefix: './selected.cjs', default: './default.cjs' },
                './ignored': { ignored: './selected.cjs', default: './default.cjs' },
            },
        }));
        await Deno.writeTextFile(join(packageDir, 'selected.cjs'), 'module.exports = "selected";\n');
        await Deno.writeTextFile(join(packageDir, 'default.cjs'), 'module.exports = "default";\n');
        await Deno.writeTextFile(join(root, 'main.cjs'), `
            console.log('KERNEL_PROBE:' + JSON.stringify({
                env: process.env.KERNEL_PROBE_VALUE,
                order: globalThis.kernelOrder,
                conditions: ['environment', 'prefix', 'ignored'].map(name => require('kernel-probe/' + name)),
                execArgv: process.execArgv,
                argv: process.argv.slice(2),
                deno: Deno.args,
            }));
        `);
        const kernelArgs = ['--env=prefix.env', '--preload=./prefix.cjs', '--conditions=prefix', '--require=./cli.cjs'];
        const scriptArgs = ['--require', 'script-only.cjs', '--inspect-wait', '--', ''];
        const result = await runCno(root, [
            ...kernelArgs, 'run', '--env-file=command.env', '--preload=./command.cjs',
            '--conditions=ignored', '--require=missing.cjs', '--inspect-wait=127.0.0.1:0',
            'main.cjs', ...scriptArgs,
        ]);
        deepStrictEqual(probe(result), {
            env: 'command', order: ['prefix', 'command', 'node preload', 'cli'],
            conditions: ['selected', 'selected', 'default'],
            execArgv: kernelArgs, argv: scriptArgs, deno: scriptArgs,
        });
        ok(!result.stderr.includes('Debugger listening'), result.stderr);
    });
});

Deno.test({ name: 'kernel options: eval preserves script argv and exact eval spelling', timeout: 15000 }, async () => {
    await withTempDir('kernel-eval-argv', async root => {
        await Deno.writeTextFile(join(root, 'preload.cjs'), 'globalThis.kernelPreloaded = true;\n');
        const code = `console.log('KERNEL_PROBE:' + JSON.stringify({
            argv: process.argv.slice(1), deno: Deno.args,
            execArgv: process.execArgv, preloaded: globalThis.kernelPreloaded,
        }))`;
        const kernelArgs = ['--require=./preload.cjs'];
        const scriptArgs = ['--inspect', '--require', 'user value', '--', ''];
        for (const evalArgs of [['eval', code], ['-e', code], [`--eval=${code}`]]) {
            const expectedEval = evalArgs[0] === 'eval' ? ['-e', code] : evalArgs;
            const result = await runCno(root, [...kernelArgs, ...evalArgs, ...scriptArgs]);
            deepStrictEqual(probe(result), {
                argv: scriptArgs, deno: scriptArgs,
                execArgv: [...kernelArgs, ...expectedEval], preloaded: true,
            });
        }
        for (const evalArgs of [['eval', ''], ['-e', ''], ['--eval=']]) {
            const empty = await runCno(root, evalArgs);
            strictEqual(empty.code, 0, empty.stdout + empty.stderr);
            strictEqual(empty.stdout, '');
        }
    });
});

Deno.test({ name: 'kernel options: test children preserve core options and isolate runner arguments', timeout: 15000 }, async () => {
    await withTempDir('kernel-test-child', async root => {
        await Deno.writeTextFile(join(root, 'preload.cjs'), 'globalThis.kernelPreloaded = (globalThis.kernelPreloaded ?? 0) + 1;\n');
        await Deno.writeTextFile(join(root, 'probe.test.ts'), `
            Deno.test('selected', () => {
                console.log('KERNEL_PROBE:' + JSON.stringify({
                    argv: process.argv.slice(2), deno: Deno.args,
                    execArgv: process.execArgv, preloaded: globalThis.kernelPreloaded,
                }));
            });
            Deno.test('unselected', () => { throw new Error('filter was lost'); });
        `);
        const kernelArgs = ['--conditions=prefix', '--require=./preload.cjs'];
        const scriptArgs = ['--filter=script-value', '--inspect', '--require', '--', ''];
        const result = await runCno(root, [
            ...kernelArgs, 'test', '--filter=/^selected$/', '--require=missing.cjs',
            '--inspect-wait=127.0.0.1:0', 'probe.test.ts', '--', ...scriptArgs,
        ]);
        deepStrictEqual(probe(result), {
            argv: scriptArgs, deno: scriptArgs, execArgv: kernelArgs, preloaded: 1,
        });
        ok(!result.stderr.includes('Debugger listening'), result.stderr);
    });
});

Deno.test({ name: 'kernel options: invalid NODE_OPTIONS fail before Inspector or user code starts', timeout: 15000 }, async () => {
    await withTempDir('kernel-invalid-node-options', async root => {
        for (const value of ['--filter=selected', '--cache-dir=cache', '--require', '-- --no-warnings']) {
            const result = await runCno(root, [
                '--inspect=127.0.0.1:0', 'eval', 'console.log("SHOULD_NOT_RUN")',
            ], { NODE_OPTIONS: value });
            ok(result.code !== 0, value + '\n' + result.stdout + result.stderr);
            ok(result.stderr.includes('NODE_OPTIONS'), result.stderr);
            ok(!result.stdout.includes('SHOULD_NOT_RUN'), result.stdout);
            ok(!result.stderr.includes('Debugger listening'), result.stderr);
        }
    });
});
