import { strictEqual, ok, throws } from 'node:assert';
import { EventEmitter } from 'node:events';
import * as stream from 'node:stream';
import { Readable, Writable, Transform, PassThrough, pipeline, compose, getDefaultHighWaterMark, setDefaultHighWaterMark, isDisturbed, isErrored, isReadable } from 'node:stream';

// --- 1. isDisturbed reflects consumption state --------------------------------

Deno.test('stream: isDisturbed false before consumption, true after data', async () => {
    const r = new Readable({ read() { this.push('x'); this.push(null); } });
    ok(!isDisturbed(r), 'fresh readable is not disturbed');
    await new Promise<void>((resolve) => r.on('data', () => resolve()));
    ok(isDisturbed(r), 'readable is disturbed after data event');
});

// --- 2. isReadable true only while not ended --------------------------------

Deno.test('stream: isReadable true while open, false after null push', async () => {
    const r = new Readable({ read() { this.push('a'); this.push(null); } });
    ok(isReadable(r), 'readable before end');
    r.resume();
    await new Promise<void>((resolve) => r.on('end', () => resolve()));
    ok(!isReadable(r), 'readable after end is not readable');
});

// --- 3. compose chains two transforms --------------------------------------

Deno.test('stream: compose chains two transforms', async () => {
    const upper = new Transform({
        transform(chunk: Buffer, _e, cb) { cb(null, Buffer.from(chunk.toString().toUpperCase())); },
    });
    const bang = new Transform({
        transform(chunk: Buffer, _e, cb) { cb(null, Buffer.from(chunk.toString() + '!')); },
    });
    const c = compose(upper, bang);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
        c.on('data', (d: Buffer) => chunks.push(d));
        c.on('end', () => resolve());
        c.on('error', reject);
        c.write('hi');
        c.end();
    });
    strictEqual(Buffer.concat(chunks).toString(), 'HI!');
});

Deno.test('stream: compose requires at least two streams', () => {
    let threw = false;
    try { compose(new PassThrough()); } catch { threw = true; }
    ok(threw, 'compose with <2 streams must throw');
});

// --- 4. pipeline with async callback rejects on dest error -----------------

Deno.test('stream: pipeline resolves on success', async () => {
    const src = Readable.from(['abc', 'def']);
    let out = '';
    const dst = new Writable({ write(chunk: Buffer, _e, cb) { out += chunk.toString(); cb(); } });
    await new Promise<void>((resolve, reject) => {
        pipeline(src, dst, (err) => err ? reject(err) : resolve());
    });
    strictEqual(out, 'abcdef');
});

Deno.test('stream: pipeline callback receives error on transform failure', async () => {
    const src = Readable.from(['x']);
    const bad = new Transform({
        transform(_c, _e, cb) { cb(new Error('transform-fail')); },
    });
    const dst = new Writable({ write(_c, _e, cb) { cb(); } });
    let caught: Error | null = null;
    try {
        await new Promise<void>((resolve, reject) => {
            pipeline(src, bad, dst, (err) => err ? reject(err) : resolve());
        });
    } catch (e) {
        caught = e as Error;
    }
    ok(caught, 'pipeline must reject');
    ok(/transform-fail/.test(caught!.message));
});

// --- 5. Readable.from yields chunks ----------------------------------------

Deno.test('stream: Readable.from yields iterable values', async () => {
    const r = Readable.from(['a', 'b', 'c']);
    const out: string[] = [];
    for await (const chunk of r) out.push(chunk);
    strictEqual(out.join(''), 'abc');
});

Deno.test('stream: Readable.from emits Buffer as one binary chunk', async () => {
    const r = Readable.from(Buffer.from('abc'));
    const out: Buffer[] = [];
    for await (const chunk of r) out.push(Buffer.from(chunk as Buffer));
    strictEqual(out.length, 1);
    strictEqual(out[0].toString('utf8'), 'abc');
});

// --- 6. Writable.end returns this (chainable) and emits finish -------------

Deno.test('stream: Writable.end is chainable and emits finish', async () => {
    let finished = false;
    const w = new Writable({ write(_c, _e, cb) { cb(); } });
    w.on('finish', () => { finished = true; });
    const ret = w.end('data');
    strictEqual(ret, w, 'end must return this');
    await new Promise((r) => setTimeout(r, 20));
    ok(finished, 'finish must emit');
});

Deno.test('stream: Writable.end callback fires when already ended', async () => {
    const calls: string[] = [];
    const w = new Writable({ write(_c, _e, cb) { cb(); } });
    w.end('data', () => calls.push('first'));
    await new Promise((r) => setTimeout(r, 20));
    w.end(() => calls.push('second'));
    await new Promise((r) => setTimeout(r, 20));
    strictEqual(calls.join(','), 'first,second');
});

// --- 7. PassThrough passes data and is both readable and writable ----------

Deno.test('stream: PassThrough is duplex', () => {
    const pt = new PassThrough();
    ok(pt.readable);
    ok(pt.writable);
});

