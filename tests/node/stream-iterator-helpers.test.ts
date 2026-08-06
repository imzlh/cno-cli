/* Node's stream iterator helpers: map/filter/forEach/reduce/some/every/find/
 * take/drop/flatMap/iterator/compose plus Duplex.from.
 *
 * Every expectation here was captured from real `node v24.18.0` first, then
 * asserted against cno, rather than derived from the docs. Where node's own
 * behaviour is surprising it is called out in a comment and matched anyway,
 * because parity is the point.
 *
 * Deliberately NOT asserted: the exact number of items an abandoned generator
 * source yields before it is destroyed. node pulls one more than cno here (a
 * readahead difference in `Readable.from`, not in these helpers), so the tests
 * assert that short-circuiting happens at all, which is the real contract.
 */
import { strictEqual, deepStrictEqual, ok, throws, rejects } from 'node:assert';
import { Readable, Duplex, Transform, PassThrough, Writable } from 'node:stream';

const tick = () => new Promise<void>((r) => { setImmediate(r); });
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

// --- 1. presence and return shapes -------------------------------------------

Deno.test('stream helpers: all present on Readable.prototype', () => {
    for (const name of ['map', 'filter', 'forEach', 'reduce', 'some', 'every',
        'find', 'take', 'drop', 'flatMap', 'iterator', 'compose', 'toArray']) {
        strictEqual(typeof (Readable.prototype as never as Record<string, unknown>)[name], 'function', `${name} missing`);
    }
    // asIndexedPairs was removed from node before v24 — must stay absent.
    strictEqual((Readable.prototype as never as Record<string, unknown>).asIndexedPairs, undefined);
    // Writable must NOT gain them.
    strictEqual((Writable.prototype as never as Record<string, unknown>).map, undefined);
});

Deno.test('stream helpers: stream-returning ops return a Readable', () => {
    const mk = () => Readable.from([1, 2, 3]);
    ok(mk().map((x) => x) instanceof Readable);
    ok(mk().filter(() => true) instanceof Readable);
    ok(mk().take(1) instanceof Readable);
    ok(mk().drop(1) instanceof Readable);
    ok(mk().flatMap((x) => [x]) instanceof Readable);
});

Deno.test('stream helpers: promise-returning ops return a Promise', async () => {
    const mk = () => Readable.from([1, 2, 3]);
    const ps = [
        mk().forEach(() => {}),
        mk().reduce((a, b) => (a as number) + (b as number), 0),
        mk().some(() => true),
        mk().every(() => true),
        mk().find(() => true),
        mk().toArray(),
    ];
    for (const p of ps) ok(p instanceof Promise);
    await Promise.all(ps);
});

Deno.test('stream helpers: derived stream is always objectMode, even from byte mode', async () => {
    // node wraps every stream-returning operator in Readable.from(), which is
    // objectMode:true — so a byte-mode source yields an objectMode result.
    const raw = new Readable({ read() { this.push('x'); this.push(null); } });
    strictEqual(raw.readableObjectMode, false, 'source is byte mode');
    const mapped = raw.map((x) => x);
    strictEqual(mapped.readableObjectMode, true, 'derived stream is object mode');
    await mapped.toArray();
});

// --- 2. basic transforms -----------------------------------------------------

Deno.test('stream helpers: map sync and async fns', async () => {
    deepStrictEqual(await Readable.from([1, 2, 3]).map((x) => (x as number) * 2).toArray(), [2, 4, 6]);
    deepStrictEqual(
        await Readable.from([1, 2, 3]).map(async (x) => { await sleep(1); return (x as number) * 3; }).toArray(),
        [3, 6, 9],
    );
});

Deno.test('stream helpers: filter sync and async', async () => {
    deepStrictEqual(await Readable.from([1, 2, 3, 4]).filter((x) => (x as number) % 2 === 0).toArray(), [2, 4]);
    deepStrictEqual(
        await Readable.from([1, 2, 3, 4]).filter(async (x) => { await sleep(1); return (x as number) > 2; }).toArray(),
        [3, 4],
    );
});

