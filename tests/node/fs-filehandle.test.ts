import { strictEqual, ok } from 'node:assert';
import { open, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = join(tmpdir(), `cno-fh-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

// FileHandle: the刁che cases are (1) open/read/write/close lifecycle,
// (2) read with position + offset, (3) write at position, (4) truncate,
// (5) close is idempotent, (6) operations after close throw.

Deno.test('fs.promises.FileHandle: open + read + close lifecycle', async () => {
    await mkdir(TMP, { recursive: true });
    const p = join(TMP, 'a.txt');
    await writeFile(p, 'hello-world');
    try {
        const fh = await open(p, 'r');
        try {
            const buf = Buffer.alloc(5);
            const { bytesRead } = await fh.read(buf, 0, 5, 0);
            strictEqual(bytesRead, 5);
            strictEqual(buf.toString(), 'hello');
        } finally {
            await fh.close();
        }
    } finally {
        await rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fs.promises.FileHandle: read with offset does not overwrite prefix', async () => {
    await mkdir(TMP, { recursive: true });
    const p = join(TMP, 'b.txt');
    await writeFile(p, 'abcdefgh');
    try {
        const fh = await open(p, 'r');
        try {
            const buf = Buffer.from('XXXXXXXX');
            await fh.read(buf, 1, 4, 2); // read 'cdef' into buf[1..4]
            strictEqual(buf[0], 'X'.charCodeAt(0), 'prefix must be untouched');
            strictEqual(buf.slice(1, 5).toString(), 'cdef');
        } finally {
            await fh.close();
        }
    } finally {
        await rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fs.promises.FileHandle: write at position', async () => {
    await mkdir(TMP, { recursive: true });
    const p = join(TMP, 'c.txt');
    await writeFile(p, 'aaaaaa');
    try {
        const fh = await open(p, 'r+');
        try {
            await fh.write(Buffer.from('ZZ'), 0, 2, 2); // overwrite positions 2-3
            await fh.close();
            strictEqual(await readFile(p, 'utf8'), 'aaZZaa');
        } finally {
            // already closed; ensure no throw on double close
            await fh.close().catch(() => {});
        }
    } finally {
        await rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fs.promises.FileHandle: truncate shortens the file', async () => {
    await mkdir(TMP, { recursive: true });
    const p = join(TMP, 'd.txt');
    await writeFile(p, '1234567890');
    try {
        const fh = await open(p, 'r+');
        try {
            await fh.truncate(4);
            await fh.close();
            strictEqual(await readFile(p, 'utf8'), '1234');
        } finally {
            await fh.close().catch(() => {});
        }
    } finally {
        await rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fs.promises.FileHandle: stat returns file size', async () => {
    await mkdir(TMP, { recursive: true });
    const p = join(TMP, 'e.txt');
    await writeFile(p, '12345');
    try {
        const fh = await open(p, 'r');
        try {
            const st = await fh.stat();
            strictEqual(st.size, 5);
            ok(st.isFile());
        } finally {
            await fh.close();
        }
    } finally {
        await rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fs.promises.FileHandle: close is idempotent', async () => {
    await mkdir(TMP, { recursive: true });
    const p = join(TMP, 'f.txt');
    await writeFile(p, 'x');
    try {
        const fh = await open(p, 'r');
        await fh.close();
        let threw = false;
        try { await fh.close(); } catch { threw = true; }
        ok(!threw, 'second close must not throw');
    } finally {
        await rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fs.promises.FileHandle: read after close throws', async () => {
    await mkdir(TMP, { recursive: true });
    const p = join(TMP, 'g.txt');
    await writeFile(p, 'data');
    try {
        const fh = await open(p, 'r');
        await fh.close();
        let threw = false;
        try {
            await fh.read(Buffer.alloc(4), 0, 4, 0);
        } catch {
            threw = true;
        }
        ok(threw, 'read after close must throw');
    } finally {
        await rm(TMP, { recursive: true, force: true });
    }
});
