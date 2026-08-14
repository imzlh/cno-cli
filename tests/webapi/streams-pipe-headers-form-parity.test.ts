import { strictEqual, deepStrictEqual, ok, rejects, throws } from 'node:assert';
import { createHash } from 'node:crypto';

// ============================================================================
// Parity regression tests for pipeTo options, stream locking, async iteration,
// WritableStream backpressure, Headers, Blob slicing and FormData multipart.
//
// Every expected value below was measured identically on node v24.18.0 and cno,
// so a future divergence in either direction fails this file.
// ============================================================================

const sha = (b: Uint8Array | string): string =>
    createHash('sha256').update(b as never).digest('hex').slice(0, 16);
const hex = (b: Uint8Array): string =>
    Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const source = (n: number, onCancel?: () => void) => {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(ctl) {
            if (i >= n) { ctl.close(); return; }
            ctl.enqueue(new Uint8Array([65 + i]));
            i++;
        },
        cancel() { onCancel?.(); },
    });
};
const recorder = () => {
    const log: string[] = [];
    const ws = new WritableStream<Uint8Array>({
        write(ch) { log.push('w:' + String.fromCharCode(ch[0]!)); },
        close() { log.push('close'); },
        abort(r) { log.push('abort:' + String((r as Error)?.message ?? r)); },
    });
    return { ws, log };
};

// --- pipeTo ------------------------------------------------------------------

Deno.test('pipeTo: writes every chunk then closes the destination', async () => {
    const { ws, log } = recorder();
    await source(4).pipeTo(ws);
    strictEqual(log.join(','), 'w:A,w:B,w:C,w:D,close');
});

Deno.test('pipeTo: preventClose leaves the destination writable', async () => {
    const { ws, log } = recorder();
    await source(3).pipeTo(ws, { preventClose: true });
    strictEqual(log.join(','), 'w:A,w:B,w:C', 'must not emit close');
    const w = ws.getWriter();
    strictEqual(w.desiredSize, 1, 'destination still accepts writes');
    w.releaseLock();
});

Deno.test('pipeTo: a source error aborts the destination and rejects', async () => {
    const { ws, log } = recorder();
    let i = 0;
    const rs = new ReadableStream<Uint8Array>({
        pull(ctl) { i++ < 2 ? ctl.enqueue(new Uint8Array([48 + i])) : ctl.error(new Error('srcerr')); },
    });
    await rejects(() => rs.pipeTo(ws), /srcerr/);
    ok(log.some((x) => x.startsWith('abort:')), 'destination must be aborted');
});

Deno.test('pipeTo: preventAbort suppresses the destination abort', async () => {
    const { ws, log } = recorder();
    let i = 0;
    const rs = new ReadableStream<Uint8Array>({
        pull(ctl) { i++ < 1 ? ctl.enqueue(new Uint8Array([65])) : ctl.error(new Error('srcerr2')); },
    });
    await rejects(() => rs.pipeTo(ws, { preventAbort: true }), /srcerr2/);
    ok(!log.some((x) => x.startsWith('abort')), 'abort must be suppressed');
});

Deno.test('pipeTo: a destination write failure cancels the source', async () => {
    const cancels: string[] = [];
    const rs = new ReadableStream<Uint8Array>({
        pull(ctl) { ctl.enqueue(new Uint8Array([1])); },
        cancel(r) { cancels.push(String((r as Error)?.message ?? r)); },
    });
    const ws = new WritableStream<Uint8Array>({ write() { throw new Error('sinkerr'); } });
    await rejects(() => rs.pipeTo(ws), /sinkerr/);
    deepStrictEqual(cancels, ['sinkerr'], 'source must be cancelled with the sink reason');
});

