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
    // POSIX-only by construction, and it stays that way now that Windows can
    // reach EOF: `strictEqual(chunks.join(''), 'high-level')` demands a
    // byte-faithful relay, and ConPTY is a terminal emulator, not a pipe -- it
    // wraps the payload in a VT preamble/teardown (measured: 86 bytes of
    // ESC[?9001h ESC[?1004h ESC[?25l ESC[2J ESC[m ESC[H ... ESC[?9001l
    // ESC[?1004l). argv, resize and getwinsize already have dedicated Windows
    // coverage below, so the Windows counterpart asserts EOF specifically
    // rather than restating them: see
    // 'Windows master pipe reaches EOF after the child exits'.
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
    // POSIX-only tooling (dd, /dev/zero), not POSIX-only behaviour. The Windows
    // counterpart is 'Windows large output drains fully and reaches EOF' below.
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

/*
 * Windows ConPTY notes — read this before "fixing" the tests below.
 *
 * Two defects in pty_win_spawn()/process_finish() (circu.js/src/mod_process.c)
 * have since been fixed; the constraints they left behind still shape what a
 * Windows PTY test may legitimately assert:
 *
 * 1. The child is ATTACHED to the pseudoconsole (a child running `mode con`
 *    reports the exact cols/rows passed to CNO.openpty) AND its stdio is now
 *    bound to it: pty_win_spawn sets STARTF_USESTDHANDLES with three NULL
 *    handles so ConPTY supplies real ConDrv handles. Previously the child kept
 *    cno's std handle values under any redirection and its bytes landed on the
 *    PARENT's stdout, leaving the master pipe carrying only ConPTY's 16-byte
 *    init sequence. Note `mode con` reporting the right size never proved stdio
 *    was bound -- mode.com opens CONOUT$ explicitly, bypassing std handles.
 *
 * 2. EOF on the master pipe is reachable. ConPTY owns the write end and holds
 *    it open until ClosePseudoConsole(); process_finish() now calls that the
 *    moment the child is reaped (via pty_win_close_hpcon(), which nulls p->hpc
 *    first so the GC finalizer's later call is a no-op), so a read-to-`done`
 *    loop terminates instead of hanging to the harness timeout.
 *
 * What is still NOT true on Windows is a byte-faithful relay: ConPTY is a
 * terminal emulator. Measured on this build, the master pipe carries the child
 * payload verbatim but wrapped in a constant 86 bytes of VT --
 * ESC[?9001h ESC[?1004h ESC[?25l ESC[2J ESC[m ESC[H at the head and
 * ESC[?9001l ESC[?1004l at the tail (86 bytes at payloads of 176 B, 1 MiB and
 * 2 MiB alike). So an exact-equality assertion on the drained text is wrong on
 * Windows even though the bytes are all there; assert the payload and a
 * sentinel, not a raw total. The argv test below still reports through a FILE:
 * that keeps the quoting path (pty_win_spawn -> spawn_sync_build_win_cmdline)
 * under test without depending on the relay's framing.
 */

Deno.test({
    name: 'CNO.openpty: Windows preserves quotes and backslashes in argv',
    ignore: Deno.build.os !== 'windows',
    timeout: 10000,
    fn: async () => {
        // Matches Node's non-verbatim child_process.spawn quoting: every element
        // arrives at the child byte-for-byte, including a trailing backslash, an
        // embedded double quote, and an empty argument.
        const expected = [
            'C:\\plain\\path',
            'space tail\\',
            'quoted"slash\\value',
            '',
        ];
        const report = Deno.makeTempFileSync({ prefix: 'cno-pty-argv-' });
        try {
            const pty = await CNO.openpty({
                name: Deno.execPath(),
                argv: [
                    Deno.execPath(),
                    'eval',
                    // Reported through a file: the ConPTY relay cannot carry it.
                    `Deno.writeTextFileSync(${JSON.stringify(report)}, JSON.stringify(Deno.args))`,
                    ...expected,
                ],
            });
            const status = await withTimeout(pty.wait());
            strictEqual(status.exitStatus, 0);
            strictEqual(status.termSignal, null);
            deepStrictEqual(JSON.parse(Deno.readTextFileSync(report)), expected);
        } finally {
            try {
                Deno.removeSync(report);
            } catch {}
        }
    },
});

