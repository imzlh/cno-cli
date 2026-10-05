import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { commandOptionTokensFor, missingFlagValues, parseArgv, parseNodeOptions, splitNodeOptions, tokenizeOptions, unknownFlags, unknownKernelFlags, unknownCommandFlags } from '../../src/cli.ts';
import { parseTestChildArgs } from '../../src/commands/test.ts';
import {
    basename,
    canonicalizePath,
    dirname,
    extname,
    hasLeadingSlashDrive,
    isRelative,
    joinPaths,
    normalizePath,
    pathRoot,
    toPosixPath,
} from '../../cts/src/utils/path.ts';
import { LRU } from '../../cts/src/utils/lru.ts';
import {
    cacheFilename,
    compareVersions,
    fmtBytes,
    hashString,
    latestVersion,
    matchLatestVersion,
    npmNameVersion,
    npmPackageName,
    parseArgs,
    safeParse,
    stripJsonc,
} from '../../cts/src/utils/misc.ts';

Deno.test('cli: run stops flag parsing after entry file', () => {
    const cli = parseArgv(['run', 'main.ts', '--user-flag', 'value']);
    strictEqual(cli.cmd, 'run');
    deepStrictEqual(cli.positional, ['main.ts', '--user-flag', 'value']);
    deepStrictEqual(cli.flags, {});
    strictEqual(cli.rawArgs.action, 'run');
    deepStrictEqual(cli.rawArgs.actionArgs, []);
    strictEqual(cli.rawArgs.entry, 'main.ts');
    deepStrictEqual(cli.rawArgs.args, ['--user-flag', 'value']);
});

Deno.test('cli: serve parses listener options and forwards entry arguments', () => {
    const cli = parseArgv([
        'serve', '--port', '3000', '--host', '127.0.0.1',
        'server.ts', '--port=script-argument', 'value',
    ]);
    strictEqual(cli.cmd, 'serve');
    strictEqual(cli.flags.port, '3000');
    strictEqual(cli.flags.host, '127.0.0.1');
    deepStrictEqual(cli.positional, ['server.ts', '--port=script-argument', 'value']);
    deepStrictEqual(unknownFlags(cli), []);
    strictEqual(cli.rawArgs.action, 'serve');
    strictEqual(cli.rawArgs.entry, 'server.ts');
    deepStrictEqual(cli.rawArgs.args, ['--port=script-argument', 'value']);
});

Deno.test('cli: implicit run keeps pre-entry runtime flags separate', () => {
    const cli = parseArgv(['--reload', 'script.ts', '--script-flag']);
    strictEqual(cli.cmd, null);
    strictEqual(cli.flags.reload, undefined);
    strictEqual(cli.kernelFlags.reload, true);
    deepStrictEqual(cli.positional, ['script.ts', '--script-flag']);
    strictEqual(cli.rawArgs.action, 'run');
    deepStrictEqual(cli.rawArgs.internalArgs, ['--reload']);
    deepStrictEqual(cli.rawArgs.actionArgs, []);
    strictEqual(cli.rawArgs.entry, 'script.ts');
    deepStrictEqual(cli.rawArgs.args, ['--script-flag']);
});

Deno.test('cli: inspect optional value consumes only port-like tokens', () => {
    const withPort = parseArgv(['--inspect', '9333', 'run', 'main.ts']);
    strictEqual(withPort.kernelFlags.inspect, '9333');
    deepStrictEqual(withPort.rawArgs.internalArgs, ['--inspect', '9333']);
    strictEqual(withPort.rawArgs.entry, 'main.ts');

    const withFile = parseArgv(['--inspect', 'main.ts']);
    strictEqual(withFile.kernelFlags.inspect, true);
    strictEqual(withFile.cmd, null);
    deepStrictEqual(withFile.rawArgs.internalArgs, ['--inspect']);
    deepStrictEqual(withFile.rawArgs.actionArgs, []);
    strictEqual(withFile.rawArgs.entry, 'main.ts');
});

Deno.test('cli: implicit run keeps Node preload flags in execArgv', () => {
    const cli = parseArgv([
        '--require', './preload.cjs',
        '--import=file:///loader.mjs',
        '--loader', './old-loader.mjs',
        '--reload',
        'main.ts',
        '--user',
    ]);
    strictEqual(cli.cmd, null);
    deepStrictEqual(cli.rawArgs.internalArgs, [
        '--require', './preload.cjs',
        '--import=file:///loader.mjs',
        '--loader', './old-loader.mjs',
        '--reload',
    ]);
    deepStrictEqual(cli.rawArgs.actionArgs, []);
    strictEqual(cli.rawArgs.entry, 'main.ts');
    deepStrictEqual(cli.rawArgs.args, ['--user']);
});

Deno.test('cli: missing Node flag values do not swallow the next option', () => {
    const cli = parseArgv(['run', '--require', '--reload', 'main.ts']);
    strictEqual(cli.flags.require, undefined);
    deepStrictEqual(cli.commandOptions[0], { name: 'require', value: true, tokens: ['--require'] });
    strictEqual(cli.flags.reload, true);
    deepStrictEqual(cli.rawArgs.internalArgs, []);
    deepStrictEqual(cli.rawArgs.actionArgs, ['--require', '--reload']);
    strictEqual(cli.rawArgs.entry, 'main.ts');
});

Deno.test('cli: explicit run keeps command flags out of kernel args', () => {
    const cli = parseArgv([
        '--memory-limit=20m',
        'run',
        '--require', './preload.cjs',
        '--reload',
        'main.ts',
    ]);
    deepStrictEqual(cli.rawArgs.internalArgs, ['--memory-limit=20m']);
    deepStrictEqual(cli.rawArgs.actionArgs, ['--require', './preload.cjs', '--reload']);
    deepStrictEqual(cli.rawArgs.args, []);
    deepStrictEqual(cli.kernelArgs, ['--memory-limit=20m']);
    deepStrictEqual(cli.commandArgs, ['--require', './preload.cjs', '--reload']);
    deepStrictEqual(cli.scriptArgs, []);
});

