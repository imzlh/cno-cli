import { strictEqual, ok } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as stream from 'node:stream';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

function touch(root: string, name: string, content = 'data'): string {
    const p = join(root, name);
    fs.writeFileSync(p, content);
    return p;
}

Deno.test({ name: 'fs: sync read/write/stat/unlink round-trip', ignore: false }, () => {
    return withTempDir('node-fs', (root) => {
        const p = touch(root, 'a.txt', 'hello');
        const st = fs.statSync(p);
        ok(st.isFile());
        strictEqual(st.size, 5);
        strictEqual(fs.readFileSync(p, 'utf8'), 'hello');

        fs.writeFileSync(p, 'updated');
        strictEqual(fs.readFileSync(p, 'utf8'), 'updated');

        fs.unlinkSync(p);
        ok(!fs.existsSync(p));
    });
});

Deno.test({ name: 'fs: promises API read/write/mkdir/rmdir/stat', timeout: 10000 }, async () => {
    await withTempDir('node-fs', async (root) => {
        const p = join(root, 'b.txt');
        await fsp.writeFile(p, 'promises');
        strictEqual(await fsp.readFile(p, 'utf8'), 'promises');

        const st = await fsp.stat(p);
        ok(st.isFile());

        const nested = join(root, 'sub', 'deep');
        await fsp.mkdir(nested, { recursive: true });
        ok((await fsp.stat(nested)).isDirectory());

        await fsp.rm(root, { recursive: true, force: true });
        let gone = false;
        try { await fsp.stat(p); } catch { gone = true; }
        ok(gone, 'removed path must not stat');
    });
});

Deno.test({ name: 'fs: readdir returns entries and Dirent names', timeout: 10000 }, () => {
    return withTempDir('node-fs', (root) => {
        touch(root, 'one.txt');
        touch(root, 'two.txt');
        fs.mkdirSync(join(root, 'dir'));

        const names = fs.readdirSync(root).sort();
        ok(names.includes('one.txt'));
        ok(names.includes('two.txt'));
        ok(names.includes('dir'));

        const dirents = fs.readdirSync(root, { withFileTypes: true });
        for (const d of dirents) ok(typeof d.name === 'string' && d.name.length > 0);
        ok(dirents.find((d) => d.name === 'dir')?.isDirectory());
        ok(dirents.find((d) => d.name === 'one.txt')?.isFile());
    });
});

Deno.test({ name: 'fs: readFile on missing path throws ENOENT', timeout: 10000 }, () => {
    let threw = false;
    try {
        fs.readFileSync(join(Deno.cwd(), 'does-not-exist', 'x.txt'));
    } catch (e: any) {
        threw = true;
        strictEqual(e.code, 'ENOENT');
    }
    ok(threw, 'readFileSync on missing file must throw ENOENT');
});

Deno.test({ name: 'fs: createReadStream pipes file content', timeout: 10000 }, async () => {
    await withTempDir('node-fs', async (root) => {
        const p = touch(root, 'stream.txt', 'stream-body');
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            const rs = fs.createReadStream(p);
            rs.on('data', (c: Buffer) => chunks.push(c));
            rs.on('end', () => resolve());
            rs.on('error', reject);
        });
        strictEqual(decodeUtf8(Buffer.concat(chunks)), 'stream-body');
    });
});

Deno.test({ name: 'fs: createWriteStream writes full content', timeout: 10000 }, async () => {
    await withTempDir('node-fs', async (root) => {
        const p = join(root, 'out.txt');
        await new Promise<void>((resolve, reject) => {
            const ws = fs.createWriteStream(p);
            ws.on('finish', () => resolve());
            ws.on('error', reject);
            ws.write('abc');
            ws.write('def');
            ws.end();
        });
        strictEqual(fs.readFileSync(p, 'utf8'), 'abcdef');
    });
});

// --- stream: pipeline + transform -----------------------------------------

Deno.test({ name: 'stream: pipeline pipes and resolves', timeout: 10000 }, async () => {
    const src = stream.Readable.from(['abc', 'def']);
    let out = '';
    const dst = stream.Writable({
        write(chunk: Buffer, _enc, cb) { out += decodeUtf8(chunk); cb(); },
    });
    await new Promise<void>((resolve, reject) => {
        stream.pipeline(src, dst, (err) => (err ? reject(err) : resolve()));
    });
    strictEqual(out, 'abcdef');
});

Deno.test({ name: 'stream: pipeline rejects when source errors', timeout: 10000 }, async () => {
    const src = new stream.Readable({
        read() { this.destroy(new Error('boom')); },
    });
    const dst = new stream.Writable({ write(_c, _e, cb) { cb(); } });
    let caught: Error | null = null;
    try {
        await new Promise<void>((resolve, reject) => {
            stream.pipeline(src, dst, (err) => (err ? reject(err) : resolve()));
        });
    } catch (e) {
        caught = e as Error;
    }
    ok(caught, 'pipeline must reject');
    ok(/boom/.test(caught!.message));
});