Deno.test('pipeTo: preventCancel suppresses the source cancel', async () => {
    const cancels: string[] = [];
    const rs = new ReadableStream<Uint8Array>({
        pull(ctl) { ctl.enqueue(new Uint8Array([1])); },
        cancel() { cancels.push('c'); },
    });
    const ws = new WritableStream<Uint8Array>({ write() { throw new Error('sinkerr2'); } });
    await rejects(() => rs.pipeTo(ws, { preventCancel: true }), /sinkerr2/);
    strictEqual(cancels.length, 0, 'source cancel must be suppressed');
});

Deno.test('pipeTo: an AbortSignal rejects with AbortError and aborts the sink', async () => {
    const ac = new AbortController();
    const { ws, log } = recorder();
    let i = 0;
    const rs = new ReadableStream<Uint8Array>({
        async pull(ctl) {
            await new Promise((r) => setTimeout(r, 30));
            ctl.enqueue(new Uint8Array([48 + (i++ % 10)]));
        },
    });
    const p = rs.pipeTo(ws, { signal: ac.signal });
    setTimeout(() => ac.abort(), 120);
    const err = await p.then(() => null, (e) => e as Error);
    ok(err, 'pipeTo must reject');
    strictEqual(err!.name, 'AbortError', 'must reject with exactly AbortError');
    ok(log.some((x) => x.startsWith('w:')), 'some chunks should have been written first');
    ok(log.some((x) => x.startsWith('abort')), 'sink must be aborted');
});

Deno.test('pipeTo: a pre-aborted signal writes nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const { ws, log } = recorder();
    const err = await source(3).pipeTo(ws, { signal: ac.signal }).then(() => null, (e) => e as Error);
    strictEqual(err?.name, 'AbortError');
    ok(!log.some((x) => x.startsWith('w:')), 'nothing may be written');
});

Deno.test('pipeThrough: transform then flush, in that order', async () => {
    const order: string[] = [];
    const ts = new TransformStream<Uint8Array, Uint8Array>({
        transform(ch, ctl) { order.push('t'); ctl.enqueue(ch); },
        flush(ctl) { order.push('flush'); ctl.enqueue(new Uint8Array([90])); },
    });
    const out: string[] = [];
    const rd = source(3).pipeThrough(ts).getReader();
    for (;;) { const x = await rd.read(); if (x.done) break; out.push(String.fromCharCode(x.value![0]!)); }
    strictEqual(order.join(','), 't,t,t,flush');
    strictEqual(out.join(''), 'ABCZ', 'flush output must come last');
});

Deno.test('TransformStream: errors propagate in both directions', async () => {
    // writable side abort -> readable rejects
    const ts1 = new TransformStream();
    const w1 = ts1.writable.getWriter();
    const rd1 = ts1.readable.getReader();
    await w1.abort(new Error('wabort'));
    await rejects(() => rd1.read(), /wabort/);
    // readable side cancel -> writable rejects
    const ts2 = new TransformStream();
    const w2 = ts2.writable.getWriter();
    await ts2.readable.cancel(new Error('rcancel'));
    await rejects(() => w2.write(new Uint8Array([1])), /rcancel/);
});

// --- locking and async iteration --------------------------------------------

Deno.test('ReadableStream: a second getReader throws TypeError', () => {
    const rs = source(2);
    const r1 = rs.getReader();
    throws(() => rs.getReader(), TypeError);
    r1.releaseLock();
    const r3 = rs.getReader();
    ok(r3, 'getReader works again after releaseLock');
    r3.releaseLock();
});

Deno.test('WritableStream: a second getWriter throws TypeError', () => {
    const ws = new WritableStream();
    ws.getWriter();
    throws(() => ws.getWriter(), TypeError);
    ok(ws.locked);
});

Deno.test('for await: breaking mid-iteration releases the lock and cancels', async () => {
    let cancelled = false;
    let i = 0;
    const rs = new ReadableStream<Uint8Array>({
        pull(ctl) {
            if (i >= 10) { ctl.close(); return; }
            ctl.enqueue(new Uint8Array([65 + i])); i++;
        },
        cancel() { cancelled = true; },
    });
    const out: string[] = [];
    for await (const ch of rs) {
        out.push(String.fromCharCode(ch[0]!));
        if (out.length === 3) break;
    }
    strictEqual(out.join(''), 'ABC');
    strictEqual(rs.locked, false, 'break must release the lock');
    strictEqual(cancelled, true, 'break must cancel the source');
    const rd = rs.getReader();
    rd.releaseLock();
});

