/**
 * Unit tests for the REPL's file-backed stdio handles.
 *
 * These drive src/commands/repl/file-stdio.ts directly from disk, so they cover
 * the fix without waiting on a rebuild (the REPL itself is baked into the
 * binary). The end-to-end exit-code contract lives in repl-stdio-redirect.test.ts.
 */
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import {
    FileInput,
    FileOutput,
    openReplInput,
    openReplOutput,
} from '../../src/commands/repl/file-stdio.ts';

const sfs = import.meta.use('fs');
const engine = import.meta.use('engine');

/** 64 KiB is FileInput's chunk size; this forces the multi-chunk path. */
const BIG_LEN = 150_000;

function withFd<T>(path: string, flags: string, fn: (fd: number) => T): T {
    const fd = sfs.open(path, flags);
    try {
        return fn(fd);
    } finally {
        try { sfs.close(fd); } catch { /* already closed */ }
    }
}

/**
 * Async form. The sync one closes the fd the moment `fn` *returns*, which for
 * an async `fn` is before its first await has resumed — the pump would then be
 * reading a closed fd.
 */
async function withFdAsync<T>(path: string, flags: string, fn: (fd: number) => Promise<T>): Promise<T> {
    const fd = sfs.open(path, flags);
    try {
        return await fn(fd);
    } finally {
        try { sfs.close(fd); } catch { /* already closed */ }
    }
}

interface Drained {
    text: string;
    chunks: number;
    eof: boolean;
    error: unknown;
}

/** Pump a FileInput to completion the way runner.ts #readInput does. */
function drain(input: FileInput): Promise<Drained> {
    return new Promise<Drained>((resolve, reject) => {
        const parts: Uint8Array[] = [];
        let chunks = 0;
        const timer = setTimeout(
            () => reject(new Error('FileInput never reported EOF — the pump is stuck')),
            10_000,
        );
        input.onread = (res, err) => {
            if (!res) {
                clearTimeout(timer);
                const total = parts.reduce((n, p) => n + p.length, 0);
                const flat = new Uint8Array(total);
                let at = 0;
                for (const p of parts) { flat.set(p, at); at += p.length; }
                resolve({
                    text: engine.decodeString(flat),
                    chunks,
                    eof: res === null && err === undefined,
                    error: err,
                });
                return;
            }
            chunks++;
            parts.push(res.slice());  // copy: the pump reuses its buffer
        };
        input.startRead();
    });
}

Deno.test('FileOutput.write puts bytes on a real file fd', async () => {
    await withTempDir('repl-fileout', async (dir) => {
        const path = join(dir, 'out.txt');
        withFd(path, 'w', (fd) => {
            const out = new FileOutput(fd);
            strictEqual(out.fd, fd);
            const n = out.write(engine.encodeString('hello '));
            strictEqual(n, 6, 'write returns the byte count');
            out.write(engine.encodeString('world\n'));
            out.close();  // must not close the fd we still own
            out.write(engine.encodeString('after-close\n'));
        });
        strictEqual(Deno.readTextFileSync(path), 'hello world\nafter-close\n');
    });
});

Deno.test('FileOutput.write handles a payload larger than one chunk', async () => {
    await withTempDir('repl-fileout-big', async (dir) => {
        const path = join(dir, 'big.txt');
        const payload = 'x'.repeat(BIG_LEN);
        withFd(path, 'w', (fd) => {
            const n = new FileOutput(fd).write(engine.encodeString(payload));
            strictEqual(n, BIG_LEN, 'sync write loops internally until everything is out');
        });
        strictEqual(Deno.readTextFileSync(path).length, BIG_LEN);
    });
});

Deno.test('FileInput reads a file to EOF and reports EOF as (null, undefined)', async () => {
    await withTempDir('repl-filein', async (dir) => {
        const path = join(dir, 'in.txt');
        Deno.writeTextFileSync(path, '1+1\n.exit\n');
        const result = await withFdAsync(path, 'r', (fd) => drain(new FileInput(fd)));
        strictEqual(result.text, '1+1\n.exit\n');
        ok(result.eof, 'EOF must arrive as onread(null, undefined), which is what runner.ts treats as end of input');
        strictEqual(result.error, undefined);
        strictEqual(result.chunks, 1);
    });
});

