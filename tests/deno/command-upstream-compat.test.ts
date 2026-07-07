// Derived from Deno upstream unit/command_test.ts public API cases.
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import { decodeUtf8 } from '../_helpers/bytes.ts';

Deno.test({ name: 'deno command upstream: non-piped stdio getters throw', timeout: 10000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'console.log("ignored")'],
        stdout: 'null',
        stderr: 'null',
    }).spawn();

    throws(() => child.stdin, TypeError);
    throws(() => child.stdout, TypeError);
    throws(() => child.stderr, TypeError);

    const status = await child.status;
    strictEqual(status.success, true);
    strictEqual(status.code, 0);
    strictEqual(status.signal, null);
});

Deno.test({ name: 'deno command upstream: spawned child exposes ChildProcess public shape', timeout: 10000 }, async () => {
    strictEqual(typeof Deno.ChildProcess, 'function');
    strictEqual(typeof Deno.Process, 'function');
    throws(() => new (Deno.ChildProcess as unknown as new () => Deno.ChildProcess)(), TypeError);
    throws(() => new (Deno.Process as unknown as new () => Deno.Process)(), TypeError);

    const command = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'Deno.exit(0)'],
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
    });
    deepStrictEqual(Object.keys(command), []);

    const child = command.spawn();
    ok(child instanceof Deno.ChildProcess);
    strictEqual(child instanceof Deno.Process, false);
    deepStrictEqual(Object.keys(child), []);
    ok(Number.isInteger(child.pid) && child.pid > 0);
    ok(child.status instanceof Promise);

    const status = await child.status;
    strictEqual(status.success, true);
    strictEqual(status.code, 0);
    strictEqual(status.signal, null);
});

Deno.test({ name: 'deno command upstream: piped stdout and stderr stream to completion', timeout: 10000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            await Deno.stdout.write(new TextEncoder().encode('out'));
            await Deno.stderr.write(new TextEncoder().encode('err'));
        `],
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();

    throws(() => child.stdin, TypeError);

    const stdoutReader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    const stderrReader = child.stderr.pipeThrough(new TextDecoderStream()).getReader();
    const stdout = await stdoutReader.read();
    const stderr = await stderrReader.read();
    const stdoutEnd = await stdoutReader.read();
    const stderrEnd = await stderrReader.read();
    stdoutReader.releaseLock();
    stderrReader.releaseLock();

    strictEqual(stdout.done, false);
    strictEqual(stdout.value, 'out');
    strictEqual(stderr.done, false);
    strictEqual(stderr.value, 'err');
    strictEqual(stdoutEnd.done, true);
    strictEqual(stderrEnd.done, true);

    const status = await child.status;
    strictEqual(status.success, true);
    strictEqual(status.code, 0);
    strictEqual(status.signal, null);
});

Deno.test({ name: 'deno command upstream: subprocess readable helpers drain bytes text json and arrayBuffer', timeout: 10000 }, async () => {
    const jsonChild = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'console.log(JSON.stringify({ value: 42, ok: true }))'],
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();
    const [json, jsonStatus] = await Promise.all([
        jsonChild.stdout.json(),
        jsonChild.status,
    ]);
    deepStrictEqual(json, { value: 42, ok: true });
    strictEqual(jsonStatus.success, true);

    const bytesChild = new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            await Deno.stdout.write(new Uint8Array([1, 2, 3, 4]));
            await Deno.stderr.write(new Uint8Array([5, 6]));
        `],
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();
    const [stdout, stderr, bytesStatus] = await Promise.all([
        bytesChild.stdout.bytes(),
        bytesChild.stderr.arrayBuffer(),
        bytesChild.status,
    ]);
    deepStrictEqual([...stdout], [1, 2, 3, 4]);
    deepStrictEqual([...new Uint8Array(stderr)], [5, 6]);
    strictEqual(bytesStatus.success, true);
});

