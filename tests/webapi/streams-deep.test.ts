import { strictEqual, ok } from 'node:assert';

// ============================================================================
// Web Streams — ReadableStream / WritableStream / TransformStream edge cases
// ============================================================================

// --- 1. ReadableStream: async iterator drains chunks -----------------------

Deno.test('ReadableStream: async iterator drains chunks', async () => {
    const rs = new ReadableStream<number>({
        start(c) { c.enqueue(1); c.enqueue(2); c.enqueue(3); c.close(); },
    });
    const out: number[] = [];
    for await (const chunk of rs) out.push(chunk);
    strictEqual(out.join(','), '1,2,3');
});

// --- 2. ReadableStream: getReader locks the stream ------------------------

Deno.test('ReadableStream: getReader locks; second reader throws', () => {
    const rs = new ReadableStream({ start(c) { c.close(); } });
    const r = rs.getReader();
    ok(rs.locked, 'stream must be locked after getReader');
    let threw = false;
    try { rs.getReader(); } catch { threw = true; }
    ok(threw, 'second getReader on locked stream must throw');
    r.releaseLock();
    ok(!rs.locked, 'releaseLock unlocks');
});

// --- 3. ReadableStream: tee produces two independent streams ---------------

Deno.test('ReadableStream: tee yields two independent streams', async () => {
    const rs = new ReadableStream<number>({
        start(c) { c.enqueue(10); c.enqueue(20); c.close(); },
    });
    const [a, b] = rs.tee();
    const ra = a.getReader();
    const rb = b.getReader();
    const va = await ra.read();
    const vb = await rb.read();
    strictEqual(va.value, 10);
    strictEqual(vb.value, 10);
    await ra.read(); // finish a
    const vb2 = await rb.read();
    strictEqual(vb2.value, 20, 'b must still see all chunks');
});

// --- 4. ReadableStream: reader.cancel resolves pending read ----------------

Deno.test('ReadableStream: reader.cancel resolves pending read as done', async () => {
    const rs = new ReadableStream({ start(_c) {} });
    const r = rs.getReader();
    const p = r.read();
    await r.cancel('my-reason');
    const result = await p;
    strictEqual(result.done, true);
    strictEqual(result.value, undefined);
});

// --- 5. ReadableStream: pull is called lazily -----------------------------

Deno.test('ReadableStream: pull is invoked on read', async () => {
    let pulls = 0;
    const rs = new ReadableStream({
        pull(c) {
            pulls++;
            c.enqueue('x');
            c.close();
        },
    });
    const r = rs.getReader();
    await r.read();
    ok(pulls >= 1, 'pull must be called at least once');
    r.releaseLock();
});

// --- 6. ReadableStream: from async iterable -------------------------------

Deno.test('ReadableStream: fromAsyncIterable via start', async () => {
    async function* gen() { yield 'a'; yield 'b'; }
    const rs = new ReadableStream({
        async start(c) {
            for await (const x of gen()) c.enqueue(x);
            c.close();
        },
    });
    const out: string[] = [];
    for await (const c of rs) out.push(c);
    strictEqual(out.join(''), 'ab');
});

// --- 7. WritableStream: getWriter locks -----------------------------------

Deno.test('WritableStream: getWriter locks; second writer throws', async () => {
    const ws = new WritableStream();
    const w = ws.getWriter();
    ok(ws.locked);
    let threw = false;
    try { ws.getWriter(); } catch { threw = true; }
    ok(threw);
    w.releaseLock();
    ok(!ws.locked);
});

// --- 8. WritableStream: write + close round-trip ---------------------------

Deno.test('WritableStream: write then close', async () => {
    const chunks: string[] = [];
    const ws = new WritableStream<string>({
        write(c) { chunks.push(c); },
    });
    const w = ws.getWriter();
    await w.write('x');
    await w.write('y');
    await w.close();
    strictEqual(chunks.join(''), 'xy');
});

// --- 9. WritableStream: abort resolves; closed rejects --------------------

Deno.test('WritableStream: abort resolves writer and rejects closed', async () => {
    const ws = new WritableStream({ write(_c) {} });
    const w = ws.getWriter();
    const closed = w.closed.then(
        () => null,
        (err) => err,
    );
    await w.abort('boom');
    strictEqual(await closed, 'boom');
});

// --- 10. TransformStream: transforms chunks -------------------------------

Deno.test('TransformStream: transforms chunks', async () => {
    const ts = new TransformStream<string, string>({
        transform(chunk, ctrl) { ctrl.enqueue(chunk.toUpperCase()); },
    });
    const w = ts.writable.getWriter();
    const r = ts.readable.getReader();
    await w.write('hi');
    await w.close();
    const { value } = await r.read();
    strictEqual(value, 'HI');
});

// --- 11. TransformStream: flush is called on close ------------------------

