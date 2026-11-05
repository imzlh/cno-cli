import { ok, rejects, strictEqual, throws } from 'node:assert';
import Bun, { spawn, stdin, stderr, stdout, write } from 'bun';

Deno.test({ name: 'bun.stdio: writes report the byte length they flushed', timeout: 5000 }, async () => {
    // The runner pipes these fds; the writes are visible to the parent harness.
    strictEqual(await write(stderr, 'bun-stdio-probe\n'), 16);
    strictEqual(await Bun.write(Bun.stdout, 'ok'), 2);
    strictEqual(await stdout.write(''), 0);
    strictEqual(await stdout.write(new Uint8Array([1, 2, 3])), 3);
    // Non-ASCII strings are UTF-8 encoded.
    strictEqual(await stdout.write('é'), 2);
});

Deno.test({ name: 'bun.stdio: direction guards', timeout: 5000 }, async () => {
    await rejects(() => stdout.text(), /not readable/);
    await rejects(() => stdout.bytes(), /not readable/);
    throws(() => stdout.stream(), /not readable/);
    await rejects(() => stdin.write('x'), /not writable/);
    strictEqual(await stdin.exists(), true);
});

Deno.test({ name: 'bun.stdio: Bun.stdin reads piped bytes end to end', timeout: 15000 }, async () => {
    const child = spawn([process.execPath, 'eval',
        'await Bun.write(Bun.stdout, await Bun.stdin.text())'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
    });
    ok(child.stdin && typeof child.stdin === 'object' && 'write' in child.stdin);
    child.stdin.start();
    strictEqual(await child.stdin.write('hello stdin'), 11);
    // end() flushes the buffered writes and reports what it flushed.
    strictEqual(await child.stdin.end(), 11);
    strictEqual(await child.stdout.text(), 'hello stdin');
    strictEqual(await child.exited, 0);
});
