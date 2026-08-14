import { strictEqual, ok, rejects, throws } from 'node:assert';
import { createHash } from 'node:crypto';

// ============================================================================
// Byte-integrity regression tests for tee() and Response/Request.clone().
//
// Both paths previously shipped real defects (Response.clone() was broken and
// fixed via tee), and both are silent failure modes: a dropped or duplicated
// chunk still produces a plausible body that passes a "did it throw?" test.
// Every assertion below compares a sha256 against a same-source baseline, so a
// truncated or reordered stream fails loudly.
//
// Verified against node v24.18.0 as the control; every expected value here was
// produced identically by both runtimes.
// ============================================================================

const sha = (b: Uint8Array | string): string =>
    createHash('sha256').update(b as never).digest('hex').slice(0, 16);

/** Deterministic source: `n` chunks of `size` bytes, chunk i filled with 'A'+i%26. */
function makeSource(n: number, size: number, onCancel?: (r: unknown) => void) {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(ctrl) {
            if (i >= n) { ctrl.close(); return; }
            const buf = new Uint8Array(size);
            buf.fill(65 + (i % 26));
            ctrl.enqueue(buf);
            i++;
        },
        cancel(reason) { onCancel?.(reason); },
    });
}

async function drain(s: ReadableStream<Uint8Array>) {
    const rd = s.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        parts.push(value!);
        total += value!.byteLength;
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.byteLength; }
    return { chunks: parts.length, total, hash: sha(all) };
}

// --- tee(): both branches must equal the original, byte for byte -------------

Deno.test('tee: both branches byte-identical to the source', async () => {
    const baseline = await drain(makeSource(8, 1024));
    strictEqual(baseline.total, 8192);
    const [a, b] = makeSource(8, 1024).tee();
    const ra = await drain(a);
    const rb = await drain(b);
    strictEqual(ra.total, 8192, 'branch A byte count');
    strictEqual(rb.total, 8192, 'branch B byte count');
    strictEqual(ra.hash, baseline.hash, 'branch A hash must equal the source');
    strictEqual(rb.hash, baseline.hash, 'branch B hash must equal the source');
});

Deno.test('tee: draining A to completion first does not lose B', async () => {
    // The lagging branch must buffer everything, not drop what A already took.
    const [a, b] = makeSource(8, 1024).tee();
    const ra = await drain(a);
    const rb = await drain(b);
    strictEqual(ra.chunks, 8);
    strictEqual(rb.chunks, 8, 'lagging branch must still see all 8 chunks');
    strictEqual(rb.hash, ra.hash);
});

Deno.test('tee: unequal consumption rates preserve both branches', async () => {
    const [a, b] = makeSource(6, 512).tee();
    const ra = a.getReader();
    const first = await ra.read();
    ok(!first.done, 'expected a first chunk from A');
    // Drain B completely while A is deliberately behind.
    const rb = await drain(b);
    const parts: Uint8Array[] = [first.value!];
    for (;;) { const x = await ra.read(); if (x.done) break; parts.push(x.value!); }
    let total = 0;
    for (const p of parts) total += p.byteLength;
    const all = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.byteLength; }
    strictEqual(total, 3072, 'branch A total after catching up');
    strictEqual(rb.total, 3072, 'branch B total');
    strictEqual(sha(all), rb.hash, 'both branches must hash equal');
});

Deno.test('tee: 1 MiB lopsided consumption drops no bytes', async () => {
    const [a, b] = makeSource(64, 16384).tee();
    const ra = a.getReader(), rb = b.getReader();
    const pa: Uint8Array[] = [], pb: Uint8Array[] = [];
    for (let k = 0; k < 10; k++) { const x = await ra.read(); if (!x.done) pa.push(x.value!); }
    for (;;) { const x = await rb.read(); if (x.done) break; pb.push(x.value!); }
    for (;;) { const x = await ra.read(); if (x.done) break; pa.push(x.value!); }
    const cat = (ps: Uint8Array[]) => {
        let t = 0; for (const p of ps) t += p.byteLength;
        const out = new Uint8Array(t); let o = 0;
        for (const p of ps) { out.set(p, o); o += p.byteLength; }
        return out;
    };
    const A = cat(pa), B = cat(pb);
    strictEqual(A.byteLength, 1048576, 'branch A must be exactly 1 MiB');
    strictEqual(B.byteLength, 1048576, 'branch B must be exactly 1 MiB');
    strictEqual(sha(A), sha(B), '1 MiB lopsided tee must hash equal');
});