Deno.test({ name: 'deno command upstream: piped stdin writes into child process', timeout: 10000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            const buffer = new Uint8Array(5);
            const n = await Deno.stdin.read(buffer);
            await Deno.stdout.write(buffer.subarray(0, n ?? 0));
        `],
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'null',
    }).spawn();

    throws(() => child.stderr, TypeError);

    const writer = child.stdin.getWriter();
    await writer.write(Buffer.from('hello'));
    writer.releaseLock();
    await child.stdin.close();

    strictEqual(await child.stdout.text(), 'hello');
    const status = await child.status;
    strictEqual(status.success, true);
    strictEqual(status.code, 0);
    strictEqual(status.signal, null);
});

Deno.test('deno command upstream: output captures stdout and stderr by default', async () => {
    const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', 'console.log("default-out"); console.error("default-err")'],
    }).output();

    strictEqual(output.success, true);
    strictEqual(output.code, 0);
    strictEqual(output.signal, null);
    strictEqual(decodeUtf8(output.stdout).trim(), 'default-out');
    strictEqual(decodeUtf8(output.stderr).trim(), 'default-err');
});

Deno.test('deno command upstream: outputSync keeps stdout and stderr separate', () => {
    const output = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'console.log("sync-out"); console.error("sync-err")'],
    }).outputSync();

    ok(output.success);
    strictEqual(decodeUtf8(output.stdout).trim(), 'sync-out');
    strictEqual(decodeUtf8(output.stderr).trim(), 'sync-err');
});

Deno.test('deno command upstream: output rejects non-piped stdio and piped stdin', async () => {
    await rejects(
        () => new Deno.Command(Deno.execPath(), {
            args: ['eval', 'console.log("hidden")'],
            stdout: 'null',
        }).output(),
        /Cannot get 'stdout': 'stdout' is not piped/,
    );
    await rejects(
        () => new Deno.Command(Deno.execPath(), {
            args: ['eval', 'console.error("hidden")'],
            stderr: 'inherit',
        }).output(),
        /Cannot get 'stderr': 'stderr' is not piped/,
    );
    await rejects(
        () => new Deno.Command(Deno.execPath(), {
            args: ['eval', ''],
            stdin: 'piped',
        }).output(),
        /Piped stdin is not supported/,
    );

    await rejects(
        () => new Deno.Command(Deno.execPath(), {
            args: ['eval', 'console.log("hidden")'],
            stdout: 'null',
            stderr: 'piped',
        }).spawn().output(),
        /Cannot get 'stdout': 'stdout' is not piped/,
    );

    throws(
        () => new Deno.Command(Deno.execPath(), {
            args: ['eval', ''],
            stdin: 'piped',
        }).outputSync(),
        /Piped stdin is not supported/,
    );
});

Deno.test('deno command upstream: invalid stdio variants throw before spawning', async () => {
    for (const key of ['stdin', 'stdout', 'stderr'] as const) {
        const options = { args: ['eval', ''], [key]: 'bad' } as Deno.CommandOptions;
        throws(() => new Deno.Command(Deno.execPath(), options).spawn(), /unknown variant `bad`/);
        await rejects(() => new Deno.Command(Deno.execPath(), options).output(), /unknown variant `bad`/);
        throws(() => new Deno.Command(Deno.execPath(), options).outputSync(), /unknown variant `bad`/);
    }
});

Deno.test({ name: 'deno command upstream: child output drains pipes while waiting', timeout: 10000 }, async () => {
    const chunkSize = 4096;
    const chunks = 96;
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            const chunk = new Uint8Array(${chunkSize});
            chunk.fill(65);
            for (let i = 0; i < ${chunks}; i++) await Deno.stdout.write(chunk);
            await Deno.stderr.write(new TextEncoder().encode('child-output-done'));
        `],
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();

    const output = await child.output();
    strictEqual(output.success, true);
    strictEqual(output.stdout.byteLength, chunkSize * chunks);
    strictEqual(decodeUtf8(output.stderr), 'child-output-done');
});

