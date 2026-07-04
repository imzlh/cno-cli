import { strictEqual, ok } from 'node:assert';
import * as fs from 'node:fs';
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
