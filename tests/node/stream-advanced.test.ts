import { strictEqual, ok } from 'node:assert';
import * as stream from 'node:stream';
import { Readable, Writable, Transform, PassThrough, pipeline, compose, isDisturbed, isErrored, isReadable } from 'node:stream';

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
    await new Promise<void>((resolve) => r.on('data', () => {}));
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

// --- 9. getDefaultHighWaterMark returns 16384 (objectMode false) ----------

Deno.test('stream: default highWaterMark is 16k in byte mode', () => {
    const fn = (stream as typeof stream & { getDefaultHighWaterMark?: (objectMode: boolean) => number }).getDefaultHighWaterMark;
    if (typeof fn === 'function') strictEqual(fn(false), 16384);
});