Deno.test({ name: 'deno command upstream: invalid signals throw before native kill', timeout: 10000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'setTimeout(() => {}, 10000)'],
        stdout: 'null',
        stderr: 'null',
    }).spawn();

    try {
        throws(() => child.kill('SIGEMT' as Deno.Signal), TypeError);
        throws(() => child.kill('CNO_BAD_SIGNAL' as Deno.Signal), TypeError);

        for (const sig of ['SIGIO', 'SIGUNUSED'] as const) {
            try {
                Deno.kill(999999999, sig as Deno.Signal);
            } catch (err) {
                ok(!String((err as Error).message).includes('Invalid signal'), `${sig} should be accepted as a signal alias`);
            }
        }
    } finally {
        try { child.kill('SIGKILL'); } catch {}
        await child.status;
    }
});

Deno.test({ name: 'deno command upstream: kill supports default numeric and check-only signals', timeout: 10000 }, async () => {
    const defaultKill = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'setTimeout(() => {}, 10000)'],
        stdout: 'null',
        stderr: 'null',
    }).spawn();
    defaultKill.kill();
    const defaultStatus = await defaultKill.status;
    strictEqual(defaultStatus.success, false);
    if (Deno.build.os !== 'windows') {
        strictEqual(defaultStatus.signal, 'SIGTERM');
        strictEqual(defaultStatus.code, 143);
    }

    const numericKill = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'setTimeout(() => {}, 10000)'],
        stdout: 'null',
        stderr: 'null',
    }).spawn();
    numericKill.kill(9);
    const numericStatus = await numericKill.status;
    strictEqual(numericStatus.success, false);
    if (Deno.build.os !== 'windows') {
        strictEqual(numericStatus.signal, 'SIGKILL');
        strictEqual(numericStatus.code, 137);
    }

    const checkOnly = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'setTimeout(() => {}, 10000)'],
        stdout: 'null',
        stderr: 'null',
    }).spawn();
    checkOnly.kill(0);
    checkOnly.kill('SIGTERM');
    const checkStatus = await checkOnly.status;
    strictEqual(checkStatus.success, false);
    if (Deno.build.os !== 'windows') strictEqual(checkStatus.signal, 'SIGTERM');
});

Deno.test({ name: 'deno command upstream: asyncDispose terminates running child', timeout: 10000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'setTimeout(() => {}, 10000)'],
        stdout: 'null',
        stderr: 'null',
    }).spawn();

    let disposedSignal: Deno.Signal | null | undefined;
    const statusSeen = child.status.then((status) => {
        disposedSignal = status.signal;
    });
    await child[Symbol.asyncDispose]();
    await statusSeen;

    if (Deno.build.os === 'windows') strictEqual(disposedSignal, null);
    else strictEqual(disposedSignal, 'SIGTERM');
});

Deno.test({ name: 'deno command upstream: env inherits by default and clearEnv isolates child env', timeout: 10000 }, async () => {
    const parentKey = 'CNO_COMMAND_PARENT_ENV';
    const childKey = 'CNO_COMMAND_CHILD_ENV';
    Deno.env.set(parentKey, 'from-parent');
    try {
        const code = `
            console.log(JSON.stringify({
                parent: Deno.env.get('${parentKey}') ?? null,
                child: Deno.env.get('${childKey}') ?? null,
            }));
        `;

        const inherited = await new Deno.Command(Deno.execPath(), {
            args: ['eval', code],
            env: { [childKey]: 'from-child' },
        }).output();
        strictEqual(inherited.success, true);
        strictEqual(decodeUtf8(inherited.stderr), '');
        strictEqual(decodeUtf8(inherited.stdout).trim(), JSON.stringify({
            parent: 'from-parent',
            child: 'from-child',
        }));

        const cleared = await new Deno.Command(Deno.execPath(), {
            args: ['eval', code],
            clearEnv: true,
            env: { [childKey]: 'from-child' },
        }).output();
        strictEqual(cleared.success, true);
        strictEqual(decodeUtf8(cleared.stderr), '');
        strictEqual(decodeUtf8(cleared.stdout).trim(), JSON.stringify({
            parent: null,
            child: 'from-child',
        }));

        const clearedOnly = await new Deno.Command(Deno.execPath(), {
            args: ['eval', `console.log(Deno.env.get('${parentKey}') ?? 'missing')`],
            clearEnv: true,
        }).output();
        strictEqual(clearedOnly.success, true);
        strictEqual(decodeUtf8(clearedOnly.stderr), '');
        strictEqual(decodeUtf8(clearedOnly.stdout).trim(), 'missing');

        const clearedSync = new Deno.Command(Deno.execPath(), {
            args: ['eval', code],
            clearEnv: true,
            env: { [childKey]: 'from-child-sync' },
        }).outputSync();
        strictEqual(clearedSync.success, true);
        strictEqual(decodeUtf8(clearedSync.stderr), '');
        strictEqual(decodeUtf8(clearedSync.stdout).trim(), JSON.stringify({
            parent: null,
            child: 'from-child-sync',
        }));

        const clearedOnlySync = new Deno.Command(Deno.execPath(), {
            args: ['eval', `console.log(Deno.env.get('${parentKey}') ?? 'missing-sync')`],
            clearEnv: true,
        }).outputSync();
        strictEqual(clearedOnlySync.success, true);
        strictEqual(decodeUtf8(clearedOnlySync.stderr), '');
        strictEqual(decodeUtf8(clearedOnlySync.stdout).trim(), 'missing-sync');
    } finally {
        Deno.env.delete(parentKey);
    }
});

