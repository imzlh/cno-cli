import { strictEqual, deepStrictEqual, ok, rejects, throws } from 'node:assert';

// ============================================================================
// Web Streams — queuing-strategy validation, source `type` enum, BYOB rejection,
// DecompressionStream error reporting, plus regression pins for the WebStreams
// fixes accepted on 2026-08-02.
//
// Every expectation here was measured against Node v24.18.0 AND Deno 2.9.3 first;
// where the two disagreed (see `size`/`highWaterMark` error ordering) the test
// deliberately asserts only what both agree on.
// ============================================================================

// A hang is the failure mode these streams defects actually produce, and an awaited
// promise that never settles reads as a pass to a test runner. Everything that could
// wedge goes through this.
const withTimeout = <T>(p: Promise<T>, ms = 4000, label = 'operation'): Promise<T> =>
    Promise.race([
        p,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`TIMEOUT: ${label} never settled within ${ms}ms`)), ms)
        ),
    ]);

const collect = async (rs: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
    const parts: Uint8Array[] = [];
    for await (const c of rs) parts.push(c);
    const total = parts.reduce((a, p) => a + p.length, 0);
    const flat = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { flat.set(p, o); o += p.length; }
    return flat;
};

// --- 1. A non-callable `size` is a TypeError at construction ---------------
// Node: 'The "strategy.size" property must be of type function'. Deno: "'size' of
// 'QueuingStrategy' ... is not a function". Both TypeError; `undefined` means absent.

Deno.test('QueuingStrategy: non-callable size throws TypeError', () => {
    for (const bad of [42, 'x', {}, null, true] as unknown[]) {
        throws(() => new ReadableStream({}, { size: bad as never, highWaterMark: 1 }), TypeError,
            `ReadableStream must reject size=${String(bad)}`);
        throws(() => new WritableStream({}, { size: bad as never, highWaterMark: 1 }), TypeError,
            `WritableStream must reject size=${String(bad)}`);
        throws(() => new TransformStream({}, { size: bad as never, highWaterMark: 1 }), TypeError,
            `TransformStream must reject size=${String(bad)}`);
    }
});

Deno.test('QueuingStrategy: absent or callable size is accepted', () => {
    ok(new ReadableStream({}, { size: undefined, highWaterMark: 1 }));
    ok(new ReadableStream({}, { highWaterMark: 1 }));
    ok(new ReadableStream({}, { size: () => 1, highWaterMark: 1 }));
    ok(new WritableStream({}, { size: () => 1, highWaterMark: 1 }));
});

// --- 2. highWaterMark is a required dictionary member ----------------------

Deno.test('CountQueuingStrategy: highWaterMark is required', () => {
    throws(() => new CountQueuingStrategy({} as never), TypeError, 'empty init must throw');
    throws(() => new CountQueuingStrategy(undefined as never), TypeError, 'missing init must throw');
    throws(() => new CountQueuingStrategy({ highWaterMark: undefined } as never), TypeError,
        'explicit undefined highWaterMark must throw');
    strictEqual(new CountQueuingStrategy({ highWaterMark: 3 }).highWaterMark, 3);
});

Deno.test('ByteLengthQueuingStrategy: highWaterMark is required', () => {
    throws(() => new ByteLengthQueuingStrategy({} as never), TypeError);
    throws(() => new ByteLengthQueuingStrategy(undefined as never), TypeError);
    strictEqual(new ByteLengthQueuingStrategy({ highWaterMark: 16 }).highWaterMark, 16);
});

Deno.test('QueuingStrategy init must be an object', () => {
    for (const bad of [5, 'x', null, true] as unknown[]) {
        throws(() => new CountQueuingStrategy(bad as never), TypeError,
            `CountQueuingStrategy must reject init=${String(bad)}`);
        throws(() => new ByteLengthQueuingStrategy(bad as never), TypeError,
            `ByteLengthQueuingStrategy must reject init=${String(bad)}`);
    }
});