Deno.test({ name: 'stream: Transform mutates chunks', timeout: 10000 }, async () => {
    const upper = new stream.Transform({
        transform(chunk: Buffer, _enc, cb) {
            cb(null, Buffer.from(chunk.toString().toUpperCase()));
        },
    });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
        upper.on('data', (c: Buffer) => chunks.push(c));
        upper.on('end', () => resolve());
        upper.on('error', reject);
        upper.write('hello');
        upper.end();
    });
    strictEqual(Buffer.concat(chunks).toString(), 'HELLO');
});

Deno.test({ name: 'stream: PassThrough preserves data', timeout: 10000 }, async () => {
    const pt = new stream.PassThrough();
    const chunks: Buffer[] = [];
    pt.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve) => pt.on('end', () => resolve()));
    pt.write('x');
    pt.write('y');
    pt.end();
    await done;
    strictEqual(Buffer.concat(chunks).toString(), 'xy');
});

Deno.test({ name: 'stream: Readable.toWeb / Writable.fromWeb exist', timeout: 10000 }, () => {
    const s = stream as typeof stream & {
        Readable: { toWeb?: (r: unknown) => ReadableStream };
        Writable: { fromWeb?: (w: unknown) => WritableStream };
    };
    ok(typeof s.Readable.toWeb === 'function');
    ok(typeof s.Writable.fromWeb === 'function');
});

// --- events: EventEmitter edge cases --------------------------------------

Deno.test({ name: 'events: once() removes listener after first emit', timeout: 10000 }, () => {
    const { EventEmitter } = require('node:events') as typeof import('node:events');
    const ee = new EventEmitter();
    let n = 0;
    ee.once('e', () => { n++; });
    ee.emit('e');
    ee.emit('e');
    strictEqual(n, 1);
});

Deno.test({ name: 'events: removeAllListeners clears all', timeout: 10000 }, () => {
    const { EventEmitter } = require('node:events') as typeof import('node:events');
    const ee = new EventEmitter();
    ee.on('e', () => {});
    ee.on('e', () => {});
    strictEqual(ee.listenerCount('e'), 2);
    ee.removeAllListeners('e');
    strictEqual(ee.listenerCount('e'), 0);
});

Deno.test({ name: 'events: defaultMaxListeners is 10', timeout: 10000 }, () => {
    const { EventEmitter } = require('node:events') as typeof import('node:events');
    strictEqual(EventEmitter.defaultMaxListeners, 10);
});

// --- child_process: execSync / spawnSync ----------------------------------

Deno.test({ name: 'child_process: execSync returns stdout', timeout: 10000 }, () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync('echo hello-subprocess').toString().trim();
    strictEqual(out, 'hello-subprocess');
});

Deno.test({ name: 'child_process: spawnSync with stdio pipe captures exit code', timeout: 10000 }, () => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const r = spawnSync(process.execPath, ['-e', 'process.exit(7)'], { encoding: 'utf8' });
    strictEqual(r.status, 7);
    strictEqual(r.signal, null);
});

// --- crypto: hash + random + timingSafeEqual -------------------------------

Deno.test({ name: 'crypto: sha256 is stable and hex', timeout: 10000 }, () => {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const h = createHash('sha256').update('abc').digest('hex');
    strictEqual(h, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

Deno.test({ name: 'crypto: randomBytes returns requested length', timeout: 10000 }, () => {
    const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
    const b = randomBytes(16);
    strictEqual(b.length, 16);
});

Deno.test({ name: 'crypto: timingSafeEqual on equal buffers', timeout: 10000 }, () => {
    const { timingSafeEqual, randomBytes } = require('node:crypto') as typeof import('node:crypto');
    const a = randomBytes(8);
    const b = Buffer.from(a);
    ok(timingSafeEqual(a, b));
});

// --- url: URL + URLSearchParams -------------------------------------------

Deno.test({ name: 'url: URL parses query', timeout: 10000 }, () => {
    const u = new URL('https://x.y/z?a=1&b=2');
    strictEqual(u.origin, 'https://x.y');
    strictEqual(u.searchParams.get('a'), '1');
    strictEqual(u.searchParams.get('b'), '2');
});

Deno.test({ name: 'url: URLSearchParams toString round-trips', timeout: 10000 }, () => {
    const sp = new URLSearchParams({ a: '1 1', b: 'two' });
    const back = new URLSearchParams(sp.toString());
    strictEqual(back.get('a'), '1 1');
    strictEqual(back.get('b'), 'two');
});

// --- util: format + inspect ------------------------------------------------

Deno.test({ name: 'util: format interpolates', timeout: 10000 }, () => {
    const { format } = require('node:util') as typeof import('node:util');
    strictEqual(format('%s:%d', 'a', 1), 'a:1');
});

Deno.test({ name: 'util: inspect formats objects', timeout: 10000 }, () => {
    const { inspect } = require('node:util') as typeof import('node:util');
    ok(inspect({ a: 1 }).includes('a: 1'));
});