Deno.test('for await: values({preventCancel:true}) leaves the source uncancelled', async () => {
    let cancelled = false;
    let i = 0;
    const rs = new ReadableStream<Uint8Array>({
        pull(ctl) { ctl.enqueue(new Uint8Array([65 + (i++ % 26)])); },
        cancel() { cancelled = true; },
    });
    const out: string[] = [];
    for await (const ch of rs.values({ preventCancel: true })) {
        out.push(String.fromCharCode(ch[0]!));
        if (out.length === 2) break;
    }
    strictEqual(out.join(''), 'AB');
    strictEqual(rs.locked, false, 'lock must still be released');
    strictEqual(cancelled, false, 'preventCancel must suppress the cancel');
});

Deno.test('for await: a second concurrent iteration throws TypeError', async () => {
    const rs = source(3);
    const first = (async () => {
        const o: string[] = [];
        for await (const ch of rs) o.push(String.fromCharCode(ch[0]!));
        return o.join('');
    })();
    await rejects(async () => { for await (const _ of rs) { /* locked */ } }, TypeError);
    strictEqual(await first, 'ABC');
});

Deno.test('ReadableStream: desiredSize goes negative past the highWaterMark', () => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    new ReadableStream<Uint8Array>({ start(c) { ctl = c; } }, { highWaterMark: 2 });
    const seen = [ctl.desiredSize];
    for (let k = 0; k < 4; k++) { ctl.enqueue(new Uint8Array([k])); seen.push(ctl.desiredSize); }
    deepStrictEqual(seen, [2, 1, 0, -1, -2]);
});

// --- WritableStream ----------------------------------------------------------

Deno.test('WritableStream: writing after close rejects rather than hanging', async () => {
    const ws = new WritableStream<Uint8Array>({ write() { /* accept */ } });
    const w = ws.getWriter();
    await w.close();
    const settled = await Promise.race([
        w.write(new Uint8Array([1])).then(() => 'resolved', () => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('HUNG'), 2000)),
    ]);
    strictEqual(settled, 'rejected', 'write after close must reject, not hang');
});

Deno.test('WritableStream: backpressure drives desiredSize and ready', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ws = new WritableStream<Uint8Array>({ async write() { await gate; } }, { highWaterMark: 2 });
    const w = ws.getWriter();
    const seen = [w.desiredSize];
    void w.write(new Uint8Array([1])); seen.push(w.desiredSize);
    void w.write(new Uint8Array([2])); seen.push(w.desiredSize);
    void w.write(new Uint8Array([3])); seen.push(w.desiredSize);
    deepStrictEqual(seen, [2, 1, 0, -1], 'desiredSize must fall below zero when over the HWM');
    let readyResolved = false;
    const rp = w.ready.then(() => { readyResolved = true; });
    await new Promise((r) => setTimeout(r, 30));
    strictEqual(readyResolved, false, 'ready must stay pending while over the HWM');
    release();
    await rp.catch(() => { /* drained */ });
    strictEqual(readyResolved, true, 'ready must resolve once drained');
});

Deno.test('WritableStream: a rejecting sink rejects write and closed', async () => {
    const ws = new WritableStream<Uint8Array>({ write() { return Promise.reject(new Error('sinkrej')); } });
    const w = ws.getWriter();
    const closed = w.closed.then(() => 'resolved', (e: Error) => 'rejected:' + e.message);
    await rejects(() => w.write(new Uint8Array([1])), /sinkrej/);
    strictEqual(await closed, 'rejected:sinkrej');
});

// --- Headers -----------------------------------------------------------------

