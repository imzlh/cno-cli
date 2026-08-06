import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';
import { ChildProcess, spawn, exec, execFile, execFileSync, execSync, fork, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

Deno.test({ name: 'child_process: spawn captures stdout and exit code', timeout: 10000 }, async () => {
    await withTempDir('child-process', async (dir) => {
        const script = join(dir, 'target.js');
        fs.writeFileSync(script, 'process.stdout.write("out"); process.exit(0);\n');
        const result = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
            const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
            let out = '';
            child.stdout?.on('data', (d) => (out += decodeUtf8(d)));
            child.on('error', reject);
            child.on('exit', (code) => resolve({ code, out }));
        });
        strictEqual(result.code, 0);
        strictEqual(result.out, 'out');
    });
});

Deno.test({ name: 'child_process: spawn non-zero exit code surfaces in callback', timeout: 10000 }, async () => {
    await withTempDir('child-process', async (dir) => {
        const script = join(dir, 'target.js');
        fs.writeFileSync(script, 'process.exit(42);\n');
        const code = await new Promise<number | null>((resolve, reject) => {
            const child = spawn(process.execPath, [script]);
            child.on('error', reject);
            child.on('exit', (c) => resolve(c));
        });
        strictEqual(code, 42);
    });
});

Deno.test({ name: 'child_process: spawn with stdio inherit returns null streams', timeout: 10000 }, () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'inherit' });
    strictEqual(child.stdout, null);
    strictEqual(child.stderr, null);
    child.kill('SIGKILL');
});

Deno.test({ name: 'child_process: child.pid is a positive number', timeout: 10000 }, () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000);']);
    ok(typeof child.pid === 'number' && child.pid > 0);
    child.kill('SIGKILL');
});

Deno.test('child_process: exports a usable ChildProcess constructor', () => {
    const child = new ChildProcess();
    ok(child instanceof ChildProcess);
    strictEqual(child.pid, 0);
});

Deno.test({ name: 'child_process: fork defaults to inherited stdio and accepts options as second argument', timeout: 10000 }, async () => {
    const child = fork('0', { silent: false, execArgv: ['eval'] });
    strictEqual(child.stdin, null);
    strictEqual(child.stdout, null);
    strictEqual(child.stderr, null);
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
});

Deno.test({ name: 'child_process: exec returns stdout/stderr to callback', timeout: 10000 }, async () => {
    const r = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        exec(`${process.execPath} -e "console.log('hello'); console.error('err');"`, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        });
    });
    strictEqual(r.stdout, 'hello');
    strictEqual(r.stderr, 'err');
});

Deno.test({ name: 'child_process: execFile runs a file with args', timeout: 10000 }, async () => {
    await withTempDir('child-process', async (dir) => {
        const script = join(dir, 'target.js');
        fs.writeFileSync(script, 'process.stdout.write(process.argv.slice(2).join(","));\n');
        const r = await new Promise<string>((resolve, reject) => {
            execFile(process.execPath, [script, 'a', 'b', 'c'], (err, stdout) => {
                if (err) reject(err); else resolve(stdout);
            });
        });
        strictEqual(r, 'a,b,c');
    });
});

Deno.test({ name: 'child_process: spawnSync returns status and stdout', timeout: 10000 }, () => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("sync-out"); process.exit(3);']);
    strictEqual(r.status, 3);
    strictEqual(decodeUtf8(r.stdout), 'sync-out');
    strictEqual(r.signal, null);
});

Deno.test({ name: 'child_process: spawnSync on missing command errors', timeout: 10000 }, () => {
    const r = spawnSync('/this/path/definitely/does/not/exist');
    ok(r.error instanceof Error, 'spawnSync of missing command must populate error');
});

Deno.test({ name: 'child_process: child.kill sends signal and resolves exit', timeout: 10000 }, async () => {
    await withTempDir('child-process', async (dir) => {
        const script = join(dir, 'target.js');
        fs.writeFileSync(script, 'setInterval(()=>{}, 1000);\n');
        const code = await new Promise<number | null>((resolve, reject) => {
            const child = spawn(process.execPath, [script]);
            child.on('error', reject);
            child.on('exit', (c) => resolve(c));
            setTimeout(() => child.kill('SIGTERM'), 100);
        });
        // SIGTERM default action is termination; code may be null with signal set.
        ok(code !== 0, 'killed child must exit non-zero or via signal');
    });
});

Deno.test({ name: 'child_process: child.on("error") emits on spawn failure', timeout: 10000 }, async () => {
    const saw = await new Promise<boolean>((resolve) => {
        const child = spawn('/nonexistent/binary/xyz');
        child.on('error', () => resolve(true));
        child.on('exit', () => resolve(false));
    });
    ok(saw, 'spawn of missing binary must emit error');
});

Deno.test({ name: 'child_process: execFile respects cwd option', timeout: 10000 }, async () => {
    await withTempDir('child-process-cwd', async (dir) => {
        const out = await new Promise<string>((resolve, reject) => {
            execFile(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir }, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });
        strictEqual(out, dir);
    });
});

Deno.test({ name: 'child_process: spawn passes env overrides to child', timeout: 10000 }, async () => {
    const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', 'process.stdout.write(process.env.TEST_CHILD_VALUE || "")'], {
            env: { ...process.env, TEST_CHILD_VALUE: 'ok' },
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        let stdout = '';
        child.stdout?.on('data', (chunk) => (stdout += decodeUtf8(chunk)));
        child.on('error', reject);
        child.on('close', () => resolve(stdout));
    });
    strictEqual(out, 'ok');
});

Deno.test({ name: 'child_process: spawn coerces non-string env values', timeout: 10000 }, async () => {
    const env = {
        ...process.env,
        TEST_CHILD_NUMBER: 42,
        TEST_CHILD_BOOLEAN: false,
        TEST_CHILD_UNDEFINED: undefined,
    } as unknown as NodeJS.ProcessEnv;
    const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ['-e', 'process.stdout.write(`${process.env.TEST_CHILD_NUMBER}:${process.env.TEST_CHILD_BOOLEAN}:${"TEST_CHILD_UNDEFINED" in process.env}`)'],
            { env, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        let stdout = '';
        child.stdout?.on('data', (chunk) => (stdout += decodeUtf8(chunk)));
        child.on('error', reject);
        child.on('close', () => resolve(stdout));
    });
    strictEqual(out, '42:false:false');
});