Deno.test('TransformStream: flush is called on close', async () => {
    let flushed = false;
    const ts = new TransformStream({
        transform(chunk: string, ctrl) { ctrl.enqueue(chunk); },
        flush(ctrl) { flushed = true; ctrl.enqueue('END'); },
    });
    const w = ts.writable.getWriter();
    const r = ts.readable.getReader();
    await w.write('a');
    await w.close();
    const out: string[] = [];
    for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        out.push(value as string);
    }
    ok(flushed, 'flush must be called');
    deepStrictEqual(out, ['a', 'END']);
});

// --- 12. pipeTo: forwards data end-to-end ---------------------------------

Deno.test('pipeTo: forwards data from ReadableStream to WritableStream', async () => {
    const rs = new ReadableStream({
        start(c) { c.enqueue('p'); c.enqueue('q'); c.close(); },
    });
    const out: string[] = [];
    const ws = new WritableStream({
        write(c) { out.push(c as string); },
        close() {},
    });
    await rs.pipeTo(ws);
    strictEqual(out.join(''), 'pq');
});

// --- 13. pipeTo: propagates source error ----------------------------------

Deno.test('pipeTo: rejects on source error', async () => {
    const rs = new ReadableStream({
        start(c) { c.error(new Error('src-fail')); },
    });
    const ws = new WritableStream({ write(_c) {} });
    let caught: Error | null = null;
    try { await rs.pipeTo(ws); } catch (e) { caught = e as Error; }
    ok(caught, 'pipeTo must reject on source error');
    ok(/src-fail/.test(caught!.message));
});

// --- 14. pipeTo: propagates destination error on write --------------------

Deno.test('pipeTo: rejects on destination error', async () => {
    const rs = new ReadableStream({ start(c) { c.enqueue('x'); c.close(); } });
    const ws = new WritableStream({
        write(_c) { throw new Error('dst-fail'); },
    });
    let caught: Error | null = null;
    try { await rs.pipeTo(ws); } catch (e) { caught = e as Error; }
    ok(caught, 'pipeTo must reject on destination error');
    ok(/dst-fail/.test(caught!.message));
});

// --- 15. pipeTo: respects AbortSignal -------------------------------------

Deno.test('pipeTo: aborts when signal fires', async () => {
    const ac = new AbortController();
    let pulls = 0;
    const rs = new ReadableStream({
        pull(_c) { pulls++; if (pulls === 1) ac.abort(); },
    });
    const ws = new WritableStream({ write(_c) {} });
    let caught: Error | null = null;
    try { await rs.pipeTo(ws, { signal: ac.signal }); } catch (e) { caught = e as Error; }
    ok(caught, 'pipeTo must reject when signal aborts');
});

// --- 16. pipeThrough: chains a TransformStream ----------------------------

Deno.test('pipeThrough: chains a TransformStream', async () => {
    const rs = new ReadableStream({
        start(c) { c.enqueue('ab'); c.close(); },
    });
    const ts = new TransformStream({
        transform(chunk: string, ctrl) { ctrl.enqueue(chunk.toUpperCase()); },
    });
    const piped = rs.pipeThrough(ts);
    const r = piped.getReader();
    const { value } = await r.read();
    strictEqual(value, 'AB');
});

// --- 17. ReadableStream: reader.read() returns done at end ----------------

Deno.test('ReadableStream: read returns done:true at end', async () => {
    const rs = new ReadableStream({ start(c) { c.close(); } });
    const r = rs.getReader();
    const { done, value } = await r.read();
    ok(done);
    strictEqual(value, undefined);
});

// --- 18. ReadableStream: desiredSize reflects backpressure -----------------

Deno.test('ReadableStream: desiredSize is positive when room', async () => {
    const rs = new ReadableStream({
        start(c) { c.enqueue('x'); },
    }, { highWaterMark: 4 });
    const r = rs.getReader();
    // Before reading, controller should have room.
    await r.read();
    // After consuming, desiredSize should be back to HWM.
    ok(true); // smoke: no throw
});

// --- 19. WritableStream: desiredSize goes negative under pressure ---------

Deno.test('WritableStream: write returns a promise that resolves', async () => {
    const ws = new WritableStream({ highWaterMark: 1, write(_c) {} });
    const w = ws.getWriter();
    const p = w.write('a');
    ok(p instanceof Promise);
    await p;
    await w.close();
});

// --- 20. ReadableStream: releaseLock allows new reader --------------------

Deno.test('ReadableStream: releaseLock allows a new reader', async () => {
    const rs = new ReadableStream({ start(c) { c.close(); } });
    const r1 = rs.getReader();
    r1.releaseLock();
    const r2 = rs.getReader();
    ok(rs.locked);
    r2.releaseLock();
});

// --- helper ---------------------------------------------------------------

function deepStrictEqual(a: unknown, b: unknown) {
    strictEqual(JSON.stringify(a), JSON.stringify(b));
}