Deno.test('cli: kernel options in the command region are retained but inactive', () => {
    const cli = parseArgv(['run', '--inspect=9333', '--require', './preload.cjs', 'main.ts', '--inspect=script']);
    deepStrictEqual(cli.kernelArgs, []);
    deepStrictEqual(cli.commandArgs, ['--inspect=9333', '--require', './preload.cjs']);
    deepStrictEqual(cli.scriptArgs, ['--inspect=script']);
    deepStrictEqual(cli.flags, {});
    deepStrictEqual(cli.kernelFlags, {});
    deepStrictEqual(unknownFlags(cli), []);
});

Deno.test('cli: prefix command flags are not mixed into command args', () => {
    const cli = parseArgv(['--reload', 'run', '--inspect', 'main.ts']);
    deepStrictEqual(cli.kernelArgs, ['--reload']);
    deepStrictEqual(cli.commandArgs, ['--inspect']);
    deepStrictEqual(cli.rawArgs.actionArgs, ['--inspect']);
});

Deno.test('cli: value flags consume their value before the entry file', () => {
    const run = parseArgv(['run', '--config', 'deno.json', '--cache-dir', '.cache', 'main.ts', '--user']);
    strictEqual(run.cmd, 'run');
    strictEqual(run.flags.config, 'deno.json');
    strictEqual(run.flags['cache-dir'], '.cache');
    deepStrictEqual(run.positional, ['main.ts', '--user']);
    deepStrictEqual(run.rawArgs.actionArgs, ['--config', 'deno.json', '--cache-dir', '.cache']);
    strictEqual(run.rawArgs.entry, 'main.ts');
    deepStrictEqual(run.rawArgs.args, ['--user']);

    const test = parseArgv(['test', '--concurrency', '2', 'tests/cts']);
    strictEqual(test.cmd, 'test');
    strictEqual(test.flags.concurrency, '2');
    deepStrictEqual(test.positional, ['tests/cts']);
    deepStrictEqual(test.rawArgs.actionArgs, ['--concurrency', '2']);
});

Deno.test('cli: repeated Node conditions are preserved and -C requires a value', () => {
    const cli = parseArgv([
        '--conditions=development',
        '--conditions', 'custom',
        '-C', 'worker',
        '-C', 'browser',
        'run',
        'main.ts',
    ]);
    strictEqual(cli.kernelFlags.conditions, 'development,custom,worker,browser');
    deepStrictEqual(cli.flags, {});
    deepStrictEqual(missingFlagValues(cli), []);

    const missing = parseArgv(['run', '-C', '--no-lock', 'main.ts']);
    strictEqual(missing.commandOptions[0]?.value, true);
    deepStrictEqual(missingFlagValues(missing), ['conditions']);
});

Deno.test('cli: pack output flags work before and after the entry', () => {
    const short = parseArgv(['pack', 'main.ts', '-o', 'dist/app.jspack']);
    strictEqual(short.cmd, 'pack');
    strictEqual(short.flags.out, 'dist/app.jspack');
    deepStrictEqual(short.positional, ['main.ts']);

    const long = parseArgv(['pack', '--out=app.jspack', 'main.ts']);
    strictEqual(long.flags.out, 'app.jspack');
    deepStrictEqual(long.positional, ['main.ts']);

    const missing = parseArgv(['pack', 'main.ts', '-o', '--no-oxc']);
    strictEqual(missing.flags.out, true);
    strictEqual(missing.flags['no-oxc'], true);

    const dashEntry = parseArgv(['pack', '--', '--entry.ts']);
    deepStrictEqual(dashEntry.positional, ['--entry.ts']);
});

Deno.test('cli: run keeps repeated env and preload value flags before entry', () => {
    const cli = parseArgv([
        'run',
        '--env=base.env',
        '--env-file', 'override.env',
        '--preload', './preload.ts',
        '--preload=./second.ts',
        'main.ts',
    ]);
    strictEqual(cli.cmd, 'run');
    strictEqual(cli.flags.env, 'base.env');
    strictEqual(cli.flags['env-file'], 'override.env');
    strictEqual(cli.flags.preload, './second.ts');
    deepStrictEqual(cli.rawArgs.actionArgs, [
        '--env=base.env',
        '--env-file', 'override.env',
        '--preload', './preload.ts',
        '--preload=./second.ts',
    ]);
    strictEqual(cli.rawArgs.entry, 'main.ts');
});

Deno.test('cli: value flags can consume dash-prefixed non-option values', () => {
    const negative = parseArgv(['test', '--concurrency', '-1', 'tests/cts']);
    strictEqual(negative.flags.concurrency, '-1');
    ok(!('1' in negative.flags));
    deepStrictEqual(negative.rawArgs.actionArgs, ['--concurrency', '-1']);
    strictEqual(negative.rawArgs.entry, 'tests/cts');

    const dashPath = parseArgv(['run', '--cache-dir', '-cache', 'main.ts']);
    strictEqual(dashPath.flags['cache-dir'], '-cache');
    ok(!('cache' in dashPath.flags));
    deepStrictEqual(missingFlagValues(dashPath), []);
    deepStrictEqual(dashPath.rawArgs.actionArgs, ['--cache-dir', '-cache']);
    strictEqual(dashPath.rawArgs.entry, 'main.ts');

    const nextFlag = parseArgv(['run', '--config', '--no-lock', 'main.ts']);
    strictEqual(nextFlag.flags.config, true);
    strictEqual(nextFlag.flags['no-lock'], true);
    deepStrictEqual(nextFlag.rawArgs.actionArgs, ['--config', '--no-lock']);
    strictEqual(nextFlag.rawArgs.entry, 'main.ts');
});