Deno.test('stream helpers: forEach visits every item and resolves undefined', async () => {
    const seen: unknown[] = [];
    const r = await Readable.from(['a', 'b', 'c']).forEach((x) => { seen.push(x); });
    deepStrictEqual(seen, ['a', 'b', 'c']);
    strictEqual(r, undefined);
});

Deno.test('stream helpers: take / drop', async () => {
    deepStrictEqual(await Readable.from([1, 2, 3]).take(0).toArray(), []);
    deepStrictEqual(await Readable.from([1, 2, 3]).take(2).toArray(), [1, 2]);
    deepStrictEqual(await Readable.from([1, 2, 3]).take(9).toArray(), [1, 2, 3]);
    deepStrictEqual(await Readable.from([1, 2, 3]).take(Infinity).toArray(), [1, 2, 3]);
    deepStrictEqual(await Readable.from([1, 2, 3]).drop(0).toArray(), [1, 2, 3]);
    deepStrictEqual(await Readable.from([1, 2, 3]).drop(2).toArray(), [3]);
    deepStrictEqual(await Readable.from([1, 2, 3]).drop(9).toArray(), []);
});

Deno.test('stream helpers: chained filter+map+drop+take', async () => {
    const out = await Readable.from([1, 2, 3, 4, 5, 6])
        .filter((x) => (x as number) % 2 === 0)
        .map((x) => (x as number) * 10)
        .drop(1)
        .take(1)
        .toArray();
    deepStrictEqual(out, [40]);
});

// --- 3. concurrency: input order preserved despite inverted delays -----------

Deno.test('stream helpers: map concurrency emits in INPUT order with inverted delays', async () => {
    // Later items finish first (delay decreases with index). The output must
    // still be in input order — this is the guarantee that map()'s promise queue
    // exists to provide.
    for (const concurrency of [1, 2, 5]) {
        const finished: number[] = [];
        const out = await Readable.from([1, 2, 3, 4, 5]).map(async (x) => {
            await sleep((6 - (x as number)) * 20);
            finished.push(x as number);
            return (x as number) * 10;
        }, { concurrency }).toArray();
        deepStrictEqual(out, [10, 20, 30, 40, 50], `input order at concurrency=${concurrency}`);
    }
});

Deno.test('stream helpers: map concurrency=5 actually completes out of order', async () => {
    // Negative control for the test above: proves the delays really are inverted,
    // so the ordering assertion is not passing trivially.
    const finished: number[] = [];
    await Readable.from([1, 2, 3, 4, 5]).map(async (x) => {
        await sleep((6 - (x as number)) * 20);
        finished.push(x as number);
        return x;
    }, { concurrency: 5 }).toArray();
    deepStrictEqual(finished, [5, 4, 3, 2, 1], 'completion order is reversed');
});

Deno.test('stream helpers: filter and flatMap preserve input order under concurrency', async () => {
    for (const concurrency of [1, 3]) {
        const f = await Readable.from([1, 2, 3, 4, 5, 6]).filter(async (x) => {
            await sleep((7 - (x as number)) * 15);
            return (x as number) % 2 === 0;
        }, { concurrency }).toArray();
        deepStrictEqual(f, [2, 4, 6], `filter order at concurrency=${concurrency}`);

        const fm = await Readable.from([1, 2, 3]).flatMap(async function* (x) {
            await sleep((4 - (x as number)) * 20);
            yield x;
            yield (x as number) * 100;
        }, { concurrency }).toArray();
        deepStrictEqual(fm, [1, 100, 2, 200, 3, 300], `flatMap order at concurrency=${concurrency}`);
    }
});

Deno.test('stream helpers: concurrency caps in-flight callbacks', async () => {
    for (const [concurrency, expected] of [[1, 1], [2, 2], [4, 4], [16, 8]] as const) {
        let cur = 0;
        let max = 0;
        await Readable.from([1, 2, 3, 4, 5, 6, 7, 8]).map(async (x) => {
            cur++;
            max = Math.max(max, cur);
            await sleep(15);
            cur--;
            return x;
        }, { concurrency }).toArray();
        // 16 over 8 items can only reach 8.
        strictEqual(max, expected, `max in-flight at concurrency=${concurrency}`);
    }
});

