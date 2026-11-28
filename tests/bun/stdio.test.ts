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

Deno.test({ name: 'bun.stdio: Blob writes stream their exact bytes', timeout: 15000 }, async () => {
    const child = spawn([process.execPath, 'eval', `
        const backing = new TextEncoder().encode('xxblob-viewyy');
        const first = await Bun.stdout.write(new Blob([backing.subarray(2, 11), '|é']));
        const second = await Bun.write(Bun.stderr, new Blob(['stderr-blob']));
        await Bun.write(Bun.stdout, ':' + String(first) + ':' + String(second));
    `], { stdout: 'pipe', stderr: 'pipe' });
    strictEqual(await child.exited, 0);
    strictEqual(new TextDecoder().decode(await child.stdout.bytes()), 'blob-view|é:12:11');
    strictEqual(await child.stderr.text(), 'stderr-blob');
});

Deno.test({ name: 'bun.stdio: Blob writes use intrinsic branding and streaming', timeout: 15000 }, async () => {
    const child = spawn([process.execPath, 'eval', `
        const target = Bun.stdout;
        const NativeBlob = Blob;
        const blob = new NativeBlob(['intrinsic']);
        Object.setPrototypeOf(blob, null);
        Object.defineProperty(blob, 'stream', {
            get() { throw new Error('own stream getter must not run'); },
        });
        const file = new File(['file'], 'probe.txt');
        Object.defineProperty(file, 'stream', {
            get() { throw new Error('File own stream getter must not run'); },
        });
        globalThis.Blob = class ReplacementBlob {};
        const blobWritten = await target.write(blob);
        const fileWritten = await target.write(file);
        await target.write(':' + blobWritten + ':' + fileWritten);
    `], { stdout: 'pipe', stderr: 'pipe' });
    strictEqual(await child.exited, 0);
    strictEqual(await child.stdout.text(), 'intrinsicfile:9:4');
    strictEqual(await child.stderr.text(), '');
});

Deno.test({ name: 'bun.stdio: forged and proxied Blobs do not enter the Blob reader', timeout: 15000 }, async () => {
    const child = spawn([process.execPath, 'eval', `
        const fake = Object.create(null);
        Object.defineProperty(fake, Symbol.toStringTag, { value: 'Blob' });
        Object.defineProperty(fake, 'stream', {
            get() { throw new Error('fake stream getter must not run'); },
        });
        const proxy = new Proxy(new Blob(['x']), {
            get() { throw new Error('proxy property access must not run'); },
        });
        const result = [];
        for (const value of [fake, proxy]) {
            try {
                await Bun.stdout.write(value);
                result.push('accepted');
            } catch (error) {
                result.push(error instanceof TypeError ? 'TypeError' : String(error));
            }
        }
        await Bun.stdout.write(result.join(','));
    `], { stdout: 'pipe', stderr: 'pipe' });
    strictEqual(await child.exited, 0);
    strictEqual(await child.stdout.text(), 'TypeError,TypeError');
    strictEqual(await child.stderr.text(), '');
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