Deno.test({ name: 'child_process: explicit env does not inherit parent env and skips nullish values', timeout: 10000 }, async () => {
    const key = 'CNO_CHILD_PROCESS_PARENT_ENV';
    const previous = process.env[key];
    process.env[key] = 'parent';
    try {
        const inherited = spawnSync(process.execPath, ['-e', `process.stdout.write(process.env.${key} || "")`], {
            encoding: 'utf8',
        });
        strictEqual(inherited.status, 0);
        strictEqual(inherited.stdout, 'parent');

        const cleared = spawnSync(process.execPath, ['-e', `process.stdout.write(String(process.env.${key}))`], {
            env: {},
            encoding: 'utf8',
        });
        strictEqual(cleared.status, 0);
        strictEqual(cleared.stdout, 'undefined');

        const nullish = spawnSync(
            process.execPath,
            ['-e', 'process.stdout.write(`${"A" in process.env}:${"B" in process.env}:${process.env.C}`)'],
            {
                env: { A: undefined, B: null, C: 'ok' },
                encoding: 'utf8',
            },
        );
        // Node drops only `undefined`; a `null` value is stringified, so B is
        // PRESENT with the literal string "null". Measured on Node v24.18.0 with
        // this exact spawnSync call: stdout is `false:true:ok` and
        // JSON.stringify(process.env.B) is `"null"`. The previous expectation
        // (`false:false:ok`) asserted that null was skipped, which no runtime does.
        strictEqual(nullish.status, 0);
        strictEqual(nullish.stdout, 'false:true:ok');
    } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
    }
});

Deno.test({ name: 'child_process: spawnSync accepts options as second argument and shell true', timeout: 10000 }, () => {
    const result = spawnSync(`"${process.execPath}" -e "process.stdout.write('shell-ok')"`, {
        shell: true,
        encoding: 'utf8',
    });
    strictEqual(result.status, 0);
    strictEqual(result.stdout, 'shell-ok');
});

Deno.test({ name: 'child_process: spawnSync with encoding returns string stdout', timeout: 10000 }, () => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("text-out")'], { encoding: 'utf8' });
    strictEqual(r.stdout, 'text-out');
});

Deno.test({ name: 'child_process: spawnSync stdio array undefined defaults to pipe', timeout: 10000 }, () => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("hello"); process.stderr.write("world");'], {
        stdio: [undefined, undefined, undefined],
        env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
        encoding: 'utf8',
    });
    strictEqual(r.status, 0);
    strictEqual(r.stdout, 'hello');
    strictEqual(r.stderr, 'world');
});

Deno.test({ name: 'child_process: spawnSync writes input to child stdin', timeout: 10000 }, () => {
    const script = 'process.stdin.on("data", chunk => process.stdout.write(chunk));';
    const r = spawnSync(process.execPath, ['-e', script], {
        input: 'sync-input',
        encoding: 'utf8',
    });
    strictEqual(r.status, 0);
    strictEqual(r.stdout, 'sync-input');

    const bytes = Buffer.from('view-input');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fromView = spawnSync(process.execPath, ['-e', script], {
        input: view,
        encoding: 'utf8',
    });
    strictEqual(fromView.status, 0);
    strictEqual(fromView.stdout, 'view-input');

    throws(() => spawnSync(process.execPath, ['-e', script], { input: {} as never }), TypeError);
});

Deno.test({ name: 'child_process upstream: process.execPath handles Node CLI eval print and warning flags', timeout: 10000 }, () => {
    const evalShort = spawnSync(process.execPath, ['-e', 'console.log("eval-test-1")'], { encoding: 'utf8' });
    strictEqual(evalShort.status, 0, evalShort.stderr);
    strictEqual(evalShort.stdout.trim(), 'eval-test-1');

    const evalLong = spawnSync(process.execPath, ['--eval', 'console.log("eval-test-2")'], { encoding: 'utf8' });
    strictEqual(evalLong.status, 0, evalLong.stderr);
    strictEqual(evalLong.stdout.trim(), 'eval-test-2');

    const printShort = spawnSync(process.execPath, ['-p', '1 + 1'], { encoding: 'utf8' });
    strictEqual(printShort.status, 0, printShort.stderr);
    strictEqual(printShort.stdout.trim(), '2');

    const printLong = spawnSync(process.execPath, ['--print', '"hello"'], { encoding: 'utf8' });
    strictEqual(printLong.status, 0, printLong.stderr);
    strictEqual(printLong.stdout.trim(), 'hello');

    const printEval = spawnSync(process.execPath, ['-pe', '2 * 3'], { encoding: 'utf8' });
    strictEqual(printEval.status, 0, printEval.stderr);
    strictEqual(printEval.stdout.trim(), '6');

    const noWarnings = spawnSync(process.execPath, ['--no-warnings', '-e', 'console.log("no-warnings-ok")'], { encoding: 'utf8' });
    strictEqual(noWarnings.status, 0, noWarnings.stderr);
    strictEqual(noWarnings.stdout.trim(), 'no-warnings-ok');

    const v8Flag = spawnSync(process.execPath, ['--max-old-space-size=100', '-e', 'console.log("v8-flags-ok")'], { encoding: 'utf8' });
    strictEqual(v8Flag.status, 0, v8Flag.stderr);
    strictEqual(v8Flag.stdout.trim(), 'v8-flags-ok');
});

Deno.test({ name: 'child_process: spawn emits spawn before stdio and exit events', timeout: 10000 }, async () => {
    const events: string[] = [];
    await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', 'process.stdout.write("ok")'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.on('spawn', () => events.push('spawn'));
        child.on('error', reject);
        child.stdout?.on('data', () => events.push('stdout:data'));
        child.stdout?.on('end', () => events.push('stdout:end'));
        child.on('exit', () => events.push('exit'));
        child.on('close', () => {
            events.push('close');
            resolve();
        });
    });

    strictEqual(events[0], 'spawn');
    ok(events.includes('stdout:data'));
    ok(events.indexOf('spawn') < events.indexOf('stdout:data'));
    ok(events.indexOf('spawn') < events.indexOf('exit'));
    ok(events.indexOf('exit') < events.indexOf('close'));
});