Deno.test({
    name: 'CNO.openpty: Windows applies cols/rows to the child pseudoconsole',
    ignore: Deno.build.os !== 'windows',
    timeout: 10000,
    fn: async () => {
        // `mode con` queries the CONSOLE, so this proves the child really is
        // attached to our pseudoconsole rather than inheriting the parent's.
        // Redirect to a bare filename with `cwd` set, so the command line carries no
        // nested quotes: the Windows quoter escapes `"` as `\"`, which cmd does not
        // understand.
        const dir = Deno.makeTempDirSync({ prefix: 'cno-pty-size-' });
        const report = dir + '\\mode.txt';
        try {
            const pty = await CNO.openpty({
                name: 'cmd.exe',
                argv: ['cmd.exe', '/c', 'mode con > mode.txt'],
                cwd: dir,
                cols: 120,
                rows: 40,
            });
            const initial = pty.getwinsize();
            strictEqual(initial.cols, 120);
            strictEqual(initial.rows, 40);
            const status = await withTimeout(pty.wait());
            strictEqual(status.exitStatus, 0);
            const text = Deno.readTextFileSync(report);
            const columns = /Columns:\s*(\d+)/.exec(text);
            const lines = /Lines:\s*(\d+)/.exec(text);
            ok(columns, `no Columns in ${JSON.stringify(text)}`);
            ok(lines, `no Lines in ${JSON.stringify(text)}`);
            strictEqual(Number(columns[1]), 120);
            strictEqual(Number(lines[1]), 40);
        } finally {
            try {
                Deno.removeSync(dir, { recursive: true });
            } catch {}
        }
    },
});

Deno.test({
    name: 'CNO.openpty: Windows resize updates the reported winsize',
    ignore: Deno.build.os !== 'windows',
    timeout: 10000,
    fn: async () => {
        // Long-lived child so ResizePseudoConsole targets a live pseudoconsole.
        const pty = await CNO.openpty({
            name: Deno.execPath(),
            argv: [Deno.execPath(), 'eval', 'await new Promise((r) => setTimeout(r, 3000))'],
            cols: 80,
            rows: 24,
        });
        try {
            deepStrictEqual(
                { cols: pty.getwinsize().cols, rows: pty.getwinsize().rows },
                { cols: 80, rows: 24 },
            );
            pty.resize(132, 50);
            deepStrictEqual(
                { cols: pty.getwinsize().cols, rows: pty.getwinsize().rows },
                { cols: 132, rows: 50 },
            );
        } finally {
            pty.kill('SIGKILL');
            await withTimeout(pty.wait()).catch(() => {});
        }
    },
});

Deno.test({
    name: 'CNO.openpty: Windows child stdout reaches the master pipe',
    // Was BLOCKED on a C defect in pty_win_spawn(): CreateProcessW was called
    // without STARTF_USESTDHANDLES, so CreateProcess propagated *cno's* std handle
    // values into the child and the pseudoconsole attach only replaced them when
    // they were already console handles. Under any redirection -- a test harness,
    // CI, MSYS bash -- the child kept cno's stdio and wrote there, so the master
    // pipe carried only ConPTY's 16-byte init sequence.
    //
    // Fixed by setting STARTF_USESTDHANDLES with all three handles NULL, which
    // makes ConPTY supply real ConDrv handles. bInheritHandles stays false; setting
    // it TRUE is actively harmful (the child receives cno's literal handle value,
    // which under a console parent is not inheritable and arrives as ftype=0).
    // Note `mode con` reporting the right size never proved stdio was bound --
    // mode.com opens CONOUT$ explicitly, bypassing std handles entirely.
    ignore: Deno.build.os !== 'windows',
    timeout: 10000,
    fn: async () => {
        const pty = await CNO.openpty({
            name: 'cmd.exe',
            argv: ['cmd.exe', '/c', 'echo RELAY_OK'],
        });
        const reader = pty.readable.getReader();
        let text = '';
        try {
            while (!text.includes('RELAY_OK')) {
                const result = await withTimeout(reader.read(), 5000);
                if (result.done) break;
                text += decoder.decode(result.value);
            }
        } finally {
            reader.releaseLock();
        }
        ok(text.includes('RELAY_OK'), `master pipe never carried child output: ${JSON.stringify(text)}`);
    },
});