Deno.test('stream helpers: default concurrency is 1', async () => {
    let cur = 0;
    let max = 0;
    await Readable.from([1, 2, 3, 4]).map(async (x) => {
        cur++;
        max = Math.max(max, cur);
        await sleep(10);
        cur--;
        return x;
    }).toArray();
    strictEqual(max, 1);
});

// --- 4. early termination destroys the source -------------------------------

Deno.test('stream helpers: take(n) destroys the source', async () => {
    const src = Readable.from([1, 2, 3, 4, 5]);
    deepStrictEqual(await src.take(2).toArray(), [1, 2]);
    await tick();
    strictEqual(src.destroyed, true);
});

Deno.test('stream helpers: break out of a for-await over map destroys the source', async () => {
    const src = Readable.from([1, 2, 3, 4, 5]);
    const got: unknown[] = [];
    for await (const v of src.map((x) => (x as number) * 2)) {
        got.push(v);
        if (got.length === 2) break;
    }
    await tick();
    deepStrictEqual(got, [2, 4]);
    strictEqual(src.destroyed, true);
});

Deno.test('stream helpers: take runs the source generator finally block', async () => {
    let ranFinally = false;
    function* gen() {
        try { yield 1; yield 2; yield 3; } finally { ranFinally = true; }
    }
    await Readable.from(gen()).take(1).toArray();
    await tick();
    strictEqual(ranFinally, true, 'generator cleanup ran');
});

Deno.test('stream helpers: some/every/find short-circuit and destroy the source', async () => {
    {
        const src = Readable.from([1, 2, 3, 4, 5]);
        strictEqual(await src.some((x) => x === 2), true);
        await tick();
        strictEqual(src.destroyed, true, 'some destroyed source');
    }
    {
        const src = Readable.from([1, 2, 3, 4, 5]);
        strictEqual(await src.every((x) => (x as number) < 3), false);
        await tick();
        strictEqual(src.destroyed, true, 'every destroyed source');
    }
    {
        const src = Readable.from([1, 2, 3, 4, 5]);
        strictEqual(await src.find((x) => x === 2), 2);
        await tick();
        strictEqual(src.destroyed, true, 'find destroyed source');
    }
});

Deno.test('stream helpers: some/every/find stop pulling once decided', async () => {
    // Asserts the pull count is far below the source length rather than an exact
    // value: node's Readable.from reads one further ahead than cno's, so an
    // exact number would encode a readahead difference unrelated to these ops.
    for (const kind of ['some', 'every', 'find'] as const) {
        let pulled = 0;
        function* gen() { for (let i = 1; i <= 1000; i++) { pulled++; yield i; } }
        const src = Readable.from(gen());
        if (kind === 'some') await src.some((x) => x === 3);
        else if (kind === 'every') await src.every((x) => (x as number) < 3);
        else await src.find((x) => x === 3);
        ok(pulled < 20, `${kind} pulled ${pulled} of 1000 — did not short-circuit`);
    }
});

Deno.test('stream helpers: some/every/find results without a match', async () => {
    strictEqual(await Readable.from([1, 2, 3]).some((x) => x === 99), false);
    strictEqual(await Readable.from([1, 2, 3]).every((x) => (x as number) < 99), true);
    strictEqual(await Readable.from([1, 2, 3]).find((x) => x === 99), undefined);
    // Empty stream: some=false, every=true (vacuous truth), find=undefined.
    strictEqual(await Readable.from([]).some(() => true), false);
    strictEqual(await Readable.from([]).every(() => false), true);
    strictEqual(await Readable.from([]).find(() => true), undefined);
});

// --- 5. errors ---------------------------------------------------------------

Deno.test('stream helpers: throwing mapper rejects and destroys the source', async () => {
    const src = Readable.from([1, 2, 3]);
    await rejects(
        () => src.map((x) => { if (x === 2) throw new Error('boom'); return x; }).toArray(),
        (e: Error) => e.message === 'boom',
    );
    await tick();
    strictEqual(src.destroyed, true);
});