Deno.test('cli: task arguments after the task name are forwarded verbatim', () => {
    const cli = parseArgv(['task', '--cwd', 'project', 'serve', '--host', '127.0.0.1', '--', '--debug']);
    strictEqual(cli.cmd, 'task');
    strictEqual(cli.flags.cwd, 'project');
    deepStrictEqual(cli.positional, ['serve', '--host', '127.0.0.1', '--', '--debug']);
    deepStrictEqual(cli.rawArgs.actionArgs, ['--cwd', 'project']);
    strictEqual(cli.rawArgs.entry, 'serve');
    deepStrictEqual(cli.rawArgs.args, ['--host', '127.0.0.1', '--', '--debug']);
});

Deno.test('cli: command-scoped help and version remain flags before a target', () => {
    const help = parseArgv(['test', '--help']);
    strictEqual(help.cmd, 'test');
    strictEqual(help.flags.help, true);
    deepStrictEqual(help.positional, []);

    const version = parseArgv(['run', '--version']);
    strictEqual(version.cmd, 'run');
    strictEqual(version.flags.version, true);
    deepStrictEqual(version.positional, []);
});

Deno.test('cli: option terminator stops cno flag parsing before entry', () => {
    const explicit = parseArgv(['run', '--no-lock', '--', 'main.ts', '--user-flag']);
    strictEqual(explicit.cmd, 'run');
    strictEqual(explicit.flags['no-lock'], true);
    deepStrictEqual(explicit.positional, ['main.ts', '--user-flag']);
    deepStrictEqual(explicit.rawArgs.actionArgs, ['--no-lock']);
    strictEqual(explicit.rawArgs.entry, 'main.ts');
    deepStrictEqual(explicit.rawArgs.args, ['--user-flag']);

    const implicit = parseArgv(['--reload', '--', '--dash-entry.ts', 'arg']);
    strictEqual(implicit.cmd, null);
    strictEqual(implicit.kernelFlags.reload, true);
    deepStrictEqual(implicit.positional, ['--dash-entry.ts', 'arg']);
    deepStrictEqual(implicit.rawArgs.internalArgs, ['--reload']);
    deepStrictEqual(implicit.rawArgs.actionArgs, []);
    strictEqual(implicit.rawArgs.entry, '--dash-entry.ts');
    deepStrictEqual(implicit.rawArgs.args, ['arg']);
});

Deno.test('cli: option terminator is preserved only for test script args', () => {
    const test = parseArgv(['test', 'tests/unit.test.ts', '--', '--case', 'one']);
    deepStrictEqual(test.positional, ['tests/unit.test.ts', '--', '--case', 'one']);

    const task = parseArgv(['task', '--', 'build']);
    deepStrictEqual(task.positional, ['build']);
    const exec = parseArgv(['exec', '--', 'tool']);
    deepStrictEqual(exec.positional, ['tool']);
    const cache = parseArgv(['cache', '--', 'main.ts']);
    deepStrictEqual(cache.positional, ['main.ts']);
});

Deno.test('cli: test child separates runner flags from script args without losing raw tokens', () => {
    const kernelArgs = ['--conditions=development', '--conditions', 'custom'];
    const commandArgs = [
        '--filter', 'selected',
        '--env=base.env',
        '--preload', './first.ts',
        '--env=override.env',
        '--preload=./second.ts',
        '-r',
        '--fail-fast',
    ];
    const scriptArgs = ['fixture', '--', '--filter=user-value', '--inspect', ''];
    const invocation = parseTestChildArgs(scriptArgs, JSON.stringify({ version: 1, kernelArgs, commandArgs }));
    deepStrictEqual(invocation.cli.flags, {
        filter: 'selected',
        env: 'override.env',
        preload: './second.ts',
        reload: true,
        'fail-fast': true,
    });
    deepStrictEqual(invocation.cli.kernelFlags, { conditions: 'development,custom' });
    deepStrictEqual(invocation.cli.kernelArgs, kernelArgs);
    deepStrictEqual(invocation.cli.commandArgs, commandArgs);
    deepStrictEqual(invocation.scriptArgs, scriptArgs);
});

Deno.test('cli: test child preserves command-prefix runtime flags', () => {
    const parent = parseArgv([
        '--conditions=development',
        '--inspect=127.0.0.1:0',
        'test',
        '--inspect-wait=127.0.0.1:9333',
        '--filter', 'selected',
        'example.test.ts',
    ]);
    const invocation = parseTestChildArgs([], JSON.stringify({
        version: 1,
        kernelArgs: parent.kernelArgs,
        commandArgs: parent.commandArgs,
    }));
    deepStrictEqual(invocation.cli.kernelFlags, {
        conditions: 'development',
        inspect: '127.0.0.1:0',
    });
    deepStrictEqual(invocation.cli.flags, { filter: 'selected' });
    deepStrictEqual(invocation.cli.kernelArgs, parent.kernelArgs);
    deepStrictEqual(invocation.cli.commandArgs, parent.commandArgs);
});

Deno.test('cli: test child rejects malformed protocols and tokens crossing argument regions', () => {
    for (const serialized of ['broken', 'null', JSON.stringify({ version: 1, kernelArgs: [], commandArgs: [1] })]) {
        throws(() => parseTestChildArgs([], serialized), /Invalid test child argument protocol/);
    }
    for (const regions of [
        { kernelArgs: ['run'], commandArgs: [] },
        { kernelArgs: ['--require'], commandArgs: [] },
        { kernelArgs: [], commandArgs: ['main.ts'] },
        { kernelArgs: [], commandArgs: ['--'] },
    ]) {
        throws(() => parseTestChildArgs([], JSON.stringify({ version: 1, ...regions })), /Invalid test child argument regions/);
    }
});