Deno.test('Headers: lookups are case-insensitive', () => {
    const h = new Headers({ 'Content-Type': 'text/plain', 'X-Custom': 'v1' });
    strictEqual(h.get('content-type'), 'text/plain');
    strictEqual(h.get('CONTENT-TYPE'), 'text/plain');
    strictEqual(h.get('Content-Type'), 'text/plain');
    ok(h.has('x-CUSTOM'));
});

Deno.test('Headers: iteration is lowercased and sorted by name', () => {
    const h = new Headers();
    h.append('zebra', '1'); h.append('Alpha', '2'); h.append('middle', '3'); h.append('BETA', '4');
    deepStrictEqual([...h.keys()], ['alpha', 'beta', 'middle', 'zebra']);
    deepStrictEqual([...h.entries()].map(([k, v]) => `${k}=${v}`),
        ['alpha=2', 'beta=4', 'middle=3', 'zebra=1']);
});

Deno.test('Headers: append combines, set replaces', () => {
    const h = new Headers();
    h.append('x-m', 'a'); h.append('x-m', 'b'); h.append('x-m', 'c');
    strictEqual(h.get('x-m'), 'a, b, c', 'append must comma-join');
    h.set('x-m', 'z');
    strictEqual(h.get('x-m'), 'z', 'set must replace every value');
    strictEqual([...h.entries()].filter(([k]) => k === 'x-m').length, 1);
});

Deno.test('Headers: set-cookie is not combined and getSetCookie lists it', () => {
    const h = new Headers();
    h.append('set-cookie', 'a=1'); h.append('set-cookie', 'b=2'); h.append('x-o', 'v');
    deepStrictEqual(h.getSetCookie(), ['a=1', 'b=2'], 'getSetCookie must keep cookies separate');
    deepStrictEqual([...h.entries()].map(([k, v]) => `${k}=${v}`),
        ['set-cookie=a=1', 'set-cookie=b=2', 'x-o=v']);
});

Deno.test('Headers: delete is case-insensitive', () => {
    const h = new Headers({ a: '1', b: '2', c: '3' });
    h.delete('B');
    ok(!h.has('b'));
    const seen: string[] = [];
    h.forEach((v, k) => seen.push(`${k}=${v}`));
    deepStrictEqual(seen, ['a=1', 'c=3']);
});

Deno.test('Headers: invalid names and values throw TypeError', () => {
    const h = new Headers();
    throws(() => h.set('bad name', 'v'), TypeError, 'space in name');
    throws(() => h.set('', 'v'), TypeError, 'empty name');
    throws(() => h.set('tab\tname', 'v'), TypeError, 'tab in name');
    throws(() => h.set('ok', 'bad\nvalue'), TypeError, 'newline in value');
});

Deno.test('Headers: values are trimmed and coerced to string', () => {
    const h = new Headers();
    h.set('x-sp', '   padded   ');
    h.set('x-num', 42 as unknown as string);
    strictEqual(h.get('x-sp'), 'padded', 'surrounding whitespace stripped');
    strictEqual(h.get('x-num'), '42');
});

// --- Blob / File -------------------------------------------------------------

Deno.test('Blob: size, type normalisation and text', async () => {
    const b = new Blob(['ABCDEFGHIJ'], { type: 'Text/Plain; Charset=UTF-8' });
    strictEqual(b.size, 10);
    strictEqual(b.type, 'text/plain; charset=utf-8', 'type must be lowercased');
    strictEqual(await b.text(), 'ABCDEFGHIJ');
    strictEqual(new Blob([], { type: 'appé/x' }).type, '', 'non-ASCII type becomes empty');
});