Deno.test({ name: 'deno command upstream: invalid cwd rejects before native spawn', timeout: 10000 }, async () => {
    await rejects(async () => {
        await new Deno.Command(Deno.execPath(), {
            cwd: `${Deno.cwd()}/definitely-missing-cwd`,
        }).output();
    }, Deno.errors.NotFound);

    await rejects(async () => {
        await new Deno.Command(Deno.execPath(), {
            cwd: Deno.execPath(),
        }).output();
    }, Deno.errors.NotFound);

    throws(() => {
        new Deno.Command(Deno.execPath(), {
            cwd: Deno.execPath(),
        }).outputSync();
    }, Deno.errors.NotFound);
});

Deno.test({ name: 'deno command upstream: URL command and cwd paths are accepted', timeout: 10000 }, async () => {
    const root = Deno.makeTempDirSync({ prefix: 'cno-command-url-cwd-' });
    try {
        const output = await new Deno.Command(new URL(`file://${Deno.execPath()}`), {
            args: ['eval', 'console.log(Deno.cwd()); console.log(Deno.env.get("CNO_URL_CWD"))'],
            cwd: new URL(`file://${root}/`),
            env: { CNO_URL_CWD: 'visible' },
        }).output();
        strictEqual(output.success, true);
        strictEqual(decodeUtf8(output.stderr), '');
        deepStrictEqual(decodeUtf8(output.stdout).trim().split(/\r?\n/), [root, 'visible']);
    } finally {
        Deno.removeSync(root, { recursive: true });
    }
});

Deno.test({ name: 'deno command upstream: missing executable rejects output and outputSync throws', timeout: 10000 }, async () => {
    const root = Deno.makeTempDirSync({ prefix: 'cno-command-missing-' });
    try {
        const missing = `${root}/missing-command`;
        await rejects(async () => {
            await new Deno.Command(missing).output();
        }, Deno.errors.NotFound);

        throws(() => {
            new Deno.Command(missing).outputSync();
        }, Deno.errors.NotFound);

        throws(() => {
            new Deno.Command(missing).spawn();
        }, Deno.errors.NotFound);
    } finally {
        Deno.removeSync(root, { recursive: true });
    }
});

Deno.test({ name: 'deno command upstream: AbortSignal terminates spawned child', timeout: 10000 }, async () => {
    const ac = new AbortController();
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'for (;;) {}'],
        stdout: 'null',
        stderr: 'null',
        signal: ac.signal,
    }).spawn();
    ac.abort(new Error('stop child'));
    const status = await child.status;
    strictEqual(status.success, false);
    ok(status.code !== 0 || status.signal !== null);

    const preAborted = new AbortController();
    preAborted.abort();
    const child2 = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'for (;;) {}'],
        stdout: 'null',
        stderr: 'null',
        signal: preAborted.signal,
    }).spawn();
    const status2 = await child2.status;
    strictEqual(status2.success, false);
    ok(status2.code !== 0 || status2.signal !== null);
});

