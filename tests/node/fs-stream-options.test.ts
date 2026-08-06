/**
 * fs stream / metadata parity guards.
 *
 * Every expectation here was measured against real Node v24.18.0 on Windows.
 * The headline regressions this file locks down:
 *
 *  1. A ReadStream whose consumer attached one macrotask late (setTimeout 0 /
 *     setImmediate) hung forever: zero bytes, no 'end', no 'close', no error.
 *     The open() callback re-entered the read path while an in-flight readChunk
 *     still held the `reading` flag, so the queued read was dropped. A
 *     synchronous consumer never saw it.
 *  2. `fs.utimesSync(p, 1614834367, 1614834367)` (Node's documented *seconds*
 *     form) stamped 1970-01-19 instead of 2021-03-04 across all eight utimes
 *     entry points, because a Date produced ms and a number produced seconds
 *     from the same helper while callers divided uniformly by 1000.
 *  3. `encoding: 'hex' | 'base64' | 'ucs2'` was applied twice, so a read stream
 *     returned hex-of-hex.
 *  4. `watchFile()` on a not-yet-existing path threw ENOENT and escaped as an
 *     unhandled rejection that killed the process.
 */
import { strictEqual, deepStrictEqual, ok, rejects, throws } from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ALPHA = 'abcdefghijklmnopqrstuvwxyz';