Deno.test('Blob: slice clamps negative and out-of-range indices', async () => {
    const b = new Blob(['ABCDEFGHIJ']);
    const cases: Array<[number[], string]> = [
        [[2, 5], 'CDE'], [[-3], 'HIJ'], [[-3, -1], 'HI'], [[0, -2], 'ABCDEFGH'],
        [[5, 2], ''], [[100, 200], ''], [[-100, 100], 'ABCDEFGHIJ'],
        [[3], 'DEFGHIJ'], [[0, 0], ''], [[7, 7], ''],
    ];
    for (const [args, expect] of cases) {
        strictEqual(await b.slice(...args).text(), expect, `slice(${args.join(',')})`);
    }
    strictEqual(await b.slice().text(), 'ABCDEFGHIJ', 'slice() with no args');
});

Deno.test('Blob: slice takes an explicit contentType', async () => {
    const b = new Blob(['ABCDEFGHIJ'], { type: 'text/plain' });
    const s = b.slice(0, 3, 'APPLICATION/JSON');
    strictEqual(s.type, 'application/json');
    strictEqual(b.type, 'text/plain', 'parent type unchanged');
    strictEqual(await s.text(), 'ABC');
});

Deno.test('Blob: stream/arrayBuffer/bytes agree byte for byte', async () => {
    const b = new Blob(['xy', 'z', new Uint8Array([0x21])]);
    strictEqual(b.size, 4);
    const ab = new Uint8Array(await b.arrayBuffer());
    const by = await b.bytes();
    ok(by instanceof Uint8Array, 'bytes() must return a Uint8Array');
    const parts: Uint8Array[] = [];
    for await (const ch of b.stream()) parts.push(ch);
    let total = 0; for (const p of parts) total += p.byteLength;
    const st = new Uint8Array(total);
    let off = 0; for (const p of parts) { st.set(p, off); off += p.byteLength; }
    strictEqual(sha(ab), sha(st), 'arrayBuffer and stream must agree');
    strictEqual(sha(ab), sha(by), 'arrayBuffer and bytes must agree');
    strictEqual(new TextDecoder().decode(ab), 'xyz!');
});

Deno.test('Blob: nested blobs and mixed part types concatenate', async () => {
    const inner = new Blob(['inner']);
    const b = new Blob(['a', inner, new Uint8Array([66]), new ArrayBuffer(2)]);
    strictEqual(b.size, 1 + 5 + 1 + 2);
    const got = new Uint8Array(await b.arrayBuffer());
    strictEqual(hex(got), '61696e6e6572420000');
});

Deno.test('File: name, lastModified and Blob inheritance', async () => {
    const f = new File(['filedata'], 'name.txt', { type: 'text/plain', lastModified: 1234567890 });
    strictEqual(f.name, 'name.txt');
    strictEqual(f.size, 8);
    strictEqual(f.type, 'text/plain');
    strictEqual(f.lastModified, 1234567890);
    ok(f instanceof Blob);
    strictEqual(await f.text(), 'filedata');
    const before = Date.now();
    const g = new File(['x'], 'n');
    ok(g.lastModified >= before - 5 && g.lastModified <= Date.now() + 5,
        'default lastModified must be roughly now');
});

// --- FormData ----------------------------------------------------------------

Deno.test('FormData: append keeps duplicates, set replaces, order preserved', () => {
    const fd = new FormData();
    fd.append('a', '1'); fd.append('b', '2'); fd.append('a', '3');
    fd.set('c', '4');
    deepStrictEqual([...fd.entries()].map(([k, v]) => `${k}=${v}`), ['a=1', 'b=2', 'a=3', 'c=4']);
    strictEqual(fd.get('a'), '1', 'get returns the first value');
    deepStrictEqual(fd.getAll('a'), ['1', '3']);
    ok(fd.has('b'));
});

Deno.test('FormData: a File entry round-trips through Response as a File', async () => {
    const fd = new FormData();
    fd.append('name', 'Ada');
    fd.append('num', '42');
    fd.append('file', new File(['FILEBYTES'], 'f.bin', { type: 'application/octet-stream' }));
    const back = await new Response(fd).formData();
    strictEqual(back.get('name'), 'Ada');
    strictEqual(back.get('num'), '42');
    const f = back.get('file') as File;
    ok(f instanceof File, 'file entry must come back as a File');
    strictEqual(f.name, 'f.bin');
    strictEqual(f.type, 'application/octet-stream');
    strictEqual(await f.text(), 'FILEBYTES');
});

