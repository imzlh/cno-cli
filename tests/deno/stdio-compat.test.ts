import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';

const decoder = new TextDecoder();

function resultLine(text: string): unknown {
    const line = text.trim().split(/\r?\n/).findLast((value) => value.startsWith('RESULT '));
    ok(line, `missing RESULT line:\n${text}`);
    return JSON.parse(line.slice('RESULT '.length));
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

Deno.test('deno stdio: facade classes and stream getters match upstream shape', () => {
    const entries = [
        ['stdin', Deno.stdin, 'Stdin'],
        ['stdout', Deno.stdout, 'Stdout'],
        ['stderr', Deno.stderr, 'Stderr'],
    ] as const;

    for (const [name, value, constructorName] of entries) {
        strictEqual(value.constructor.name, constructorName, name);
        deepStrictEqual(Object.keys(value), [], name);
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), 'rid');
        strictEqual(typeof descriptor?.get, 'function', name);
        strictEqual(descriptor?.set, undefined, name);
        strictEqual(descriptor?.enumerable, false, name);
        strictEqual(Reflect.set(value, 'rid', 99), false, name);
    }
    strictEqual(Deno.stdin.readable, Deno.stdin.readable);
    strictEqual(Deno.stdout.writable, Deno.stdout.writable);
    strictEqual(Deno.stderr.writable, Deno.stderr.writable);
    strictEqual(Deno.stdin.read.constructor.name, 'AsyncFunction');

    const reader = Deno.stdin.readable.getReader();
    strictEqual(Deno.stdin.readable.locked, true);
    throws(() => Deno.stdin.readable.getReader(), TypeError);
    reader.releaseLock();

    for (const stream of [Deno.stdout.writable, Deno.stderr.writable]) {
        const writer = stream.getWriter();
        strictEqual(stream.locked, true);
        throws(() => stream.getWriter(), TypeError);
        writer.releaseLock();
    }

    throws(() => Deno.stdout.writeSync.call({}, new Uint8Array(0)), TypeError);
});

Deno.test('deno stdio: validates byte views before zero-length shortcuts', async () => {
    const fake = { byteLength: 0 } as Uint8Array<ArrayBuffer>;
    const fakeLength = { length: 0 } as Uint8Array<ArrayBuffer>;
    const dataView = new DataView(new ArrayBuffer(0)) as unknown as Uint8Array<ArrayBuffer>;

    strictEqual(await Deno.stdin.read(fakeLength), 0);
    strictEqual(Deno.stdin.readSync(fakeLength), 0);
    await rejects(() => Deno.stdin.read(fake), TypeError);
    throws(() => Deno.stdin.readSync(dataView), TypeError);
    await rejects(() => Deno.stdout.write(fake), TypeError);
    throws(() => Deno.stdout.writeSync(dataView), TypeError);
    await rejects(() => Deno.stderr.write(fake), TypeError);
    throws(() => Deno.stderr.writeSync(dataView), TypeError);
    const isatty = Reflect.get(Deno, 'isatty') as (fd: number) => boolean;
    throws(() => isatty('1' as unknown as number), TypeError);
    strictEqual(isatty(1n as unknown as number), Deno.stdout.isTerminal());

    if (!Deno.stdin.isTerminal()) {
        throws(() => Deno.stdin.setRaw(true), Deno.errors.BadResource);
    }
});

Deno.test('deno FsFile: zero reads bypass closed-resource checks but writes do not', async () => {
    const path = Deno.makeTempFileSync({ prefix: 'cno-fsfile-empty-' });
    const file = Deno.openSync(path, { read: true, write: true });
    try {
        file.close();
        strictEqual(file.readSync(new Uint8Array(0)), 0);
        strictEqual(await file.read(new Uint8Array(0)), 0);
        throws(() => file.writeSync(new Uint8Array(0)), Deno.errors.BadResource);
        await rejects(() => file.write(new Uint8Array(0)), Deno.errors.BadResource);
    } finally {
        // The body already closed the handle; close() again throws BadResource
        // and would skip the temp-file cleanup. Symbol.dispose is idempotent.
        file[Symbol.dispose]();
        Deno.removeSync(path);
    }
});

