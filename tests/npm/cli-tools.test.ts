import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';

function cacheDir(): string | undefined {
    try {
        return Deno.env.get('CTS_CACHE_DIR') || undefined;
    } catch {
        return undefined;
    }
}

async function runCno(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return runCnoWithTimeout(args);
}

async function runCnoWithTimeout(args: string[], timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }> {
    const dir = cacheDir();
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const command = new Deno.Command(execPath, {
        args: dir ? [`--cache-dir=${dir}`, ...args] : args,
        stdout: 'piped',
        stderr: 'piped',
        env: dir ? { CTS_CACHE_DIR: dir } : undefined,
    });
    const output = timeoutMs === undefined
        ? await command.output()
        : await (async () => {
            const child = command.spawn();
            const timeoutId = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch {}
            }, timeoutMs);
            try {
                return await child.output();
            } finally {
                clearTimeout(timeoutId);
            }
        })();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

Deno.test({ name: 'prettier: formats source through parser plugins', timeout: 60000 }, async () => {
    const prettier = await import('npm:prettier');
    const formatted = await prettier.format('const x={a:1}\n', {
        parser: 'babel',
        singleQuote: true,
    });
    strictEqual(formatted, 'const x = { a: 1 };\n');
});

Deno.test({ name: 'prettier bin: cno exec runs CJS CLI dynamic import path', timeout: 60000 }, async () => {
    await import('npm:prettier');

    const result = await runCno(['exec', 'prettier', '--', '--version']);
    strictEqual(result.code, 0, result.stderr);
    ok(/^3\.\d+\.\d+/.test(result.stdout.trim()), result.stdout);
});

Deno.test({ name: 'eslint: lints text through config and parser stack', timeout: 60000 }, async () => {
    const eslintMod = await import('npm:eslint');
    const eslint = new eslintMod.ESLint({
        overrideConfigFile: true,
        overrideConfig: {
            languageOptions: { ecmaVersion: 2022 },
            rules: { semi: ['error', 'always'] },
        },
    });

    const [result] = await eslint.lintText('const x = 1\n', { filePath: 'input.js' });
    strictEqual(result.messages.length, 1);
    strictEqual(result.messages[0].ruleId, 'semi');
});

Deno.test({ name: 'eslint bin: cno exec runs package binary with forwarded args', timeout: 60000 }, async () => {
    await import('npm:eslint');

    const result = await runCno(['exec', 'eslint', '--', '--version']);
    strictEqual(result.code, 0, result.stderr);
    ok(/\bv\d+\.\d+\.\d+\b/.test(result.stdout), result.stdout);
});

Deno.test({ name: 'typescript bin: cno exec resolves tsc and strips arg separator', timeout: 120000 }, async () => {
    const ts = await import('npm:typescript');
    const dir = await Deno.makeTempDir({ prefix: 'cno-tsc-' });
    try {
        await Deno.writeTextFile(join(dir, 'index.ts'), 'const value: number = 1;\n');

        const version = await runCno(['exec', 'tsc', '--', '--version']);
        strictEqual(version.code, 0, version.stderr);
        ok(version.stdout.includes(ts.version), version.stdout);

        const check = await runCno(['exec', 'tsc', '--', '--noEmit', '--ignoreConfig', '--target', 'es2022', join(dir, 'index.ts')]);
        strictEqual(check.code, 0, check.stderr);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test({ name: 'tsx bin: executes TypeScript through IPC preflight and exits', timeout: 60000 }, async () => {
    await import('npm:tsx');
    const dir = await Deno.makeTempDir({ prefix: 'cno-tsx-' });
    try {
        const script = join(dir, 'app.ts');
        await Deno.writeTextFile(script, 'console.log("tsx-run-ok", 21 * 2)\n');

        const result = await runCnoWithTimeout(['exec', 'tsx', '--', script], 15000);
        strictEqual(result.code, 0, result.stderr || result.stdout);
        ok(result.stdout.includes('tsx-run-ok 42'), result.stdout);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test({ name: 'node preload flag: --require runs before the entry script', timeout: 60000 }, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'cno-preload-' });
    try {
        const preload = join(dir, 'preload.cjs');
        const main = join(dir, 'main.js');
        await Deno.writeTextFile(preload, 'globalThis.__cnoPreloaded = "ready";\n');
        await Deno.writeTextFile(main, [
            'console.log(JSON.stringify({',
            '  preloaded: globalThis.__cnoPreloaded,',
            '  argv: process.argv,',
            '  execArgv: process.execArgv',
            '}));',
        ].join('\n'));

        const result = await runCno(['--require', preload, main, 'arg1']);
        strictEqual(result.code, 0, result.stderr);
        const payload = JSON.parse(result.stdout.trim());
        strictEqual(payload.preloaded, 'ready');
        deepStrictEqual(payload.argv.slice(1), [main, 'arg1']);
        deepStrictEqual(payload.execArgv, ['--require', preload]);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test({ name: 'commander and yargs: parse argv arrays with typed options', timeout: 30000 }, async () => {
    const { Command } = await import('npm:commander');
    const yargsMod = await import('npm:yargs/yargs');
    const yargs = yargsMod.default ?? yargsMod;

    const program = new Command();
    program
        .exitOverride()
        .option('-n, --name <name>')
        .option('-c, --count <count>', 'count value', (value: string) => Number(value), 0)
        .parse(['node', 'probe', '--name', 'cno', '--count', '3']);

    strictEqual(program.opts().name, 'cno');
    strictEqual(program.opts().count, 3);

    const argv = yargs(['--port', '8080', '--flag'])
        .option('port', { type: 'number' })
        .boolean('flag')
        .parseSync();

    strictEqual(argv.port, 8080);
    strictEqual(argv.flag, true);
});