Deno.test('FormData: Response sets multipart content-type with a boundary', async () => {
    const fd = new FormData();
    fd.append('field1', 'value1');
    fd.append('field2', 'value2');
    const r = new Response(fd);
    const ct = r.headers.get('content-type')!;
    strictEqual(ct.split(';')[0], 'multipart/form-data');
    const boundary = /boundary=(.*)$/.exec(ct)?.[1];
    ok(boundary && boundary.length > 8, 'a non-trivial boundary must be present');
    const raw = new TextDecoder().decode(await r.arrayBuffer());
    // Normalise the random boundary so the wire format is comparable.
    const norm = raw.split(boundary!).join('<B>');
    strictEqual(norm,
        '--<B>\r\nContent-Disposition: form-data; name="field1"\r\n\r\nvalue1\r\n'
        + '--<B>\r\nContent-Disposition: form-data; name="field2"\r\n\r\nvalue2\r\n'
        + '--<B>--\r\n',
        'multipart wire format must match node byte for byte (boundary normalised)');
});

Deno.test('FormData: multipart names and filenames cannot inject part headers', async () => {
    const fd = new FormData();
    fd.append('field"\r\nX-Name: injected', new Blob(['payload']), 'file"\r\nX-File: injected.txt');
    const raw = await new Response(fd).text();
    ok(raw.includes('name="field%22%0D%0AX-Name: injected"'));
    ok(raw.includes('filename="file%22%0D%0AX-File: injected.txt"'));
    strictEqual(raw.includes('\r\nX-Name:'), false, 'field name must not create a header line');
    strictEqual(raw.includes('\r\nX-File:'), false, 'filename must not create a header line');
});

Deno.test('FormData: duplicate keys survive a multipart round-trip', async () => {
    const fd = new FormData();
    fd.append('dup', 'one'); fd.append('dup', 'two'); fd.append('dup', 'three');
    const back = await new Response(fd).formData();
    deepStrictEqual(back.getAll('dup'), ['one', 'two', 'three']);
});

Deno.test('FormData: CRLF and unicode values survive a round-trip', async () => {
    const fd = new FormData();
    fd.append('nl', 'line1\r\nline2');
    fd.append('uni', 'café-日本');
    fd.append('semi;colon', 'a;b');
    const back = await new Response(fd).formData();
    strictEqual(back.get('nl'), 'line1\r\nline2');
    strictEqual(back.get('uni'), 'café-日本');
    strictEqual(back.get('semi;colon'), 'a;b');
});

Deno.test('FormData: a 1 KiB binary blob is byte-exact after a round-trip', async () => {
    const bin = new Uint8Array(1024);
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 7 + 13) & 0xff;
    const expect = sha(bin);
    const fd = new FormData();
    fd.append('blob', new Blob([bin], { type: 'application/octet-stream' }), 'b.bin');
    const back = await new Response(fd).formData();
    const f = back.get('blob') as File;
    const got = new Uint8Array(await f.arrayBuffer());
    strictEqual(got.byteLength, 1024);
    strictEqual(sha(got), expect, 'binary payload must survive multipart byte for byte');
    strictEqual(f.name, 'b.bin');
});

Deno.test('FormData: urlencoded bodies decode through formData()', async () => {
    const r = new Response('a=1&b=two+words&c=%C3%A9', {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const back = await r.formData();
    strictEqual(back.get('a'), '1');
    strictEqual(back.get('b'), 'two words', '+ must decode to a space');
    strictEqual(back.get('c'), 'é', 'percent-encoded UTF-8 must decode');
});

Deno.test('FormData: formData() on a non-form body rejects with TypeError', async () => {
    const r = new Response('not-a-form', { headers: { 'content-type': 'text/plain' } });
    await rejects(() => r.formData(), TypeError);
});