Deno.test({ name: 'deno command upstream: kill after status throws', timeout: 10000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'Deno.exit(0)'],
        stdout: 'null',
        stderr: 'null',
    }).spawn();
    const status = await child.status;
    strictEqual(status.success, true);
    throws(() => child.kill(), /Child process has already terminated/);
});

Deno.test({ name: 'deno command upstream: output after manually consuming streams returns empty pipes', timeout: 10000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', 'console.log("already-read"); console.error("already-read-err")'],
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();

    for await (const _chunk of child.stdout) {
    }
    for await (const _chunk of child.stderr) {
    }

    const output = await child.output();
    strictEqual(output.success, true);
    strictEqual(output.code, 0);
    strictEqual(output.signal, null);
    deepStrictEqual(output.stdout, new Uint8Array());
    deepStrictEqual(output.stderr, new Uint8Array());
});

Deno.test({ name: 'deno command upstream: relative executable resolves through cwd and PATH', timeout: 10000 }, async () => {
    const root = Deno.makeTempDirSync({ prefix: 'cno-command-path-' });
    const suffix = Deno.build.os === 'windows' ? '.exe' : '';
    const binDir = `${root}/bin`;
    const binPath = `${binDir}/cno-command-bin${suffix}`;
    try {
        Deno.mkdirSync(binDir);
        Deno.copyFileSync(Deno.execPath(), binPath);
        if (Deno.build.os !== 'windows') Deno.chmodSync(binPath, 0o755);

        const viaCwd = await new Deno.Command(`./cno-command-bin${suffix}`, {
            cwd: binDir,
            args: ['eval', 'console.log("cwd-bin")'],
        }).output();
        strictEqual(viaCwd.success, true);
        strictEqual(decodeUtf8(viaCwd.stdout).trim(), 'cwd-bin');

        const viaPath = await new Deno.Command(`cno-command-bin${suffix}`, {
            args: ['eval', 'console.log("path-bin")'],
            env: { PATH: binDir },
        }).output();
        strictEqual(viaPath.success, true);
        strictEqual(decodeUtf8(viaPath.stdout).trim(), 'path-bin');
    } finally {
        Deno.removeSync(root, { recursive: true });
    }
});

Deno.test({ name: 'deno command upstream: spawn shorthand overloads mirror Command methods', timeout: 10000 }, async () => {
    const child = Deno.spawn(Deno.execPath(), ['eval', 'console.log("spawn-short")'], {
        stdout: 'piped',
        stderr: 'piped',
    });
    const [stdout, stderr, status] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.status,
    ]);
    strictEqual(stdout, 'spawn-short\n');
    strictEqual(stderr, '');
    strictEqual(status.success, true);

    const waited = await Deno.spawnAndWait(Deno.execPath(), {
        args: ['eval', 'console.log("wait-out"); console.error("wait-err")'],
    });
    strictEqual(waited.success, true);
    strictEqual(decodeUtf8(waited.stdout).trim(), 'wait-out');
    strictEqual(decodeUtf8(waited.stderr).trim(), 'wait-err');

    const waitedArgs = await Deno.spawnAndWait(Deno.execPath(), ['eval', 'Deno.exit(5)']);
    strictEqual(waitedArgs.success, false);
    strictEqual(waitedArgs.code, 5);
    strictEqual(waitedArgs.signal, null);

    const sync = Deno.spawnAndWaitSync(Deno.execPath(), ['eval', 'console.log("sync-short")']);
    strictEqual(sync.success, true);
    strictEqual(decodeUtf8(sync.stdout).trim(), 'sync-short');
    strictEqual(decodeUtf8(sync.stderr), '');

    throws(() => {
        Deno.spawnAndWaitSync(Deno.execPath(), ['eval', ''], { stdin: 'piped' });
    }, /Piped stdin is not supported/);
});