Deno.test('deno FsFile: readable rejects when the descriptor is not readable', async () => {
    const nullDevice = Deno.build.os === 'windows' ? 'NUL' : '/dev/null';
    const file = await Deno.open(nullDevice, { write: true });
    const reader = file.readable.getReader();
    try {
        await rejects(() => reader.read(), Error);
    } finally {
        try { reader.releaseLock(); } catch {}
        // A failed pull may already have closed the handle.
        file[Symbol.dispose]();
    }
});

Deno.test({ name: 'deno stdio: closing stdin interrupts a pending read', timeout: 10000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            const pending = Deno.stdin.read(new Uint8Array(1));
            await new Promise(resolve => setTimeout(resolve, 30));
            Deno.stdin.close();
            try {
                await pending;
                console.log('RESULT ' + JSON.stringify('resolved'));
            } catch (error) {
                console.log('RESULT ' + JSON.stringify(error.name));
            }
        `],
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();

    const [stdout, stderr, status] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.status,
    ]);
    strictEqual(status.code, 0, stderr);
    strictEqual(resultLine(stdout), 'Interrupted');
});

Deno.test({ name: 'deno stdio: canceling a pending readable read stops native input', timeout: 10000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            const reader = Deno.stdin.readable.getReader();
            const pending = reader.read();
            await new Promise(resolve => setTimeout(resolve, 30));
            await reader.cancel('done');
            try {
                const result = await pending;
                console.log('RESULT ' + JSON.stringify(result));
            } catch (error) {
                console.log('RESULT ' + JSON.stringify({ error: error.name }));
            }
        `],
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();

    const [stdout, stderr, status] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.status,
    ]);
    strictEqual(status.code, 0, stderr);
    deepStrictEqual(resultLine(stdout), { done: true });
});