Deno.test('stream helpers: rejecting async mapper propagates', async () => {
    await rejects(
        () => Readable.from([1, 2, 3]).map(async (x) => {
            if (x === 2) throw new Error('boom');
            return x;
        }).toArray(),
        (e: Error) => e.message === 'boom',
    );
});

Deno.test('stream helpers: throwing filter/forEach/reduce all reject and destroy', async () => {
    {
        const src = Readable.from([1, 2, 3]);
        await rejects(() => src.filter((x) => { if (x === 2) throw new Error('f'); return true; }).toArray());
        await tick();
        strictEqual(src.destroyed, true, 'filter destroyed source');
    }
    {
        const src = Readable.from([1, 2, 3]);
        await rejects(() => src.forEach((x) => { if (x === 2) throw new Error('fe'); }));
        await tick();
        strictEqual(src.destroyed, true, 'forEach destroyed source');
    }
    {
        const src = Readable.from([1, 2, 3]);
        await rejects(() => src.reduce((a, x) => {
            if (x === 2) throw new Error('rd');
            return (a as number) + (x as number);
        }, 0));
        await tick();
        strictEqual(src.destroyed, true, 'reduce destroyed source');
    }
});

// --- 6. reduce ---------------------------------------------------------------

Deno.test('stream helpers: reduce with and without an initial value', async () => {
    strictEqual(await Readable.from([1, 2, 3]).reduce((a, b) => (a as number) + (b as number)), 6);
    strictEqual(await Readable.from([1, 2, 3]).reduce((a, b) => (a as number) + (b as number), 10), 16);
    // No initial value: the first item becomes the accumulator and the reducer
    // is never called for it.
    strictEqual(await Readable.from([7]).reduce((a, b) => (a as number) + (b as number)), 7);
    strictEqual(await Readable.from([1, 2, 3]).reduce(async (a, b) => (a as number) + (b as number), 0), 6);
});

Deno.test('stream helpers: reduce on an empty stream', async () => {
    // No initial value -> rejects with ERR_MISSING_ARGS.
    await rejects(
        () => Readable.from([]).reduce((a, b) => (a as number) + (b as number)),
        (e: Error & { code?: string }) => e.code === 'ERR_MISSING_ARGS'
            && e.message === 'Reduce of an empty stream requires an initial value',
    );
    // With an initial value -> resolves to it.
    strictEqual(await Readable.from([]).reduce((a, b) => (a as number) + (b as number), 42), 42);
});

Deno.test('stream helpers: reduce counts arguments, so explicit undefined is an initial value', async () => {
    // node uses `arguments.length > 1`, so passing undefined explicitly means
    // "the initial value is undefined" and the empty stream does NOT reject.
    strictEqual(await Readable.from([]).reduce((a) => a, undefined), undefined);
});

Deno.test('stream helpers: reduce receives (acc, value, { signal })', async () => {
    const seen: Array<[unknown, unknown, boolean]> = [];
    await Readable.from(['a', 'b']).reduce((acc, v, opts) => {
        seen.push([acc, v, !!(opts && (opts as { signal?: unknown }).signal)]);
        return (acc as string) + (v as string);
    }, 'Z');
    deepStrictEqual(seen, [['Z', 'a', true], ['Za', 'b', true]]);
});

Deno.test('stream helpers: map callback receives (value, { signal })', async () => {
    const seen: Array<[unknown, boolean]> = [];
    await Readable.from(['a', 'b']).map((v, opts) => {
        seen.push([v, !!(opts && (opts as { signal?: unknown }).signal)]);
        return v;
    }).toArray();
    deepStrictEqual(seen, [['a', true], ['b', true]]);
});

// --- 7. AbortSignal ---------------------------------------------------------

