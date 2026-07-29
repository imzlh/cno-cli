import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';

const process = import.meta.use('process');
const engine = import.meta.use('engine');

const decoder = new TextDecoder();

function spawnOutputPty(): CModuleProcess.ChildProcess<true> {
    return process.spawn(['/bin/sh'], {
        pty: true,
        name: '/bin/sh',
        argv: ['/bin/sh', '-c', 'printf x'],
        cols: 80,
        rows: 24,
        env: {},
    });
}

function closeStream(stream: CModuleStreams.Pipe): void {
    try {
        stream.close();
    } catch {}
}

async function withTimeout<T>(promise: Promise<T>, ms = 10000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

Deno.test({
    name: 'CNO PTY: async read maps Linux master EIO to zero-byte EOF',
    ignore: Deno.build.os === 'windows',
    fn: async () => {
        const child = spawnOutputPty();
        const stream = child.readable;
        const buffer = new Uint8Array(16);
        try {
            const status = child.waitSync();
            strictEqual(status.exit_status, 0);
            strictEqual(status.term_signal, null);
            const cachedStatus = child.waitSync();
            strictEqual(cachedStatus.exit_status, 0);
            strictEqual(cachedStatus.term_signal, null);
            const n = await stream.read(buffer);
            strictEqual(n, 1);
            strictEqual(decoder.decode(buffer.subarray(0, n)), 'x');
            strictEqual(await stream.read(buffer), 0);
        } finally {
            closeStream(stream);
        }
    },
});

Deno.test({
    name: 'CNO PTY: sync read maps Linux master EIO to null EOF',
    ignore: Deno.build.os === 'windows',
    fn: () => {
        const child = spawnOutputPty();
        const stream = child.readable;
        const buffer = new Uint8Array(16);
        let output = '';
        try {
            const status = child.waitSync();
            strictEqual(status.exit_status, 0);
            strictEqual(status.term_signal, null);
            while (true) {
                const n = stream.readSync(buffer);
                if (n === null) break;
                ok(n > 0);
                output += decoder.decode(buffer.subarray(0, n));
            }
            strictEqual(output, 'x');
            strictEqual(stream.readSync(buffer), null);
        } finally {
            closeStream(stream);
        }
    },
});

Deno.test({
    name: 'CNO PTY: callback read reports EOF instead of EIO',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
    fn: async () => {
        const child = spawnOutputPty();
        const stream = child.readable;
        const chunks: string[] = [];
        let callbackCount = 0;
        try {
            const eof = new Promise<void>((resolve, reject) => {
                stream.onread = (data, error) => {
                    callbackCount++;
                    if (error !== undefined) {
                        reject(error);
                        return;
                    }
                    if (data === null) {
                        resolve();
                        return;
                    }
                    chunks.push(engine.decodeString(data));
                };
            });
            stream.startRead();
            throws(() => stream.startRead(), /startRead already in progress/);
            const status = child.waitSync();
            strictEqual(status.exit_status, 0);
            strictEqual(status.term_signal, null);
            await eof;
            await new Promise((resolve) => setTimeout(resolve, 10));
            strictEqual(chunks.join(''), 'x');
            strictEqual(callbackCount, 2);
            stream.stopRead();
            stream.stopRead();
            stream.close();
            stream.close();
        } finally {
            closeStream(stream);
        }
    },
});

Deno.test({
    name: 'CNO PTY: canceling a one-shot read does not consume another pin',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
    fn: async () => {
        for (let i = 0; i < 50; i++) {
            const child = spawnOutputPty();
            const stream = child.readable;
            const pending = stream.read(new Uint8Array(1));
            stream.cancelRead();
            let canceled = false;
            await pending.catch(() => {
                canceled = true;
            });
            strictEqual(canceled, true);
            child.waitSync();
            stream.close();
        }
    },
});

Deno.test({
    name: 'CNO.openpty: forwards argv and exposes resize/getwinsize with EOF',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
    fn: async () => {
        const pty = await CNO.openpty({
            name: '/bin/sh',
            argv: ['/bin/sh', '-c', 'printf high-level'],
            cols: 80,
            rows: 24,
            env: {},
        });
        const initialSize = pty.getwinsize();
        strictEqual(initialSize.cols, 80);
        strictEqual(initialSize.rows, 24);
        pty.resize(100, 30);
        const resized = pty.getwinsize();
        strictEqual(resized.cols, 100);
        strictEqual(resized.rows, 30);

        const reader = pty.readable.getReader();
        const chunks: string[] = [];
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            chunks.push(decoder.decode(result.value));
        }
        reader.releaseLock();
        strictEqual(chunks.join(''), 'high-level');
        const status = await pty.wait();
        strictEqual(status.exitStatus, 0);
        strictEqual(status.termSignal, null);
    },
});