Deno.test({ name: 'child_process: execFile supports encoding buffer', timeout: 10000 }, async () => {
    await withTempDir('child-process-buffer', async (dir) => {
        const script = join(dir, 'buffer-output.js');
        fs.writeFileSync(script, 'process.stdout.write("Hello World!\\n");\n');
        const stdout = await new Promise<Buffer>((resolve, reject) => {
            execFile(process.execPath, [script], { encoding: 'buffer' }, (err, out) => {
                if (err) reject(err);
                else resolve(out as Buffer);
            });
        });
        ok(Buffer.isBuffer(stdout));
        strictEqual(stdout.toString('utf8'), 'Hello World!\n');
    });
});

Deno.test({ name: 'child_process: execFile enforces stdout maxBuffer before callback', timeout: 10000 }, async () => {
    await withTempDir('child-process-max-buffer', async (dir) => {
        const script = join(dir, 'stdout-output.js');
        fs.writeFileSync(script, 'process.stdout.write("yikes!\\n");\n');
        const result = await new Promise<{ err: Error & { code?: string } | null; stdout: Buffer }>((resolve) => {
            execFile(process.execPath, [script], {
                encoding: 'buffer',
                maxBuffer: 3,
                env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
            }, (err, stdout) => {
                resolve({ err: err as Error & { code?: string } | null, stdout: stdout as Buffer });
            });
        });
        ok(result.err);
        strictEqual(result.err?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
        strictEqual(result.err?.message, 'stdout maxBuffer length exceeded');
        ok(Buffer.isBuffer(result.stdout));
        strictEqual(result.stdout.toString('utf8'), 'yik');
    });
});

Deno.test({ name: 'child_process upstream: execFile enforces stderr maxBuffer before callback', timeout: 10000 }, async () => {
    await withTempDir('child-process-max-buffer-stderr', async (dir) => {
        const script = join(dir, 'stderr-output.js');
        fs.writeFileSync(script, 'process.stderr.write("yikes!\\n");\n');
        const result = await new Promise<{ err: Error & { code?: string } | null; stderr: Buffer }>((resolve) => {
            execFile(process.execPath, [script], {
                encoding: 'buffer',
                maxBuffer: 3,
                env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
            }, (err, _stdout, stderr) => {
                resolve({ err: err as Error & { code?: string } | null, stderr: stderr as Buffer });
            });
        });
        ok(result.err);
        strictEqual(result.err?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
        strictEqual(result.err?.message, 'stderr maxBuffer length exceeded');
        ok(Buffer.isBuffer(result.stderr));
        strictEqual(result.stderr.toString('utf8'), 'yik');
    });
});

Deno.test({
    name: 'child_process upstream: shell true passes arguments and supports shell pipelines',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
}, async () => {
    const echo = spawn('echo', ['foo'], { shell: true });
    const echoOut = await new Promise<string>((resolve, reject) => {
        let output = '';
        echo.stdout?.on('data', (chunk) => { output += decodeUtf8(chunk); });
        echo.on('error', reject);
        echo.on('close', () => resolve(output));
    });
    strictEqual(echo.spawnargs.at(-1)?.replace(/"/g, ''), 'echo foo');
    strictEqual(echoOut.trim(), 'foo');

    const piped = spawn('echo bar | cat', { shell: true });
    const pipedOut = await new Promise<string>((resolve, reject) => {
        let output = '';
        piped.stdout?.on('data', (chunk) => { output += decodeUtf8(chunk); });
        piped.on('error', reject);
        piped.on('close', () => resolve(output));
    });
    strictEqual(pipedOut.trim(), 'bar');
});

Deno.test({ name: 'child_process upstream: spawn missing command emits platform errno', timeout: 10000 }, async () => {
    const err = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        const child = spawn('no-such-command-for-cno-tests');
        child.on('error', (error) => resolve(error as NodeJS.ErrnoException));
        child.on('exit', () => reject(new Error('missing command should not exit normally')));
    });

    if (Deno.build.os === 'windows') strictEqual(err.errno, -4058);
    else strictEqual(err.errno, -2);
});

// CVE-2024-27980. cmd.exe re-parses a batch file's argument string, so `&` in an
// argument runs as its own command. Verified exploitable before the guard: the
// `.bat` echoed `args=["a\"]` and `INJECTED` appeared on a *separate* line,
// outside the script's own brackets. Node refuses the spawn (EINVAL) unless
// `shell` is set; asserting only "`.bat` is rejected" would not catch a
// regression that still ran the file, so assert INJECTED never executes.
Deno.test({
    name: 'child_process: refuses direct .bat/.cmd spawn (CVE-2024-27980 argument injection)',
    ignore: Deno.build.os !== 'windows',
    timeout: 20000,
}, async () => {
    await withTempDir('child-process-batcve', async (dir) => {
        const bat = join(dir, 'hello.bat');
        fs.writeFileSync(bat, '@echo off\r\necho HELLO_FROM_BAT args=[%*]\r\n');
        const cmdFile = join(dir, 'hello.cmd');
        fs.writeFileSync(cmdFile, '@echo off\r\necho HELLO_FROM_CMD args=[%*]\r\n');
        const evil = 'a" & echo INJECTED & rem "b';

        // spawnSync reports it in `error` (pid 0, status null) and runs nothing.
        const sync = spawnSync(bat, [evil], { encoding: 'utf8' });
        strictEqual(sync.status, null);
        strictEqual(String(sync.stdout ?? '').includes('INJECTED'), false, 'injected command must not run');
        strictEqual(String(sync.stdout ?? '').includes('HELLO_FROM_BAT'), false, 'the batch file must not run');
        const syncErr = sync.error as NodeJS.ErrnoException | undefined;
        ok(syncErr, 'spawnSync must report an error');
        strictEqual(syncErr?.code, 'EINVAL');
        strictEqual(syncErr?.errno, -4071);
        strictEqual(syncErr?.syscall, `spawnSync ${bat}`);
        strictEqual(syncErr?.message, `spawnSync ${bat} EINVAL`);
        strictEqual(syncErr?.path, bat);
        deepStrictEqual(Reflect.get(syncErr!, 'spawnargs'), [evil]);

        // .cmd and an uppercase extension are the same case (Node matches both).
        strictEqual((spawnSync(cmdFile, [evil], { encoding: 'utf8' }).error as NodeJS.ErrnoException).code, 'EINVAL');
        strictEqual((spawnSync(bat.toUpperCase(), [evil], { encoding: 'utf8' }).error as NodeJS.ErrnoException).code, 'EINVAL');

        // Async spawn throws synchronously — Node only defers ENOENT, not EINVAL.
        let asyncErr: NodeJS.ErrnoException | undefined;
        try {
            spawn(bat, [evil]).on('error', () => {});
        } catch (err) {
            asyncErr = err as NodeJS.ErrnoException;
        }
        ok(asyncErr, 'spawn must throw for a direct .bat');
        strictEqual(asyncErr?.message, 'spawn EINVAL');
        strictEqual(asyncErr?.code, 'EINVAL');
        strictEqual(asyncErr?.errno, -4071);
        strictEqual(asyncErr?.syscall, 'spawn');
        deepStrictEqual(Object.keys(asyncErr!), ['errno', 'code', 'syscall']);

        // execFile delegates to spawn, so it throws the same way.
        throws(() => execFile(bat, [evil], () => {}), (err: NodeJS.ErrnoException) => err.code === 'EINVAL');

        // `shell: true` is the documented escape hatch: it runs, and the argument
        // stays one literal token inside the brackets (no separate INJECTED line).
        const viaShell = spawnSync(bat, [evil], { encoding: 'utf8', shell: true });
        strictEqual(viaShell.status, 0);
        const shellOut = String(viaShell.stdout ?? '');
        strictEqual(shellOut.includes('HELLO_FROM_BAT'), true, shellOut);
        strictEqual(/args=\[[^\]\r\n]*INJECTED[^\]\r\n]*\]/.test(shellOut), true, shellOut);
        strictEqual(/^INJECTED/m.test(shellOut), false, `INJECTED must stay inside args=[…]: ${shellOut}`);

        // A real .exe is unaffected, including the extensionless PATHEXT form.
        const exe = spawnSync(Deno.execPath(), ['--version'], { encoding: 'utf8' });
        strictEqual(exe.status, 0);
    });
});