Deno.test('stream helpers: aborting mid-flight rejects with ABORT_ERR and destroys source', async () => {
    const ac = new AbortController();
    const src = Readable.from([1, 2, 3]);
    const p = src.map(async (x) => { await sleep(200); return x; }, { signal: ac.signal }).toArray();
    setTimeout(() => ac.abort(), 20);
    await rejects(() => p, (e: Error & { code?: string }) => e.code === 'ABORT_ERR' && e.name === 'AbortError');
    await tick();
    strictEqual(src.destroyed, true);
});

Deno.test('stream helpers: pre-aborted signal rejects every op', async () => {
    const mkAborted = () => { const ac = new AbortController(); ac.abort(); return ac.signal; };
    const isAbort = (e: Error & { code?: string }) => e.code === 'ABORT_ERR';
    await rejects(() => Readable.from([1, 2, 3]).map((x) => x, { signal: mkAborted() }).toArray(), isAbort);
    await rejects(() => Readable.from([1, 2, 3]).take(2, { signal: mkAborted() }).toArray(), isAbort);
    await rejects(() => Readable.from([1, 2, 3]).drop(1, { signal: mkAborted() }).toArray(), isAbort);
    await rejects(() => Readable.from([1, 2, 3]).toArray({ signal: mkAborted() }), isAbort);
    await rejects(() => Readable.from([1, 2, 3]).find(() => true, { signal: mkAborted() }), isAbort);
    await rejects(() => Readable.from([1, 2, 3]).forEach(() => {}, { signal: mkAborted() }), isAbort);
});

Deno.test('stream helpers: abort rejects forEach and reduce', async () => {
    {
        const ac = new AbortController();
        const p = Readable.from([1, 2, 3]).forEach(async () => { await sleep(200); }, { signal: ac.signal });
        setTimeout(() => ac.abort(), 20);
        await rejects(() => p, (e: Error & { code?: string }) => e.code === 'ABORT_ERR');
    }
    {
        const ac = new AbortController();
        const p = Readable.from([1, 2, 3]).reduce(async (a, x) => {
            await sleep(200);
            return (a as number) + (x as number);
        }, 0, { signal: ac.signal });
        setTimeout(() => ac.abort(), 20);
        await rejects(() => p, (e: Error & { code?: string }) => e.code === 'ABORT_ERR');
    }
});

// --- 8. argument validation -------------------------------------------------

Deno.test('stream helpers: map/filter/flatMap throw SYNCHRONOUSLY on a bad fn', () => {
    const bad = (e: Error & { code?: string }) => e.code === 'ERR_INVALID_ARG_TYPE';
    throws(() => Readable.from([1]).map(42 as never), bad);
    throws(() => Readable.from([1]).filter(42 as never), bad);
    throws(() => Readable.from([1]).flatMap(42 as never), bad);
});

Deno.test('stream helpers: forEach/reduce/some reject instead of throwing on a bad fn', async () => {
    // Asymmetry inherited from node: these are `async function`s, so the
    // validateFunction failure becomes a rejected promise rather than a throw.
    const bad = (e: Error & { code?: string }) => e.code === 'ERR_INVALID_ARG_TYPE';
    await rejects(() => Readable.from([1]).forEach(42 as never), bad);
    await rejects(() => Readable.from([1]).reduce(42 as never), bad);
    await rejects(() => Readable.from([1]).some(42 as never), bad);
});

Deno.test('stream helpers: concurrency and options validation', () => {
    const src = () => Readable.from([1, 2]);
    throws(() => src().map((x) => x, 42 as never), (e: Error & { code?: string }) => e.code === 'ERR_INVALID_ARG_TYPE');
    throws(() => src().map((x) => x, { concurrency: 0 }), (e: Error & { code?: string }) => e.code === 'ERR_OUT_OF_RANGE');
    throws(() => src().map((x) => x, { concurrency: -1 }), (e: Error & { code?: string }) => e.code === 'ERR_OUT_OF_RANGE');
    throws(() => src().map((x) => x, { signal: 5 as never }), (e: Error & { code?: string }) => e.code === 'ERR_INVALID_ARG_TYPE');
    throws(() => src().compose(42), (e: Error & { code?: string }) => e.code === 'ERR_INVALID_ARG_TYPE');
    throws(() => src().iterator(42 as never), (e: Error & { code?: string }) => e.code === 'ERR_INVALID_ARG_TYPE');
});