Deno.test('FileInput reassembles a file spanning several chunks', async () => {
    await withTempDir('repl-filein-big', async (dir) => {
        const path = join(dir, 'big.txt');
        const payload = 'ab'.repeat(BIG_LEN / 2);
        Deno.writeTextFileSync(path, payload);
        const result = await withFdAsync(path, 'r', (fd) => drain(new FileInput(fd)));
        strictEqual(result.text.length, BIG_LEN);
        strictEqual(result.text, payload);
        ok(result.chunks > 1, `expected several 64 KiB chunks, got ${result.chunks}`);
        ok(result.eof);
    });
});

Deno.test('FileInput on an empty file reports EOF with no data', async () => {
    await withTempDir('repl-filein-empty', async (dir) => {
        const path = join(dir, 'empty.txt');
        Deno.writeTextFileSync(path, '');
        const result = await withFdAsync(path, 'r', (fd) => drain(new FileInput(fd)));
        strictEqual(result.text, '');
        strictEqual(result.chunks, 0);
        ok(result.eof, 'an empty redirect must still terminate the REPL rather than hang');
    });
});

Deno.test('FileInput.startRead does not dispatch synchronously', async () => {
    await withTempDir('repl-filein-async', async (dir) => {
        const path = join(dir, 'in.txt');
        Deno.writeTextFileSync(path, 'data\n');
        // runner.ts start() calls #readInput() (which calls startRead) *before*
        // it awaits #readLineLoop(), so a synchronous first dispatch would
        // arrive before there is a readline resolver to hand the line to.
        // libuv's uv_read_start has the same guarantee.
        const seen: string[] = [];
        await withFdAsync(path, 'r', async (fd) => {
            const input = new FileInput(fd);
            const done = new Promise<void>((resolve) => {
                input.onread = (res) => {
                    seen.push(res ? 'data' : 'eof');
                    if (!res) resolve();
                };
            });
            input.startRead();
            seen.push('startRead-returned');
            await done;
        });
        strictEqual(seen[0], 'startRead-returned', `onread fired synchronously: ${seen.join(',')}`);
        deepStrictEqual(seen, ['startRead-returned', 'data', 'eof']);
    });
});

Deno.test('FileInput.stopRead halts the pump', async () => {
    await withTempDir('repl-filein-stop', async (dir) => {
        const path = join(dir, 'big.txt');
        Deno.writeTextFileSync(path, 'y'.repeat(BIG_LEN));
        let chunks = 0;
        await withFdAsync(path, 'r', async (fd) => {
            const input = new FileInput(fd);
            input.onread = (res) => {
                if (res) { chunks++; input.stopRead(); }
            };
            input.startRead();
            // Let the pump run as long as it wants to; it must not continue.
            for (let i = 0; i < 50; i++) await Promise.resolve();
            await new Promise((r) => setTimeout(r, 50));
        });
        strictEqual(chunks, 1, 'stopRead must stop further delivery');
    });
});

Deno.test('the selectors pick the fd shim for a regular file', async () => {
    await withTempDir('repl-select', async (dir) => {
        const outPath = join(dir, 'o.txt');
        const inPath = join(dir, 'i.txt');
        Deno.writeTextFileSync(inPath, 'x\n');
        withFd(outPath, 'w', (fd) => {
            const h = openReplOutput(fd);
            ok(h instanceof FileOutput, `expected FileOutput for a file fd, got ${h.constructor.name}`);
        });
        withFd(inPath, 'r', (fd) => {
            const h = openReplInput(fd);
            ok(h instanceof FileInput, `expected FileInput for a file fd, got ${h.constructor.name}`);
        });
    });
});