Deno.test({ name: 'deno stdio: readable cancel interrupts all pending fd reads', timeout: 10000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            const settle = async promise => {
                try { return await promise; }
                catch (error) { return error.name; }
            };
            const one = settle(Deno.stdin.read(new Uint8Array(1)));
            const two = settle(Deno.stdin.read(new Uint8Array(1)));
            const reader = Deno.stdin.readable.getReader();
            const pending = reader.read();
            await new Promise(resolve => setTimeout(resolve, 30));
            await reader.cancel('done');
            console.log('RESULT ' + JSON.stringify({
                one: await one,
                two: await two,
                web: await settle(pending),
            }));
        `],
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();

    const [stdout, stderr, status] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.status,
    ]);
    strictEqual(status.code, 0, stderr);
    strictEqual(stderr, '');
    deepStrictEqual(resultLine(stdout), {
        one: 'Interrupted',
        two: 'Interrupted',
        web: { done: true },
    });
});

Deno.test({
    name: 'deno stdio: cbreak preserves terminal-generated signals in raw mode',
    ignore: Deno.build.os !== 'linux',
    fn: async () => {
        const childScript = String.raw`
            const decoder = new TextDecoder();
            const ttyState = () => {
                const output = new Deno.Command('/bin/sh', {
                    args: ['-c', 'stty -a < /dev/tty'],
                    stdout: 'piped',
                    stderr: 'piped',
                }).outputSync();
                if (!output.success) throw new Error(decoder.decode(output.stderr));
                return /(?:^|[;\s])isig(?:[;\s]|$)/.test(decoder.decode(output.stdout));
            };

            const original = ttyState();
            let raw;
            let cbreak;
            try {
                Deno.stdin.setRaw(true, { cbreak: false });
                raw = ttyState();
                Deno.stdin.setRaw(true, { cbreak: true });
                cbreak = ttyState();
            } finally {
                Deno.stdin.setRaw(false);
            }
            let nullOptions;
            try {
                Reflect.apply(Deno.stdin.setRaw, Deno.stdin, [false, null]);
                nullOptions = 'accepted';
            } catch (error) {
                nullOptions = error instanceof Error ? error.name : typeof error;
            }
            console.log('RESULT ' + JSON.stringify({
                raw,
                cbreak,
                restored: ttyState() === original,
                nullOptions,
            }));
        `;
        const command = [Deno.execPath(), 'eval', childScript].map(shellQuote).join(' ');
        const output = await new Deno.Command('script', {
            args: ['-qec', command, '/dev/null'],
            stdout: 'piped',
            stderr: 'piped',
        }).output();

        strictEqual(output.code, 0, decoder.decode(output.stderr));
        deepStrictEqual(resultLine(decoder.decode(output.stdout)), {
            raw: false,
            cbreak: true,
            restored: true,
            nullOptions: 'TypeError',
        });
    },
});

Deno.test({ name: 'deno stdio: writable close owns stdout and empty writes stay valid', timeout: 10000 }, async () => {
    const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            import process from 'node:process';
            const encoder = new TextEncoder();
            const result = {};
            process.stdout.destroy();
            result.nodeDestroyed = process.stdout.destroyed;
            result.nodeClosed = process.stdout.closed;
            process.stdin.destroy();
            result.nodeStdinDestroyed = process.stdin.destroyed;
            result.nodeStdinClosed = process.stdin.closed;
            result.nodeStdinReadable = process.stdin.readable;
            const writer = Deno.stdout.writable.getWriter();
            await writer.write(new Uint8Array(0));
            await writer.close();
            for (const [name, data] of [
                ['empty', new Uint8Array(0)],
                ['nonempty', encoder.encode('x')],
            ]) {
                try {
                    await Deno.stdout.write(data);
                    result[name] = 'resolved';
                } catch (error) {
                    result[name] = error.name;
                }
            }
            try {
                Deno.stdout.close();
                result.secondClose = 'resolved';
            } catch (error) {
                result.secondClose = error.name;
            }
            try {
                process.stdout.write('x');
                result.nodeWrite = 'resolved';
            } catch (error) {
                result.nodeWrite = error.name;
            }
            Deno.stderr.writeSync(encoder.encode('RESULT ' + JSON.stringify(result) + '\\n'));
        `],
        stdout: 'piped',
        stderr: 'piped',
    }).output();

    strictEqual(output.code, 0, decoder.decode(output.stderr));
    strictEqual(decoder.decode(output.stdout), '');
    deepStrictEqual(resultLine(decoder.decode(output.stderr)), {
        empty: 'BadResource',
        nonempty: 'BadResource',
        secondClose: 'BadResource',
        nodeWrite: 'BadResource',
        nodeDestroyed: false,
        nodeClosed: false,
        nodeStdinDestroyed: true,
        nodeStdinClosed: true,
        nodeStdinReadable: false,
    });
});

Deno.test({
    name: 'deno stdio: redirected stdout shares the operating-system file cursor',
    ignore: Deno.build.os === 'windows',
    fn: async () => {
        const path = Deno.makeTempFileSync({ prefix: 'cno-stdio-out-' });
        try {
            const child = await new Deno.Command('/bin/sh', {
                args: [
                    '-c',
                    'exec "$1" eval "$2" > "$3"',
                    'stdio-test',
                    Deno.execPath(),
                    `console.log('A'); Deno.stdout.writeSync(new TextEncoder().encode('B')); console.log('C')`,
                    path,
                ],
                stdout: 'piped',
                stderr: 'piped',
            }).output();
            strictEqual(child.code, 0, decoder.decode(child.stderr));
            strictEqual(Deno.readTextFileSync(path), 'A\nBC\n');
        } finally {
            Deno.removeSync(path);
        }
    },
});