Deno.test('stream helpers: fractional and string concurrency are accepted', async () => {
    // MathFloor'd, not rejected.
    deepStrictEqual(await Readable.from([1, 2]).map((x) => x, { concurrency: 1.5 }).toArray(), [1, 2]);
    deepStrictEqual(await Readable.from([1, 2]).map((x) => x, { concurrency: '2' as never }).toArray(), [1, 2]);
});

Deno.test('stream helpers: take/drop numeric coercion matches node exactly', async () => {
    // node's helper is *named* toIntegerOrInfinity but does not truncate: it is
    // Number() -> NaN becomes 0 -> negative throws. So take(1.5) yields TWO
    // items (the counter decrements 1.5 -> 0.5 -> -0.5), and take(-0.5) throws,
    // which a truncate-then-check implementation could not produce.
    deepStrictEqual(await Readable.from([1, 2, 3, 4]).take(1.5).toArray(), [1, 2]);
    deepStrictEqual(await Readable.from([1, 2, 3, 4]).take(2.5).toArray(), [1, 2, 3]);
    deepStrictEqual(await Readable.from([1, 2, 3, 4]).drop(1.5).toArray(), [3, 4]);
    deepStrictEqual(await Readable.from([1, 2, 3, 4]).take(NaN).toArray(), []);
    deepStrictEqual(await Readable.from([1, 2, 3, 4]).drop(NaN).toArray(), [1, 2, 3, 4]);
    deepStrictEqual(await Readable.from([1, 2, 3, 4]).take('2' as never).toArray(), [1, 2]);
    deepStrictEqual(await Readable.from([1, 2, 3, 4]).take(true as never).toArray(), [1]);
    deepStrictEqual(await Readable.from([1, 2, 3, 4]).take([2] as never).toArray(), [1, 2]);
    deepStrictEqual(await Readable.from([1, 2, 3, 4]).take('abc' as never).toArray(), []);
    const oor = (e: Error & { code?: string }) => e.code === 'ERR_OUT_OF_RANGE';
    throws(() => Readable.from([1]).take(-1), oor);
    throws(() => Readable.from([1]).take(-0.5), oor);
    throws(() => Readable.from([1]).drop(-1), oor);
    throws(() => Readable.from([1]).take(-Infinity), oor);
});

Deno.test('stream helpers: calling a helper with new throws', () => {
    const M = Readable.prototype.map as unknown as new () => unknown;
    throws(() => new M(), (e: Error & { code?: string }) => e.code === 'ERR_ILLEGAL_CONSTRUCTOR');
});

// --- 9. flatMap flattening --------------------------------------------------

Deno.test('stream helpers: flatMap flattens iterables and async iterables', async () => {
    deepStrictEqual(await Readable.from([1, 2]).flatMap((x) => [x, (x as number) * 10]).toArray(), [1, 10, 2, 20]);
    deepStrictEqual(await Readable.from(['ab']).flatMap((x) => x).toArray(), ['a', 'b']);
    deepStrictEqual(await Readable.from([1]).flatMap(function* (x) { yield x; yield (x as number) + 1; }).toArray(), [1, 2]);
    deepStrictEqual(
        await Readable.from([1]).flatMap(async function* (x) { yield x; yield (x as number) + 1; }).toArray(),
        [1, 2],
    );
    deepStrictEqual(await Readable.from([1]).flatMap((x) => Readable.from([x, (x as number) + 1])).toArray(), [1, 2]);
    deepStrictEqual(await Readable.from([1]).flatMap((x) => new Set([x, (x as number) + 1])).toArray(), [1, 2]);
    deepStrictEqual(await Readable.from([1]).flatMap(async (x) => [x, (x as number) + 1]).toArray(), [1, 2]);
    deepStrictEqual(await Readable.from([1, 2]).flatMap(() => []).toArray(), []);
    // Only one level is flattened.
    deepStrictEqual(await Readable.from([1]).flatMap((x) => [[x]]).toArray(), [[1]]);
});