Deno.test('tee: abandoning one branch still completes the other', async () => {
    const [a] = makeSource(5, 256).tee();
    const ra = await drain(a);
    strictEqual(ra.total, 1280);
});

Deno.test('tee: underlying cancel runs only after BOTH branches cancel', async () => {
    const seen: unknown[] = [];
    const [a, b] = makeSource(50, 128, (r) => seen.push(r)).tee();
    void a.cancel('reasonA');
    // Cancelling one branch must not cancel the source.
    await new Promise((r) => setTimeout(r, 20));
    strictEqual(seen.length, 0, 'source cancel must not run after one branch');
    void b.cancel('reasonB');
    await new Promise((r) => setTimeout(r, 20));
    strictEqual(seen.length, 1, 'source cancel must run once both branches cancel');
});

Deno.test('tee: locks the source and hands out unlocked branches', () => {
    const rs = makeSource(2, 8);
    const [a, b] = rs.tee();
    ok(rs.locked, 'tee must lock the source');
    throws(() => rs.getReader(), TypeError, 'getReader on a tee\'d source must throw TypeError');
    ok(!a.locked && !b.locked, 'branches start unlocked');
});

Deno.test('tee: source error reaches both branches', async () => {
    let i = 0;
    const rs = new ReadableStream<Uint8Array>({
        pull(ctrl) {
            if (i++ < 2) ctrl.enqueue(new Uint8Array([i]));
            else ctrl.error(new Error('tee-src-boom'));
        },
    });
    const [a, b] = rs.tee();
    await rejects(() => drain(a), /tee-src-boom/, 'branch A must reject');
    await rejects(() => drain(b), /tee-src-boom/, 'branch B must reject');
});

// --- Response.clone() / Request.clone(): both halves must be readable -------

Deno.test('Response.clone: both halves readable, identical text', async () => {
    const r = new Response('hello-clone');
    const c = r.clone();
    strictEqual(await r.text(), 'hello-clone');
    strictEqual(await c.text(), 'hello-clone');
});

Deno.test('Response.clone: clone consumed first, original still intact', async () => {
    const r = new Response('reverse-order');
    const c = r.clone();
    strictEqual(await c.text(), 'reverse-order', 'clone first');
    strictEqual(await r.text(), 'reverse-order', 'original must survive');
});

Deno.test('Response.clone: 300 KiB binary is byte-exact in both halves', async () => {
    const big = new Uint8Array(300 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const expect = sha(big);
    const r = new Response(big);
    const c = r.clone();
    const a = new Uint8Array(await r.arrayBuffer());
    const b = new Uint8Array(await c.arrayBuffer());
    strictEqual(a.byteLength, 307200);
    strictEqual(b.byteLength, 307200);
    strictEqual(sha(a), expect, 'original hash');
    strictEqual(sha(b), expect, 'clone hash');
});

Deno.test('Response.clone: stream-backed body, both halves byte-exact', async () => {
    let i = 0;
    const src = new ReadableStream<Uint8Array>({
        pull(ctl) {
            if (i >= 20) { ctl.close(); return; }
            const u = new Uint8Array(1024); u.fill(48 + (i % 10)); ctl.enqueue(u); i++;
        },
    });
    const r = new Response(src);
    const c = r.clone();
    const a = new Uint8Array(await r.arrayBuffer());
    const b = new Uint8Array(await c.arrayBuffer());
    strictEqual(a.byteLength, 20480, 'original length');
    strictEqual(b.byteLength, 20480, 'clone length');
    strictEqual(sha(a), sha(b), 'stream-backed clone must hash equal');
});

Deno.test('Response.clone: stream-backed lopsided readers stay in sync', async () => {
    let i = 0;
    const src = new ReadableStream<Uint8Array>({
        pull(ctl) {
            if (i >= 32) { ctl.close(); return; }
            const u = new Uint8Array(4096); u.fill(i & 0xff); ctl.enqueue(u); i++;
        },
    });
    const r = new Response(src);
    const c = r.clone();
    const ra = r.body!.getReader(), rb = c.body!.getReader();
    const pa: Uint8Array[] = [], pb: Uint8Array[] = [];
    for (let k = 0; k < 5; k++) { const x = await ra.read(); if (!x.done) pa.push(x.value!); }
    for (;;) { const x = await rb.read(); if (x.done) break; pb.push(x.value!); }
    for (;;) { const x = await ra.read(); if (x.done) break; pa.push(x.value!); }
    const cat = (ps: Uint8Array[]) => {
        let t = 0; for (const p of ps) t += p.byteLength;
        const out = new Uint8Array(t); let o = 0;
        for (const p of ps) { out.set(p, o); o += p.byteLength; }
        return out;
    };
    const A = cat(pa), B = cat(pb);
    strictEqual(A.byteLength, 131072, 'original total');
    strictEqual(B.byteLength, 131072, 'clone total');
    strictEqual(sha(A), sha(B), 'lopsided clone readers must hash equal');
});

Deno.test('Response.clone: cloning does not consume the original', () => {
    const r = new Response('x');
    strictEqual(r.bodyUsed, false);
    const c = r.clone();
    strictEqual(r.bodyUsed, false, 'clone must not mark the original used');
    strictEqual(c.bodyUsed, false, 'clone starts unused');
});

Deno.test('Response.clone: after the body is consumed it must throw', async () => {
    const r = new Response('y');
    await r.text();
    throws(() => r.clone(), TypeError, 'clone after consume must throw TypeError');
});

Deno.test('Response.clone: while the body is locked it must throw', () => {
    const r = new Response(new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array([1])); c.close(); },
    }));
    r.body!.getReader();
    throws(() => r.clone(), TypeError, 'clone while locked must throw TypeError');
});