// Every entry point, plain AND injecting, against the payload. The whole point of
// the guard is that `INJECTED` never executes, so each case asserts on the child's
// actual output rather than only on the error shape. Error shapes below were all
// measured against real Node v24.18 on Windows.
//
// exec/execSync are deliberately NOT refused: they pass `shell: options.shell ?? true`,
// and Node exempts them the same way, so they DO run the injected command. That is
// upstream behaviour, not a cno bug — asserting it here stops someone "fixing" it
// into a divergence.
Deno.test({
    name: 'child_process: CVE-2024-27980 entry-point matrix (spawn/spawnSync/execFile/execFileSync refuse, exec/execSync exempt)',
    ignore: Deno.build.os !== 'windows',
    timeout: 30000,
}, async () => {
    await withTempDir('child-process-batmatrix', async (dir) => {
        const bat = join(dir, 'hello.bat');
        fs.writeFileSync(bat, '@echo off\r\necho HELLO_BAT args=[%*]\r\n');
        const cmdFile = join(dir, 'hello.cmd');
        fs.writeFileSync(cmdFile, '@echo off\r\necho HELLO_CMD args=[%*]\r\n');
        const EVIL = 'a" & echo INJECTED & rem "b';
        const quoted = (p: string) => `"${p}"`;

        const noInjection = (out: string, label: string) => {
            strictEqual(out.includes('INJECTED'), false, `${label}: injected command ran: ${out}`);
        };

        // --- spawn: throws synchronously, bare `spawn EINVAL` (no path/spawnargs).
        for (const [label, file] of [['bat', bat], ['cmd', cmdFile], ['BAT-upper', bat.toUpperCase()]] as const) {
            for (const [argLabel, args] of [['plain', ['plainarg']], ['injecting', [EVIL]]] as const) {
                let thrown: NodeJS.ErrnoException | undefined;
                try {
                    spawn(file, args as string[]).on('error', () => {});
                } catch (err) {
                    thrown = err as NodeJS.ErrnoException;
                }
                ok(thrown, `spawn ${label}/${argLabel} must throw`);
                strictEqual(thrown?.code, 'EINVAL');
                strictEqual(thrown?.errno, -4071);
                strictEqual(thrown?.message, 'spawn EINVAL');
                strictEqual(thrown?.syscall, 'spawn');
                deepStrictEqual(Object.keys(thrown!), ['errno', 'code', 'syscall']);
            }
        }

        // --- spawnSync: reports via `error`, status null, and carries path/spawnargs.
        for (const [argLabel, args] of [['plain', ['plainarg']], ['injecting', [EVIL]]] as const) {
            const r = spawnSync(bat, args as string[], { encoding: 'utf8' });
            const out = String(r.stdout ?? '') + String(r.stderr ?? '');
            noInjection(out, `spawnSync ${argLabel}`);
            strictEqual(out.includes('HELLO_BAT'), false, `spawnSync ${argLabel}: script ran`);
            strictEqual(r.status, null);
            const err = r.error as NodeJS.ErrnoException;
            strictEqual(err?.code, 'EINVAL');
            strictEqual(err?.message, `spawnSync ${bat} EINVAL`);
            strictEqual(err?.path, bat);
            deepStrictEqual(Reflect.get(err, 'spawnargs'), args);
        }

        // --- execFile: delegates to spawn, so it throws synchronously too.
        for (const [argLabel, args] of [['plain', ['plainarg']], ['injecting', [EVIL]]] as const) {
            throws(
                () => execFile(bat, args as string[], () => {}),
                (err: NodeJS.ErrnoException) => err.code === 'EINVAL' && err.message === 'spawn EINVAL',
                `execFile ${argLabel}`,
            );
        }

        // --- execFileSync: rethrows the spawnSync error, decorated with the result.
        for (const [argLabel, args] of [['plain', ['plainarg']], ['injecting', [EVIL]]] as const) {
            let thrown: NodeJS.ErrnoException | undefined;
            try {
                execFileSync(bat, args as string[], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (err) {
                thrown = err as NodeJS.ErrnoException;
            }
            ok(thrown, `execFileSync ${argLabel} must throw`);
            noInjection(String(Reflect.get(thrown!, 'stdout') ?? ''), `execFileSync ${argLabel}`);
            strictEqual(thrown?.code, 'EINVAL');
            strictEqual(Reflect.get(thrown!, 'status'), null);
            // Node builds this by ObjectAssign(err, result), so `error` is the error
            // itself. Callers doing `e.error?.code` rely on it being present.
            strictEqual(Reflect.get(thrown!, 'error'), thrown);
        }

        // --- exec / execSync: EXEMPT (shell ?? true), matching Node. They run, and
        // the injected command DOES execute — cmd.exe re-parses the string. Asserted
        // so the exemption stays deliberate and visible.
        const execOut = await new Promise<string>((resolve) => {
            exec(`${quoted(bat)} plainarg`, (_e, stdout, stderr) => resolve(String(stdout) + String(stderr)));
        });
        strictEqual(execOut.includes('HELLO_BAT'), true, execOut);
        noInjection(execOut, 'exec plain');

        const execEvil = await new Promise<string>((resolve) => {
            exec(`${quoted(bat)} "${EVIL.replace(/"/g, '""')}"`, (_e, stdout, stderr) => resolve(String(stdout) + String(stderr)));
        });
        strictEqual(execEvil.includes('INJECTED'), true, `exec is shell-exempt like Node: ${execEvil}`);

        const execSyncPlain = String(execSync(`${quoted(bat)} plainarg`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
        strictEqual(execSyncPlain.includes('HELLO_BAT'), true, execSyncPlain);
        noInjection(execSyncPlain, 'execSync plain');
        const execSyncEvil = String(execSync(`${quoted(bat)} "${EVIL.replace(/"/g, '""')}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
        strictEqual(execSyncEvil.includes('INJECTED'), true, `execSync is shell-exempt like Node: ${execSyncEvil}`);
    });
});

// The PATHEXT trap: `spawn('D:/tools/build')` where only `build.bat` exists. A guard
// that tested the raw string would miss it, but Node does NOT run it either — it
// reports ENOENT, because CreateProcess cannot launch a batch file (measured on
// v24.18: ENOENT, not EINVAL). So the batch file must never execute AND the code
// must be ENOENT. resolveCommandFile enforces this by refusing to let the PATHEXT
// probe resolve onto .bat/.cmd.
Deno.test({
    name: 'child_process: extensionless command resolving to .bat is ENOENT and never runs (PATHEXT)',
    ignore: Deno.build.os !== 'windows',
    timeout: 20000,
}, async () => {
    await withTempDir('child-process-pathext-bat', async (dir) => {
        fs.writeFileSync(join(dir, 'build.bat'), '@echo off\r\necho HELLO_BUILD args=[%*]\r\n');
        const spec = join(dir, 'build');
        const EVIL = 'a" & echo INJECTED & rem "b';

        const sync = spawnSync(spec, [EVIL], { encoding: 'utf8' });
        const syncOut = String(sync.stdout ?? '') + String(sync.stderr ?? '');
        strictEqual(syncOut.includes('INJECTED'), false, `injected command ran: ${syncOut}`);
        strictEqual(syncOut.includes('HELLO_BUILD'), false, `batch file ran: ${syncOut}`);
        const syncErr = sync.error as NodeJS.ErrnoException;
        strictEqual(syncErr?.code, 'ENOENT');
        strictEqual(syncErr?.errno, -4058);
        strictEqual(syncErr?.message, `spawnSync ${spec} ENOENT`);
        strictEqual(syncErr?.path, spec);
        // Node's ENOENT carries spawnargs, and the key order is errno-first.
        deepStrictEqual(Reflect.get(syncErr, 'spawnargs'), [EVIL]);
        deepStrictEqual(Object.keys(syncErr), ['errno', 'code', 'syscall', 'path', 'spawnargs']);

        // Async spawn defers ENOENT to the 'error' event (unlike EINVAL).
        const asyncErr = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
            const child = spawn(spec, [EVIL]);
            let out = '';
            child.stdout?.on('data', (c) => { out += decodeUtf8(c); });
            child.on('error', (e) => {
                strictEqual(out.includes('INJECTED'), false, out);
                resolve(e as NodeJS.ErrnoException);
            });
            child.on('exit', () => reject(new Error('must not exit normally')));
        });
        strictEqual(asyncErr.code, 'ENOENT');
        deepStrictEqual(Reflect.get(asyncErr, 'spawnargs'), [EVIL]);
    });
});

// Relative commands resolve against the CHILD's cwd. Node runs
// `spawnSync('./tool.exe', { cwd: dir })` when dir holds the file even though the
// parent cwd does not (measured on v24.18). cno's native layer resolves against the
// parent instead — CreateProcessW(NULL, cmdline, …) parses the program out of the
// command line, and lpCurrentDirectory only sets where the child starts — so the JS
// layer pre-resolves to an absolute path. Regressing that turns a working spawn into
// a spurious ENOENT.
Deno.test({
    name: 'child_process: relative command resolves against options.cwd, not the parent cwd',
    ignore: Deno.build.os !== 'windows',
    timeout: 20000,
}, async () => {
    await withTempDir('child-process-relcwd', async (dir) => {
        // A real executable is required — copy one that is guaranteed present.
        const src = join(Deno.env.get('SystemRoot') ?? 'C:\\Windows', 'System32', 'where.exe');
        const tool = join(dir, 'tool.exe');
        fs.copyFileSync(src, tool);

        const viaCwd = spawnSync('./tool.exe', ['/?'], { encoding: 'utf8', cwd: dir });
        strictEqual(viaCwd.error, undefined, String(viaCwd.error?.message));
        strictEqual(viaCwd.status, 0);

        // The extensionless PATHEXT form must work the same way.
        const extensionless = spawnSync('./tool', ['/?'], { encoding: 'utf8', cwd: dir });
        strictEqual(extensionless.error, undefined, String(extensionless.error?.message));
        strictEqual(extensionless.status, 0);

        // Without cwd it is genuinely missing, and spawnfile keeps the caller's spec.
        const missing = spawnSync('./tool.exe', ['/?'], { encoding: 'utf8' });
        strictEqual((missing.error as NodeJS.ErrnoException | undefined)?.code, 'ENOENT');

        const child = spawn('./tool.exe', ['/?'], { cwd: dir, stdio: 'ignore' });
        strictEqual(child.spawnfile, './tool.exe');
        deepStrictEqual(child.spawnargs, ['./tool.exe', '/?']);
        await new Promise<void>((resolve) => child.on('close', () => resolve()));
    });
});

// A directory is not a runnable command: Node reports ENOENT for `spawn('./adir')`
// (measured on v24.18). An existence check that counts directories would let it
// through to the native layer and surface a codeless InternalError instead.
Deno.test({ name: 'child_process: spawning a directory reports ENOENT', timeout: 15000 }, async () => {
    await withTempDir('child-process-dirspawn', async (dir) => {
        const sub = join(dir, 'adir');
        fs.mkdirSync(sub, { recursive: true });

        const r = spawnSync(sub, ['x'], { encoding: 'utf8' });
        const err = r.error as NodeJS.ErrnoException | undefined;
        strictEqual(err?.code, 'ENOENT');
        strictEqual(err?.path, sub);
        strictEqual(r.status, null);

        const asyncErr = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
            const child = spawn(sub, ['x']);
            child.on('error', (e) => resolve(e as NodeJS.ErrnoException));
            child.on('exit', () => reject(new Error('must not exit normally')));
        });
        strictEqual(asyncErr.code, 'ENOENT');
    });
});

// Node decorates a pre-existing exec/execFile failure (spawn error, maxBuffer) with
// `cmd` ONLY — killed/signal appear solely on the exit-status error it builds itself.
// Measured on v24.18: ENOENT gives [errno,code,syscall,path,spawnargs,cmd] and
// maxBuffer gives [code,cmd], while a non-zero exit gives [code,killed,signal,cmd].
Deno.test({ name: 'child_process: execFile error decoration matches Node per failure kind', timeout: 20000 }, async () => {
    const missing = await new Promise<NodeJS.ErrnoException>((resolve) => {
        execFile(join('.', 'no-such-cno-execfile-target'), ['a'], (err) => resolve(err as NodeJS.ErrnoException));
    });
    strictEqual(missing.code, 'ENOENT');
    strictEqual(Reflect.has(missing, 'killed'), false, 'spawn error must not carry killed');
    strictEqual(Reflect.has(missing, 'signal'), false, 'spawn error must not carry signal');
    ok(Reflect.has(missing, 'cmd'), 'spawn error must carry cmd');

    const exited = await new Promise<NodeJS.ErrnoException>((resolve) => {
        execFile(process.execPath, ['-e', 'process.exit(7)'], (err) => resolve(err as NodeJS.ErrnoException));
    });
    strictEqual(exited.code as unknown as number, 7);
    strictEqual(Reflect.get(exited, 'killed'), false);
    strictEqual(Reflect.get(exited, 'signal'), null);

    const overflow = await new Promise<NodeJS.ErrnoException>((resolve) => {
        execFile(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], { maxBuffer: 10 }, (err) => resolve(err as NodeJS.ErrnoException));
    });
    strictEqual(overflow.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    strictEqual(Reflect.has(overflow, 'killed'), false, 'maxBuffer error must not carry killed');
    strictEqual(Reflect.has(overflow, 'signal'), false, 'maxBuffer error must not carry signal');
});

// execSync/execFileSync throw an Error carrying the whole spawnSync result. Node
// builds it with ObjectAssign(err, result), so a result that has an `error` yields a
// self-referencing `error` key — and a plain non-zero exit has no `error` key at all.
Deno.test({ name: 'child_process: execFileSync/execSync error carries the spawnSync result shape', timeout: 20000 }, () => {
    let nonZero: NodeJS.ErrnoException | undefined;
    try {
        execFileSync(process.execPath, ['-e', 'process.exit(3)'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
        nonZero = err as NodeJS.ErrnoException;
    }
    ok(nonZero, 'non-zero exit must throw');
    strictEqual(Reflect.get(nonZero!, 'status'), 3);
    strictEqual(Reflect.has(nonZero!, 'error'), false, 'a plain non-zero exit has no `error` key');
    deepStrictEqual(Object.keys(nonZero!), ['status', 'signal', 'output', 'pid', 'stdout', 'stderr']);

    let spawnFailure: NodeJS.ErrnoException | undefined;
    try {
        execFileSync(join('.', 'no-such-cno-execfilesync-target'), ['a'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
        spawnFailure = err as NodeJS.ErrnoException;
    }
    ok(spawnFailure, 'missing command must throw');
    strictEqual(spawnFailure?.code, 'ENOENT');
    strictEqual(Reflect.get(spawnFailure!, 'error'), spawnFailure, '`error` must be the error itself');
    strictEqual(Reflect.get(spawnFailure!, 'status'), null);
});

Deno.test({ name: 'child_process upstream: kill can be called repeatedly without throwing', timeout: 10000 }, async () => {
    await withTempDir('child-process-kill-repeat', async (dir) => {
        const script = join(dir, 'loop.js');
        fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
        const child = fork(script, [], {
            silent: true,
            env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
        });
        try {
            const closed = new Promise<void>((resolve, reject) => {
                child.on('error', reject);
                child.on('close', () => resolve());
            });
            strictEqual(child.kill(), true);
            strictEqual(child.kill(), false);
            await closed;
        } finally {
            try { child.kill('SIGKILL'); } catch {}
        }
    });
});

Deno.test({ name: 'child_process upstream: fork buffers child messages until listener is attached', timeout: 10000 }, async () => {
    await withTempDir('child-process-ipc-buffer', async (dir) => {
        const script = join(dir, 'child.js');
        fs.writeFileSync(script, `
            process.send('hello');
            process.send('world');
            console.error('sent messages');
            process.on('message', (message) => {
                if (message === 'ready') process.disconnect();
            });
        `);

        const child = fork(script, [], {
            silent: true,
            env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
        });
        const messages: unknown[] = [];
        await new Promise<void>((resolve, reject) => {
            child.on('error', reject);
            child.stderr?.on('data', (chunk) => {
                if (!String(chunk).includes('sent messages')) return;
                child.on('message', (message) => messages.push(message));
                child.send('ready');
            });
            child.on('close', () => resolve());
        });

        deepStrictEqual(messages, ['hello', 'world']);
    });
});

Deno.test({ name: 'child_process: fork child exits after IPC listener is removed', timeout: 10000 }, async () => {
    await withTempDir('child-process-ipc-unref', async (dir) => {
        const script = join(dir, 'child.js');
        fs.writeFileSync(script, `
            const onMessage = () => {};
            process.on('message', onMessage);
            process.off('message', onMessage);
            process.stdout.write('removed');
        `);

        const child = fork(script, [], {
            silent: true,
            env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
        });
        const timeout = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
        }, 3000);

        try {
            const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>((resolve, reject) => {
                let stdout = '';
                child.stdout?.on('data', (chunk) => (stdout += decodeUtf8(chunk)));
                child.on('error', reject);
                child.on('close', (code, signal) => resolve({ code, signal, stdout }));
            });
            strictEqual(result.code, 0);
            strictEqual(result.signal, null);
            strictEqual(result.stdout, 'removed');
        } finally {
            clearTimeout(timeout);
            try { child.kill('SIGKILL'); } catch {}
        }
    });
});

Deno.test({ name: 'child_process upstream: fork json IPC serializes typed array views as arrays', timeout: 10000 }, async () => {
    await withTempDir('child-process-ipc-json', async (dir) => {
        const script = join(dir, 'child.js');
        fs.writeFileSync(script, `
            const shared = new SharedArrayBuffer(3);
            new Uint8Array(shared).set([4, 5, 6]);
            process.send({
                bytes: new Uint8Array([1, 2, 3]),
                nested: { shared: new Uint8Array(shared) },
            });
            process.disconnect();
        `);

        const child = fork(script, [], {
            silent: true,
            env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
        });
        const message = await new Promise<any>((resolve, reject) => {
            child.on('message', resolve);
            child.on('error', reject);
        });

        deepStrictEqual(message, {
            bytes: [1, 2, 3],
            nested: { shared: [4, 5, 6] },
        });
    });
});

Deno.test({ name: 'child_process upstream: fork advanced IPC preserves structured values', timeout: 10000 }, async () => {
    await withTempDir('child-process-ipc-advanced', async (dir) => {
        const script = join(dir, 'child.js');
        fs.writeFileSync(script, `
            process.on('message', (message) => {
                process.send({
                    big: message.big + 1n,
                    view: new Uint8Array([4, 5, 6]),
                    receivedView: Array.from(message.view),
                    mapValue: message.map.get('key'),
                    setHas: message.set.has(7),
                });
                process.disconnect();
            });
        `);

        const child = fork(script, [], {
            silent: true,
            env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
            serialization: 'advanced',
        });
        const reply = await new Promise<any>((resolve, reject) => {
            child.on('message', resolve);
            child.on('error', reject);
            child.send({
                big: 41n,
                view: new Uint8Array([1, 2, 3]),
                map: new Map([['key', 'value']]),
                set: new Set([7]),
            });
        });

        strictEqual(reply.big, 42n);
        ok(reply.view instanceof Uint8Array);
        deepStrictEqual(Array.from(reply.view), [4, 5, 6]);
        deepStrictEqual(reply.receivedView, [1, 2, 3]);
        strictEqual(reply.mapValue, 'value');
        strictEqual(reply.setHas, true);
    });
});

Deno.test({ name: 'child_process upstream: send after IPC close reports ERR_IPC_CHANNEL_CLOSED', timeout: 10000 }, async () => {
    await withTempDir('child-process-ipc-closed', async (dir) => {
        const script = join(dir, 'child.js');
        fs.writeFileSync(script, 'process.disconnect();\n');

        const child = fork(script, [], {
            silent: true,
            env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
        });
        const code = await new Promise<string | undefined>((resolve, reject) => {
            child.on('error', reject);
            child.on('disconnect', () => {
                const sent = child.send('late', (error) => resolve((error as NodeJS.ErrnoException | null)?.code));
                strictEqual(sent, false);
            });
        });

        strictEqual(code, 'ERR_IPC_CHANNEL_CLOSED');
    });
});

Deno.test({ name: 'child_process upstream: spawn supports ipc stdio entry outside fd 3 tuple shape', timeout: 10000 }, async () => {
    await withTempDir('child-process-stdio-ipc', async (dir) => {
        const script = join(dir, 'child.mjs');
        fs.writeFileSync(script, `
            import process from 'node:process';
            process.send('hahah');
        `);

        const child = spawn(process.execPath, [script], {
            stdio: ['ipc', 'ignore', 'ignore'],
            env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
        });
        const message = await new Promise<unknown>((resolve, reject) => {
            child.on('message', resolve);
            child.on('error', reject);
        });

        strictEqual(message, 'hahah');
        child.kill();
    });
});

Deno.test({ name: 'child_process upstream: spawn exposes extra pipe stdio entries by fd index', timeout: 10000 }, async () => {
    await withTempDir('child-process-extra-pipes', async (dir) => {
        const script = join(dir, 'child.mjs');
        fs.writeFileSync(script, `
            const streams = import.meta.use('streams');
            const engine = import.meta.use('engine');
            const pipe = new streams.Pipe();
            pipe.open(4);
            pipe.onread = (data, err) => {
                if (err) {
                    console.error(String(err));
                    pipe.close();
                    process.exit(1);
                    return;
                }
                if (!data) {
                    pipe.close();
                    return;
                }
                if (engine.decodeString(data) === 'start') {
                    pipe.write(engine.encodeString('hello world'))
                        .then(() => pipe.close());
                }
            };
            pipe.startRead();
        `);

        const child = spawn(process.execPath, [script], {
            stdio: ['ignore', 'ignore', 'inherit', 'ignore', 'pipe'],
            env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
        });
        const extra = child.stdio[4];
        ok(extra, 'child.stdio[4] must expose the requested extra pipe');
        strictEqual(child.stdio[3], null);

        const result = await new Promise<{ code: number | null; got: string }>((resolve, reject) => {
            let got = '';
            extra.on('data', (chunk) => { got += decodeUtf8(chunk); });
            extra.on('error', reject);
            child.on('error', reject);
            child.on('close', (code) => resolve({ code, got }));
            extra.write('start');
        });

        strictEqual(result.code, 0);
        strictEqual(result.got, 'hello world');
    });
});

// The IPC channel must be DUPLEX. An anonymous _pipe() on Windows is
// unidirectional: child->parent worked while every parent->child send() failed
// EPIPE (-4047). Node reference, measured on v24.18.0: send() === true, then
// messages ["ready", {"echo":{"hello":1}}].
Deno.test({ name: 'child_process upstream: fork IPC round-trips parent send to child and back', timeout: 15000 }, async () => {
    await withTempDir('child-process-ipc-roundtrip', async (dir) => {
        const script = join(dir, 'child.js');
        fs.writeFileSync(script, `
            process.send('ready');
            process.on('message', (m) => {
                process.send({ echo: m });
                process.disconnect();
            });
        `);

        const child = fork(script, [], {
            silent: true,
            env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
        });
        const messages: unknown[] = [];
        let sendReturned: unknown = '<send never called>';
        let sendCallbackError: unknown = '<callback never fired>';

        try {
            await new Promise<void>((resolve, reject) => {
                child.on('error', reject);
                child.on('message', (message) => {
                    messages.push(message);
                    if (messages.length !== 1) return;
                    sendReturned = child.send({ hello: 1 }, (error) => {
                        sendCallbackError = error === null || error === undefined ? null : String(error);
                    });
                });
                child.on('close', () => resolve());
            });

            deepStrictEqual(messages[0], 'ready', 'child->parent direction must deliver the first message');
            strictEqual(sendReturned, true, `parent->child send() must return true, got ${String(sendReturned)} (callback error: ${String(sendCallbackError)})`);
            strictEqual(sendCallbackError, null, `send() must not report a write error, got ${String(sendCallbackError)}`);
            deepStrictEqual(messages, ['ready', { echo: { hello: 1 } }], 'the child must receive the payload and echo it back');
        } finally {
            try { child.kill('SIGKILL'); } catch {}
        }
    });
});

Deno.test({ name: 'child_process upstream: fork IPC survives repeated parent sends in both directions', timeout: 15000 }, async () => {
    await withTempDir('child-process-ipc-pingpong', async (dir) => {
        const script = join(dir, 'child.js');
        fs.writeFileSync(script, `
            process.on('message', (m) => {
                if (m === 'stop') { process.disconnect(); return; }
                process.send(m * 2);
            });
            process.send('go');
        `);

        const child = fork(script, [], {
            silent: true,
            env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
        });
        const replies: number[] = [];
        const sendResults: unknown[] = [];
        const sendErrors: string[] = [];
        // Supplying a callback keeps a write failure off the 'error' event, so a
        // broken channel surfaces as a failed assertion rather than a rejection.
        const record = (error: Error | null) => { if (error) sendErrors.push(String(error)); };

        try {
            await new Promise<void>((resolve, reject) => {
                child.on('error', reject);
                child.on('message', (message) => {
                    if (message === 'go') {
                        for (const n of [1, 2, 3, 4, 5]) sendResults.push(child.send(n, record));
                        // Nothing will come back on a broken channel; stop waiting.
                        if (sendResults.some((r) => r === false)) child.kill('SIGKILL');
                        return;
                    }
                    replies.push(message as number);
                    if (replies.length === 5) sendResults.push(child.send('stop', record));
                });
                child.on('close', () => resolve());
            });

            deepStrictEqual(sendErrors, [], `no send() may report a write error, got ${sendErrors.join('; ')}`);
            deepStrictEqual(sendResults, [true, true, true, true, true, true], 'every send() must succeed');
            deepStrictEqual(replies, [2, 4, 6, 8, 10], 'each payload must reach the child intact');
        } finally {
            try { child.kill('SIGKILL'); } catch {}
        }
    });
});

Deno.test({ name: 'child_process upstream: fork execArgv conditions affect child package exports', timeout: 10000 }, async () => {
    await withTempDir('child-process-fork-conditions', async (dir) => {
        const pkgDir = join(dir, 'node_modules', 'test-pkg');
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
            name: 'test-pkg',
            exports: {
                '.': {
                    custom: './custom.cjs',
                    default: './default.cjs',
                },
            },
        }));
        fs.writeFileSync(join(pkgDir, 'default.cjs'), 'module.exports = { type: "default" };\n');
        fs.writeFileSync(join(pkgDir, 'custom.cjs'), 'module.exports = { type: "custom" };\n');
        const script = join(dir, 'child.js');
        fs.writeFileSync(script, `
            const pkg = require('test-pkg');
            process.send({ type: pkg.type, execArgv: process.execArgv });
            process.disconnect();
        `);

        const run = (execArgv?: string[]) => new Promise<any>((resolve, reject) => {
            const child = fork(script, [], {
                silent: true,
                cwd: dir,
                execArgv,
                env: { ...process.env, CTS_DISABLE_CACHE: 'true' },
            });
            child.on('message', resolve);
            child.on('error', reject);
        });

        const plain = await run();
        strictEqual(plain.type, 'default');

        const longFlag = await run(['--conditions=custom']);
        strictEqual(longFlag.type, 'custom');
        deepStrictEqual(longFlag.execArgv, ['--conditions=custom']);

        const shortFlag = await run(['-C', 'custom']);
        strictEqual(shortFlag.type, 'custom');
        deepStrictEqual(shortFlag.execArgv, ['-C', 'custom']);

        const denoStyle = await run(['run', '-A', '--conditions=custom']);
        strictEqual(denoStyle.type, 'custom');
        deepStrictEqual(denoStyle.execArgv, ['--conditions=custom']);
    });
});