Deno.test('cli: exec keeps command args after option terminator', () => {
    const cli = parseArgv(['exec', 'prettier', '--', '--version']);
    strictEqual(cli.cmd, 'exec');
    deepStrictEqual(cli.positional, ['prettier', '--', '--version']);
    strictEqual(cli.rawArgs.entry, 'prettier');
    deepStrictEqual(cli.rawArgs.args, ['--', '--version']);
});

// `cno exec opencode --version` must forward --version to the bin, not treat
// it as cno's top-level version subcommand/flag (that left args empty → TUI).
Deno.test('cli: exec forwards flags after the binary name', () => {
    const cli = parseArgv(['exec', 'opencode', '--version']);
    strictEqual(cli.cmd, 'exec');
    deepStrictEqual(cli.positional, ['opencode', '--version']);
    strictEqual(cli.rawArgs.entry, 'opencode');
    deepStrictEqual(cli.rawArgs.args, ['--version']);
    strictEqual(cli.flags['version'], undefined);
});

Deno.test('cli: prefix runtime options are independent of the subcommand', () => {
    const before = parseArgv([
        '--memory-limit=20m', '--no-http', '--conditions=development',
        'exec', 'tool', '--user-flag',
    ]);
    strictEqual(before.cmd, 'exec');
    deepStrictEqual(unknownFlags(before), []);
    deepStrictEqual(before.positional, ['tool', '--user-flag']);
    deepStrictEqual(before.rawArgs.internalArgs, [
        '--memory-limit=20m', '--no-http', '--conditions=development',
    ]);
    deepStrictEqual(before.prefixArgs, [
        '--memory-limit=20m', '--no-http', '--conditions=development',
    ]);

    const commandScoped = parseArgv([
        'exec', '--memory-limit', '20m', '--max-stack-size=1MB',
        '--require', './preload.mjs', 'tool', '--version',
    ]);
    strictEqual(commandScoped.cmd, 'exec');
    deepStrictEqual(unknownFlags(commandScoped), []);
    deepStrictEqual(commandScoped.flags, {});
    deepStrictEqual(commandScoped.kernelFlags, {});
    deepStrictEqual(commandScoped.positional, ['tool', '--version']);
});

Deno.test('cli: prefix runtime options are accepted for every subcommand', () => {
    const commands = [
        ['run', 'entry.ts'],
        ['serve', 'entry.ts'],
        ['eval', '1 + 1'],
        ['cache', 'entry.ts'],
        ['pack', 'entry.ts'],
        ['repl'],
        ['exec', 'tool'],
        ['test', 'entry.test.ts'],
        ['setup'],
        ['task', 'build'],
    ];
    for (const args of commands) {
        const cli = parseArgv([
            '--memory-limit=20m', '--max-stack-size=1MB', '--no-http',
            ...args,
        ]);
        deepStrictEqual(unknownFlags(cli), [], args[0]);
        deepStrictEqual(cli.prefixFlags, ['memory-limit', 'max-stack-size', 'no-http'], args[0]);
    }
});

Deno.test('cli: command flags remain command-scoped when placed in the prefix', () => {
    deepStrictEqual(unknownFlags(parseArgv(['--filter=x', 'test', 'entry.test.ts'])), ['--filter']);
    deepStrictEqual(unknownFlags(parseArgv(['--out=x.jspack', 'pack', 'entry.ts'])), ['--out']);
    deepStrictEqual(unknownFlags(parseArgv(['--port=8000', 'run', 'entry.ts'])), ['--port']);
});

Deno.test('cli: eval aliases collect code as entry', () => {
    const short = parseArgv(['-e', 'console.log(1)']);
    strictEqual(short.cmd, 'eval');
    deepStrictEqual(short.positional, ['console.log(1)']);
    strictEqual(short.rawArgs.action, 'eval');
    strictEqual(short.rawArgs.entry, 'console.log(1)');
    deepStrictEqual(short.rawArgs.args, []);

    const long = parseArgv(['--eval', 'console.log(2)']);
    strictEqual(long.cmd, 'eval');
    strictEqual(long.rawArgs.entry, 'console.log(2)');

    const inline = parseArgv(['--eval=console.log(3)']);
    strictEqual(inline.cmd, 'eval');
    deepStrictEqual(inline.positional, ['console.log(3)']);
    deepStrictEqual(inline.flags, {});
    strictEqual(inline.rawArgs.action, 'eval');
    strictEqual(inline.rawArgs.entry, 'console.log(3)');
    deepStrictEqual(inline.rawArgs.args, []);

    const print = parseArgv(['-p', '1 + 1']);
    deepStrictEqual(print.rawArgs.evalToken, { flag: '-p', inline: false });

    const inlinePrint = parseArgv(['--print=1 + 2']);
    strictEqual(inlinePrint.cmd, 'eval');
    strictEqual(inlinePrint.flags.print, true);
    deepStrictEqual(inlinePrint.positional, ['1 + 2']);
    deepStrictEqual(inlinePrint.rawArgs.evalToken, { flag: '--print', inline: true });
});

Deno.test('cli: option terminator is never consumed as a value-flag value', () => {
    // Swallowing `--` loses the boundary AND assigns a nonsense value; deno and
    // node both reject it ("a value is required for '--config <FILE>'").
    const cacheDir = parseArgv(['run', '--cache-dir', '--', 'main.ts']);
    strictEqual(cacheDir.flags['cache-dir'], true);
    deepStrictEqual(cacheDir.positional, ['main.ts']);

    const filter = parseArgv(['test', '--filter', '--', 'a_test.ts']);
    strictEqual(filter.flags.filter, true);
    // `test` keeps the terminator so runTest can split roots from Deno.args.
    deepStrictEqual(filter.positional, ['--', 'a_test.ts']);

    const out = parseArgv(['pack', '-o', '--', 'main.ts']);
    strictEqual(out.flags.out, true);
    deepStrictEqual(out.positional, ['main.ts']);

    const require = parseArgv(['run', '--require', '--', 'main.ts']);
    strictEqual(require.flags.require, undefined);
    strictEqual(require.commandOptions[0]?.value, true);
    deepStrictEqual(require.positional, ['main.ts']);
});

