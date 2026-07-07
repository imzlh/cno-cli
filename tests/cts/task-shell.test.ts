import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { LockStore } from '../../cts/src/lock.ts';
import { parseShellCommand, isShellOperator, resolveUnixBinEntry, resolveWinBinEntry } from '../../cts/src/shell.ts';
import { planLifecycleScript, resolveLifecycleCommandArgv, runLifecyclePlan, type LifecycleCommand } from '../../cts/src/runtime/lifecycle.ts';
import { loadTasks } from '../../cts/src/task.ts';
import { cwd, joinPaths, normalizePath } from '../../cts/src/utils/path.ts';
import { entryAndDir } from '../../src/utils.ts';
import { decodeUtf8 } from '../_helpers/bytes.ts';

async function runCnoTask(args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(execPath, {
        args,
        cwd,
        stdout: 'piped',
        stderr: 'piped',
        env: {
            CTS_SILENT: 'true',
            ...env,
        },
    }).output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

Deno.test('cts shell: parser preserves quoted operators and segment operators', () => {
    const segments = parseShellCommand(`echo "a && b" && deno run --allow-net main.ts "x y" || echo done; node script.js`);
    deepStrictEqual(segments, [
        { bin: 'echo', args: ['a && b'], op: '&&' },
        { bin: 'deno', args: ['run', '--allow-net', 'main.ts', 'x y'], op: '||' },
        { bin: 'echo', args: ['done'], op: ';' },
        { bin: 'node', args: ['script.js'] },
    ]);
});

Deno.test('cts shell: parser handles escapes, pipes and background separators', () => {
    const segments = parseShellCommand(String.raw`cmd a\ b 'c d' | tee out & cleanup`);
    deepStrictEqual(segments, [
        { bin: 'cmd', args: ['a b', 'c d'], op: '|' },
        { bin: 'tee', args: ['out'], op: '&' },
        { bin: 'cleanup', args: [] },
    ]);
    for (const op of ['&&', '||', ';', '|', '&']) ok(isShellOperator(op));
    ok(!isShellOperator('echo'));
});

Deno.test('cts lifecycle: plans node fallback scripts without shelling the whole command', () => {
    const plan = planLifecycleScript('node scripts/prebuild.js || node-gyp rebuild', {
        exePath: '/bin/cno',
        shell: 'sh',
        shellArg: '-c',
    });

    strictEqual(plan.fallback, false);
    deepStrictEqual(plan.commands, [
        { argv: ['/bin/cno', 'run', 'scripts/prebuild.js'], op: '||' },
        { argv: ['node-gyp', 'rebuild'] },
    ]);
});

Deno.test('cts lifecycle: keeps single non-node and shell-only syntax on shell fallback', () => {
    const single = planLifecycleScript('prebuild-install --runtime napi', {
        exePath: '/bin/cno',
        shell: 'sh',
        shellArg: '-c',
    });
    strictEqual(single.fallback, true);
    deepStrictEqual(single.commands, [
        { argv: ['sh', '-c', 'prebuild-install --runtime napi'] },
    ]);

    const redirected = planLifecycleScript('node build.js > out.txt', {
        exePath: '/bin/cno',
        shell: 'sh',
        shellArg: '-c',
    });
    strictEqual(redirected.fallback, true);
    deepStrictEqual(redirected.commands, [
        { argv: ['sh', '-c', 'node build.js > out.txt'] },
    ]);

    const piped = planLifecycleScript('node build.js | tee out.txt', {
        exePath: '/bin/cno',
        shell: 'sh',
        shellArg: '-c',
    });
    strictEqual(piped.fallback, true);
    deepStrictEqual(piped.commands, [
        { argv: ['sh', '-c', 'node build.js | tee out.txt'] },
    ]);
});

Deno.test('cts lifecycle: resolves fallback bins without touching shell or path commands', () => {
    const resolveBin = (name: string) => name === 'node-gyp' ? '/cache/npm/node-gyp@11/bin/node-gyp.js' : null;

    deepStrictEqual(
        resolveLifecycleCommandArgv(['node-gyp', 'rebuild'], resolveBin),
        ['/cache/npm/node-gyp@11/bin/node-gyp.js', 'rebuild'],
    );
    deepStrictEqual(
        resolveLifecycleCommandArgv(['sh', '-c', 'node build.js > out.txt'], resolveBin),
        ['sh', '-c', 'node build.js > out.txt'],
    );
    deepStrictEqual(
        resolveLifecycleCommandArgv(['./node-gyp', 'rebuild'], resolveBin),
        ['./node-gyp', 'rebuild'],
    );
});

Deno.test('cts lifecycle: executes && || ; with shell-compatible short-circuiting', async () => {
    const calls: string[] = [];
    const run = (codes: Record<string, number>) => {
        calls.length = 0;
        return (command: LifecycleCommand): Promise<number> => {
            const name = command.argv[0] ?? '';
            calls.push(name);
            return Promise.resolve(codes[name] ?? 0);
        };
    };

    strictEqual(await runLifecyclePlan({
        fallback: false,
        commands: [
            { argv: ['prebuild'], op: '||' },
            { argv: ['node-gyp'] },
        ],
    }, run({ prebuild: 1, 'node-gyp': 0 })), 0);
    deepStrictEqual(calls, ['prebuild', 'node-gyp']);

    strictEqual(await runLifecyclePlan({
        fallback: false,
        commands: [
            { argv: ['prebuild'], op: '||' },
            { argv: ['node-gyp'] },
        ],
    }, run({ prebuild: 0, 'node-gyp': 1 })), 0);
    deepStrictEqual(calls, ['prebuild']);

    strictEqual(await runLifecyclePlan({
        fallback: false,
        commands: [
            { argv: ['prepare'], op: '&&' },
            { argv: ['build'] },
        ],
    }, run({ prepare: 1, build: 0 })), 1);
    deepStrictEqual(calls, ['prepare']);

    strictEqual(await runLifecyclePlan({
        fallback: false,
        commands: [
            { argv: ['cleanup'], op: ';' },
            { argv: ['build'] },
        ],
    }, run({ cleanup: 1, build: 0 })), 0);
    deepStrictEqual(calls, ['cleanup', 'build']);
});

Deno.test('cts shell: unix bin resolver accepts direct node shebang scripts', () => {
    const root = makePosixTempDir('unix-direct-bin');
    try {
        const script = joinPaths(root, 'cli.js');
        writeFileSync(script, '#!/usr/bin/env node\nconsole.log("ok");\n');
        strictEqual(resolveUnixBinEntry(script), script);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts shell: unix bin resolver extracts basedir-relative JS entry', () => {
    const root = makePosixTempDir('unix-wrapper-bin');
    try {
        const shim = joinPaths(root, 'node_modules', '.bin', 'vite');
        const entry = joinPaths(root, 'node_modules', 'vite', 'bin', 'vite.js');
        mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
        mkdirSync(join(root, 'node_modules', 'vite', 'bin'), { recursive: true });
        writeFileSync(entry, 'console.log("vite");\n');
        writeFileSync(shim, [
            '#!/bin/sh',
            'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
            'exec "$basedir/../vite/bin/vite.js" "$@"',
            '',
        ].join('\n'));

        strictEqual(resolveUnixBinEntry(shim), normalizePath(entry));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts shell: windows bin resolver extracts dp0-relative JS entry', () => {
    const root = makePosixTempDir('win-wrapper-bin');
    try {
        const shim = joinPaths(root, 'node_modules', '.bin', 'tool.cmd');
        const entry = joinPaths(root, 'node_modules', 'tool', 'bin', 'tool.js');
        mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
        mkdirSync(join(root, 'node_modules', 'tool', 'bin'), { recursive: true });
        writeFileSync(entry, 'console.log("tool");\n');
        writeFileSync(shim, '@ECHO off\r\n"%dp0%\\..\\tool\\bin\\tool.js" %*\r\n');

        strictEqual(resolveWinBinEntry(shim), normalizePath(entry));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts task: loadTasks merges package scripts and deno task overrides', () => {
    const root = makePosixTempDir('load-tasks');
    try {
        const subdir = joinPaths(root, 'src', 'nested');
        mkdirSync(join(root, 'src', 'nested'), { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({
            scripts: {
                build: 'node build.js',
                test: 'node test.js',
            },
        }));
        writeFileSync(join(root, 'deno.jsonc'), `{
            // deno tasks override package scripts
            "tasks": {
                "test": "deno run test.ts",
                "dev": { "command": "deno run dev.ts", "dependencies": ["build"] }
            }
        }`);

        const loaded = loadTasks(subdir, new LockStore(root, true));
        ok(loaded);
        strictEqual(loaded.configPath, joinPaths(root, 'deno.jsonc'));
        strictEqual(loaded.runner.has('build'), true);
        strictEqual(loaded.runner.has('test'), true);
        strictEqual(loaded.runner.has('dev'), true);
        strictEqual(loaded.runner.has('missing'), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({
    name: 'cts task: shell fallback appends extra args without expansion',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const root = makePosixTempDir('task-shell-extra-args');
        const lock = new LockStore(root, true);
        try {
            writeFileSync(join(root, 'deno.json'), JSON.stringify({
                tasks: {
                    echo: 'echo 1 > args.txt',
                },
            }));

            const loaded = loadTasks(root, lock);
            ok(loaded);
            strictEqual(await loaded.runner.run('echo', ['$(echo 5)', 'two words']), 0);
            strictEqual(readFileSync(join(root, 'args.txt'), 'utf8'), '1 $(echo 5) two words\n');
        } finally {
            lock.close();
            rmSync(root, { recursive: true, force: true });
        }
    },
});

Deno.test({
    name: 'cts task: package scripts run pre/post but deno tasks do not',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const pkgRoot = makePosixTempDir('task-package-prepost');
        const pkgLock = new LockStore(pkgRoot, true);
        try {
            writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
                scripts: {
                    pretest: 'echo pre >> order.txt',
                    test: 'echo test >> order.txt',
                    posttest: 'echo post >> order.txt',
                },
            }));

            const loaded = loadTasks(pkgRoot, pkgLock);
            ok(loaded);
            strictEqual(await loaded.runner.run('test'), 0);
            strictEqual(readFileSync(join(pkgRoot, 'order.txt'), 'utf8'), 'pre\ntest\npost\n');
        } finally {
            pkgLock.close();
            rmSync(pkgRoot, { recursive: true, force: true });
        }

        const denoRoot = makePosixTempDir('task-deno-no-prepost');
        const denoLock = new LockStore(denoRoot, true);
        try {
            writeFileSync(join(denoRoot, 'deno.json'), JSON.stringify({
                tasks: {
                    pretest: 'echo pre >> order.txt',
                    test: 'echo test >> order.txt',
                    posttest: 'echo post >> order.txt',
                },
            }));

            const loaded = loadTasks(denoRoot, denoLock);
            ok(loaded);
            strictEqual(await loaded.runner.run('test'), 0);
            strictEqual(readFileSync(join(denoRoot, 'order.txt'), 'utf8'), 'test\n');
        } finally {
            denoLock.close();
            rmSync(denoRoot, { recursive: true, force: true });
        }
    },
});

Deno.test({
    name: 'cts task: dependencies dedupe diamond graphs and reject cycles',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const root = makePosixTempDir('task-diamond-deps');
        const lock = new LockStore(root, true);
        try {
            writeFileSync(join(root, 'deno.jsonc'), `{
                // a depends on b and c; both depend on d, which should run once.
                "tasks": {
                    "a": { "command": "echo a >> order.txt", "dependencies": ["b", "c"] },
                    "b": { "command": "echo b >> order.txt", "dependencies": ["d"] },
                    "c": { "command": "echo c >> order.txt", "dependencies": ["d"] },
                    "d": "echo d >> order.txt"
                }
            }`);

            const loaded = loadTasks(root, lock);
            ok(loaded);
            strictEqual(await loaded.runner.run('a'), 0);
            strictEqual(readFileSync(join(root, 'order.txt'), 'utf8'), 'd\nb\nc\na\n');
        } finally {
            lock.close();
            rmSync(root, { recursive: true, force: true });
        }

        const cycleRoot = makePosixTempDir('task-cycle-deps');
        const cycleLock = new LockStore(cycleRoot, true);
        try {
            writeFileSync(join(cycleRoot, 'deno.jsonc'), `{
                "tasks": {
                    "a": { "command": "echo a >> order.txt", "dependencies": ["a"] }
                }
            }`);

            const loaded = loadTasks(cycleRoot, cycleLock);
            ok(loaded);
            strictEqual(await loaded.runner.run('a'), 1);
        } finally {
            cycleLock.close();
            rmSync(cycleRoot, { recursive: true, force: true });
        }
    },
});

Deno.test({
    name: 'cts task: shell-only syntax runs through platform shell',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const root = makePosixTempDir('task-shell-fallback');
        const lock = new LockStore(root, true);
        try {
            writeFileSync(join(root, 'deno.json'), JSON.stringify({
                tasks: {
                    pipe: 'printf shell-ok | cat > shell-out.txt',
                },
            }));

            const loaded = loadTasks(root, lock);
            ok(loaded);
            strictEqual(await loaded.runner.run('pipe'), 0);
            strictEqual(readFileSync(join(root, 'shell-out.txt'), 'utf8'), 'shell-ok');
        } finally {
            lock.close();
            rmSync(root, { recursive: true, force: true });
        }
    },
});

Deno.test({
    name: 'cts task: shell fallback propagates exit codes and unknown tasks fail',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const root = makePosixTempDir('task-exit-codes');
        const lock = new LockStore(root, true);
        try {
            writeFileSync(join(root, 'deno.json'), JSON.stringify({
                tasks: {
                    fail5: 'printf "10\\n" && exit 5',
                },
            }));

            const loaded = loadTasks(root, lock);
            ok(loaded);
            strictEqual(await loaded.runner.run('fail5'), 5);
            strictEqual(await loaded.runner.run('missing'), 1);
        } finally {
            lock.close();
            rmSync(root, { recursive: true, force: true });
        }
    },
});

Deno.test({
    name: 'cts task: INIT_CWD defaults to invocation directory and preserves existing env',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const root = makePosixTempDir('task-init-cwd');
        const subdir = joinPaths(root, 'nested');
        const lock = new LockStore(root, true);
        try {
            mkdirSync(join(subdir), { recursive: true });
            writeFileSync(join(root, 'deno.json'), JSON.stringify({
                tasks: {
                    init: 'printf "$INIT_CWD" > init.txt',
                    pwd: 'pwd > pwd.txt',
                    override: {
                        command: 'printf "$INIT_CWD" > override.txt',
                        env: { INIT_CWD: 'TASK_ENV' },
                    },
                },
            }));

            const loaded = loadTasks(subdir, lock);
            ok(loaded);
            strictEqual(await loaded.runner.run('init'), 0);
            strictEqual(await loaded.runner.run('pwd'), 0);
            strictEqual(await loaded.runner.run('override'), 0);
            strictEqual(readFileSync(join(root, 'init.txt'), 'utf8'), subdir);
            strictEqual(normalizePath(readFileSync(join(root, 'pwd.txt'), 'utf8').trim()), root);
            strictEqual(readFileSync(join(root, 'override.txt'), 'utf8'), 'TASK_ENV');

            const previous = Deno.env.get('INIT_CWD');
            try {
                Deno.env.set('INIT_CWD', 'EXISTING_INIT');
                const inherited = makePosixTempDir('task-init-cwd-existing');
                const inheritedLock = new LockStore(inherited, true);
                try {
                    writeFileSync(join(inherited, 'deno.json'), JSON.stringify({
                        tasks: { init: 'printf "$INIT_CWD" > init.txt' },
                    }));
                    const inheritedTasks = loadTasks(inherited, inheritedLock);
                    ok(inheritedTasks);
                    strictEqual(await inheritedTasks.runner.run('init'), 0);
                    strictEqual(readFileSync(join(inherited, 'init.txt'), 'utf8'), 'EXISTING_INIT');
                } finally {
                    inheritedLock.close();
                    rmSync(inherited, { recursive: true, force: true });
                }
            } finally {
                if (previous === undefined) Deno.env.delete('INIT_CWD');
                else Deno.env.set('INIT_CWD', previous);
            }
        } finally {
            lock.close();
            rmSync(root, { recursive: true, force: true });
        }
    },
});