Deno.test({
    name: 'CNO process: waitSync settles pending normal and PTY waits',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
    fn: async () => {
        const child = process.spawn(['/bin/sh', '-c', 'sleep 0.02; exit 7'], {
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
        });
        const pending = child.wait();
        strictEqual(child.wait(), pending);
        const syncStatus = child.waitSync();
        strictEqual(syncStatus.exit_status, 7);
        strictEqual(syncStatus.term_signal, null);
        const asyncStatus = await withTimeout(pending);
        strictEqual(asyncStatus.exit_status, 7);
        strictEqual(asyncStatus.term_signal, null);
        const cached = await child.wait();
        deepStrictEqual(
            { exit_status: cached.exit_status, term_signal: cached.term_signal },
            { exit_status: 7, term_signal: null },
        );
        child.kill();

        const ptyChild = process.spawn(['/bin/sh'], {
            pty: true,
            name: '/bin/sh',
            argv: ['/bin/sh', '-c', 'sleep 0.02; exit 6'],
            env: {},
        });
        const stream = ptyChild.readable;
        try {
            const ptyPending = ptyChild.wait();
            strictEqual(ptyChild.wait(), ptyPending);
            const ptySyncStatus = ptyChild.waitSync();
            strictEqual(ptySyncStatus.exit_status, 6);
            strictEqual(ptySyncStatus.term_signal, null);
            const ptyAsyncStatus = await withTimeout(ptyPending);
            strictEqual(ptyAsyncStatus.exit_status, 6);
            strictEqual(ptyAsyncStatus.term_signal, null);
        } finally {
            closeStream(stream);
        }
    },
});

Deno.test({
    name: 'CNO process: normal and PTY children stay pinned until exit',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
    fn: async () => {
        let child: CModuleProcess.ChildProcess | undefined = process.spawn(
            ['/bin/sh', '-c', 'sleep 0.05; exit 5'],
            { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        );
        const normalWait = child.wait();
        child = undefined;
        engine.gc.run();
        const normalStatus = await withTimeout(normalWait);
        strictEqual(normalStatus.exit_status, 5);

        let ptyChild: CModuleProcess.ChildProcess<true> | undefined = spawnOutputPty();
        const stream = ptyChild.readable;
        const ptyWait = ptyChild.wait();
        ptyChild = undefined;
        engine.gc.run();
        const ptyStatus = await withTimeout(ptyWait);
        strictEqual(ptyStatus.exit_status, 0);
        closeStream(stream);
    },
});

Deno.test({
    name: 'CNO PTY: async wait leaves the event loop responsive',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
    fn: async () => {
        const pty = await CNO.openpty({
            argv: ['/bin/sh', '-c', 'sleep 0.1; exit 3'],
            env: {},
        });
        let ticked = false;
        const tick = new Promise<void>((resolve) => {
            setTimeout(() => {
                ticked = true;
                resolve();
            }, 1);
        });
        const wait = pty.wait();
        strictEqual(pty.wait(), wait);
        const status = await withTimeout(wait);
        strictEqual(pty.wait(), wait);
        await tick;
        strictEqual(ticked, true);
        strictEqual(status.exitStatus, 3);
        strictEqual(status.termSignal, null);
        const reader = pty.readable.getReader();
        await reader.cancel();
        reader.releaseLock();
    },
});

Deno.test({
    name: 'CNO PTY: async wait and large output drain concurrently',
    ignore: Deno.build.os === 'windows',
    timeout: 15000,
    fn: async () => {
        const pty = await CNO.openpty({
            argv: ['/bin/sh', '-c', 'dd if=/dev/zero bs=65536 count=32 2>/dev/null'],
            env: {},
        });
        const reader = pty.readable.getReader();
        const readAll = (async () => {
            let total = 0;
            try {
                while (true) {
                    const result = await reader.read();
                    if (result.done) break;
                    total += result.value.byteLength;
                }
                return total;
            } finally {
                reader.releaseLock();
            }
        })();
        const [status, total] = await withTimeout(Promise.all([pty.wait(), readAll]));
        strictEqual(status.exitStatus, 0);
        strictEqual(status.termSignal, null);
        ok(total >= 32 * 65536, `expected at least 2 MiB, got ${total}`);
    },
});

Deno.test({
    name: 'CNO.openpty: Windows preserves quotes and backslashes in argv',
    ignore: Deno.build.os !== 'windows',
    timeout: 10000,
    fn: async () => {
        const expected = [
            'C:\\plain\\path',
            'space tail\\',
            'quoted"slash\\value',
            '',
        ];
        const pty = await CNO.openpty({
            name: Deno.execPath(),
            argv: [
                Deno.execPath(),
                'eval',
                "console.log('ARGS:' + JSON.stringify(Deno.args) + ':END')",
                ...expected,
            ],
        });
        const reader = pty.readable.getReader();
        const output = (async () => {
            let text = '';
            try {
                while (true) {
                    const result = await reader.read();
                    if (result.done) break;
                    text += decoder.decode(result.value);
                }
                return text;
            } finally {
                reader.releaseLock();
            }
        })();
        const [status, text] = await withTimeout(Promise.all([pty.wait(), output]));
        strictEqual(status.exitStatus, 0);
        const match = /ARGS:(\[.*\]):END/.exec(text);
        ok(match, `missing argv payload in ${JSON.stringify(text)}`);
        deepStrictEqual(JSON.parse(match[1]), expected);
    },
});