Deno.test('cli: unknown flags are reported so a typo cannot exit 0', () => {
    // A misspelled flag used to print a warning and then run the program with
    // the intent silently dropped, exiting 0 — node exits 9 ("bad option") and
    // deno exits 1 ("unexpected argument"), so CI scored the typo as a pass.
    deepStrictEqual(unknownFlags(parseArgv(['run', '--frobnicate', 'main.ts'])), ['--frobnicate']);
    deepStrictEqual(unknownFlags(parseArgv(['run', '--frozenn', 'main.ts'])), ['--frozenn']);
    // Short flags are stored bare; they must be reported with one dash.
    deepStrictEqual(unknownFlags(parseArgv(['run', '-Z', 'main.ts'])), ['-Z']);

    // Real flags stay silent.
    deepStrictEqual(unknownFlags(parseArgv(['run', '--frozen', '--no-lock', 'main.ts'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['test', '--filter=t', '--fail-fast'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['run', '-r', '-q', '-A', 'main.ts'])), []);

    // Deno-compat no-ops are accepted silently: cno advertises deno
    // compatibility, so these must keep working unchanged.
    deepStrictEqual(unknownFlags(parseArgv(['run', '--allow-net', '--deny-env', 'main.ts'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['run', '--unstable-byonm', 'main.ts'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['run', '--allow-anything-at-all', 'main.ts'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['run', '--no-check', '--quiet', 'main.ts'])), []);

    // Tokens after the entry belong to the script, not to cno, so a flag the
    // program defines itself must not be rejected.
    deepStrictEqual(unknownFlags(parseArgv(['run', 'main.ts', '--script-own-flag'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['main.ts', '--script-own-flag'])), []);
    // `task` forwards everything after the task name.
    deepStrictEqual(unknownFlags(parseArgv(['task', 'build', '--task-own-flag'])), []);
    // Everything after `--` is the program's.
    deepStrictEqual(unknownFlags(parseArgv(['run', 'main.ts', '--', '--not-ours'])), []);
});

Deno.test('cli: value flags with no value are reported, not silently dropped', () => {
    // Every consumer type-guards on `string`, so `true` means the flag was
    // silently ignored — a typo like `cno test --filter --fail-fast` would run
    // the whole suite unfiltered and still exit 0.
    deepStrictEqual(missingFlagValues(parseArgv(['test', '--filter', '--fail-fast', 'a_test.ts'])), ['filter']);
    deepStrictEqual(missingFlagValues(parseArgv(['run', '--cache-dir', '--no-lock', 'main.ts'])), ['cache-dir']);
    deepStrictEqual(missingFlagValues(parseArgv(['run', '--config', '--', 'main.ts'])), ['config']);
    deepStrictEqual(missingFlagValues(parseArgv(['run', '--ext=', 'main.ts'])), ['ext']);

    // Values present, or flags whose bare form is meaningful, stay silent.
    deepStrictEqual(missingFlagValues(parseArgv(['test', '--filter=t', 'a_test.ts'])), []);
    deepStrictEqual(missingFlagValues(parseArgv(['run', '--cache-dir', '.cache', 'main.ts'])), []);
    deepStrictEqual(missingFlagValues(parseArgv(['run', '--reload', '--no-lock', 'main.ts'])), []);
    // pack prints its own `-o requires a file path`; task owns bare `--eval`.
    deepStrictEqual(missingFlagValues(parseArgv(['pack', 'main.ts', '-o', '--no-oxc'])), []);
    deepStrictEqual(missingFlagValues(parseArgv(['task', '--eval'])), []);
    // --inspect is legitimately bare.
    deepStrictEqual(missingFlagValues(parseArgv(['run', '--inspect', 'main.ts'])), []);
});

Deno.test('cli: all runtime commands share the same Inspector ownership', () => {
    for (const command of ['run', 'serve', 'test', 'task', 'exec', 'eval', 'repl']) {
        for (const inspect of ['--inspect', '--inspect-brk', '--inspect-wait']) {
            const cli = parseArgv([inspect + '=9333', command, inspect + '=9444', 'entry.ts']);
            deepStrictEqual(cli.kernelArgs, [inspect + '=9333'], command);
            deepStrictEqual(cli.commandArgs, [inspect + '=9444'], command);
            strictEqual(cli.kernelFlags[inspect.slice(2)], '9333', command);
            strictEqual(cli.flags[inspect.slice(2)], undefined, command);
            deepStrictEqual(unknownFlags(cli), [], command);
        }
    }
    const ipv6 = parseArgv(['--inspect', '[::1]:9333', 'run', 'main.ts']);
    strictEqual(ipv6.kernelFlags.inspect, '[::1]:9333');
    strictEqual(ipv6.rawArgs.entry, 'main.ts');
});

Deno.test('cli: regions preserve independent values and option occurrences', () => {
    const cli = parseArgv([
        '--cache-dir=kernel-cache', '--require', './first.cjs', '--require=./second.cjs',
        'run', '--cache-dir', 'command-cache', '--require=ignored.cjs', 'main.ts',
        '--inspect', '--require', 'script-value', '--',
    ]);
    strictEqual(cli.kernelFlags['cache-dir'], 'kernel-cache');
    strictEqual(cli.flags['cache-dir'], 'command-cache');
    deepStrictEqual(cli.kernelOptions.filter(option => option.name === 'require').map(option => option.value), ['./first.cjs', './second.cjs']);
    deepStrictEqual(cli.scriptArgs, ['--inspect', '--require', 'script-value', '--']);
    strictEqual(cli.flags.require, undefined);
    strictEqual(cli.kernelArgs, cli.rawArgs.kernelArgs);
    strictEqual(cli.commandArgs, cli.rawArgs.commandArgs);
    strictEqual(cli.scriptArgs, cli.rawArgs.scriptArgs);
});

Deno.test('cli: missing values are validated before a later occurrence can hide them', () => {
    const cli = parseArgv(['--require', '--require=valid.cjs', 'run', '--cache-dir=', '--cache-dir=valid', 'main.ts']);
    deepStrictEqual(missingFlagValues(cli), ['require', 'cache-dir']);
    const split = parseArgv(['--cache-dir', 'run', '--cache-dir=command-cache', 'main.ts']);
    // A bare word is a value, including a command name. The parser never guesses
    // that a value is really a command and silently changes ownership.
    strictEqual(split.kernelFlags['cache-dir'], 'command-cache');
    strictEqual(split.cmd, null);
});

Deno.test('cli: unknown flag diagnostics preserve their owning region', () => {
    const cli = parseArgv(['--filter=prefix', '--constructor', 'run', '--not-real=value', '--__proto__=value', 'entry.ts']);
    deepStrictEqual(unknownKernelFlags(cli), ['--filter', '--constructor']);
    deepStrictEqual(unknownCommandFlags(cli), ['--not-real', '--__proto__']);
    strictEqual(Object.getPrototypeOf(cli.flags), Object.prototype);
    strictEqual(cli.flags.__proto__, 'value');
    const invalidShort = parseArgv(['-inspect', 'run', 'entry.ts']);
    deepStrictEqual(unknownKernelFlags(invalidShort), ['-inspect']);
    strictEqual(invalidShort.kernelFlags.inspect, undefined);
});

Deno.test('cli: eval and aliases stop option parsing after source', () => {
    for (const invocation of [['eval', '42'], ['-e', '42'], ['--eval=42'], ['--print=42']]) {
        const cli = parseArgv([...invocation, '--inspect', '--require', 'x']);
        deepStrictEqual(cli.scriptArgs, ['--inspect', '--require', 'x']);
        deepStrictEqual(cli.kernelArgs, []);
        deepStrictEqual(cli.commandArgs, []);
        deepStrictEqual(unknownFlags(cli), []);
    }
});

Deno.test('cli: eval aliases consume dash-prefixed source and retain combined flag spelling', () => {
    for (const flag of ['-e', '-p', '-pe', '-ep']) {
        const cli = parseArgv([flag, '-1', '--inspect']);
        strictEqual(cli.cmd, 'eval');
        strictEqual(cli.rawArgs.entry, '-1');
        deepStrictEqual(cli.rawArgs.evalToken, { flag, inline: false });
        deepStrictEqual(cli.scriptArgs, ['--inspect']);
        deepStrictEqual(cli.kernelArgs, []);
        deepStrictEqual(cli.commandArgs, []);
    }
});

Deno.test('cli: multi-target commands keep their documented separator contract', () => {
    const test = parseArgv(['--conditions=test', 'test', 'one.test.ts', '--filter=selected', 'two.test.ts', '--', '--inspect', 'value']);
    deepStrictEqual(test.positional, ['one.test.ts', 'two.test.ts', '--', '--inspect', 'value']);
    deepStrictEqual(test.commandArgs, ['--filter=selected']);
    deepStrictEqual(test.scriptArgs, ['--inspect', 'value']);
    const cache = parseArgv(['cache', 'one.ts', '--no-oxc', 'two.ts']);
    deepStrictEqual(cache.positional, ['one.ts', 'two.ts']);
    deepStrictEqual(cache.scriptArgs, []);
});

Deno.test('cli: shared tokenizer preserves option-shaped values and Node short aliases', () => {
    deepStrictEqual(tokenizeOptions(['--require=--inspect', '-Cdev', '--inspect=9333']), [
        { name: 'require', value: '--inspect', tokens: ['--require=--inspect'] },
        { name: 'conditions', value: 'dev', tokens: ['-Cdev'] },
        { name: 'inspect', value: '9333', tokens: ['--inspect=9333'] },
    ]);
    deepStrictEqual(tokenizeOptions(['-r', './init.cjs', '-C=dev'], { nodeOptions: true }), [
        { name: 'require', value: './init.cjs', tokens: ['-r', './init.cjs'] },
        { name: 'conditions', value: 'dev', tokens: ['-C=dev'] },
    ]);
    deepStrictEqual(tokenizeOptions(['-r']), [{ name: 'reload', value: true, tokens: ['-r'] }]);
    deepStrictEqual(splitNodeOptions('--require "./space path.cjs" --conditions=dev'), ['--require', './space path.cjs', '--conditions=dev']);
    throws(() => splitNodeOptions('--require "unclosed'), /unterminated/);
});

Deno.test('cli: command forwarding selects registered command options without promoting kernel flags', () => {
    const cli = parseArgv(['test', '--cache-dir=cache', '--filter=selected', '--inspect=9333', '--require=ignored.cjs', '--reload', 'test.ts']);
    deepStrictEqual(commandOptionTokensFor(cli, 'run'), ['--cache-dir=cache', '--reload']);
    deepStrictEqual(commandOptionTokensFor(cli, 'cache'), ['--cache-dir=cache']);
});

Deno.test('cli: NODE_OPTIONS accepts core options and rejects commands and malformed input', () => {
    deepStrictEqual(parseNodeOptions('-r "./space path.cjs" -C=dev --no-warnings'), [
        { name: 'require', value: './space path.cjs', tokens: ['-r', './space path.cjs'] },
        { name: 'conditions', value: 'dev', tokens: ['-C=dev'] },
        { name: 'no-warnings', value: true, tokens: ['--no-warnings'] },
    ]);
    for (const value of [
        '--filter=selected', '--cache-dir=cache', '--help', '--eval=42',
        'main.ts', '-- --require=preload.cjs', '--unknown', '--allow-anything',
        '--require', '--require=', '--conditions --no-warnings',
    ]) {
        throws(() => parseNodeOptions(value), /NODE_OPTIONS/, value);
    }
});

Deno.test('cts path: normalizes separators and drive prefixes', () => {
    strictEqual(toPosixPath('a\\b\\c'), 'a/b/c');
    strictEqual(canonicalizePath('c:\\Users\\me'), 'C:/Users/me');
    strictEqual(hasLeadingSlashDrive('/c:/tmp'), true);
    strictEqual(hasLeadingSlashDrive('/tmp'), false);
    strictEqual(pathRoot('/tmp/a'), '/');
    strictEqual(pathRoot('D:\\tmp\\a'), 'D:/');
});

Deno.test('cts path: basename dirname extname and joins handle common edges', () => {
    strictEqual(basename('/tmp/file.ts', '.ts'), 'file');
    strictEqual(basename('/tmp/dir/'), 'dir');
    strictEqual(dirname('C:\\tmp\\file.ts'), 'C:/tmp');
    strictEqual(dirname('C:/file.ts'), 'C:/');
    strictEqual(dirname('file.ts'), '.');
    strictEqual(extname('.env'), '');
    strictEqual(extname('archive.tar.gz'), '.gz');
    strictEqual(joinPaths('/a/', '/b', 'c'), '/a/b/c');
    strictEqual(joinPaths('C:\\a', 'b'), 'C:/a/b');
});

Deno.test('cts path: normalizePath collapses dot segments without escaping roots', () => {
    strictEqual(normalizePath('/a/./b/../c'), '/a/c');
    strictEqual(normalizePath('a/../../b'), '../b');
    strictEqual(normalizePath('C:\\a\\..\\b'), 'C:/b');
    strictEqual(normalizePath('/../../x'), '/x');
    strictEqual(normalizePath('C:/cache//local/'), 'C:/cache/local');
    strictEqual(normalizePath('C:cache//local/'), 'C:cache/local');
    strictEqual(normalizePath('/cache//local/'), '/cache/local');
    strictEqual(normalizePath('https://example.test/a//b/'), 'https://example.test/a//b/');
    strictEqual(normalizePath('node:fs'), 'node:fs');
    strictEqual(normalizePath('npm:pkg//subpath'), 'npm:pkg//subpath');
});

Deno.test('cts path: normalizePath preserves UNC and device roots', () => {
    if (Deno.build.os !== 'windows') return;

    strictEqual(normalizePath('\\\\server\\share\\dir\\..'), '//server/share');
    strictEqual(normalizePath('\\\\?\\C:\\dir\\..'), '//?/C:');
    strictEqual(normalizePath('\\\\?\\UNC\\server\\share\\dir\\..'), '//?/UNC/server/share');
    strictEqual(normalizePath('\\\\.\\pipe\\cno'), '//./pipe/cno');
});

Deno.test('cts path: isRelative accepts only explicit relative specifiers', () => {
    for (const spec of ['.', '..', './x', '../x', '.\\x', '..\\x']) {
        ok(isRelative(spec), `${spec} should be relative`);
    }
    for (const spec of ['x', 'pkg/subpath', '/x', 'node:fs']) {
        ok(!isRelative(spec), `${spec} should not be relative`);
    }
});

Deno.test('cts LRU: get updates recency and set evicts least-recently-used', () => {
    const cache = new LRU<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    strictEqual(cache.get('a'), 1);
    cache.set('c', 3);
    strictEqual(cache.has('a'), true);
    strictEqual(cache.has('b'), false);
    strictEqual(cache.has('c'), true);

    cache.set('a', 11);
    cache.set('d', 4);
    strictEqual(cache.get('a'), 11);
    strictEqual(cache.has('c'), false);
    strictEqual(cache.size, 2);

    cache.delete('a');
    strictEqual(cache.has('a'), false);
    cache.clear();
    strictEqual(cache.size, 0);
});

Deno.test('cts misc: hash and cache filenames are stable', () => {
    strictEqual(hashString('hello'), '4f9f2cab');
    // Query is part of the identity key (path-only hash was '7b990bea').
    strictEqual(cacheFilename('https://example.test/a/b/mod.ts?x=1'), '353d30eb.ts');
    strictEqual(cacheFilename('https://example.test/a/b/mod.ts'), '7b990bea.ts');
    strictEqual(cacheFilename('https://example.test/pkg'), 'e0b5d81c.js');
    strictEqual(cacheFilename('not a url'), hashString('not a url'));
});

Deno.test('cts misc: bytes and semver matching cover common range forms', () => {
    strictEqual(fmtBytes(12), '12B');
    strictEqual(fmtBytes(1536), '1.5KB');
    ok(compareVersions('1.2.3', '1.2.4') < 0);
    ok(compareVersions('1.0.0', '1.0.0-beta') > 0);
    strictEqual(latestVersion(['1.0.0', '1.0.1-beta', '1.0.1']), '1.0.1');
    strictEqual(matchLatestVersion(['1.0.0', '1.2.0', '2.0.0'], '^1.0.0'), '1.2.0');
    strictEqual(matchLatestVersion(['0.1.0', '0.1.5', '0.2.0'], '^0.1.0'), '0.1.5');
    strictEqual(matchLatestVersion(['0.0.5', '0.4.0', '1.0.0'], '^0'), '0.4.0');
    strictEqual(matchLatestVersion(['0.0.5', '0.1.0'], '^0.0'), '0.0.5');
    strictEqual(matchLatestVersion(['0.0.3', '0.0.4'], '^0.0.3'), '0.0.3');
    strictEqual(matchLatestVersion(['1.2.0', '1.2.9', '1.3.0'], '1.2'), '1.2.9');
    strictEqual(matchLatestVersion(['1.5.0', '1.5.1', '2.0.0', '2.0.2'], '>= 1.5.0 < 2'), '1.5.1');
    strictEqual(matchLatestVersion(['19.2.7', '19.3.0-canary-a757cb76-20251002'], '^19.2.7'), '19.2.7');
    strictEqual(matchLatestVersion(['19.2.7', '19.3.0-canary-a757cb76-20251002'], '>=19.3.0-canary <20'), '19.3.0-canary-a757cb76-20251002');
    strictEqual(matchLatestVersion(['1.0.0'], '<1.0.0'), null);
});

Deno.test('cts misc: npm specPath parser handles scoped packages and subpaths', () => {
    deepStrictEqual(npmNameVersion('npm:left-pad@1.3.0'), { name: 'left-pad', version: '1.3.0' });
    deepStrictEqual(npmNameVersion('npm:@scope/pkg@2.0.1/sub/path'), { name: '@scope/pkg', version: '2.0.1' });
    strictEqual(npmPackageName('npm:@scope/pkg@2.0.1/sub/path'), '@scope/pkg');
    strictEqual(npmNameVersion('jsr:@scope/pkg@1.0.0'), null);
    strictEqual(npmNameVersion('npm:missing-version'), null);
});

Deno.test('cts misc: stripJsonc removes comments without touching strings', () => {
    const src = `{
        "url": "https://example.test//path",
        // remove this
        "text": "/* keep this */",
        "n": 1 /* remove this too */
    }`;
    const stripped = stripJsonc(src);
    ok(!stripped.includes('remove this'));
    deepStrictEqual(safeParse(stripped), {
        url: 'https://example.test//path',
        text: '/* keep this */',
        n: 1,
    });
});

Deno.test('cts misc: parseArgs handles long, short, inline and positional boundaries', () => {
    const parsed = parseArgs(
        ['--name', 'alice', '--count=3', '--flag=false', '-abc', 'entry.ts', '--raw'],
        { name: 'string', count: 'number', flag: 'boolean', a: 'boolean', b: 'boolean', c: 'boolean' },
    );
    strictEqual(parsed.name, 'alice');
    strictEqual(parsed.count, 3);
    strictEqual(parsed.flag, false);
    strictEqual(parsed.a, true);
    strictEqual(parsed.b, true);
    strictEqual(parsed.c, true);
    strictEqual(parsed._, 'entry.ts');
    deepStrictEqual(parsed._args, ['--raw']);
    strictEqual(parsed._offset, 6);

    const shortValue = parseArgs(['-p8080', '-o', 'out.txt'], { p: 'number', o: 'string' });
    strictEqual(shortValue.p, 8080);
    strictEqual(shortValue.o, 'out.txt');

    const unknown = parseArgs(['--debug=wire', '--loose'], {});
    strictEqual(unknown.debug, 'wire');
    strictEqual(unknown.loose, true);
});

Deno.test('cts misc: parseArgs preserves option boundaries and positional contract', () => {
    const parsed = parseArgs(['--silent', '--', '--script-flag', 'value'], { silent: 'boolean' });
    strictEqual(parsed.silent, true);
    strictEqual(parsed._, '--script-flag');
    deepStrictEqual(parsed._args, ['value']);
    strictEqual(parsed._offset, 3);

    const missingString = parseArgs(['--cache-dir', '--silent', 'entry.ts'], {
        'cache-dir': 'string',
        silent: 'boolean',
    });
    strictEqual(missingString['cache-dir'], undefined);
    strictEqual(missingString.silent, true);
    strictEqual(missingString._, 'entry.ts');
    deepStrictEqual(missingString._args, []);
    strictEqual(missingString._offset, 3);

    const negativeNumber = parseArgs(['--jsr-cache-ttl', '-2', 'entry.ts'], {
        'jsr-cache-ttl': 'number',
    });
    strictEqual(negativeNumber['jsr-cache-ttl'], -2);
    strictEqual(negativeNumber._, 'entry.ts');
    deepStrictEqual(negativeNumber._args, []);
    strictEqual(negativeNumber._offset, 3);
});

Deno.test('cli: value flags do not consume option-shaped tokens', () => {
    const unknownOption = parseArgv(['test', '--filter', '--not-a-cno-option', 'example.test.ts']);
    strictEqual(unknownOption.flags.filter, true);
    strictEqual(unknownOption.flags['not-a-cno-option'], true);
    deepStrictEqual(missingFlagValues(unknownOption), ['filter']);

    const terminator = parseArgv(['test', '--filter', '--', 'example.test.ts']);
    strictEqual(terminator.flags.filter, true);
    deepStrictEqual(terminator.positional, ['--', 'example.test.ts']);
    deepStrictEqual(missingFlagValues(terminator), ['filter']);

    const negative = parseArgv(['test', '--concurrency', '-2']);
    strictEqual(negative.flags.concurrency, '-2');
    deepStrictEqual(missingFlagValues(negative), []);
});

Deno.test('cli: eval aliases treat their next token as source without flag reinterpretation', () => {
    const shortAlias = parseArgv(['-e', '--quiet']);
    strictEqual(shortAlias.cmd, 'eval');
    deepStrictEqual(shortAlias.positional, ['--quiet']);
    deepStrictEqual(shortAlias.flags, {});

    const longAlias = parseArgv(['--eval', '--', '-1']);
    strictEqual(longAlias.cmd, 'eval');
    strictEqual(longAlias.rawArgs.entry, '--');
    deepStrictEqual(longAlias.scriptArgs, ['-1']);
    deepStrictEqual(unknownFlags(longAlias), []);
});