Deno.test({
    name: 'cts task cli: --config and --cwd split config lookup from execution cwd',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const root = makePosixTempDir('task-cli-cwd');
        const specDir = joinPaths(root, 'spec');
        try {
            mkdirSync(join(specDir), { recursive: true });
            writeFileSync(join(specDir, 'deno.json'), JSON.stringify({
                tasks: {
                    pwd: 'pwd',
                    init: 'printf "$INIT_CWD"',
                    fail5: 'printf "10\\n" && exit 5',
                },
            }));

            const pwd = await runCnoTask(['task', '-q', '--config', 'deno.json', '--cwd', '..', 'pwd'], specDir);
            strictEqual(pwd.code, 0, pwd.stderr);
            strictEqual(normalizePath(pwd.stdout.trim()), root);

            const runPwd = await runCnoTask(['run', '-q', '--config', 'deno.json', '--cwd', '..', 'pwd'], specDir);
            strictEqual(runPwd.code, 0, runPwd.stderr);
            strictEqual(normalizePath(runPwd.stdout.trim()), root);

            const init = await runCnoTask(['task', '-q', '--config', 'deno.json', '--cwd', '..', 'init'], specDir);
            strictEqual(init.code, 0, init.stderr);
            strictEqual(normalizePath(init.stdout.trim()), specDir);

            const inherited = await runCnoTask(['task', '-q', '--config', 'deno.json', 'init'], specDir, { INIT_CWD: 'HELLO' });
            strictEqual(inherited.code, 0, inherited.stderr);
            strictEqual(inherited.stdout.trim(), 'HELLO');

            const fail = await runCnoTask(['task', '-q', '--config', 'deno.json', 'fail5'], specDir);
            strictEqual(fail.code, 5);
            ok(fail.stdout.includes('10'), fail.stdout);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
});

Deno.test('cli utils: entryAndDir resolves relative, absolute and protocol targets', () => {
    const rel = entryAndDir('tests/cts/loader.test.ts');
    strictEqual(rel.entry, normalizePath(joinPaths(cwd(), 'tests/cts/loader.test.ts')));
    strictEqual(rel.dir, normalizePath(joinPaths(cwd(), 'tests/cts')));

    const abs = entryAndDir('/tmp/example.ts');
    strictEqual(abs.entry, '/tmp/example.ts');
    strictEqual(abs.dir, '/tmp');

    const remote = entryAndDir('https://example.test/mod.ts');
    strictEqual(remote.entry, 'https://example.test/mod.ts');
    strictEqual(remote.dir, cwd());
});