// --- 3. Brand checks on the strategy accessors ----------------------------
// Both oracles throw when the accessor runs on something that is not an instance
// (Node reports a private-field read, Deno "Illegal invocation"); only the type matters.

Deno.test('CountQueuingStrategy: accessors are brand-checked', () => {
    throws(() => CountQueuingStrategy.prototype.size, TypeError, 'prototype.size must brand-check');
    throws(() => CountQueuingStrategy.prototype.highWaterMark, TypeError,
        'prototype.highWaterMark must brand-check');
    throws(() => Object.create(CountQueuingStrategy.prototype).highWaterMark, TypeError,
        'Object.create must not pass the brand check');
    throws(() => ByteLengthQueuingStrategy.prototype.size, TypeError);
    throws(() => ByteLengthQueuingStrategy.prototype.highWaterMark, TypeError);
});

Deno.test('QueuingStrategy: size still works on real instances', () => {
    strictEqual(new CountQueuingStrategy({ highWaterMark: 1 }).size('anything'), 1);
    strictEqual(new ByteLengthQueuingStrategy({ highWaterMark: 1 }).size(new Uint8Array(7)), 7);
});

// --- 4. WebIDL shape of the strategy interfaces ---------------------------

Deno.test('QueuingStrategy: highWaterMark and size are enumerable prototype accessors', () => {
    for (const Ctor of [CountQueuingStrategy, ByteLengthQueuingStrategy]) {
        for (const key of ['highWaterMark', 'size']) {
            const d = Object.getOwnPropertyDescriptor(Ctor.prototype, key);
            ok(d, `${Ctor.name}.prototype.${key} must exist`);
            strictEqual(typeof d!.get, 'function', `${Ctor.name}.${key} must be an accessor`);
            strictEqual(d!.enumerable, true, `${Ctor.name}.${key} must be enumerable`);
        }
        // Instances carry no own data properties: the values live behind the accessors.
        deepStrictEqual(Object.getOwnPropertyNames(new Ctor({ highWaterMark: 1 })), []);
    }
    strictEqual(Object.prototype.toString.call(new CountQueuingStrategy({ highWaterMark: 1 })),
        '[object CountQueuingStrategy]');
    strictEqual(Object.prototype.toString.call(new ByteLengthQueuingStrategy({ highWaterMark: 1 })),
        '[object ByteLengthQueuingStrategy]');
});

Deno.test('QueuingStrategy: size is one shared function per class', () => {
    strictEqual(new CountQueuingStrategy({ highWaterMark: 1 }).size,
        new CountQueuingStrategy({ highWaterMark: 2 }).size);
    strictEqual(new ByteLengthQueuingStrategy({ highWaterMark: 1 }).size,
        new ByteLengthQueuingStrategy({ highWaterMark: 2 }).size);
});

// --- 5. highWaterMark is an unrestricted double on the strategy object ----
// Out-of-range values are *stored* here and only rejected when a stream uses them.

Deno.test('QueuingStrategy: highWaterMark is coerced, not validated, at construction', () => {
    strictEqual(new CountQueuingStrategy({ highWaterMark: '5' as never }).highWaterMark, 5);
    strictEqual(new CountQueuingStrategy({ highWaterMark: null as never }).highWaterMark, 0);
    strictEqual(new CountQueuingStrategy({ highWaterMark: { valueOf: () => 7 } as never }).highWaterMark, 7);
    strictEqual(new CountQueuingStrategy({ highWaterMark: -1 }).highWaterMark, -1);
    // ...but a negative highWaterMark is a RangeError once a stream extracts it.
    throws(() => new ReadableStream({}, new CountQueuingStrategy({ highWaterMark: -1 })), RangeError);
});

Deno.test('QueuingStrategy: subclasses pass the brand check', () => {
    class Sub extends CountQueuingStrategy {}
    strictEqual(new Sub({ highWaterMark: 9 }).highWaterMark, 9);
    strictEqual(new Sub({ highWaterMark: 9 }).size('x'), 1);
});