// --- 8. stream.promises.pipeline exists ------------------------------------

Deno.test('stream.promises.pipeline is exported', () => {
    const sp = (stream as typeof stream & { promises?: { pipeline?: unknown } }).promises;
    ok(typeof sp === 'object');
    ok(typeof sp?.pipeline === 'function');
});

// --- 9. getDefaultHighWaterMark follows upstream defaults -----------------

Deno.test('stream: default highWaterMark matches byte and object mode defaults', () => {
    const expectedByteMode = process.platform === 'win32' ? 16 * 1024 : 64 * 1024;
    strictEqual(getDefaultHighWaterMark(false), expectedByteMode);
    strictEqual(getDefaultHighWaterMark(true), 16);
    strictEqual(new Readable({ read() {} }).readableHighWaterMark, expectedByteMode);
    strictEqual(new Writable({ write(_c, _e, cb) { cb(); } }).writableHighWaterMark, expectedByteMode);
});

Deno.test('stream: setDefaultHighWaterMark affects newly constructed streams', () => {
    const previousByte = getDefaultHighWaterMark(false);
    const previousObject = getDefaultHighWaterMark(true);
    try {
        setDefaultHighWaterMark(false, 1024);
        setDefaultHighWaterMark(true, 2);
        strictEqual(getDefaultHighWaterMark(false), 1024);
        strictEqual(getDefaultHighWaterMark(true), 2);
        strictEqual(new Readable({ read() {} }).readableHighWaterMark, 1024);
        strictEqual(new Writable({ objectMode: true, write(_c, _e, cb) { cb(); } }).writableHighWaterMark, 2);
        throws(() => setDefaultHighWaterMark(false, -1), RangeError);
    } finally {
        setDefaultHighWaterMark(false, previousByte);
        setDefaultHighWaterMark(true, previousObject);
    }
});

// --- 10. Transform flush can emit a final chunk ----------------------------

Deno.test('stream: Transform flush can append a trailing chunk', async () => {
    const t = new Transform({
        transform(chunk: Buffer, _encoding, cb) {
            cb(null, chunk.toString().toUpperCase());
        },
        flush(cb) {
            cb(null, '!');
        },
    });

    const out: string[] = [];
    await new Promise<void>((resolve, reject) => {
        t.on('data', chunk => out.push(chunk.toString()));
        t.on('end', resolve);
        t.on('error', reject);
        t.end('hi');
    });

    strictEqual(out.join(''), 'HI!');
});

// --- 11. Readable.from async iterable surfaces iterator errors -------------

Deno.test('stream: Readable.from propagates async iterable errors after yielded chunks', async () => {
    const r = Readable.from((async function* () {
        yield 'a';
        throw new Error('boom');
    })());

    const chunks: string[] = [];
    let err: Error | null = null;
    try {
        for await (const chunk of r) chunks.push(String(chunk));
    } catch (e) {
        err = e as Error;
    }

    strictEqual(chunks.join(''), 'a');
    ok(err, 'iterator error must surface to the consumer');
    strictEqual(err!.message, 'boom');
});

// --- 12. unpipe emits on the destination with the original source ---------

Deno.test('stream: unpipe emits on the destination with the original source', () => {
    const src = Readable.from(['x']);
    const dst = new PassThrough();
    const seen: unknown[] = [];

    dst.on('unpipe', stream => seen.push(stream));
    src.pipe(dst);
    src.unpipe(dst);

    strictEqual(seen.length, 1);
    strictEqual(seen[0], src);
});

// --- 13. isReadable treats duplex streams with a readable side as readable -

Deno.test('stream: isReadable returns true for a fresh PassThrough', () => {
    strictEqual(isReadable(new PassThrough()), true);
});

Deno.test('stream upstream: base Stream is an EventEmitter', () => {
    strictEqual(new stream.Stream() instanceof EventEmitter, true);
});

Deno.test('stream: resume keeps readable-mode streams readable without data listeners', async () => {
    const pt = new PassThrough();
    const chunks: string[] = [];

    pt.on('readable', () => {
        let chunk;
        while ((chunk = pt.read()) !== null) {
            chunks.push(String(chunk));
        }
    });

    pt.resume();
    const ended = new Promise<void>((resolve) => pt.on('end', resolve));
    pt.end('abc');
    await ended;

    strictEqual(chunks.join(''), 'abc');
});

Deno.test('stream: unshift prepends data for readable and duplex streams', () => {
    const readable = new Readable({ read() {} });
    readable.push(Buffer.from('b'));
    readable.unshift(Buffer.from('a'));
    strictEqual(String(readable.read(1)), 'a');
    strictEqual(String(readable.read(1)), 'b');

    const duplex = new stream.Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
            callback();
        },
    });
    duplex.push(Buffer.from('b'));
    duplex.unshift(Buffer.from('a'));
    strictEqual(String(duplex.read(1)), 'a');
    strictEqual(String(duplex.read(1)), 'b');
});