Deno.test('stream helpers: flatMap rejects non-iterable results', async () => {
    await rejects(() => Readable.from([1]).flatMap((x) => x).toArray(), TypeError);
    await rejects(() => Readable.from([1]).flatMap(() => null).toArray(), TypeError);
    await rejects(() => Readable.from([1]).flatMap(() => undefined).toArray(), TypeError);
});

// --- 10. iterator({ destroyOnReturn }) --------------------------------------

Deno.test('stream helpers: iterator({destroyOnReturn:false}) leaves the stream alive', async () => {
    const src = Readable.from([1, 2, 3, 4]);
    const got: unknown[] = [];
    for await (const v of src.iterator({ destroyOnReturn: false })) {
        got.push(v);
        if (got.length === 2) break;
    }
    await tick();
    deepStrictEqual(got, [1, 2]);
    strictEqual(src.destroyed, false, 'stream survived early exit');
    // ...and is still resumable.
    const rest: unknown[] = [];
    for await (const v of src.iterator({ destroyOnReturn: false })) rest.push(v);
    deepStrictEqual(rest, [3, 4]);
});

Deno.test('stream helpers: iterator() and iterator({destroyOnReturn:true}) destroy', async () => {
    for (const options of [undefined, { destroyOnReturn: true }]) {
        const src = Readable.from([1, 2, 3, 4]);
        const got: unknown[] = [];
        for await (const v of src.iterator(options)) {
            got.push(v);
            if (got.length === 2) break;
        }
        await tick();
        deepStrictEqual(got, [1, 2]);
        strictEqual(src.destroyed, true, `destroyed with options=${JSON.stringify(options)}`);
    }
});

// --- 11. object mode vs byte mode, and Duplex/Transform ---------------------

Deno.test('stream helpers: byte-mode source yields Buffers to the mapper', async () => {
    const src = new Readable({ read() { this.push('ab'); this.push(null); } });
    const out = await src.map((x) => {
        ok(Buffer.isBuffer(x), 'chunk is a Buffer');
        return (x as Buffer).toString().toUpperCase();
    }).toArray();
    deepStrictEqual(out, ['AB']);
});

Deno.test('stream helpers: byte-mode source with an encoding yields strings', async () => {
    const src = new Readable({ encoding: 'utf8', read() { this.push('ab'); this.push(null); } });
    deepStrictEqual(await src.map((x) => x).toArray(), ['ab']);
});

Deno.test('stream helpers: work on a Transform', async () => {
    const t = new Transform({ objectMode: true, transform(c, _e, cb) { cb(null, (c as number) * 2); } });
    const p = t.map((x) => (x as number) + 1).toArray();
    t.write(1);
    t.write(2);
    t.end();
    deepStrictEqual(await p, [3, 5]);
});

Deno.test('stream helpers: work on a PassThrough and a Duplex', async () => {
    {
        const pt = new PassThrough({ objectMode: true });
        const p = pt.take(1).toArray();
        pt.write('x');
        pt.write('y');
        pt.end();
        deepStrictEqual(await p, ['x']);
    }
    {
        const d = new Duplex({
            objectMode: true,
            read() { this.push('r1'); this.push(null); },
            write(_c, _e, cb) { cb(); },
        });
        deepStrictEqual(await d.map((x) => `${x as string}!`).toArray(), ['r1!']);
    }
});

// --- 12. compose -----------------------------------------------------------

Deno.test('stream helpers: compose pipes through a transform', async () => {
    const src = Readable.from([1, 2, 3]);
    const t = new Transform({ objectMode: true, transform(c, _e, cb) { cb(null, (c as number) * 3); } });
    deepStrictEqual(await src.compose(t).toArray(), [3, 6, 9]);
});