// --- 6. UnderlyingSource.type is a WebIDL enum ----------------------------
// Coercion happens before the check, so `{ toString: () => 'bytes' }` is accepted.

Deno.test('ReadableStream: unknown source type throws TypeError', () => {
    for (const bad of ['nonsense', null, '', 5, 'BYTES', true] as unknown[]) {
        throws(() => new ReadableStream({ type: bad as never }), TypeError,
            `type=${String(bad)} must be rejected`);
    }
});

Deno.test('ReadableStream: bytes and absent type are accepted', () => {
    ok(new ReadableStream({ type: undefined }));
    ok(new ReadableStream({}));
    ok(new ReadableStream({ type: 'bytes' }));
    ok(new ReadableStream({ type: { toString: () => 'bytes' } as never }));
});

// --- 7. getReader mode enum ----------------------------------------------

Deno.test('ReadableStream: byob reader request is a TypeError', () => {
    const rs = new ReadableStream({ start(c) { c.close(); } });
    // Unimplemented (no byte-stream controller), but it must fail as the spec's
    // TypeError rather than a bare Error, so feature detection can branch on it.
    throws(() => rs.getReader({ mode: 'byob' }), TypeError);
});

Deno.test('ReadableStream: invalid getReader mode is a TypeError', () => {
    throws(() => new ReadableStream({ start(c) { c.close(); } }).getReader({ mode: 'nonsense' as never }),
        TypeError);
    strictEqual(new ReadableStream({ start(c) { c.close(); } }).getReader().constructor.name,
        'ReadableStreamDefaultReader');
    strictEqual(new ReadableStream({ start(c) { c.close(); } }).getReader({}).constructor.name,
        'ReadableStreamDefaultReader');
});

// --- 8. DecompressionStream must report bad input, not hang --------------

Deno.test('DecompressionStream: garbage input rejects instead of hanging', async () => {
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    // Erroring only the writable used to leave `readable` awaiting forever, so this
    // must be timed: an unbounded await would score a hang as a pass.
    await rejects(
        () => withTimeout(collect(new Blob([bad]).stream().pipeThrough(new DecompressionStream('gzip'))),
            4000, 'garbage gzip decompression'),
        TypeError,
    );
});

Deno.test('DecompressionStream: truncated input rejects instead of returning partial data', async () => {
    const full = await collect(new Blob(['some text to compress here'])
        .stream().pipeThrough(new CompressionStream('gzip')));
    ok(full.length > 8, 'compressed fixture must be non-trivial');
    const cut = full.slice(0, full.length - 4);
    await rejects(
        () => withTimeout(collect(new Blob([cut]).stream().pipeThrough(new DecompressionStream('gzip'))),
            4000, 'truncated gzip decompression'),
        TypeError,
    );
});

Deno.test('DecompressionStream: valid round-trips still succeed', async () => {
    for (const fmt of ['gzip', 'deflate', 'deflate-raw'] as const) {
        const text = 'round trip payload '.repeat(30);
        const out = await withTimeout(collect(new Blob([text]).stream()
            .pipeThrough(new CompressionStream(fmt))
            .pipeThrough(new DecompressionStream(fmt))), 6000, `${fmt} round-trip`);
        strictEqual(new TextDecoder().decode(out), text, `${fmt} must round-trip exactly`);
    }
});