Deno.test({
    name: 'deno stdio: redirected stdin shares its cursor with node fs',
    ignore: Deno.build.os === 'windows',
    fn: async () => {
        const path = Deno.makeTempFileSync({ prefix: 'cno-stdio-in-' });
        try {
            Deno.writeTextFileSync(path, 'abc');
            const child = await new Deno.Command('/bin/sh', {
                args: [
                    '-c',
                    'exec "$1" eval "$2" < "$3"',
                    'stdio-test',
                    Deno.execPath(),
                    `
                        import { readSync } from 'node:fs';
                        const first = new Uint8Array(1);
                        const second = new Uint8Array(1);
                        Deno.stdin.readSync(first);
                        readSync(0, second, 0, 1, null);
                        console.log(String.fromCharCode(first[0], second[0]));
                    `,
                    path,
                ],
                stdout: 'piped',
                stderr: 'piped',
            }).output();
            strictEqual(child.code, 0, decoder.decode(child.stderr));
            strictEqual(decoder.decode(child.stdout), 'ab\n');
        } finally {
            Deno.removeSync(path);
        }
    },
});

Deno.test({
    name: 'deno stdio: redirected stdout shares the operating-system file cursor (Windows)',
    ignore: Deno.build.os !== 'windows',
    fn: async () => {
        // Windows counterpart of the /bin/sh test above. `cmd`'s own `>` gives the
        // child a real regular-file handle for fd 1, which is the condition under
        // test; the redirection lives in a .cmd wrapper because cmd.exe applies no
        // backslash escaping, so an inline command line cannot carry a quoted exe
        // path (measured: Node's spawn behaves identically, this is not a cno bug).
        const out = Deno.makeTempFileSync({ prefix: 'cno-stdio-out-' });
        const script = Deno.makeTempFileSync({ prefix: 'cno-stdio-s1-', suffix: '.mjs' });
        const wrapper = Deno.makeTempFileSync({ prefix: 'cno-stdio-b1-', suffix: '.cmd' });
        try {
            Deno.writeTextFileSync(
                script,
                `console.log('A'); Deno.stdout.writeSync(new TextEncoder().encode('B')); console.log('C')`,
            );
            Deno.writeTextFileSync(wrapper, `@echo off\r\n"${Deno.execPath()}" run "${script}" > "${out}"\r\n`);
            const child = await new Deno.Command('cmd', {
                args: ['/d', '/s', '/c', wrapper],
                stdout: 'piped',
                stderr: 'piped',
            }).output();
            strictEqual(child.code, 0, decoder.decode(child.stderr));
            strictEqual(Deno.readTextFileSync(out), 'A\nBC\n');
        } finally {
            for (const path of [out, script, wrapper]) Deno.removeSync(path);
        }
    },
});

Deno.test({
    name: 'deno stdio: redirected stdin shares its cursor with node fs (Windows)',
    ignore: Deno.build.os !== 'windows',
    fn: async () => {
        const input = Deno.makeTempFileSync({ prefix: 'cno-stdio-in-' });
        const script = Deno.makeTempFileSync({ prefix: 'cno-stdio-s2-', suffix: '.mjs' });
        const wrapper = Deno.makeTempFileSync({ prefix: 'cno-stdio-b2-', suffix: '.cmd' });
        try {
            Deno.writeTextFileSync(input, 'abc');
            Deno.writeTextFileSync(
                script,
                `
                    import { readSync } from 'node:fs';
                    const first = new Uint8Array(1);
                    const second = new Uint8Array(1);
                    Deno.stdin.readSync(first);
                    readSync(0, second, 0, 1, null);
                    console.log(String.fromCharCode(first[0], second[0]));
                `,
            );
            Deno.writeTextFileSync(wrapper, `@echo off\r\n"${Deno.execPath()}" run "${script}" < "${input}"\r\n`);
            const child = await new Deno.Command('cmd', {
                args: ['/d', '/s', '/c', wrapper],
                stdout: 'piped',
                stderr: 'piped',
            }).output();
            strictEqual(child.code, 0, decoder.decode(child.stderr));
            strictEqual(decoder.decode(child.stdout), 'ab\n');
        } finally {
            for (const path of [input, script, wrapper]) Deno.removeSync(path);
        }
    },
});