Deno.test('stream helpers: compose result is a Duplex, not writable when head is a Readable', async () => {
    const c = Readable.from([1, 2, 3]).compose(new PassThrough({ objectMode: true }));
    ok(c instanceof Duplex, 'compose returns a Duplex');
    strictEqual(c.writable, false, 'writable side is closed when the head is read-only');
    strictEqual(c.readableObjectMode, true);
    deepStrictEqual(await c.toArray(), [1, 2, 3]);
});

Deno.test('stream helpers: compose accepts an async generator function', async () => {
    const c = Readable.from([1, 2]).compose(async function* (s: AsyncIterable<unknown>) {
        for await (const v of s) yield (v as number) * 7;
    });
    deepStrictEqual(await c.toArray(), [7, 14]);
});

Deno.test('stream helpers: compose output can be chained into more helpers', async () => {
    const t = new Transform({ objectMode: true, transform(c, _e, cb) { cb(null, (c as number) + 1); } });
    deepStrictEqual(await Readable.from([1, 2]).compose(t).map((x) => (x as number) * 10).toArray(), [20, 30]);
});

Deno.test('stream helpers: compose propagates a transform error', async () => {
    const t = new Transform({ objectMode: true, transform(_c, _e, cb) { cb(new Error('tfail')); } });
    await rejects(() => Readable.from([1, 2]).compose(t).toArray(), (e: Error) => e.message === 'tfail');
});

Deno.test('stream helpers: early exit from a composed stream destroys the source', async () => {
    const src = Readable.from([1, 2, 3, 4]);
    deepStrictEqual(await src.compose(new PassThrough({ objectMode: true })).take(1).toArray(), [1]);
    await tick();
    strictEqual(src.destroyed, true);
});

// --- 13. Duplex.from -------------------------------------------------------

Deno.test('stream helpers: Duplex.from over the supported body types', async () => {
    ok(Duplex.from([1, 2]) instanceof Duplex);
    deepStrictEqual(await Duplex.from([1, 2, 3]).toArray(), [1, 2, 3]);
    deepStrictEqual(await Duplex.from(new Set([1, 2])).toArray(), [1, 2]);
    // A string is pushed whole, not split into characters.
    deepStrictEqual((await Duplex.from('abc').toArray()).map(String), ['abc']);
    deepStrictEqual(await Duplex.from((async function* () { yield 1; yield 2; })()).toArray(), [1, 2]);
    deepStrictEqual(await Duplex.from(async function* () { yield 5; yield 6; }).toArray(), [5, 6]);
    deepStrictEqual(await Duplex.from(Readable.from([9])).toArray(), [9]);
    deepStrictEqual((await Duplex.from(Promise.resolve('pv')).toArray()).map(String), ['pv']);
});

Deno.test('stream helpers: Duplex.from(transform generator) is writable and readable', async () => {
    const d = Duplex.from(async function* (src: AsyncIterable<unknown>) {
        for await (const c of src) yield String(c).toUpperCase();
    });
    const p = d.toArray();
    d.write('ab');
    d.end();
    deepStrictEqual((await p).map(String), ['AB']);
});

Deno.test('stream helpers: Duplex.from({readable, writable}) pair', async () => {
    const r = Readable.from([1, 2]);
    const w = new PassThrough({ objectMode: true });
    deepStrictEqual(await Duplex.from({ readable: r, writable: w }).toArray(), [1, 2]);
});

Deno.test('stream helpers: Duplex.from(Transform) round-trips a write', async () => {
    const d = Duplex.from(new PassThrough({ objectMode: true }));
    const p = d.toArray();
    d.write('q');
    d.end();
    deepStrictEqual((await p).map(String), ['q']);
});

Deno.test('stream helpers: Duplex.from rejects invalid bodies', () => {
    const bad = (e: Error & { code?: string }) => e.code === 'ERR_INVALID_ARG_TYPE';
    throws(() => Duplex.from(42), bad);
    throws(() => Duplex.from(null), bad);
});

Deno.test('stream helpers: a Duplex.from result carries the helpers too', async () => {
    deepStrictEqual(await Duplex.from([1, 2]).map((x) => (x as number) * 5).toArray(), [5, 10]);
});