Deno.test('DecompressionStream: binary payload round-trips byte-for-byte', async () => {
    const bytes = new Uint8Array(3000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    const out = await withTimeout(collect(new Blob([bytes]).stream()
        .pipeThrough(new CompressionStream('gzip'))
        .pipeThrough(new DecompressionStream('gzip'))), 6000, 'binary round-trip');
    deepStrictEqual(Array.from(out), Array.from(bytes));
});

// ============================================================================
// Regression pins for the four fixes accepted 2026-08-02. These reproduce the
// original defects exactly; before those fixes each one hung or silently corrupted.
// ============================================================================

// --- 9. A throwing or junk-returning size() must error the stream ---------

Deno.test('ReadableStream: throwing size() errors the stream instead of wedging it', async () => {
    const rs = new ReadableStream({ start(c) { c.enqueue('a'); } },
        { size: () => { throw new RangeError('boom'); }, highWaterMark: 1 });
    const reader = rs.getReader();
    // All three used to stay pending forever with the stream still 'readable'.
    await rejects(() => withTimeout(reader.read(), 3000, 'first read'), RangeError);
    await rejects(() => withTimeout(reader.read(), 3000, 'second read'), RangeError);
    await rejects(() => withTimeout(reader.closed, 3000, 'closed'), RangeError);
});

Deno.test('ReadableStream: junk size() values error the stream', async () => {
    for (const [label, size] of [
        ['NaN', () => NaN],
        ['-1', () => -1],
        ['string', () => 'x' as unknown as number],
        ['Infinity', () => Infinity],
    ] as const) {
        const rs = new ReadableStream({ start(c) { c.enqueue('a'); } },
            { size: size as (c: unknown) => number, highWaterMark: 1 });
        const reader = rs.getReader();
        await rejects(() => withTimeout(reader.read(), 3000, `read after size=${label}`), RangeError,
            `size returning ${label} must error the stream`);
        await rejects(() => withTimeout(reader.closed, 3000, `closed after size=${label}`), RangeError);
    }
});

Deno.test('ReadableStream: size() throwing on a later enqueue errors the stream', async () => {
    let controller: ReadableStreamDefaultController<string>;
    const rs = new ReadableStream<string>({ start(c) { controller = c; } },
        { size: () => { throw new RangeError('late'); }, highWaterMark: 1 });
    throws(() => controller!.enqueue('a'), RangeError, 'the throw must reach the producer');
    const reader = rs.getReader();
    await rejects(() => withTimeout(reader.read(), 3000, 'read'), RangeError);
    // Stream is errored, so a second enqueue is rejected rather than silently queued.
    throws(() => controller!.enqueue('b'), TypeError);
});

// --- 10. write-then-close must not lose data -----------------------------

Deno.test('ReadableStream: enqueue-then-close delivers every chunk', async () => {
    for (const [hwm, n] of [[1, 5], [0, 5], [3, 10], [1, 100], [2, 50]] as const) {
        let controller: ReadableStreamDefaultController<number>;
        const rs = new ReadableStream<number>({ start(c) { controller = c; } }, { highWaterMark: hwm });
        for (let i = 0; i < n; i++) controller!.enqueue(i);
        controller!.close();
        const got: number[] = [];
        const reader = rs.getReader();
        for (;;) {
            const { value, done } = await withTimeout(reader.read(), 4000, `read hwm=${hwm}`);
            if (done) break;
            got.push(value!);
        }
        strictEqual(got.length, n, `hwm=${hwm} must deliver all ${n} chunks`);
        strictEqual(got[0], 0);
        strictEqual(got[n - 1], n - 1);
    }
});

Deno.test('WritableStream: unawaited writes then close reach the sink', async () => {
    for (const [hwm, n] of [[1, 5], [0, 5], [4, 20]] as const) {
        const seen: string[] = [];
        const ws = new WritableStream<string>({ write(c) { seen.push(c); } }, { highWaterMark: hwm });
        const writer = ws.getWriter();
        const writes = [];
        for (let i = 0; i < n; i++) writes.push(writer.write('w' + i));
        const closing = writer.close();
        await Promise.allSettled(writes);
        await withTimeout(closing, 4000, `close hwm=${hwm}`);
        strictEqual(seen.length, n, `hwm=${hwm} must observe all ${n} writes`);
    }
});

Deno.test('ReadableStream: sized backpressure buffer drains on close', async () => {
    let controller: ReadableStreamDefaultController<string>;
    const n = 50;
    const rs = new ReadableStream<string>({ start(c) { controller = c; } },
        { highWaterMark: 2, size: (chunk) => chunk.length });
    for (let i = 0; i < n; i++) controller!.enqueue('xxxx' + i);
    controller!.close();
    let count = 0;
    const reader = rs.getReader();
    for (;;) {
        const { done } = await withTimeout(reader.read(), 4000, 'sized drain read');
        if (done) break;
        count++;
    }
    strictEqual(count, n, 'every chunk past the high water mark must still be delivered');
});

// --- 11. TextEncoderStream must not split surrogate pairs ---------------

Deno.test('TextEncoderStream: a surrogate pair split across chunks survives', async () => {
    const cases: Array<[string, string[]]> = [
        ['split pair', ['\ud83d', '\ude00']],
        ['split pair in context', ['a\ud83d', '\ude00b']],
        ['whole pair', ['\u{1f600}']],
        ['lone high surrogate at end', ['\ud83d']],
        ['lone low surrogate', ['\ude00']],
        ['high surrogate then ascii', ['\ud83d', 'A']],
        ['two pairs across three chunks', ['x\ud83d', '\ude00\ud83d', '\ude0ay']],
        ['empty chunk between halves', ['\ud83d', '', '\ude00']],
    ];
    for (const [label, chunks] of cases) {
        const ts = new TextEncoderStream();
        const parts: Uint8Array[] = [];
        const done = (async () => { for await (const p of ts.readable) parts.push(p); })();
        const writer = ts.writable.getWriter();
        for (const c of chunks) await writer.write(c);
        await writer.close();
        await withTimeout(done, 4000, `encode ${label}`);
        const total = parts.reduce((a, p) => a + p.length, 0);
        const flat = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { flat.set(p, o); o += p.length; }
        // The stream must agree with encoding the whole string at once.
        deepStrictEqual(Array.from(flat), Array.from(new TextEncoder().encode(chunks.join(''))),
            `${label} must encode identically to TextEncoder`);
    }
});

// --- 12. structuredClone must not hollow out Blob/File ------------------

Deno.test('structuredClone: Blob keeps size, type and contents', async () => {
    const blob = new Blob(['hello world'], { type: 'text/plain' });
    const clone = structuredClone(blob);
    ok(clone instanceof Blob, 'clone must still be a Blob');
    strictEqual(clone.size, blob.size);
    strictEqual(clone.type, 'text/plain');
    strictEqual(await clone.text(), 'hello world');
});

Deno.test('structuredClone: Blob preserves binary bytes and slices', async () => {
    const bytes = new Uint8Array([0, 1, 255, 128, 0]);
    const clone = structuredClone(new Blob([bytes]));
    deepStrictEqual(Array.from(new Uint8Array(await clone.arrayBuffer())), Array.from(bytes));
    strictEqual(structuredClone(new Blob([])).size, 0);
    strictEqual(await structuredClone(new Blob(['0123456789']).slice(2, 5)).text(), '234');
});

Deno.test('structuredClone: File keeps name and lastModified', async () => {
    const file = new File(['abc'], 'note.txt', { type: 'text/plain', lastModified: 1234567890 });
    const clone = structuredClone(file);
    ok(clone instanceof File, 'clone must still be a File');
    strictEqual(clone.name, 'note.txt');
    strictEqual(clone.type, 'text/plain');
    strictEqual(clone.lastModified, 1234567890);
    strictEqual(await clone.text(), 'abc');
});

Deno.test('structuredClone: Blobs nested in containers survive', async () => {
    const source = {
        arr: [new Blob(['x1'])],
        map: new Map([['k', new Blob(['x2'])]]),
        set: new Set([new Blob(['x3'])]),
    };
    const clone = structuredClone(source);
    strictEqual(await clone.arr[0].text(), 'x1');
    strictEqual(await clone.map.get('k')!.text(), 'x2');
    strictEqual(await [...clone.set][0].text(), 'x3');
});

Deno.test('structuredClone: a Blob referenced twice stays one object', async () => {
    const blob = new Blob(['dup']);
    const clone = structuredClone({ x: blob, y: blob });
    strictEqual(clone.x, clone.y, 'shared references must be preserved');
    strictEqual(await clone.x.text(), 'dup');
});

Deno.test('structuredClone: non-serializable web objects throw DataCloneError', () => {
    for (const make of [() => new URL('https://x.test/'), () => new Headers(), () => () => {}]) {
        throws(() => structuredClone(make() as never), (e: Error) => e.name === 'DataCloneError',
            'must reject with DataCloneError');
    }
});

// ============================================================================
// Previously uncovered areas, each verified against Node and Deno before pinning.
// ============================================================================

Deno.test('ReadableStream.tee: both branches receive every chunk', async () => {
    const rs = new ReadableStream({ start(c) { c.enqueue(1); c.enqueue(2); c.enqueue(3); c.close(); } });
    const [a, b] = rs.tee();
    ok(rs.locked, 'tee must lock the source');
    const drain = async (s: ReadableStream) => {
        const out: unknown[] = [];
        const r = s.getReader();
        for (;;) { const { value, done } = await withTimeout(r.read(), 3000, 'tee read'); if (done) break; out.push(value); }
        return out;
    };
    const [ra, rb] = await Promise.all([drain(a), drain(b)]);
    deepStrictEqual(ra, [1, 2, 3]);
    deepStrictEqual(rb, [1, 2, 3]);
});

Deno.test('ReadableStream.tee: cancelling one branch leaves the other readable', async () => {
    const rs = new ReadableStream({ start(c) { c.enqueue('x'); c.enqueue('y'); c.close(); } });
    const [a, b] = rs.tee();
    // Not awaited: a branch's cancel promise stays pending until BOTH branches cancel.
    void a.cancel('nope').catch(() => {});
    const out: unknown[] = [];
    const r = b.getReader();
    for (;;) { const { value, done } = await withTimeout(r.read(), 3000, 'surviving branch'); if (done) break; out.push(value); }
    deepStrictEqual(out, ['x', 'y']);
});

Deno.test('ReadableStream.tee: source cancel runs only once both branches cancel', async () => {
    let reason = 'never';
    const rs = new ReadableStream({ start(c) { c.enqueue(1); }, cancel(r) { reason = String(r); } });
    const [a, b] = rs.tee();
    await withTimeout(Promise.all([a.cancel('ra'), b.cancel('rb')]), 3000, 'both cancels');
    strictEqual(reason, 'ra,rb', 'source cancel receives both branch reasons');
});

Deno.test('ReadableStream.tee: an error reaches both branches', async () => {
    let controller: ReadableStreamDefaultController<number>;
    const rs = new ReadableStream<number>({ start(c) { controller = c; } });
    const [a, b] = rs.tee();
    controller!.error(new Error('tee-boom'));
    await rejects(() => withTimeout(a.getReader().read(), 3000, 'branch a'), /tee-boom/);
    await rejects(() => withTimeout(b.getReader().read(), 3000, 'branch b'), /tee-boom/);
});

Deno.test('ReadableStream.tee: chunks are passed by reference, not cloned', async () => {
    const obj = { v: 1 };
    const rs = new ReadableStream({ start(c) { c.enqueue(obj); c.close(); } });
    const [a, b] = rs.tee();
    const first = async (s: ReadableStream) => (await withTimeout(s.getReader().read(), 3000, 'tee ref')).value;
    const [ va, vb ] = await Promise.all([first(a), first(b)]);
    strictEqual(va, vb);
    strictEqual(va, obj);
});

Deno.test('ReadableStream.tee: tee on a locked stream throws', () => {
    const rs = new ReadableStream({ start(c) { c.close(); } });
    rs.getReader();
    throws(() => rs.tee(), TypeError);
});

Deno.test('pipeTo: preventClose leaves the destination open', async () => {
    const state = { chunks: [] as unknown[], closed: false };
    const ws = new WritableStream({ write(c) { state.chunks.push(c); }, close() { state.closed = true; } });
    const rs = new ReadableStream({ start(c) { c.enqueue(0); c.enqueue(1); c.close(); } });
    await withTimeout(rs.pipeTo(ws, { preventClose: true }), 4000, 'pipeTo preventClose');
    deepStrictEqual(state.chunks, [0, 1]);
    strictEqual(state.closed, false, 'preventClose must not close the destination');
});

Deno.test('pipeTo: preventAbort leaves the destination unaborted on source error', async () => {
    const state = { aborted: 'no' };
    const ws = new WritableStream({ abort(r) { state.aborted = String(r); } });
    const rs = new ReadableStream({ start(c) { c.enqueue(0); c.error(new Error('src-bad')); } });
    await rejects(() => withTimeout(rs.pipeTo(ws, { preventAbort: true }), 4000, 'pipeTo preventAbort'),
        /src-bad/);
    strictEqual(state.aborted, 'no');
});

Deno.test('pipeTo: preventCancel leaves the source uncancelled on destination error', async () => {
    let cancelled = 'no';
    const rs = new ReadableStream({ start(c) { c.enqueue(1); }, cancel(r) { cancelled = String(r); } });
    const ws = new WritableStream({ write() { throw new Error('dest-bad'); } });
    await rejects(() => withTimeout(rs.pipeTo(ws, { preventCancel: true }), 4000, 'pipeTo preventCancel'),
        /dest-bad/);
    strictEqual(cancelled, 'no');
});

Deno.test('pipeTo: source error aborts the destination by default', async () => {
    const state = { aborted: 'no' };
    const ws = new WritableStream({ abort(r) { state.aborted = String(r); } });
    const rs = new ReadableStream({ start(c) { c.enqueue(0); c.error(new Error('src-bad')); } });
    await rejects(() => withTimeout(rs.pipeTo(ws), 4000, 'pipeTo default abort'), /src-bad/);
    ok(state.aborted.includes('src-bad'), `destination must be aborted, got ${state.aborted}`);
});

Deno.test('pipeTo: an AbortSignal aborts the pipe and the destination', async () => {
    const controller = new AbortController();
    const state = { aborted: 'no' };
    const ws = new WritableStream({ abort(r) { state.aborted = String(r); } });
    const rs = new ReadableStream({ start(c) { c.enqueue('a'); } });
    const piped = rs.pipeTo(ws, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort(new Error('mid'));
    await rejects(() => withTimeout(piped, 4000, 'aborted pipeTo'), /mid/);
    ok(state.aborted.includes('mid'), `destination must be aborted, got ${state.aborted}`);
    strictEqual(rs.locked, false, 'an aborted pipe must release the source lock');
});

Deno.test('pipeTo: an already-aborted signal rejects immediately', async () => {
    const ws = new WritableStream({});
    const rs = new ReadableStream({ start(c) { c.enqueue('a'); c.close(); } });
    await rejects(() => withTimeout(rs.pipeTo(ws, { signal: AbortSignal.abort('pre') }), 4000,
        'pre-aborted pipeTo'));
});

Deno.test('pipeTo: locks both streams and releases them on completion', async () => {
    const ws = new WritableStream({ write() {} });
    const rs = new ReadableStream({ start(c) { c.enqueue(1); c.close(); } });
    const piped = rs.pipeTo(ws);
    ok(rs.locked && ws.locked, 'pipeTo must lock both ends');
    await withTimeout(piped, 4000, 'pipeTo completion');
    ok(!rs.locked && !ws.locked, 'both ends must unlock when the pipe finishes');
});

Deno.test('pipeTo: piping a locked source rejects', async () => {
    const rs = new ReadableStream({ start(c) { c.close(); } });
    rs.getReader();
    await rejects(() => withTimeout(rs.pipeTo(new WritableStream({})), 4000, 'locked pipeTo'), TypeError);
});

Deno.test('TransformStream: a throwing transform errors both ends', async () => {
    const ts = new TransformStream({ transform() { throw new Error('t-boom'); } });
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    void writer.write('a').catch(() => {});
    await rejects(() => withTimeout(reader.read(), 3000, 'transform throw read'), /t-boom/);
    await rejects(() => withTimeout(writer.closed, 3000, 'transform throw closed'), /t-boom/);
});

Deno.test('TransformStream: a throwing flush rejects close and errors the readable', async () => {
    const ts = new TransformStream({ flush() { throw new Error('f-boom'); } });
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    await rejects(() => withTimeout(writer.close(), 3000, 'flush throw close'), /f-boom/);
    await rejects(() => withTimeout(reader.read(), 3000, 'flush throw read'), /f-boom/);
});

Deno.test('TransformStream: flush may enqueue a trailing chunk', async () => {
    const ts = new TransformStream<string, string>({
        transform(c, ctl) { ctl.enqueue(c); },
        flush(ctl) { ctl.enqueue('tail'); },
    });
    const writer = ts.writable.getWriter();
    const out: string[] = [];
    const done = (async () => { for await (const v of ts.readable) out.push(v); })();
    await writer.write('a');
    await writer.close();
    await withTimeout(done, 4000, 'flush enqueue');
    deepStrictEqual(out, ['a', 'tail']);
});

Deno.test('TransformStream: terminate ends the readable cleanly', async () => {
    const ts = new TransformStream({ transform(_c, ctl) { ctl.terminate(); } });
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    void writer.write('a').catch(() => {});
    const { done } = await withTimeout(reader.read(), 3000, 'terminate read');
    strictEqual(done, true);
});

Deno.test('TransformStream: a rejecting async transform errors the readable', async () => {
    const ts = new TransformStream({ async transform() { throw new Error('at-boom'); } });
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    void writer.write('a').catch(() => {});
    await rejects(() => withTimeout(reader.read(), 3000, 'async transform read'), /at-boom/);
});

Deno.test('WritableStream: close after abort is rejected and the sink is not closed', async () => {
    const state = { aborted: 'no', closed: false };
    const ws = new WritableStream({ close() { state.closed = true; }, abort(r) { state.aborted = String(r); } });
    const writer = ws.getWriter();
    const aborting = writer.abort('A');
    await rejects(() => withTimeout(writer.close(), 3000, 'close after abort'));
    await withTimeout(aborting, 3000, 'abort');
    strictEqual(state.aborted, 'A');
    strictEqual(state.closed, false, 'the sink must not be closed after an abort');
});

Deno.test('WritableStream: write and second close after close are rejected', async () => {
    const ws = new WritableStream({});
    const writer = ws.getWriter();
    await withTimeout(writer.close(), 3000, 'close');
    await rejects(() => withTimeout(writer.write('x'), 3000, 'write after close'), TypeError);
    await rejects(() => withTimeout(writer.close(), 3000, 'second close'), TypeError);
});

Deno.test('WritableStream: releaseLock rejects the writer closed promise', async () => {
    const ws = new WritableStream({ write() { return new Promise<void>(() => {}); } });
    const writer = ws.getWriter();
    void writer.write('x').catch(() => {});
    writer.releaseLock();
    await rejects(() => withTimeout(writer.closed, 3000, 'closed after releaseLock'), TypeError);
});

Deno.test('WritableStream: abort resolves without a sink abort method', async () => {
    const writer = new WritableStream({}).getWriter();
    await withTimeout(writer.abort('r'), 3000, 'abort without sink.abort');
    await rejects(() => withTimeout(writer.closed, 3000, 'closed after abort'));
});