Deno.test({
    name: 'deno FsFile: /dev/full preserves ENOSPC for zero and nonzero writes',
    ignore: Deno.build.os !== 'linux',
    fn: async () => {
        const encoder = new TextEncoder();
        for (const size of [0, 1]) {
            const syncFile = Deno.openSync('/dev/full', { write: true });
            try {
                try {
                    syncFile.writeSync(encoder.encode('x').subarray(0, size));
                    throw new Error(`sync write unexpectedly succeeded (${size})`);
                } catch (error) {
                    strictEqual(Reflect.get(error, 'name'), 'Error');
                    strictEqual(Reflect.get(error, 'code'), 'ENOSPC');
                }
            } finally {
                syncFile.close();
            }

            const asyncFile = await Deno.open('/dev/full', { write: true });
            try {
                try {
                    await asyncFile.write(encoder.encode('x').subarray(0, size));
                    throw new Error(`async write unexpectedly succeeded (${size})`);
                } catch (error) {
                    strictEqual(Reflect.get(error, 'name'), 'Error');
                    strictEqual(Reflect.get(error, 'code'), 'ENOSPC');
                }
            } finally {
                asyncFile.close();
            }
        }
    },
});

Deno.test({
    name: 'deno FsFile: tty handles use stream I/O and expose terminal controls',
    ignore: Deno.build.os !== 'linux',
    fn: async () => {
        const childScript = String.raw`
            const result = {};
            const file = Deno.openSync('/dev/tty', { read: true, write: true });
            result.terminal = file.isTerminal();
            result.syncWrite = file.writeSync(new Uint8Array([84]));
            result.asyncWrite = await file.write(new Uint8Array([85]));
            file.setRaw(true, { cbreak: true });
            Reflect.apply(file.setRaw, file, [false, 1]);
            result.primitiveOptions = 'accepted';
            try {
                Reflect.apply(file.setRaw, file, [false, null]);
                result.nullOptions = 'accepted';
            } catch (error) {
                result.nullOptions = error.name;
            }
            file.setRaw(false);
            file.close();
            result.closedTerminal = file.isTerminal();
            try {
                file.setRaw(false);
                result.closedRaw = 'resolved';
            } catch (error) {
                result.closedRaw = error.name;
            }
            console.log('\nRESULT ' + JSON.stringify(result));
        `;
        const command = [Deno.execPath(), 'eval', childScript].map(shellQuote).join(' ');
        const output = await new Deno.Command('script', {
            args: ['-qec', command, '/dev/null'],
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        strictEqual(output.code, 0, decoder.decode(output.stderr));
        deepStrictEqual(resultLine(decoder.decode(output.stdout)), {
            terminal: true,
            syncWrite: 1,
            asyncWrite: 1,
            primitiveOptions: 'accepted',
            nullOptions: 'TypeError',
            closedTerminal: false,
            closedRaw: 'BadResource',
        });
    },
});

Deno.test({
    name: 'deno FsFile: Windows TTY retains the descriptor owned by libuv',
    ignore: Deno.build.os !== 'windows',
    fn: async () => {
        // CONOUT$ must be opened for reading too: libuv's handle probe calls
        // GetConsoleMode, which needs GENERIC_READ, so a write-only console
        // handle is classified as a plain file and isTerminal() reports false.
        const file = Deno.openSync('CONOUT$', { read: true, write: true });
        try {
            strictEqual(file.isTerminal(), true);
            strictEqual(await file.write(new Uint8Array([0])), 1);
        } finally {
            file.close();
        }
    },
});

Deno.test({
    name: 'deno stdio: missing standard descriptors are normalized to null devices',
    ignore: Deno.build.os === 'windows',
    fn: async () => {
        const resultPath = Deno.makeTempFileSync({ prefix: 'cno-stdio-normalized-' });
        try {
            const childScript = String.raw`
                import { fstatSync } from 'node:fs';
                const result = {};
                for (const fd of [0, 1, 2]) {
                    try {
                        const stat = fstatSync(fd);
                        result[fd] = {
                            character: stat.isCharacterDevice(),
                            file: stat.isFile(),
                        };
                    } catch (error) {
                        result[fd] = { name: error.name, code: error.code };
                    }
                }
                try { result.read = Deno.stdin.readSync(new Uint8Array(1)); }
                catch (error) { result.read = { name: error.name, code: error.code }; }
                try { result.out = Deno.stdout.writeSync(new Uint8Array([65])); }
                catch (error) { result.out = { name: error.name, code: error.code }; }
                try { result.err = Deno.stderr.writeSync(new Uint8Array([65])); }
                catch (error) { result.err = { name: error.name, code: error.code }; }
                Deno.writeTextFileSync(Deno.env.get('CNO_STDIO_RESULT'), JSON.stringify(result));
            `;
            const child = new Deno.Command('/bin/sh', {
                args: [
                    '-c',
                    'exec 0<&-; exec 1>&-; exec 2>&-; exec "$1" eval "$2"',
                    'stdio-test',
                    Deno.execPath(),
                    childScript,
                ],
                env: { CNO_STDIO_RESULT: resultPath },
                stdin: 'null',
                stdout: 'null',
                stderr: 'null',
            }).spawn();
            const status = await child.status;
            strictEqual(status.code, 0);
            deepStrictEqual(JSON.parse(Deno.readTextFileSync(resultPath)), {
                0: { character: true, file: false },
                1: { character: true, file: false },
                2: { character: true, file: false },
                read: null,
                out: 1,
                err: 1,
            });
        } finally {
            Deno.removeSync(resultPath);
        }
    },
});

Deno.test({
    name: 'deno stdio: sync stdin reads can block alongside pending async reads',
    timeout: 10000,
    fn: async () => {
        const child = new Deno.Command(Deno.execPath(), {
            args: ['eval', `
                const asyncBuffer = new Uint8Array(1);
                const syncBuffer = new Uint8Array(1);
                const pending = Deno.stdin.read(asyncBuffer);
                await new Promise(resolve => setTimeout(resolve, 30));
                const result = {};
                try {
                    result.syncCount = Deno.stdin.readSync(syncBuffer);
                    result.syncByte = syncBuffer[0];
                } catch (error) {
                    result.syncError = { name: error.name, code: error.code };
                }
                try {
                    result.asyncCount = await pending;
                    result.asyncByte = asyncBuffer[0];
                } catch (error) {
                    result.asyncError = { name: error.name, code: error.code };
                }
                console.log('RESULT ' + JSON.stringify(result));
            `],
            stdin: 'piped',
            stdout: 'piped',
            stderr: 'piped',
        }).spawn();
        const writer = child.stdin.getWriter();
        await new Promise(resolve => setTimeout(resolve, 100));
        await writer.write(new TextEncoder().encode('ab'));
        await writer.close();
        const [stdout, stderr, status] = await Promise.all([
            child.stdout.text(),
            child.stderr.text(),
            child.status,
        ]);
        strictEqual(status.code, 0, stderr);
        const result = resultLine(stdout) as Record<string, unknown>;
        strictEqual(result.syncCount, 1);
        strictEqual(result.asyncCount, 1);
        deepStrictEqual([result.syncByte, result.asyncByte].sort(), [97, 98]);
        strictEqual(result.syncError, undefined);
        strictEqual(result.asyncError, undefined);
    },
});