async function withTempDir(tag: string, fn: (root: string) => Promise<void> | void): Promise<void> {
    const root = fs.mkdtempSync(join(tmpdir(), `cno-${tag}-`));
    try {
        await fn(root);
    } finally {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drain a readable, attaching the consumer `delay` ms late. */
function drainLate(
    stream: fs.ReadStream,
    attach: 'sync' | 'micro' | 'immediate' | number,
): Promise<{ events: string[]; bytes: number; data: Buffer }> {
    return new Promise((resolve) => {
        const events: string[] = [];
        const chunks: Buffer[] = [];
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve({ events, bytes: chunks.reduce((n, c) => n + c.length, 0), data: Buffer.concat(chunks) });
        };
        const hook = () => {
            stream.on('data', (c) => chunks.push(Buffer.from(c as Uint8Array)));
            stream.on('end', () => events.push('end'));
            stream.on('error', (e) => { events.push(`error:${(e as NodeJS.ErrnoException).code}`); done(); });
            stream.on('close', () => { events.push('close'); done(); });
        };
        if (attach === 'sync') hook();
        else if (attach === 'micro') queueMicrotask(hook);
        else if (attach === 'immediate') setImmediate(hook);
        else setTimeout(hook, attach);
        setTimeout(() => { events.push('TIMEOUT'); done(); }, 4000);
    });
}

Deno.test('fs streams: a deferred consumer still receives every byte', async () => {
    await withTempDir('fs-stream-deferred', async (root) => {
        const file = join(root, 'alpha.txt');
        fs.writeFileSync(file, ALPHA);
        // setTimeout(0) and setImmediate are the shapes that used to hang; a
        // hang shows up as bytes=0 with a TIMEOUT event and no 'end'.
        for (const attach of ['sync', 'micro', 'immediate', 0, 1, 25] as const) {
            const r = await drainLate(fs.createReadStream(file), attach);
            strictEqual(r.bytes, 26, `attach=${String(attach)} delivered ${r.bytes} bytes`);
            strictEqual(r.data.toString(), ALPHA, `attach=${String(attach)} content`);
            ok(r.events.includes('end'), `attach=${String(attach)} must emit 'end', saw ${r.events.join('>')}`);
            ok(r.events.includes('close'), `attach=${String(attach)} must emit 'close', saw ${r.events.join('>')}`);
            ok(!r.events.includes('TIMEOUT'), `attach=${String(attach)} must not hang`);
        }
    });
});

Deno.test('fs streams: deferred consumer on a file larger than one highWaterMark', async () => {
    await withTempDir('fs-stream-deferred-big', async (root) => {
        const file = join(root, 'big.bin');
        const payload = Buffer.alloc(300 * 1024 + 7);
        for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
        fs.writeFileSync(file, payload);
        const r = await drainLate(fs.createReadStream(file), 0);
        strictEqual(r.bytes, payload.length);
        ok(r.data.equals(payload), 'bytes must be identical');
        ok(r.events.includes('end'));
    });
});

Deno.test('fs streams: start/end are inclusive and clamp at EOF', async () => {
    await withTempDir('fs-stream-range', async (root) => {
        const file = join(root, 'alpha.txt');
        fs.writeFileSync(file, ALPHA);
        const cases: Array<[fs.ReadStreamOptions, string, number]> = [
            [{ start: 0, end: 4 }, 'abcde', 5],
            [{ start: 2, end: 2 }, 'c', 1],
            [{ end: 0 }, 'a', 1],
            [{ start: 24 }, 'yz', 2],
            [{ start: 100 }, '', 0],
            [{ start: 26 }, '', 0],
            [{ start: 20, end: 999 }, 'uvwxyz', 6],
        ];
        for (const [opts, expected, expectedRead] of cases) {
            const stream = fs.createReadStream(file, opts);
            const r = await drainLate(stream, 0);
            strictEqual(r.data.toString(), expected, `opts=${JSON.stringify(opts)}`);
            strictEqual(stream.bytesRead, expectedRead, `bytesRead for ${JSON.stringify(opts)}`);
        }
    });
});

Deno.test('fs streams: invalid start/end/highWaterMark throw like Node', async () => {
    await withTempDir('fs-stream-validate', async (root) => {
        const file = join(root, 'alpha.txt');
        fs.writeFileSync(file, ALPHA);
        // start:-1 previously reached pread() as a huge unsigned offset and a
        // 26-byte file yielded 27 bytes with a duplicated tail byte.
        const expectCode = (fn: () => unknown, code: string, label: string) => {
            let seen: unknown;
            try { fn(); } catch (e) { seen = e; }
            ok(seen instanceof Error, `${label} must throw`);
            strictEqual((seen as NodeJS.ErrnoException).code, code, label);
        };
        expectCode(() => fs.createReadStream(file, { start: 5, end: 2 }), 'ERR_OUT_OF_RANGE', 'end<start');
        expectCode(() => fs.createReadStream(file, { start: -1 }), 'ERR_OUT_OF_RANGE', 'negative start');
        expectCode(() => fs.createReadStream(file, { start: 0, end: -5 }), 'ERR_OUT_OF_RANGE', 'negative end');
        expectCode(() => fs.createReadStream(file, { start: 1.5 }), 'ERR_OUT_OF_RANGE', 'float start');
        expectCode(() => fs.createReadStream(file, { start: NaN }), 'ERR_OUT_OF_RANGE', 'NaN start');
        expectCode(() => fs.createReadStream(file, { start: '3' as unknown as number }), 'ERR_INVALID_ARG_TYPE', 'string start');
        expectCode(() => fs.createReadStream(file, { end: null as unknown as number }), 'ERR_INVALID_ARG_TYPE', 'null end');
        expectCode(() => fs.createReadStream(file, { highWaterMark: -1 }), 'ERR_INVALID_ARG_VALUE', 'negative hwm');
        expectCode(() => fs.createWriteStream(join(root, 'w.txt'), { start: -1 }), 'ERR_OUT_OF_RANGE', 'negative ws start');
    });
});

Deno.test('fs streams: encoding is applied exactly once', async () => {
    await withTempDir('fs-stream-encoding', async (root) => {
        const file = join(root, 'alpha.txt');
        fs.writeFileSync(file, ALPHA);
        // 'hex' used to come back as hex-of-hex ('3631...' for '6162...').
        const expected: Record<string, string> = {
            utf8: ALPHA,
            latin1: ALPHA,
            hex: Buffer.from(ALPHA).toString('hex'),
            base64: Buffer.from(ALPHA).toString('base64'),
        };
        for (const [encoding, want] of Object.entries(expected)) {
            const stream = fs.createReadStream(file, { encoding: encoding as BufferEncoding });
            let acc = '';
            stream.on('data', (c) => { ok(typeof c === 'string', `${encoding} must yield strings`); acc += c; });
            await new Promise((r) => { stream.on('close', r); stream.on('error', r); setTimeout(r, 3000); });
            strictEqual(acc, want, `encoding=${encoding}`);
        }
    });
});

Deno.test('fs streams: chunk sizes follow highWaterMark and a zero-length file ends', async () => {
    await withTempDir('fs-stream-hwm', async (root) => {
        const file = join(root, 'alpha.txt');
        fs.writeFileSync(file, ALPHA);
        for (const [hwm, want] of [[7, [7, 7, 7, 5]], [4096, [26]]] as Array<[number, number[]]>) {
            const stream = fs.createReadStream(file, { highWaterMark: hwm });
            const sizes: number[] = [];
            stream.on('data', (c) => sizes.push((c as Uint8Array).length));
            await new Promise((r) => { stream.on('close', r); setTimeout(r, 3000); });
            deepStrictEqual(sizes, want, `hwm=${hwm}`);
        }
        const empty = join(root, 'zero.txt');
        fs.writeFileSync(empty, '');
        const r = await drainLate(fs.createReadStream(empty), 0);
        strictEqual(r.bytes, 0);
        ok(r.events.includes('end'), `zero-length file must still emit 'end', saw ${r.events.join('>')}`);
    });
});

Deno.test('fs streams: autoClose:false leaves the fd open and skips close', async () => {
    await withTempDir('fs-stream-autoclose', async (root) => {
        const file = join(root, 'alpha.txt');
        fs.writeFileSync(file, ALPHA);
        // Node ties 'close' emission to autoClose: with autoClose:false the
        // stream ends but never closes, and the fd survives.
        const stream = fs.createReadStream(file, { autoClose: false });
        const events: string[] = [];
        stream.on('data', () => {});
        stream.on('end', () => events.push('end'));
        stream.on('close', () => events.push('close'));
        await sleep(700);
        const fd = stream.fd as number;
        let fdOpen = false;
        try { fs.fstatSync(fd); fdOpen = true; } catch { fdOpen = false; }
        // capture before any cleanup can perturb it
        const observed = { events: events.join('>'), fdOpen };
        try { fs.closeSync(fd); } catch { /* already gone */ }
        strictEqual(observed.events, 'end', 'autoClose:false must not emit close');
        strictEqual(observed.fdOpen, true, 'autoClose:false must leave the fd open');
    });
});

Deno.test('fs streams: an externally supplied fd honours autoClose', async () => {
    await withTempDir('fs-stream-fd', async (root) => {
        const file = join(root, 'alpha.txt');
        fs.writeFileSync(file, ALPHA);
        // autoClose:false -> the caller's fd stays usable for a second stream.
        const fd = fs.openSync(file, 'r');
        const first = await drainLate(fs.createReadStream(null as unknown as string, { fd, autoClose: false, start: 0, end: 2 }), 0);
        const second = await drainLate(fs.createReadStream(null as unknown as string, { fd, autoClose: false, start: 10, end: 12 }), 0);
        const observed = { first: first.data.toString(), second: second.data.toString() };
        try { fs.closeSync(fd); } catch { /* already gone */ }
        strictEqual(observed.first, 'abc');
        strictEqual(observed.second, 'klm');
    });
});

Deno.test('fs streams: emitClose:false suppresses close on both directions', async () => {
    await withTempDir('fs-stream-emitclose', async (root) => {
        const file = join(root, 'alpha.txt');
        fs.writeFileSync(file, ALPHA);
        const rs = fs.createReadStream(file, { emitClose: false });
        const rsEvents: string[] = [];
        rs.on('data', () => {});
        rs.on('end', () => rsEvents.push('end'));
        rs.on('close', () => rsEvents.push('close'));
        const ws = fs.createWriteStream(join(root, 'out.txt'), { emitClose: false });
        const wsEvents: string[] = [];
        ws.on('finish', () => wsEvents.push('finish'));
        ws.on('close', () => wsEvents.push('close'));
        ws.end('x');
        await sleep(700);
        strictEqual(rsEvents.join('>'), 'end');
        strictEqual(wsEvents.join('>'), 'finish');
    });
});

Deno.test('fs streams: destroy() mid-read stops cleanly without end', async () => {
    await withTempDir('fs-stream-destroy', async (root) => {
        const file = join(root, 'big.bin');
        fs.writeFileSync(file, Buffer.alloc(200 * 1024, 0x41));
        const stream = fs.createReadStream(file, { highWaterMark: 1024 });
        const events: string[] = [];
        let got = 0;
        stream.on('data', (c) => { got += (c as Uint8Array).length; if (got >= 4096) stream.destroy(); });
        stream.on('end', () => events.push('end'));
        stream.on('error', (e) => events.push(`error:${(e as NodeJS.ErrnoException).code}`));
        await new Promise((r) => { stream.on('close', () => { events.push('close'); r(null); }); setTimeout(r, 3000); });
        strictEqual(events.join('>'), 'close', 'destroy() emits only close');
        strictEqual(stream.destroyed, true);
        ok(got >= 4096);
    });
});

Deno.test('fs streams: a missing path and a directory report string error codes', async () => {
    await withTempDir('fs-stream-errors', async (root) => {
        const missing = await drainLate(fs.createReadStream(join(root, 'nope.txt')), 0);
        ok(missing.events.includes('error:ENOENT'), `expected ENOENT, saw ${missing.events.join('>')}`);
        const dir = await drainLate(fs.createReadStream(root), 0);
        ok(dir.events.includes('error:EISDIR'), `expected EISDIR, saw ${dir.events.join('>')}`);
    });
});

Deno.test('fs streams: WriteStream emits finish before close', async () => {
    await withTempDir('fs-stream-order', async (root) => {
        const file = join(root, 'out.txt');
        const stream = fs.createWriteStream(file);
        const events: string[] = [];
        stream.on('open', () => events.push('open'));
        stream.on('ready', () => events.push('ready'));
        stream.on('finish', () => events.push('finish'));
        stream.on('close', () => events.push('close'));
        stream.write('hello ');
        stream.write('world');
        stream.end('!');
        await new Promise((r) => { stream.on('close', r); setTimeout(r, 3000); });
        strictEqual(events.join('>'), 'open>ready>finish>close');
        strictEqual(fs.readFileSync(file).toString(), 'hello world!');
        strictEqual(stream.bytesWritten, 12);
    });
});

Deno.test('fs streams: WriteStream flags and start position', async () => {
    await withTempDir('fs-stream-wflags', async (root) => {
        const appendTarget = join(root, 'a.txt');
        fs.writeFileSync(appendTarget, 'BASE');
        const appender = fs.createWriteStream(appendTarget, { flags: 'a' });
        appender.write('-one');
        appender.end('-two');
        await new Promise((r) => { appender.on('close', r); setTimeout(r, 2000); });
        strictEqual(fs.readFileSync(appendTarget).toString(), 'BASE-one-two');
        strictEqual(appender.bytesWritten, 8);

        const patchTarget = join(root, 'b.txt');
        fs.writeFileSync(patchTarget, '0123456789');
        const patcher = fs.createWriteStream(patchTarget, { start: 3, flags: 'r+' });
        patcher.end('XY');
        await new Promise((r) => { patcher.on('close', r); setTimeout(r, 2000); });
        strictEqual(fs.readFileSync(patchTarget).toString(), '012XY56789');

        const exclusive = join(root, 'c.txt');
        fs.writeFileSync(exclusive, 'X');
        const wx = fs.createWriteStream(exclusive, { flags: 'wx' });
        const errors: string[] = [];
        wx.on('error', (e) => errors.push((e as NodeJS.ErrnoException).code ?? 'null'));
        wx.write('nope');
        await sleep(800);
        // Exactly one 'error'; the open failure used to be reported twice.
        deepStrictEqual(errors, ['EEXIST']);
        strictEqual(fs.readFileSync(exclusive).toString(), 'X');
    });
});

Deno.test('fs streams: pipe() is byte-exact including a sliced source', async () => {
    await withTempDir('fs-stream-pipe', async (root) => {
        const src = join(root, 'src.bin');
        const payload = Buffer.alloc(300 * 1024 + 7);
        for (let i = 0; i < payload.length; i++) payload[i] = (i * 17) & 0xff;
        fs.writeFileSync(src, payload);

        const whole = join(root, 'whole.bin');
        await new Promise((resolve, reject) => {
            const w = fs.createWriteStream(whole);
            fs.createReadStream(src, { highWaterMark: 1024 }).pipe(w);
            w.on('close', resolve);
            w.on('error', reject);
            setTimeout(resolve, 30000);
        });
        ok(fs.readFileSync(whole).equals(payload), 'piped bytes must be identical');

        const slice = join(root, 'slice.bin');
        await new Promise((resolve) => {
            const w = fs.createWriteStream(slice);
            fs.createReadStream(src, { start: 100, end: 199 }).pipe(w);
            w.on('close', resolve);
            setTimeout(resolve, 8000);
        });
        ok(fs.readFileSync(slice).equals(payload.subarray(100, 200)), 'sliced pipe must be identical');
    });
});

Deno.test('fs utimes: a bare number is seconds on every entry point', async () => {
    await withTempDir('fs-utimes-units', async (root) => {
        // 1614834367s == 2021-03-04T05:06:07Z. Every path below used to stamp
        // 1970-01-19 because seconds were written as milliseconds.
        const seconds = 1614834367;
        const wantMs = seconds * 1000;
        const target = (name: string) => {
            const p = join(root, name);
            fs.writeFileSync(p, 'x');
            return p;
        };

        const syncPath = target('sync.txt');
        fs.utimesSync(syncPath, seconds, seconds);
        strictEqual(fs.statSync(syncPath).mtimeMs, wantMs, 'utimesSync');

        const cbPath = target('cb.txt');
        await new Promise<void>((resolve, reject) => fs.utimes(cbPath, seconds, seconds, (e) => e ? reject(e) : resolve()));
        strictEqual(fs.statSync(cbPath).mtimeMs, wantMs, 'fs.utimes callback');

        const promPath = target('prom.txt');
        await fsp.utimes(promPath, seconds, seconds);
        strictEqual(fs.statSync(promPath).mtimeMs, wantMs, 'fsp.utimes');

        const fhPath = target('fh.txt');
        const handle = await fsp.open(fhPath, 'r+');
        await handle.utimes(seconds, seconds);
        await handle.close();
        strictEqual(fs.statSync(fhPath).mtimeMs, wantMs, 'FileHandle.utimes');

        const futPath = target('fut.txt');
        const fd = fs.openSync(futPath, 'r+');
        fs.futimesSync(fd, seconds, seconds);
        fs.closeSync(fd);
        strictEqual(fs.statSync(futPath).mtimeMs, wantMs, 'futimesSync');

        const lutPath = target('lut.txt');
        fs.lutimesSync(lutPath, seconds, seconds);
        strictEqual(fs.statSync(lutPath).mtimeMs, wantMs, 'lutimesSync');

        const lutPromPath = target('lutprom.txt');
        await fsp.lutimes(lutPromPath, seconds, seconds);
        strictEqual(fs.statSync(lutPromPath).mtimeMs, wantMs, 'fsp.lutimes');
    });
});

Deno.test('fs utimes: Date, numeric string and fractional seconds all round-trip', async () => {
    await withTempDir('fs-utimes-forms', async (root) => {
        const p = join(root, 'a.txt');
        fs.writeFileSync(p, 'x');

        const when = new Date('2021-03-04T05:06:07.500Z');
        fs.utimesSync(p, when, when);
        strictEqual(fs.statSync(p).mtimeMs, when.getTime(), 'Date form');

        fs.utimesSync(p, '1614834367', '1614834367');
        strictEqual(fs.statSync(p).mtimeMs, 1614834367000, 'numeric string form');

        fs.utimesSync(p, 1614834367.25, 1614834367.75);
        strictEqual(fs.statSync(p).mtimeMs, 1614834367750, 'fractional seconds keep ms');

        // Node maps a negative timestamp to "now".
        fs.utimesSync(p, -1, -1);
        ok(Math.abs(fs.statSync(p).mtimeMs - Date.now()) < 60000, 'negative means now');

        for (const bad of [NaN, Infinity, null, {}, true]) {
            throws(
                () => fs.utimesSync(p, bad as unknown as number, bad as unknown as number),
                (e: unknown) => (e as NodeJS.ErrnoException).code === 'ERR_INVALID_ARG_TYPE',
                `utimesSync must reject ${String(bad)}`,
            );
        }
    });
});

Deno.test('fs watchFile: a path that does not exist yet is polled, not thrown', async () => {
    await withTempDir('fs-watchfile-missing', async (root) => {
        const p = join(root, 'later.txt');
        // This used to throw ENOENT synchronously and also surface as an
        // unhandled rejection from engine.waitIO, killing the process.
        let fired = 0;
        let firstPrevSize: unknown = 'never';
        fs.watchFile(p, { interval: 60 }, (curr, prev) => {
            fired++;
            if (fired === 1) firstPrevSize = prev.size;
        });
        await sleep(200);
        fs.writeFileSync(p, 'now-exists');
        await sleep(900);
        const observed = { fired, firstPrevSize };
        fs.unwatchFile(p);
        ok(observed.fired > 0, 'creating the file must fire the listener');
        strictEqual(observed.firstPrevSize, 0, 'the pre-existence Stats reports size 0');
    });
});

Deno.test('fs watchFile: bigint option yields BigInt stat fields', async () => {
    await withTempDir('fs-watchfile-bigint', async (root) => {
        const p = join(root, 'a.txt');
        fs.writeFileSync(p, 'a');
        let seen: string = 'never fired';
        fs.watchFile(p, { interval: 60, bigint: true }, (curr) => { seen = typeof curr.mtimeMs; });
        await sleep(200);
        fs.writeFileSync(p, 'bb-longer');
        await sleep(900);
        const observed = seen;
        fs.unwatchFile(p);
        strictEqual(observed, 'bigint');
    });
});

Deno.test('fs watchFile: unwatchFile removes only the named listener', async () => {
    await withTempDir('fs-watchfile-unwatch', async (root) => {
        const p = join(root, 'a.txt');
        fs.writeFileSync(p, 'a');
        let a = 0, b = 0;
        const first = () => { a++; };
        const second = () => { b++; };
        fs.watchFile(p, { interval: 60 }, first);
        fs.watchFile(p, { interval: 60 }, second);
        await sleep(150);
        fs.unwatchFile(p, first);
        fs.writeFileSync(p, 'bb-longer');
        await sleep(800);
        const observed = { a, b };
        fs.unwatchFile(p);
        strictEqual(observed.a, 0, 'the removed listener must not fire');
        ok(observed.b > 0, 'the remaining listener must still fire');
    });
});

Deno.test('fs watch: a missing path throws ENOENT as a string code', async () => {
    await withTempDir('fs-watch-missing', (root) => {
        throws(
            () => fs.watch(join(root, 'nope-zz')),
            (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT',
            'fs.watch on a missing path must throw ENOENT',
        );
    });
});

Deno.test('fs FileHandle: createReadStream / createWriteStream own the handle', async () => {
    await withTempDir('fs-fh-streams', async (root) => {
        const file = join(root, 'alpha.txt');
        fs.writeFileSync(file, ALPHA);

        const reader = await fsp.open(file, 'r');
        const stream = reader.createReadStream();
        const chunks: Buffer[] = [];
        await new Promise((r) => { stream.on('data', (c) => chunks.push(Buffer.from(c as Uint8Array))); stream.on('close', r); setTimeout(r, 3000); });
        strictEqual(Buffer.concat(chunks).toString(), ALPHA);
        // Measured Node v24.18.0: the handle is closed once its stream closes.
        await rejects(() => reader.stat(), (e: unknown) => (e as NodeJS.ErrnoException).code === 'EBADF');

        const ranged = await fsp.open(file, 'r');
        const slice = ranged.createReadStream({ start: 2, end: 5 });
        const sliceChunks: Buffer[] = [];
        await new Promise((r) => { slice.on('data', (c) => sliceChunks.push(Buffer.from(c as Uint8Array))); slice.on('close', r); setTimeout(r, 3000); });
        strictEqual(Buffer.concat(sliceChunks).toString(), 'cdef');

        const out = join(root, 'out.txt');
        const writer = await fsp.open(out, 'w');
        const ws = writer.createWriteStream();
        await new Promise((r) => { ws.end('viaFhStream', () => r(null)); setTimeout(r, 3000); });
        strictEqual(fs.readFileSync(out).toString(), 'viaFhStream');
    });
});

Deno.test('fs FileHandle: readableWebStream and readLines', async () => {
    await withTempDir('fs-fh-web', async (root) => {
        const file = join(root, 'alpha.txt');
        fs.writeFileSync(file, ALPHA);
        const handle = await fsp.open(file, 'r');
        const web = handle.readableWebStream();
        strictEqual(web.constructor.name, 'ReadableStream');
        const reader = web.getReader();
        let acc = Buffer.alloc(0);
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            ok(value instanceof Uint8Array, 'web stream chunks are Uint8Array');
            acc = Buffer.concat([acc, Buffer.from(value)]);
        }
        strictEqual(acc.toString(), ALPHA);
        // Node leaves the handle usable after a web stream drain, and refuses a
        // second readableWebStream() with ERR_INVALID_STATE.
        ok((await handle.stat()).size === 26, 'handle stays usable');
        throws(() => handle.readableWebStream(), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ERR_INVALID_STATE');
        await handle.close();

        const lines = join(root, 'lines.txt');
        fs.writeFileSync(lines, 'a\nb\r\nc\n');
        const lineHandle = await fsp.open(lines, 'r');
        const seen: string[] = [];
        for await (const line of lineHandle.readLines()) seen.push(line);
        deepStrictEqual(seen, ['a', 'b', 'c'], 'CRLF is stripped like readline');

        const noTrailing = join(root, 'nl.txt');
        fs.writeFileSync(noTrailing, 'x\ny');
        const tailHandle = await fsp.open(noTrailing, 'r');
        const tail: string[] = [];
        for await (const line of tailHandle.readLines()) tail.push(line);
        deepStrictEqual(tail, ['x', 'y'], 'a final unterminated line is yielded');
    });
});

Deno.test('fs FileHandle: shape is a FileHandle and aborts use ABORT_ERR', async () => {
    await withTempDir('fs-fh-shape', async (root) => {
        const file = join(root, 'alpha.txt');
        fs.writeFileSync(file, ALPHA);
        const handle = await fsp.open(file, 'r');
        strictEqual(handle.constructor.name, 'FileHandle');
        for (const method of ['createReadStream', 'createWriteStream', 'readableWebStream', 'readLines']) {
            strictEqual(typeof (handle as unknown as Record<string, unknown>)[method], 'function', `handle.${method}`);
        }
        // Measured Node v24.18.0: an AbortError (not a DOMException) with
        // code 'ABORT_ERR' and signal.reason on `.cause`.
        const isAbort = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ABORT_ERR' && (e as Error).name === 'AbortError';
        await rejects(() => handle.readFile({ signal: AbortSignal.abort() }), isAbort);
        await handle.close();
        await rejects(() => fsp.readFile(file, { signal: AbortSignal.abort() }), isAbort);
        await rejects(() => fsp.writeFile(join(root, 'w.txt'), 'x', { signal: AbortSignal.abort() }), isAbort);
    });
});

Deno.test('fs metadata: realpath.native exists in all three flavours', async () => {
    await withTempDir('fs-realpath-native', async (root) => {
        const file = join(root, 'a.txt');
        fs.writeFileSync(file, 'x');
        strictEqual(typeof fs.realpathSync.native, 'function');
        strictEqual(typeof fs.realpath.native, 'function', 'fs.realpath.native was missing');
        const viaCallback = await new Promise<string>((resolve, reject) =>
            fs.realpath.native(file, (e, p) => e ? reject(e) : resolve(p as string)));
        strictEqual(viaCallback.replace(/\\/g, '/').toLowerCase(), fs.realpathSync(file).replace(/\\/g, '/').toLowerCase());
    });
});

Deno.test('fs metadata: junction lstat/stat/readlink match Node', async () => {
    await withTempDir('fs-junction', async (root) => {
        const targetDir = join(root, 'sub');
        fs.mkdirSync(targetDir);
        fs.writeFileSync(join(targetDir, 'inner.txt'), 'i');
        const link = join(root, 'jnc');
        try {
            fs.symlinkSync(targetDir, link, 'junction');
        } catch {
            return; // no privilege to create reparse points here
        }
        const viaStat = fs.statSync(link);
        const viaLstat = fs.lstatSync(link);
        strictEqual(viaStat.isDirectory(), true, 'stat follows the junction');
        strictEqual(viaStat.isSymbolicLink(), false);
        strictEqual(viaLstat.isDirectory(), false, 'lstat does not follow');
        strictEqual(viaLstat.isSymbolicLink(), true);
        // readlink on a junction must resolve, not fail with a blank message.
        const resolved = String(fs.readlinkSync(link)).replace(/\\/g, '/').replace(/\/$/, '');
        strictEqual(resolved.toLowerCase(), targetDir.replace(/\\/g, '/').toLowerCase());
        deepStrictEqual(fs.readdirSync(link), ['inner.txt'], 'reads through the junction');
        const entry = fs.readdirSync(root, { withFileTypes: true }).find((e) => e.name === 'jnc');
        ok(entry, 'junction appears in readdir');
        strictEqual(entry.isSymbolicLink(), true);
        strictEqual(entry.isDirectory(), false);
    });
});

Deno.test('fs metadata: stat field types and bigint stats', async () => {
    await withTempDir('fs-stat-shape', async (root) => {
        const file = join(root, 'a.txt');
        fs.writeFileSync(file, 'hello');
        const st = fs.statSync(file);
        strictEqual(st.constructor.name, 'Stats');
        for (const key of ['dev', 'ino', 'mode', 'nlink', 'size', 'blksize', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs']) {
            strictEqual(typeof (st as unknown as Record<string, unknown>)[key], 'number', `stat.${key}`);
        }
        for (const key of ['atime', 'mtime', 'ctime', 'birthtime']) {
            ok((st as unknown as Record<string, unknown>)[key] instanceof Date, `stat.${key} is a Date`);
        }
        strictEqual(st.size, 5);
        ok(st.blksize > 0, 'blksize is positive');
        ok(Math.abs(st.mtimeMs - st.mtime.getTime()) < 2, 'mtimeMs agrees with mtime');
        strictEqual((st.mode & 0o170000) === 0o100000, true, 'regular-file mode bit');

        const big = fs.statSync(file, { bigint: true });
        strictEqual(big.constructor.name, 'BigIntStats');
        for (const key of ['size', 'mode', 'mtimeMs', 'mtimeNs', 'birthtimeNs']) {
            strictEqual(typeof (big as unknown as Record<string, unknown>)[key], 'bigint', `bigint stat.${key}`);
        }
        strictEqual(big.size, 5n);
        strictEqual(big.mtimeNs / 1000000n, big.mtimeMs, 'Ns and Ms agree');
        ok(big.mtime instanceof Date, 'bigint stats still expose Dates');

        const fd = fs.openSync(file, 'r');
        strictEqual(fs.fstatSync(fd, { bigint: true }).constructor.name, 'BigIntStats');
        fs.closeSync(fd);
        strictEqual(fs.lstatSync(file, { bigint: true }).constructor.name, 'BigIntStats');
    });
});

Deno.test('fs metadata: statfs shape', async () => {
    await withTempDir('fs-statfs', (root) => {
        const sf = fs.statfsSync(root);
        strictEqual(sf.constructor.name, 'StatFs');
        for (const key of ['type', 'bsize', 'blocks', 'bfree', 'bavail', 'files', 'ffree']) {
            strictEqual(typeof (sf as unknown as Record<string, unknown>)[key], 'number', `statfs.${key}`);
        }
        ok(sf.bsize > 0 && sf.blocks > 0, 'statfs values are sane');
        const big = fs.statfsSync(root, { bigint: true });
        strictEqual(typeof big.bsize, 'bigint');
    });
});

Deno.test('fs metadata: cp/cpSync honour filter, force and errorOnExist', async () => {
    await withTempDir('fs-cp', async (root) => {
        const src = join(root, 'src');
        fs.mkdirSync(join(src, 'd1', 'd2'), { recursive: true });
        fs.writeFileSync(join(src, 'f.txt'), 'F');
        fs.writeFileSync(join(src, 'd1', 'g.txt'), 'G');
        fs.writeFileSync(join(src, 'd1', 'd2', 'h.log'), 'H');
        const listing = (p: string) => fs.readdirSync(p, { recursive: true }).map((s) => String(s).replace(/\\/g, '/')).sort();

        fs.cpSync(src, join(root, 'full'), { recursive: true });
        deepStrictEqual(listing(join(root, 'full')), ['d1', 'd1/d2', 'd1/d2/h.log', 'd1/g.txt', 'f.txt']);

        throws(
            () => fs.cpSync(src, join(root, 'nope')),
            (e: unknown) => (e as NodeJS.ErrnoException).code === 'ERR_FS_EISDIR',
            'a directory without recursive must throw',
        );

        fs.cpSync(src, join(root, 'filtered'), { recursive: true, filter: (s) => !s.endsWith('.log') });
        deepStrictEqual(listing(join(root, 'filtered')), ['d1', 'd1/d2', 'd1/g.txt', 'f.txt']);

        const existing = join(root, 'existing.txt');
        fs.writeFileSync(existing, 'OLD');
        fs.cpSync(join(src, 'f.txt'), existing, { force: false });
        strictEqual(fs.readFileSync(existing).toString(), 'OLD', 'force:false keeps the destination');
        throws(
            () => fs.cpSync(join(src, 'f.txt'), existing, { errorOnExist: true, force: false }),
            (e: unknown) => (e as NodeJS.ErrnoException).code === 'ERR_FS_CP_EEXIST',
        );
        throws(
            () => fs.cpSync(src, join(src, 'inner'), { recursive: true }),
            (e: unknown) => (e as NodeJS.ErrnoException).code === 'ERR_FS_CP_EINVAL',
            'copying into itself must throw',
        );

        await fsp.cp(src, join(root, 'async'), { recursive: true });
        deepStrictEqual(listing(join(root, 'async')), ['d1', 'd1/d2', 'd1/d2/h.log', 'd1/g.txt', 'f.txt']);
        await fsp.cp(src, join(root, 'asyncFiltered'), { recursive: true, filter: async (s) => !s.endsWith('g.txt') });
        deepStrictEqual(listing(join(root, 'asyncFiltered')), ['d1', 'd1/d2', 'd1/d2/h.log', 'f.txt']);

        // cpSync must carry timestamps across when asked; this rode on the
        // seconds-as-milliseconds bug and produced a 1970 mtime.
        const stamped = join(root, 'stamped.txt');
        fs.utimesSync(join(src, 'f.txt'), 1300000000, 1300000000);
        fs.cpSync(join(src, 'f.txt'), stamped, { preserveTimestamps: true });
        strictEqual(fs.statSync(stamped).mtimeMs, 1300000000000);
    });
});

Deno.test('fs metadata: opendir, Dirent and mkdir recursive', async () => {
    await withTempDir('fs-dir', async (root) => {
        fs.mkdirSync(join(root, 'sub'));
        fs.writeFileSync(join(root, 'f.txt'), 'x');

        const dir = fs.opendirSync(root);
        strictEqual(dir.constructor.name, 'Dir');
        const seen: string[] = [];
        for (;;) {
            const entry = dir.readSync();
            if (entry === null) break;
            seen.push(`${entry.name}:${entry.isDirectory() ? 'D' : 'F'}`);
        }
        deepStrictEqual(seen.sort(), ['f.txt:F', 'sub:D']);
        dir.closeSync();
        throws(() => dir.readSync(), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ERR_DIR_CLOSED');

        const asyncDir = await fsp.opendir(root);
        const names: string[] = [];
        for await (const entry of asyncDir) names.push(entry.name);
        deepStrictEqual(names.sort(), ['f.txt', 'sub']);

        const entries = fs.readdirSync(root, { withFileTypes: true });
        strictEqual(entries[0].constructor.name, 'Dirent');
        ok(entries.every((e) => typeof e.parentPath === 'string'), 'Dirent exposes parentPath');

        // mkdir recursive returns the first directory it created.
        const created = fs.mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
        strictEqual(String(created).replace(/\\/g, '/').endsWith('/a'), true, `got ${created}`);
        strictEqual(fs.mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true }), undefined, 'no-op returns undefined');
        const deeper = fs.mkdirSync(join(root, 'a', 'b', 'c', 'd'), { recursive: true });
        strictEqual(String(deeper).replace(/\\/g, '/').endsWith('/a/b/c/d'), true, `got ${deeper}`);
        strictEqual(String(await fsp.mkdir(join(root, 'x', 'y'), { recursive: true })).replace(/\\/g, '/').endsWith('/x'), true);
    });
});