Deno.test({
    name: 'CNO.openpty: Windows master pipe reaches EOF after the child exits',
    // Windows counterpart to the EOF half of the POSIX
    // 'forwards argv and exposes resize/getwinsize with EOF'. Deliberately does
    // NOT restate argv/resize/getwinsize -- the three tests above already cover
    // those on Windows -- so a failure here points at exactly one thing:
    // process_finish() no longer releasing the pseudoconsole when the child is
    // reaped. Kept minimal on purpose: it isolates EOF from throughput, which
    // the large-drain test below cannot (that one could fail for either).
    //
    // Note the neighbouring 'child stdout reaches the master pipe' test breaks
    // out of its read loop as soon as it sees its marker, so it never observes
    // `done` -- EOF on a small payload is genuinely uncovered without this.
    ignore: Deno.build.os !== 'windows',
    timeout: 15000,
    fn: async () => {
        const pty = await CNO.openpty({
            name: 'cmd.exe',
            argv: ['cmd.exe', '/c', 'echo EOF_MARKER_A'],
            cols: 80,
            rows: 24,
        });
        const reader = pty.readable.getReader();
        let text = '';
        let sawEof = false;
        try {
            while (true) {
                // Per-read timeout: the pre-fix failure mode was an indefinite
                // stall, which the harness would otherwise report only as a
                // whole-file timeout.
                const result = await withTimeout(reader.read(), 6000);
                if (result.done) {
                    sawEof = true;
                    break;
                }
                text += decoder.decode(result.value);
            }
        } finally {
            reader.releaseLock();
        }
        ok(sawEof, 'master pipe never reached EOF after the child exited');
        ok(
            text.includes('EOF_MARKER_A'),
            `child output missing before EOF: ${JSON.stringify(text)}`,
        );
        const status = await withTimeout(pty.wait());
        strictEqual(status.exitStatus, 0);
        strictEqual(status.termSignal, null);
    },
});

Deno.test({
    name: 'CNO.openpty: Windows large output drains fully and reaches EOF',
    // Windows counterpart to the POSIX 'async wait and large output drain
    // concurrently' (dd and /dev/zero do not exist here, and NUL bytes are not
    // a meaningful payload through a terminal emulator). Same shape: ~2 MiB,
    // wait() and the drain awaited concurrently via Promise.all, which is where
    // releasing the pseudoconsole on child exit could regress -- close too
    // eagerly and the tail of a still-buffered pipe would be cut off.
    //
    // Assertions are chosen against what ConPTY actually guarantees. It is a
    // terminal emulator, so the drained text is the payload wrapped in a
    // constant 86 bytes of VT (measured identical at 176 B, 1 MiB and 2 MiB),
    // which makes a byte-exact total wrong -- but it is NOT weaker to assert a
    // lower bound plus an exact line count: LINE_HITS === lines catches a drop
    // anywhere in the stream, not just at the tail, which a byte total cannot.
    // Measured on the 10:10 build: 2080106 bytes, 40000/40000 lines, sentinel
    // present, EOF reached, ~1.8s, byte-for-byte reproducible over repeats.
    ignore: Deno.build.os !== 'windows',
    timeout: 30000,
    fn: async () => {
        const lines = 40000;
        const dir = Deno.makeTempDirSync({ prefix: 'cno-pty-drain-' });
        try {
            // 50 chars + CRLF: comfortably under the 120-column window, so
            // ConPTY does not line-wrap and inject bytes mid-payload.
            const line = 'LINE-padpadpadpadpadpadpadpadpadpadpadpadpadpadpad\r\n';
            const payload = line.repeat(lines) + 'SENTINEL_LAST_LINE\r\n';
            Deno.writeTextFileSync(dir + '\\big.txt', payload);
            const fileBytes = Deno.statSync(dir + '\\big.txt').size;

            // Bare filename with `cwd` set: the Windows quoter escapes `"` as
            // `\"`, which cmd does not understand, so avoid nested quotes.
            const pty = await CNO.openpty({
                name: 'cmd.exe',
                argv: ['cmd.exe', '/c', 'type big.txt'],
                cwd: dir,
                cols: 120,
                rows: 40,
            });
            const reader = pty.readable.getReader();
            const readAll = (async () => {
                let total = 0;
                let text = '';
                try {
                    while (true) {
                        const result = await reader.read();
                        if (result.done) return { total, text, eof: true };
                        total += result.value.byteLength;
                        text += decoder.decode(result.value);
                    }
                } finally {
                    reader.releaseLock();
                }
            })();

            const [status, res] = await withTimeout(
                Promise.all([pty.wait(), readAll]),
                25000,
            );
            strictEqual(status.exitStatus, 0);
            strictEqual(status.termSignal, null);
            ok(res.eof, 'master pipe never reached EOF after draining');
            ok(
                res.text.includes('SENTINEL_LAST_LINE'),
                'releasing the pseudoconsole truncated the tail of the output',
            );
            // No line lost or duplicated anywhere in the stream.
            strictEqual((res.text.match(/LINE-/g) ?? []).length, lines);
            ok(
                res.total >= fileBytes,
                `truncated: expected >= ${fileBytes} bytes, got ${res.total}`,
            );
        } finally {
            try {
                Deno.removeSync(dir, { recursive: true });
            } catch {}
        }
    },
});

