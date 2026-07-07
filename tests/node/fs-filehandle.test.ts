import { strictEqual, ok } from 'node:assert';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

async function withFile<T>(name: string, content: string, fn: (path: string) => T | Promise<T>): Promise<T> {
    return withTempDir('filehandle', async (dir) => {
        const path = join(dir, name);
        await writeFile(path, content);
        return await fn(path);
    });
}

// FileHandle: tricky cases are (1) open/read/write/close lifecycle,
// (2) read with position + offset, (3) write at position, (4) truncate,
// (5) close is idempotent, (6) operations after close throw.

Deno.test('fs.promises.FileHandle: open + read + close lifecycle', async () => {
    await withFile('a.txt', 'hello-world', async (path) => {
        const fh = await open(path, 'r');
        try {
            const buf = Buffer.alloc(5);
            const { bytesRead } = await fh.read(buf, 0, 5, 0);
            strictEqual(bytesRead, 5);
            strictEqual(decodeUtf8(buf), 'hello');
        } finally {
            await fh.close();
        }
    });
});

Deno.test('fs.promises.FileHandle: read with offset does not overwrite prefix', async () => {
    await withFile('b.txt', 'abcdefgh', async (path) => {
        const fh = await open(path, 'r');
        try {
            const buf = Buffer.from('XXXXXXXX');
            await fh.read(buf, 1, 4, 2); // read 'cdef' into buf[1..4]
            strictEqual(buf[0], 'X'.charCodeAt(0), 'prefix must be untouched');
            strictEqual(decodeUtf8(buf.slice(1, 5)), 'cdef');
        } finally {
            await fh.close();
        }
    });
});

Deno.test('fs.promises.FileHandle: write at position', async () => {
    await withFile('c.txt', 'aaaaaa', async (path) => {
        const fh = await open(path, 'r+');
        try {
            await fh.write(Buffer.from('ZZ'), 0, 2, 2); // overwrite positions 2-3
            await fh.close();
            strictEqual(await readFile(path, 'utf8'), 'aaZZaa');
        } finally {
            // already closed; ensure no throw on double close
            await fh.close().catch(() => {});
        }
    });
});

Deno.test('fs.promises.FileHandle: truncate shortens the file', async () => {
    await withFile('d.txt', '1234567890', async (path) => {
        const fh = await open(path, 'r+');
        try {
            await fh.truncate(4);
            await fh.close();
            strictEqual(await readFile(path, 'utf8'), '1234');
        } finally {
            await fh.close().catch(() => {});
        }
    });
});

Deno.test('fs.promises.FileHandle: stat returns file size', async () => {
    await withFile('e.txt', '12345', async (path) => {
        const fh = await open(path, 'r');
        try {
            const st = await fh.stat();
            strictEqual(st.size, 5);
            ok(st.isFile());
        } finally {
            await fh.close();
        }
    });
});

Deno.test('fs.promises.FileHandle: fd is numeric and readFile supports encoding', async () => {
    await withFile('fd-readfile.txt', 'abcdef', async (path) => {
        const fh = await open(path, 'r');
        try {
            ok(typeof fh.fd === 'number' && fh.fd > 0);
            strictEqual(await fh.readFile('utf8'), 'abcdef');
        } finally {
            await fh.close();
        }
    });
});

Deno.test('fs.promises.FileHandle: writeFile writes from current offset without truncating', async () => {
    await withFile('writefile-handle.txt', 'abcdef', async (path) => {
        const fh = await open(path, 'r+');
        try {
            await fh.writeFile('xy');
        } finally {
            await fh.close().catch(() => {});
        }
        strictEqual(await readFile(path, 'utf8'), 'xycdef');
    });
});

Deno.test('fs.promises.FileHandle: writev writes multiple buffers and reports bytesWritten', async () => {
    await withFile('writev.txt', 'abcdef', async (path) => {
        const fh = await open(path, 'r+');
        try {
            const result = await fh.writev([Buffer.from('12'), Buffer.from('34')], 1);
            strictEqual(result.bytesWritten, 4);
            strictEqual(result.buffers.length, 2);
            strictEqual(decodeUtf8(result.buffers[0]), '12');
            strictEqual(decodeUtf8(result.buffers[1]), '34');
        } finally {
            await fh.close().catch(() => {});
        }
        strictEqual(await readFile(path, 'utf8'), 'a1234f');
    });
});

Deno.test('fs.promises.FileHandle: sync and datasync are callable', async () => {
    await withFile('sync.txt', 'abc', async (path) => {
        const fh = await open(path, 'r+');
        try {
            strictEqual(await fh.sync(), undefined);
            strictEqual(await fh.datasync(), undefined);
        } finally {
            await fh.close();
        }
    });
});

Deno.test('fs.promises.FileHandle: close is idempotent', async () => {
    await withFile('f.txt', 'x', async (path) => {
        const fh = await open(path, 'r');
        await fh.close();
        let threw = false;
        try { await fh.close(); } catch { threw = true; }
        ok(!threw, 'second close must not throw');
    });
});

Deno.test('fs.promises.FileHandle: read after close throws', async () => {
    await withFile('g.txt', 'data', async (path) => {
        const fh = await open(path, 'r');
        await fh.close();
        let threw = false;
        try {
            await fh.read(Buffer.alloc(4), 0, 4, 0);
        } catch {
            threw = true;
        }
        ok(threw, 'read after close must throw');
    });
});
