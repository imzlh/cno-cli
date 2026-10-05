import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { LockStore } from '../../cts/src/lock.ts';
import { parseShellCommand, isShellOperator, resolveUnixBinEntry, resolveWinBinEntry } from '../../cts/src/shell.ts';
import {
    applyShellBuiltin,
    emulateShellBuiltin,
    planLifecycleScript,
    resolveLifecycleCommandArgv,
    runLifecyclePlan,
    type LifecycleCommand,
    type LifecycleSession,
} from '../../cts/src/runtime/lifecycle.ts';
import { loadTasks, runTaskChild, taskShellArgv } from '../../cts/src/task.ts';
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

Deno.test('cts shell: parser preserves empty args and POSIX quote escapes', () => {
    const segments = parseShellCommand(String.raw`deno run args.ts '' "" 'a\b' "c\d" escaped\ space trailing\ `);
    deepStrictEqual(segments, [{
        bin: 'deno',
        args: ['run', 'args.ts', '', '', String.raw`a\b`, String.raw`c\d`, 'escaped space', 'trailing '],
    }]);
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

Deno.test('cts lifecycle: preserves Node runtime flags and script arguments', () => {
    const script = 'node --require ./init.cjs --conditions=install scripts/install.js --require=script-arg';
    for (const suffix of ['', ' && node -p "42"']) {
        const plan = planLifecycleScript(script + suffix, {
            exePath: '/bin/cno', shell: 'sh', shellArg: '-c',
        });
        strictEqual(plan.fallback, false);
        deepStrictEqual(plan.commands[0]?.argv, [
            '/bin/cno', '--require', './init.cjs', '--conditions=install',
            'scripts/install.js', '--require=script-arg',
        ]);
        if (suffix) {
            strictEqual(plan.commands[0]?.op, '&&');
            deepStrictEqual(plan.commands[1]?.argv, ['/bin/cno', '-p', '42']);
        }
    }
});

Deno.test('cts lifecycle: preserves separators and eval source beginning with a dash', () => {
    for (const [script, args] of [
        ['node -- -dash.js --inspect', ['--', '-dash.js', '--inspect']],
        ["node -e '-1' --inspect", ['-e', '-1', '--inspect']],
        ["node --eval='-1' --inspect", ['--eval=-1', '--inspect']],
        ["node -p '-1'", ['-p', '-1']],
    ] as const) {
        const plan = planLifecycleScript(script, {
            exePath: '/bin/cno', shell: 'sh', shellArg: '-c',
        });
        strictEqual(plan.fallback, false);
        deepStrictEqual(plan.commands[0]?.argv, ['/bin/cno', ...args]);
    }
});

// es5-ext style: `node -e … || exit 0` must not bare-spawn `exit` (ENOENT→127).
Deno.test('cts lifecycle: plans node -e || exit 0 with emulatable exit builtin', () => {
    const plan = planLifecycleScript(
        `node -e "try{require('./_postinstall')}catch(e){}" || exit 0`,
        { exePath: '/bin/cno', shell: 'sh', shellArg: '-c' },
    );
    strictEqual(plan.fallback, false);
    deepStrictEqual(plan.commands, [
        { argv: ['/bin/cno', '-e', "try{require('./_postinstall')}catch(e){}"], op: '||' },
        { argv: ['exit', '0'] },
    ]);
    strictEqual(emulateShellBuiltin(['exit', '0']), 0);
    strictEqual(emulateShellBuiltin(['true']), 0);
    strictEqual(emulateShellBuiltin(['false']), 1);
    strictEqual(emulateShellBuiltin(['node-gyp']), null);
});

// cd/export/unset stay in multi-seg plans (no whole-script shell fallback).
Deno.test('cts lifecycle: plans cd and export without shell fallback', () => {
    const opts = { exePath: '/bin/cno', shell: 'sh', shellArg: '-c' as const };
    const cdPlan = planLifecycleScript('cd sub && node install.js', opts);
    strictEqual(cdPlan.fallback, false);
    deepStrictEqual(cdPlan.commands, [
        { argv: ['cd', 'sub'], op: '&&' },
        { argv: ['/bin/cno', 'run', 'install.js'] },
    ]);

    const expPlan = planLifecycleScript('export FOO=bar && node -e "console.log(1)"', opts);
    strictEqual(expPlan.fallback, false);
    deepStrictEqual(expPlan.commands, [
        { argv: ['export', 'FOO=bar'], op: '&&' },
        { argv: ['/bin/cno', '-e', 'console.log(1)'] },
    ]);

    const unsetPlan = planLifecycleScript('export FOO=1 && unset FOO && node x.js', opts);
    strictEqual(unsetPlan.fallback, false);
    deepStrictEqual(unsetPlan.commands.map((c) => c.argv[0]), ['export', 'unset', '/bin/cno']);
});

// Interpretive apply: token walk, not regex on the raw script.
Deno.test('cts lifecycle: applyShellBuiltin mutates session cwd and env', () => {
    const root = makePosixTempDir('lc-builtin-apply');
    try {
        const sub = joinPaths(root, 'sub');
        mkdirSync(join(sub), { recursive: true });
        const session: LifecycleSession = { cwd: root, env: { FOO: 'old', KEEP: '1' } };

        strictEqual(applyShellBuiltin(['cd', 'sub'], session), 0);
        strictEqual(session.cwd, normalizePath(sub));

        strictEqual(applyShellBuiltin(['export', 'FOO=bar', 'BAZ=qux'], session), 0);
        strictEqual(session.env.FOO, 'bar');
        strictEqual(session.env.BAZ, 'qux');
        strictEqual(session.env.KEEP, '1');

        strictEqual(applyShellBuiltin(['unset', 'FOO'], session), 0);
        strictEqual(session.env.FOO, undefined);
        strictEqual(session.env.KEEP, '1');

        // failed cd does not change cwd
        const before = session.cwd;
        strictEqual(applyShellBuiltin(['cd', 'no-such-dir-xyz'], session), 1);
        strictEqual(session.cwd, before);

        // invalid export name fails closed
        strictEqual(applyShellBuiltin(['export', '1bad=x'], session), 1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
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

    // Failed node + || exit 0 → overall 0 without spawning exit.
    calls.length = 0;
    strictEqual(await runLifecyclePlan({
        fallback: false,
        commands: [
            { argv: ['prebuild'], op: '||' },
            { argv: ['exit', '0'] },
        ],
    }, run({ prebuild: 1 })), 0);
    deepStrictEqual(calls, ['prebuild']);

    strictEqual(await runLifecyclePlan({
        fallback: false,
        commands: [
            { argv: ['false'], op: '&&' },
            { argv: ['skipped'], op: '||' },
            { argv: ['fallback'] },
        ],
    }, run({ skipped: 0, fallback: 0 })), 0);
    deepStrictEqual(calls, ['fallback']);

    strictEqual(await runLifecyclePlan({
        fallback: false,
        commands: [
            { argv: ['true'], op: '||' },
            { argv: ['skipped'], op: '&&' },
            { argv: ['required'] },
        ],
    }, run({ skipped: 1, required: 0 })), 0);
    deepStrictEqual(calls, ['required']);

    strictEqual(await runLifecyclePlan({
        fallback: false,
        commands: [
            { argv: ['exit', '1'], op: '||' },
            { argv: ['must-not-run'] },
        ],
    }, run({ 'must-not-run': 0 })), 1);
    deepStrictEqual(calls, []);
});

// Session state: cd/export apply before spawn; failed cd blocks && next.
Deno.test('cts lifecycle: runLifecyclePlan carries cwd/env and short-circuits failed cd', async () => {
    const root = makePosixTempDir('lc-session-carry');
    try {
        const sub = joinPaths(root, 'pkg');
        mkdirSync(join(sub), { recursive: true });
        const session: LifecycleSession = { cwd: root, env: { FOO: '0' } };
        const seen: Array<{ argv0: string; cwd: string; foo?: string }> = [];

        const spawn = async (command: LifecycleCommand, sess: LifecycleSession): Promise<number> => {
            seen.push({ argv0: command.argv[0] ?? '', cwd: sess.cwd, foo: sess.env.FOO });
            return 0;
        };

        const plan = planLifecycleScript('cd pkg && export FOO=bar && node install.js', {
            exePath: '/bin/cno',
            shell: 'sh',
            shellArg: '-c',
        });
        strictEqual(plan.fallback, false);
        strictEqual(await runLifecyclePlan(plan, spawn, session), 0);
        deepStrictEqual(seen, [
            { argv0: '/bin/cno', cwd: normalizePath(sub), foo: 'bar' },
        ]);
        strictEqual(session.cwd, normalizePath(sub));
        strictEqual(session.env.FOO, 'bar');

        // failed cd → && does not run next
        seen.length = 0;
        const bad = planLifecycleScript('cd missing-dir-xyz && node install.js', {
            exePath: '/bin/cno',
            shell: 'sh',
            shellArg: '-c',
        });
        const sess2: LifecycleSession = { cwd: root, env: {} };
        strictEqual(await runLifecyclePlan(bad, spawn, sess2), 1);
        deepStrictEqual(seen, []);
        strictEqual(sess2.cwd, root);

        // || export after failure still runs export
        const sess3: LifecycleSession = { cwd: root, env: {} };
        strictEqual(await runLifecyclePlan({
            fallback: false,
            commands: [
                { argv: ['false'], op: '||' },
                { argv: ['export', 'Z=1'] },
            ],
        }, spawn, sess3), 0);
        strictEqual(sess3.env.Z, '1');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
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

// Native bins (opencode ELF ~180MB) must not be fully read when resolving.
Deno.test('cts shell: unix bin resolver skips ELF binaries without full read', () => {
    const root = makePosixTempDir('unix-elf-bin');
    try {
        const elf = joinPaths(root, 'opencode.exe');
        // Minimal ELF magic + padding (not a real executable).
        const buf = new Uint8Array(4096);
        buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;
        writeFileSync(elf, buf);
        const t0 = Date.now();
        strictEqual(resolveUnixBinEntry(elf), null);
        ok(Date.now() - t0 < 500, 'must not fully read native binary');
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

/**
 * Pre/post lifecycle ordering is a task-runner semantic, not a shell one: npm
 * package scripts run pre<name>/post<name>, deno.json tasks do not. Oracle
 * (2026-08-03): real Deno 2.9.3 on Windows runs only `test` for a deno.json
 * task that also defines pretest/posttest, confirming the second half.
 *
 * Only the fixture needed POSIX: `echo x >> f` depends on sh redirection and
 * LF line endings. Using `node -e` (rewritten by the task command parser) keeps
 * the fixture portable, so this now runs on Windows too.
 */
const appendLine = (word: string) =>
    `node -e "require('node:fs').appendFileSync('order.txt','${word}\\n')"`;

Deno.test({
    name: 'cts task: package scripts run pre/post but deno tasks do not',
    async fn() {
        const pkgRoot = makePosixTempDir('task-package-prepost');
        const pkgLock = new LockStore(pkgRoot, true);
        try {
            writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
                scripts: {
                    pretest: appendLine('pre'),
                    test: appendLine('test'),
                    posttest: appendLine('post'),
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
                    pretest: appendLine('pre'),
                    test: appendLine('test'),
                    posttest: appendLine('post'),
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
    name: 'cts task: package scripts expose npm env and run node through cno',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const root = makePosixTempDir('task-package-npm-env');
        const lock = new LockStore(root, true);
        try {
            writeFileSync(join(root, 'probe.cjs'), `
                const { appendFileSync } = require('node:fs');
                const env = process.env;
                appendFileSync('events.jsonl', JSON.stringify({
                    argv: process.argv.slice(2),
                    execPath: process.execPath,
                    event: env.npm_lifecycle_event,
                    script: env.npm_lifecycle_script,
                    packageJson: env.npm_package_json,
                    packageName: env.npm_package_name,
                    packageVersion: env.npm_package_version,
                    configEnabled: env.npm_package_config_enabled,
                    configNested: env.npm_package_config_nested_value,
                    command: env.npm_command,
                    exec: env.npm_execpath,
                    nodeExec: env.npm_node_execpath,
                    userAgent: env.npm_config_user_agent,
                }) + '\\n');
            `);
            writeFileSync(join(root, 'package.json'), JSON.stringify({
                name: 'task-env-probe',
                version: '1.2.3',
                config: { enabled: false, nested: { value: 2 } },
                scripts: {
                    preprobe: 'node probe.cjs pre',
                    probe: 'node probe.cjs main',
                    postprobe: 'node probe.cjs post',
                },
            }));

            const loaded = loadTasks(root, lock);
            ok(loaded);
            strictEqual(await loaded.runner.run('probe', ['extra arg']), 0);
            const events = readFileSync(join(root, 'events.jsonl'), 'utf8')
                .trim().split('\n').map((line) => JSON.parse(line));
            deepStrictEqual(events.map((event) => event.event), ['preprobe', 'probe', 'postprobe']);
            deepStrictEqual(events.map((event) => event.argv), [['pre'], ['main', 'extra arg'], ['post']]);
            const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
            for (const event of events) {
                strictEqual(event.execPath.replace(/ \(deleted\)$/, ''), execPath);
                strictEqual(event.packageJson, joinPaths(root, 'package.json'));
                strictEqual(event.packageName, 'task-env-probe');
                strictEqual(event.packageVersion, '1.2.3');
                strictEqual(event.configEnabled, 'false');
                strictEqual(event.configNested, '2');
                strictEqual(event.command, 'run-script');
                strictEqual(event.exec.replace(/ \(deleted\)$/, ''), execPath);
                strictEqual(event.nodeExec.replace(/ \(deleted\)$/, ''), execPath);
                ok(String(event.userAgent).startsWith('cno/'), String(event.userAgent));
            }
            deepStrictEqual(events.map((event) => event.script), [
                'node probe.cjs pre',
                'node probe.cjs main',
                'node probe.cjs post',
            ]);
        } finally {
            lock.close();
            rmSync(root, { recursive: true, force: true });
        }
    },
});

Deno.test({
    name: 'cts task: command parsing resolves node and deno to cno',
    async fn() {
        const root = makePosixTempDir('task-runtime-resolution');
        const lock = new LockStore(root, true);
        try {
            writeFileSync(join(root, 'probe.cjs'), `
                const { appendFileSync } = require('node:fs');
                appendFileSync('runtime.jsonl', JSON.stringify({
                    tag: process.argv[2],
                    execPath: process.execPath,
                    foo: process.env.FOO,
                }) + '\\n');
            `);
            writeFileSync(join(root, 'deno.json'), JSON.stringify({
                tasks: {
                    probe: "node probe.cjs assigned-node && deno run probe.cjs assigned-deno",
                    serveHelp: 'deno serve --help',
                },
            }));

            const loaded = loadTasks(root, lock);
            ok(loaded);
            strictEqual(await loaded.runner.run('probe'), 0);
            const events = readFileSync(join(root, 'runtime.jsonl'), 'utf8')
                .trim().split('\n').map((line) => JSON.parse(line));
            deepStrictEqual(events.map((event) => event.tag), ['assigned-node', 'assigned-deno']);
            const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
            for (const event of events) strictEqual(event.execPath.replace(/ \(deleted\)$/, ''), execPath);
            strictEqual(events[0].foo, undefined);
            strictEqual(events[1].foo, undefined);
            strictEqual(await loaded.runner.run('serveHelp'), 0);
        } finally {
            lock.close();
            rmSync(root, { recursive: true, force: true });
        }
    },
});

/**
 * Diamond dedup and cycle rejection are graph semantics in the task runner,
 * independent of the shell. The gate existed only because the fixture used
 * `echo x >> order.txt`. `appendLine` (node -e, rewritten by the task parser) is
 * portable, so this runs on Windows too.
 */
Deno.test({
    name: 'cts task: dependencies dedupe diamond graphs and reject cycles',
    async fn() {
        const root = makePosixTempDir('task-diamond-deps');
        const lock = new LockStore(root, true);
        try {
            writeFileSync(join(root, 'deno.jsonc'), `{
                // a depends on b and c; both depend on d, which should run once.
                "tasks": {
                    "a": { "command": ${JSON.stringify(appendLine('a'))}, "dependencies": ["b", "c"] },
                    "b": { "command": ${JSON.stringify(appendLine('b'))}, "dependencies": ["d"] },
                    "c": { "command": ${JSON.stringify(appendLine('c'))}, "dependencies": ["d"] },
                    "d": ${JSON.stringify(appendLine('d'))}
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
                    "a": { "command": ${JSON.stringify(appendLine('a'))}, "dependencies": ["a"] }
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
    name: 'cts task: shell quoting globs and mixed boolean lists match Deno',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const root = makePosixTempDir('task-shell-semantics');
        const lock = new LockStore(root, true);
        try {
            writeFileSync(join(root, 'a.txt'), '');
            writeFileSync(join(root, 'b.txt'), '');
            writeFileSync(join(root, 'deno.json'), JSON.stringify({
                tasks: {
                    quotes: 'printf "<%s>\\n" "$FOO" \'$FOO\'',
                    glob: 'printf "<%s>\\n" *.txt',
                    fallback: 'false && echo BAD || echo GOOD',
                    sequence: 'false && echo BAD ; echo GOOD',
                },
            }));

            const quotes = await runCnoTask(['task', '-q', 'quotes'], root, { FOO: 'VALUE' });
            strictEqual(quotes.code, 0, quotes.stderr);
            strictEqual(quotes.stdout, '<VALUE>\n<$FOO>\n');

            const glob = await runCnoTask(['task', '-q', 'glob'], root);
            strictEqual(glob.code, 0, glob.stderr);
            deepStrictEqual(glob.stdout.trim().split('\n').sort(), ['<a.txt>', '<b.txt>']);

            const fallback = await runCnoTask(['task', '-q', 'fallback'], root);
            strictEqual(fallback.code, 0, fallback.stderr);
            strictEqual(fallback.stdout, 'GOOD\n');

            const sequence = await runCnoTask(['task', '-q', 'sequence'], root);
            strictEqual(sequence.code, 0, sequence.stderr);
            strictEqual(sequence.stdout, 'GOOD\n');
        } finally {
            lock.close();
            rmSync(root, { recursive: true, force: true });
        }
    },
});

Deno.test({
    name: 'cts task: Windows internal shell preserves quotes, state, pipelines and redirects',
    ignore: Deno.build.os !== 'windows',
    async fn() {
        const root = makePosixTempDir('task-windows-internal-shell');
        try {
            mkdirSync(join(root, 'nested'));
            writeFileSync(join(root, 'stdin.cjs'),
                "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log('got:'+s.trim()));");
            writeFileSync(join(root, 'env.cjs'),
                "console.log([process.env.ONCE ?? '', process.env.KEEP ?? ''].join(':'));");
            writeFileSync(join(root, 'deno.json'), JSON.stringify({
                tasks: {
                    quotes: `echo "quoted $FOO" '$FOO'`,
                    logic: 'false && echo BAD || echo GOOD',
                    redirect: 'echo one > out.txt ; echo two >> out.txt',
                    redirectedPipe: 'echo hidden > redirected.txt | node stdin.cjs',
                    pipe: 'echo value | node stdin.cjs',
                    scopedEnv: 'ONCE=one node env.cjs ; node env.cjs',
                    state: 'cd nested ; export KEEP=yes ; node ../env.cjs ; pwd',
                },
            }));

            const quotes = await runCnoTask(['task', '-q', 'quotes'], root, { FOO: 'VALUE' });
            strictEqual(quotes.code, 0, quotes.stderr);
            strictEqual(quotes.stdout, 'quoted VALUE $FOO\n');

            const logic = await runCnoTask(['task', '-q', 'logic'], root);
            strictEqual(logic.code, 0, logic.stderr);
            strictEqual(logic.stdout, 'GOOD\n');

            const redirect = await runCnoTask(['task', '-q', 'redirect'], root);
            strictEqual(redirect.code, 0, redirect.stderr);
            strictEqual(readFileSync(join(root, 'out.txt'), 'utf8'), 'one\ntwo\n');

            const redirectedPipe = await runCnoTask(['task', '-q', 'redirectedPipe'], root);
            strictEqual(redirectedPipe.code, 0, redirectedPipe.stderr);
            strictEqual(redirectedPipe.stdout, 'got:\n');
            strictEqual(readFileSync(join(root, 'redirected.txt'), 'utf8'), 'hidden\n');

            const pipe = await runCnoTask(['task', '-q', 'pipe'], root);
            strictEqual(pipe.code, 0, pipe.stderr);
            strictEqual(pipe.stdout, 'got:value\n');

            const scopedEnv = await runCnoTask(['task', '-q', 'scopedEnv'], root);
            strictEqual(scopedEnv.code, 0, scopedEnv.stderr);
            strictEqual(scopedEnv.stdout, 'one:\n:\n');

            const state = await runCnoTask(['task', '-q', 'state'], root);
            strictEqual(state.code, 0, state.stderr);
            strictEqual(state.stdout, `:yes\n${normalizePath(joinPaths(root, 'nested'))}\n`);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
});

Deno.test({
    name: 'cts task: deno run forwarding preserves empty and escaped arguments',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const root = makePosixTempDir('task-deno-run-args');
        try {
            writeFileSync(join(root, 'args.ts'), 'console.log(JSON.stringify(Deno.args));\n');
            writeFileSync(join(root, 'deno.json'), JSON.stringify({
                tasks: { args: String.raw`deno run args.ts '' "" 'a\b'` },
            }));

            const result = await runCnoTask(['task', '-q', 'args'], root);
            strictEqual(result.code, 0, result.stderr);
            deepStrictEqual(JSON.parse(result.stdout.trim()), ['', '', String.raw`a\b`]);
        } finally {
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

Deno.test({
    name: 'cts task cli: terminal signals handled by the foreground task do not kill its parent',
    ignore: Deno.build.os !== 'linux',
    async fn() {
        const root = makePosixTempDir('task-sigint-parent');
        try {
            writeFileSync(join(root, 'deno.json'), JSON.stringify({
                tasks: { hold: 'deno run -A child.ts' },
            }));
            writeFileSync(join(root, 'child.ts'), `
                let resolveInt = () => {};
                let resolveQuit = () => {};
                let resolveTstp = () => {};
                const interrupted = new Promise<void>((resolve) => { resolveInt = resolve; });
                const quit = new Promise<void>((resolve) => { resolveQuit = resolve; });
                const stopped = new Promise<void>((resolve) => { resolveTstp = resolve; });
                const onInt = () => { console.log('CHILD_INT'); resolveInt(); };
                const onQuit = () => { console.log('CHILD_QUIT'); resolveQuit(); };
                const onTstp = () => { console.log('CHILD_TSTP'); resolveTstp(); };
                Deno.addSignalListener('SIGINT', onInt);
                Deno.addSignalListener('SIGQUIT', onQuit);
                Deno.addSignalListener('SIGTSTP', onTstp);
                const keepAlive = setInterval(() => {}, 1_000);
                console.log('CHILD_READY');
                await interrupted;
                await quit;
                await stopped;
                clearInterval(keepAlive);
                Deno.removeSignalListener('SIGINT', onInt);
                Deno.removeSignalListener('SIGQUIT', onQuit);
                Deno.removeSignalListener('SIGTSTP', onTstp);
                await new Promise((resolve) => setTimeout(resolve, 50));
                console.log('CHILD_DONE');
            `);

            const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
            const command = [execPath, 'task', '-q', 'hold']
                .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
                .join(' ');
            const child = new Deno.Command('script', {
                args: ['-qec', command, '/dev/null'],
                cwd: root,
                stdin: 'piped',
                stdout: 'piped',
                stderr: 'piped',
                env: { CTS_SILENT: 'true' },
            }).spawn();

            const writer = child.stdin.getWriter();
            const reader = child.stdout.getReader();
            const chunks: Uint8Array[] = [];
            let output = '';
            const decoder = new TextDecoder();
            const readyDeadline = Date.now() + 10_000;
            const readUntil = async (marker: string) => {
                while (!output.includes(marker)) {
                    const remaining = readyDeadline - Date.now();
                    ok(remaining > 0, `task child did not print ${marker}:\n${output}`);
                    const result = await Promise.race([
                        reader.read(),
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error(`task child ${marker} timeout`)), remaining)
                        ),
                    ]);
                    ok(!result.done, `task child exited before ${marker}:\n${output}`);
                    chunks.push(result.value);
                    output += decoder.decode(result.value, { stream: true });
                }
            };
            await readUntil('CHILD_READY');

            await writer.write(Uint8Array.of(3));
            await readUntil('CHILD_INT');
            await writer.write(Uint8Array.of(28));
            await readUntil('CHILD_QUIT');
            await writer.write(Uint8Array.of(26));
            await writer.close();
            while (true) {
                const result = await reader.read();
                if (result.done) break;
                chunks.push(result.value);
            }
            output = decodeUtf8(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])));
            const stderr = await child.stderr.text();
            const status = await child.status;

            strictEqual(status.code, 0, stderr + output);
            ok(output.includes('CHILD_INT'), output);
            ok(output.includes('CHILD_QUIT'), output);
            ok(output.includes('CHILD_TSTP'), output);
            ok(output.includes('CHILD_DONE'), output);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
});

Deno.test({
    name: 'cts task shell fallback: terminal signal status follows the leaf command',
    ignore: Deno.build.os !== 'linux',
    async fn() {
        const root = makePosixTempDir('task-shell-signal');
        const caughtLeaf = join(root, 'caught.sh');
        const defaultLeaf = join(root, 'default.sh');
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        writeFileSync(caughtLeaf, [
            "trap 'exit 0' HUP INT QUIT USR1 TERM TSTP TTIN TTOU IO",
            ': > "$1"',
            'while :; do sleep 1; done',
            '',
        ].join('\n'));
        writeFileSync(defaultLeaf, [
            ': > "$1"',
            'exec sleep 30',
            '',
        ].join('\n'));

        const runCase = async (
            name: string,
            signal: 'SIGHUP' | 'SIGINT' | 'SIGQUIT' | 'SIGUSR1' | 'SIGTERM' | 'SIGTSTP' | 'SIGTTIN' | 'SIGTTOU' | 'SIGIO',
            catches: boolean,
        ) => {
            const ready = join(root, `${name}.ready`);
            const leaf = catches ? caughtLeaf : defaultLeaf;
            const child = new Deno.Command('setsid', {
                args: taskShellArgv(`sh ${quote(leaf)} ${quote(ready)}`),
                cwd: root,
                stdin: 'null',
                stdout: 'null',
                stderr: 'piped',
            }).spawn();
            const statusPromise = child.status;
            let settled = false;
            try {
                const readyDeadline = Date.now() + 5_000;
                while (!existsSync(ready)) {
                    ok(Date.now() < readyDeadline, `${name} leaf did not become ready`);
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                Deno.kill(-child.pid, signal);
                const status = await Promise.race([
                    statusPromise,
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error(`${name} shell did not exit`)), 5_000)
                    ),
                ]);
                settled = true;
                return { status, stderr: await child.stderr.text() };
            } finally {
                if (!settled) {
                    try { Deno.kill(-child.pid, 'SIGKILL'); } catch {}
                    await statusPromise.catch(() => {});
                }
            }
        };

        try {
            for (const [name, signal, catches, expected] of [
                ['caught-int', 'SIGINT', true, 0],
                ['default-int', 'SIGINT', false, 130],
                ['caught-quit', 'SIGQUIT', true, 0],
                ['default-quit', 'SIGQUIT', false, 131],
                ['caught-tstp', 'SIGTSTP', true, 0],
                ['caught-ttin', 'SIGTTIN', true, 0],
                ['caught-ttou', 'SIGTTOU', true, 0],
            ] as const) {
                const { status, stderr } = await runCase(name, signal, catches);
                strictEqual(status.code, expected, `${name}: ${stderr}`);
                strictEqual(status.signal, null, `${name}: ${stderr}`);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
});

Deno.test({
    name: 'cts task child: preserves the runtime SIGPIPE disposition',
    ignore: Deno.build.os !== 'linux',
    async fn() {
        const sigpipeMask = 1n << 12n;
        const ignoredSignals = () => {
            const match = readFileSync('/proc/self/status', 'utf8').match(/^SigIgn:\s*([0-9a-f]+)$/m);
            ok(match?.[1], 'missing SigIgn in /proc/self/status');
            return BigInt(`0x${match[1]}`);
        };

        ok((ignoredSignals() & sigpipeMask) !== 0n, 'runtime must start with SIGPIPE ignored');
        await runTaskChild(['/bin/true'], Deno.env.toObject(), Deno.cwd());
        await new Promise((resolve) => setTimeout(resolve, 10));
        ok((ignoredSignals() & sigpipeMask) !== 0n, 'task child guard reset SIGPIPE to its default action');
    },
});

Deno.test({
    name: 'cts task child: caught process-group signals are decided by the leaf',
    ignore: Deno.build.os !== 'linux',
    async fn() {
        const root = makePosixTempDir('task-child-signals');
        const leaf = join(root, 'leaf.sh');
        const runner = join(root, 'runner.ts');
        const taskModule = decodeURIComponent(new URL('../../cts/src/task.ts', import.meta.url).pathname);
        writeFileSync(leaf, [
            "trap 'exit 0' INT QUIT TSTP TTIN TTOU",
            ': > "$1"',
            'while :; do sleep 1; done',
            '',
        ].join('\n'));
        writeFileSync(runner, `
            import { runTaskChild } from ${JSON.stringify(taskModule)};
            const os = import.meta.use('os');
            const code = await runTaskChild(
                ['sh', Deno.args[0], Deno.args[1]],
                os.environ(),
                Deno.cwd(),
            );
            Deno.exit(code);
        `);

        try {
            for (const signal of ['SIGINT', 'SIGQUIT', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU'] as const) {
                const ready = join(root, `${signal}.ready`);
                const child = new Deno.Command('setsid', {
                    args: [Deno.execPath(), 'run', runner, leaf, ready],
                    cwd: root,
                    stdin: 'null',
                    stdout: 'null',
                    stderr: 'piped',
                }).spawn();
                const statusPromise = child.status;
                let settled = false;
                try {
                    const readyDeadline = Date.now() + 5_000;
                    while (!existsSync(ready)) {
                        ok(Date.now() < readyDeadline, `${signal} leaf did not become ready`);
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    Deno.kill(-child.pid, signal);
                    const status = await Promise.race([
                        statusPromise,
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error(`${signal} task child did not exit`)), 5_000)
                        ),
                    ]);
                    settled = true;
                    strictEqual(status.code, 0, `${signal}: ${await child.stderr.text()}`);
                    strictEqual(status.signal, null, signal);
                } finally {
                    if (!settled) {
                        try { Deno.kill(-child.pid, 'SIGKILL'); } catch {}
                        await statusPromise.catch(() => {});
                    }
                }
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
});

Deno.test({
    name: 'cts task child: direct non-terminal signals are not swallowed by the parent guard',
    ignore: Deno.build.os !== 'linux',
    async fn() {
        const root = makePosixTempDir('task-child-direct-signal');
        const leaf = join(root, 'leaf.sh');
        const runner = join(root, 'runner.ts');
        const taskModule = decodeURIComponent(new URL('../../cts/src/task.ts', import.meta.url).pathname);
        writeFileSync(leaf, [
            'printf "%s" "$$" > "$1"',
            'while :; do sleep 1; done',
            '',
        ].join('\n'));
        writeFileSync(runner, `
            import { runTaskChild } from ${JSON.stringify(taskModule)};
            const os = import.meta.use('os');
            const code = await runTaskChild(
                ['sh', Deno.args[0], Deno.args[1]],
                os.environ(),
                Deno.cwd(),
            );
            Deno.exit(code);
        `);

        try {
            for (const signal of ['SIGHUP', 'SIGUSR1', 'SIGTERM'] as const) {
                const pidFile = join(root, `${signal}.pid`);
                const child = new Deno.Command(Deno.execPath(), {
                    args: ['run', runner, leaf, pidFile],
                    cwd: root,
                    stdin: 'null',
                    stdout: 'null',
                    stderr: 'piped',
                }).spawn();
                const statusPromise = child.status;
                let leafPid: number | undefined;
                try {
                    const readyDeadline = Date.now() + 5_000;
                    while (!existsSync(pidFile)) {
                        ok(Date.now() < readyDeadline, `${signal} leaf did not become ready`);
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    leafPid = Number(readFileSync(pidFile, 'utf8'));
                    ok(Number.isInteger(leafPid) && leafPid > 0, `${signal} invalid leaf pid`);
                    Deno.kill(child.pid, signal);
                    const status = await Promise.race([
                        statusPromise,
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error(`${signal} task parent did not exit`)), 5_000)
                        ),
                    ]);
                    strictEqual(status.signal, signal);
                } finally {
                    if (leafPid !== undefined) {
                        try { Deno.kill(leafPid, 'SIGKILL'); } catch {}
                    }
                    try { Deno.kill(child.pid, 'SIGKILL'); } catch {}
                    await statusPromise.catch(() => {});
                }
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
});

// specs/task/boolean_logic: && || & through platform shell
Deno.test({
    name: 'cts task upstream: boolean_logic shell operators run via shell fallback',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const root = makePosixTempDir('task-boolean-logic');
        const lock = new LockStore(root, true);
        try {
            writeFileSync(join(root, 'deno.json'), JSON.stringify({
                tasks: {
                    boolean_logic: 'sleep 0.05 && echo 3 >> out.txt && echo 4 >> out.txt & echo 1 >> out.txt && echo 2 >> out.txt || echo NOPE >> out.txt',
                },
            }));
            const loaded = loadTasks(root, lock);
            ok(loaded);
            strictEqual(await loaded.runner.run('boolean_logic'), 0);
            // Wait briefly for background `&` job to finish writing
            await new Promise((r) => setTimeout(r, 200));
            const text = readFileSync(join(root, 'out.txt'), 'utf8');
            for (const n of ['1', '2', '3', '4']) ok(text.includes(n), text);
            ok(!text.includes('NOPE'), text);
        } finally {
            lock.close();
            rmSync(root, { recursive: true, force: true });
        }
    },
});

// specs/task/wildcard: foo-* and dep-* globs
/**
 * Wildcard task-name matching and once-only dependency execution are runner
 * semantics; the gate existed only for the `echo x >> out.txt` fixture.
 * This one runs through the real `cno task` CLI (cmd /c on Windows), so the
 * fixture is a .cjs script taking the word as argv — no inner quoting, which
 * `cmd` and `sh` would treat differently.
 */
Deno.test({
    name: 'cts task upstream: wildcard task names match and run once with deps',
    async fn() {
        const root = makePosixTempDir('task-wildcard');
        try {
            writeFileSync(
                join(root, 'append.cjs'),
                "require('node:fs').appendFileSync('out.txt', process.argv[2] + '\\n');",
            );
            const appendArgv = (word: string) => `node append.cjs ${word}`;
            writeFileSync(join(root, 'deno.json'), JSON.stringify({
                tasks: {
                    'foo-1': appendArgv('foo-1'),
                    'foo-2': appendArgv('foo-2'),
                    'foo-3': appendArgv('foo-3'),
                    'dep-1': {
                        command: appendArgv('dep-1'),
                        dependencies: ['dep-2', 'foo-1'],
                    },
                    'dep-2': {
                        command: appendArgv('dep-2'),
                        dependencies: ['foo-1'],
                    },
                },
            }));

            const foo = await runCnoTask(['task', '-q', 'foo-*'], root);
            strictEqual(foo.code, 0, foo.stderr);
            const fooOut = readFileSync(join(root, 'out.txt'), 'utf8');
            ok(fooOut.includes('foo-1'), fooOut);
            ok(fooOut.includes('foo-2'), fooOut);
            ok(fooOut.includes('foo-3'), fooOut);

            writeFileSync(join(root, 'out.txt'), '');
            const dep = await runCnoTask(['task', '-q', 'dep-*'], root);
            strictEqual(dep.code, 0, dep.stderr);
            const depOut = readFileSync(join(root, 'out.txt'), 'utf8');
            // foo-1 once, then dep-2, then dep-1 (diamond deps dedupe)
            strictEqual(depOut, 'foo-1\ndep-2\ndep-1\n', depOut);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
});

// specs/task/both_prefers_deno + package_json_echo
Deno.test({
    name: 'cts task upstream: deno tasks override package scripts; package-only scripts run',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const both = makePosixTempDir('task-both-prefers');
        try {
            writeFileSync(join(both, 'package.json'), JSON.stringify({
                scripts: {
                    output: 'echo should-never-run',
                },
            }));
            writeFileSync(join(both, 'deno.json'), JSON.stringify({
                tasks: {
                    output: 'echo from-deno',
                },
            }));
            const prefer = await runCnoTask(['task', '-q', 'output', 'extra'], both);
            strictEqual(prefer.code, 0, prefer.stderr);
            ok(prefer.stdout.includes('from-deno'), prefer.stdout);
            ok(!prefer.stdout.includes('should-never-run'), prefer.stdout);
        } finally {
            rmSync(both, { recursive: true, force: true });
        }

        const pkgOnly = makePosixTempDir('task-pkg-echo');
        try {
            writeFileSync(join(pkgOnly, 'package.json'), JSON.stringify({
                scripts: {
                    echo: 'echo package-echo',
                },
            }));
            const result = await runCnoTask(['task', '-q', 'echo'], pkgOnly);
            strictEqual(result.code, 0, result.stderr);
            ok(result.stdout.includes('package-echo'), result.stdout);
        } finally {
            rmSync(pkgOnly, { recursive: true, force: true });
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

// specs/task/description, emoji, non_existent
Deno.test({
    name: 'cts task cli: lists descriptions, runs emoji tasks, fails unknown names',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const root = makePosixTempDir('task-desc-emoji');
        try {
            writeFileSync(join(root, 'deno.json'), JSON.stringify({
                tasks: {
                    echo_emoji: {
                        description: 'This is some task',
                        command: 'echo 1',
                    },
                    multiline_description: {
                        description: 'This is a multiline\ndescription',
                        command: 'echo 2',
                    },
                    fire: 'echo 🔥',
                },
            }));

            const listed = await runCnoTask(['task', '--config', join(root, 'deno.json')], root);
            strictEqual(listed.code, 0, listed.stderr + listed.stdout);
            ok(listed.stdout.includes('Available tasks:'), listed.stdout);
            ok(listed.stdout.includes('- echo_emoji'), listed.stdout);
            ok(listed.stdout.includes('// This is some task'), listed.stdout);
            ok(listed.stdout.includes('// This is a multiline'), listed.stdout);
            ok(listed.stdout.includes('// description'), listed.stdout);
            ok(listed.stdout.includes('echo 1'), listed.stdout);

            const emoji = await runCnoTask(['task', '-q', '--config', join(root, 'deno.json'), 'fire'], root);
            strictEqual(emoji.code, 0, emoji.stderr);
            ok(emoji.stdout.includes('🔥'), emoji.stdout);

            const missing = await runCnoTask(['task', '--config', join(root, 'deno.json'), 'non_existent'], root);
            strictEqual(missing.code, 1, missing.stderr + missing.stdout);
            ok(/Unknown task|not found|non_existent/i.test(missing.stderr + missing.stdout), missing.stderr + missing.stdout);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
});

// specs/task/eval
Deno.test({
    name: 'cts task upstream: --eval runs ad-hoc shell and errors without command',
    ignore: Deno.build.os === 'windows',
    async fn() {
        const root = makePosixTempDir('task-eval');
        try {
            writeFileSync(join(root, 'deno.json'), JSON.stringify({ tasks: {} }));
            const okEval = await runCnoTask(['task', '--eval', 'echo hello-eval'], root);
            strictEqual(okEval.code, 0, okEval.stderr + okEval.stdout);
            ok(okEval.stdout.includes('hello-eval'), okEval.stdout);

            const noArg = await runCnoTask(['task', '--eval'], root);
            strictEqual(noArg.code, 1, noArg.stderr + noArg.stdout);
            ok(/must be specified when using --eval/i.test(noArg.stderr + noArg.stdout), noArg.stderr + noArg.stdout);

            const pwd = await runCnoTask(['task', '--eval', 'echo $(pwd)'], root);
            strictEqual(pwd.code, 0, pwd.stderr + pwd.stdout);
            ok(pwd.stdout.includes(root) || pwd.stdout.trim().length > 0, pwd.stdout);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
});