Deno.test({
    name: 'CNO.openpty: Windows closing the pseudoconsole twice is a no-op',
    // Three sites now release the HPCON: process_finish() on child exit, the GC
    // finalizer (mod_process.c:499, for a wrapper collected while the child is
    // still running), and the uv_timer_init failure path (:1599). All route
    // through pty_win_close_hpcon(), which nulls p->hpc BEFORE calling
    // ClosePseudoConsole, so every call after the first must do nothing.
    //
    // Untested until now, and the failure modes are nasty rather than obvious:
    // a genuine double ClosePseudoConsole is either a crash or -- worse,
    // because it stays silent -- a close of whatever handle Windows has since
    // recycled into that slot. So it is not enough for the loop to survive; a
    // pseudoconsole created AFTER the double-closes has to still work, which is
    // what the canary checks.
    ignore: Deno.build.os !== 'windows',
    timeout: 30000,
    fn: async () => {
        const runOne = async (tag: string) => {
            // Scoped so both the wrapper and its reader become unreachable when
            // this returns, letting the finalizer run on the next gc.
            const pty = await CNO.openpty({
                name: 'cmd.exe',
                argv: ['cmd.exe', '/c', 'echo ' + tag],
                cols: 80,
                rows: 24,
            });
            const status = await withTimeout(pty.wait(), 8000); // close #1
            const reader = pty.readable.getReader();
            let text = '';
            let eof = false;
            try {
                while (true) {
                    const result = await withTimeout(reader.read(), 6000);
                    if (result.done) {
                        eof = true;
                        break;
                    }
                    text += decoder.decode(result.value);
                }
            } finally {
                reader.releaseLock();
            }
            strictEqual(status.exitStatus, 0);
            ok(eof, `${tag}: no EOF`);
            ok(text.includes(tag), `${tag}: output missing: ${JSON.stringify(text)}`);
        };

        for (let i = 0; i < 6; i++) {
            await runOne('IDEM_' + i);
            // close #2: the finalizer on the now-unreachable wrapper.
            engine.gc.run();
            engine.gc.run();
        }
        await runOne('CANARY_AFTER_GC');
    },
});

Deno.test({
    name: 'CNO.openpty: Windows resize after the child exits keeps the tracked size',
    // process_finish() releases the pseudoconsole the moment the child is
    // reaped, so by the time JS observes the exit p->hpc is already NULL. That
    // used to make resize() throw "ConPTY unavailable"; it now updates the
    // tracked size and returns, matching POSIX, which still succeeds against
    // the surviving master fd. The existing Windows resize test resizes while
    // the child is alive, so this path had no coverage.
    ignore: Deno.build.os !== 'windows',
    timeout: 15000,
    fn: async () => {
        const pty = await CNO.openpty({
            name: 'cmd.exe',
            argv: ['cmd.exe', '/c', 'echo RESIZE_AFTER_EXIT'],
            cols: 80,
            rows: 24,
        });
        deepStrictEqual(
            { cols: pty.getwinsize().cols, rows: pty.getwinsize().rows },
            { cols: 80, rows: 24 },
        );
        const status = await withTimeout(pty.wait());
        strictEqual(status.exitStatus, 0);

        // Drain to EOF so the child is fully reaped and the pipe is done.
        const reader = pty.readable.getReader();
        try {
            while (true) {
                const result = await withTimeout(reader.read(), 6000);
                if (result.done) break;
            }
        } finally {
            reader.releaseLock();
        }

        // Must not throw, and must be observable through getwinsize().
        pty.resize(200, 60);
        deepStrictEqual(
            { cols: pty.getwinsize().cols, rows: pty.getwinsize().rows },
            { cols: 200, rows: 60 },
        );
        // A second post-exit resize behaves the same.
        pty.resize(81, 25);
        deepStrictEqual(
            { cols: pty.getwinsize().cols, rows: pty.getwinsize().rows },
            { cols: 81, rows: 25 },
        );
    },
});

