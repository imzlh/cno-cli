import { strictEqual, ok } from 'node:assert';
import { Buffer } from 'node:buffer';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = join(tmpdir(), `cno-fsp-${process.pid}`);

Deno.test('fsp: readFile/writeFile round-trip', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const p = join(TMP, 'a.txt');
        await fsp.writeFile(p, 'hello-fsp');
        strictEqual(await fsp.readFile(p, 'utf8'), 'hello-fsp');
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: appendFile appends', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const p = join(TMP, 'b.txt');
        await fsp.writeFile(p, 'a');
        await fsp.appendFile(p, 'b');
        strictEqual(await fsp.readFile(p, 'utf8'), 'ab');
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: writeFile accepts Uint8Array and readFile returns Buffer by default', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const p = join(TMP, 'bytes.bin');
        await fsp.writeFile(p, new Uint8Array([0x61, 0x62, 0x63]));
        const data = await fsp.readFile(p);
        ok(Buffer.isBuffer(data), 'readFile without encoding must return a Buffer');
        strictEqual(data.toString('utf8'), 'abc');
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: stat returns file info', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const p = join(TMP, 'c.txt');
        await fsp.writeFile(p, 'xyz');
        const st = await fsp.stat(p);
        ok(st.isFile());
        strictEqual(st.size, 3);
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: lstat on symlink returns isSymbolicLink', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const target = join(TMP, 'target.txt');
        const link = join(TMP, 'link.txt');
        await fsp.writeFile(target, 't');
        await fsp.symlink(target, link);
        const st = await fsp.lstat(link);
        ok(st.isSymbolicLink(), 'lstat of symlink must report isSymbolicLink');
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: readlink returns symlink target', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const target = join(TMP, 'readlink-target.txt');
        const link = join(TMP, 'readlink-link.txt');
        await fsp.writeFile(target, 'target');
        await fsp.symlink(target, link);
        strictEqual(await fsp.readlink(link), target);
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: mkdir recursive creates nested dirs', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const nested = join(TMP, 'a', 'b', 'c');
        await fsp.mkdir(nested, { recursive: true });
        const st = await fsp.stat(nested);
        ok(st.isDirectory());
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: readdir with withFileTypes returns Dirent objects', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        await fsp.writeFile(join(TMP, 'f1'), '1');
        await fsp.writeFile(join(TMP, 'f2'), '2');
        await fsp.mkdir(join(TMP, 'd'));
        const ents = await fsp.readdir(TMP, { withFileTypes: true });
        ok(Array.isArray(ents));
        ok(ents.length >= 3);
        for (const e of ents) ok(typeof e.name === 'string');
        ok(ents.find((e) => e.name === 'd')?.isDirectory());
        ok(ents.find((e) => e.name === 'f1')?.isFile());
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: rm recursive removes tree', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const nested = join(TMP, 'x', 'y');
        await fsp.mkdir(nested, { recursive: true });
        await fsp.writeFile(join(nested, 'z'), 'z');
        await fsp.rm(TMP, { recursive: true, force: true });
        let gone = false;
        try { await fsp.stat(TMP); } catch { gone = true; }
        ok(gone);
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
    }
});

Deno.test('fsp: rm force ignores missing paths', async () => {
    strictEqual(await fsp.rm(join(TMP, 'missing.txt'), { force: true }), undefined);
});

Deno.test('fsp: access succeeds for existing, throws for missing', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const p = join(TMP, 'ok.txt');
        await fsp.writeFile(p, 'ok');
        await fsp.access(p); // should not throw

        let threw = false;
        try { await fsp.access(join(TMP, 'nope.txt')); } catch { threw = true; }
        ok(threw, 'access on missing file must throw');
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: rename moves file', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const a = join(TMP, 'from.txt');
        const b = join(TMP, 'to.txt');
        await fsp.writeFile(a, 'content');
        await fsp.rename(a, b);
        let gone = false;
        try { await fsp.stat(a); } catch { gone = true; }
        ok(gone, 'old path must not exist after rename');
        strictEqual(await fsp.readFile(b, 'utf8'), 'content');
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: copyFile copies file contents', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const src = join(TMP, 'copy-src.txt');
        const dst = join(TMP, 'copy-dst.txt');
        await fsp.writeFile(src, 'copy-content');
        await fsp.copyFile(src, dst);
        strictEqual(await fsp.readFile(dst, 'utf8'), 'copy-content');
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: truncate shortens an existing file', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const p = join(TMP, 'truncate.txt');
        await fsp.writeFile(p, 'abcdef');
        await fsp.truncate(p, 3);
        strictEqual(await fsp.readFile(p, 'utf8'), 'abc');
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: realpath resolves path', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const p = join(TMP, 'rp.txt');
        await fsp.writeFile(p, 'x');
        const r = await fsp.realpath(p);
        ok(typeof r === 'string' && r.length > 0);
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});

Deno.test('fsp: chmod sets permissions', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    try {
        const p = join(TMP, 'perm.txt');
        await fsp.writeFile(p, 'x');
        await fsp.chmod(p, 0o755);
        const st = await fsp.stat(p);
        ok('mode' in st);
    } finally {
        await fsp.rm(TMP, { recursive: true, force: true });
    }
});