Deno.test('Response.clone: carries metadata and isolates header mutation', () => {
    const r = new Response('z', {
        status: 418, statusText: 'Teapot',
        headers: { 'x-a': '1', 'content-type': 'text/plain' },
    });
    const c = r.clone();
    strictEqual(c.status, 418);
    strictEqual(c.statusText, 'Teapot');
    strictEqual(c.headers.get('x-a'), '1');
    strictEqual(c.headers.get('content-type'), 'text/plain');
    c.headers.set('x-a', 'MUTATED');
    strictEqual(r.headers.get('x-a'), '1', 'mutating clone headers must not affect the original');
});

Deno.test('Request.clone: both halves readable, metadata carried', async () => {
    const q = new Request('http://example.invalid/p', {
        method: 'POST', body: 'reqclone', headers: { 'x-q': '9' },
    });
    const q2 = q.clone();
    strictEqual(await q.text(), 'reqclone');
    strictEqual(await q2.text(), 'reqclone');
    strictEqual(q2.method, 'POST');
    strictEqual(q2.headers.get('x-q'), '9');
});

Deno.test('Response.clone: clone-of-clone chain keeps every link readable', async () => {
    const r = new Response('chain-payload');
    const c1 = r.clone();
    const c2 = c1.clone();
    const c3 = c2.clone();
    strictEqual(await r.text(), 'chain-payload');
    strictEqual(await c1.text(), 'chain-payload');
    strictEqual(await c2.text(), 'chain-payload');
    strictEqual(await c3.text(), 'chain-payload');
});

// --- body single-use enforcement --------------------------------------------

Deno.test('body: a second read of the same body must reject', async () => {
    for (const [first, second] of [
        ['text', 'arrayBuffer'], ['json', 'text'], ['arrayBuffer', 'blob'], ['bytes', 'text'],
    ] as const) {
        const r = new Response(first === 'json' ? '{"a":1}' : 'payload');
        await (r as unknown as Record<string, () => Promise<unknown>>)[first]!();
        strictEqual(r.bodyUsed, true, `${first} must set bodyUsed`);
        await rejects(
            () => (r as unknown as Record<string, () => Promise<unknown>>)[second]!(),
            TypeError,
            `${first} then ${second} must reject with TypeError`,
        );
    }
});

Deno.test('body: reading the body stream marks the body used', async () => {
    const r = new Response('streamy');
    const rd = r.body!.getReader();
    const x = await rd.read();
    ok(!x.done && x.value!.byteLength > 0, 'expected a chunk');
    strictEqual(r.bodyUsed, true);
    await rejects(() => r.text(), TypeError, 'text() after stream read must reject');
});
