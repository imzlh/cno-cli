import { strictEqual, ok, deepStrictEqual, throws, rejects } from 'node:assert';
import { withTempPath } from '../_helpers/temp.ts';

// Deno KV: SQLite-backed. Tests run in-process against the Deno global.
// Each test opens its own isolated DB via a unique path.

async function withKv<T>(name: string, fn: (kv: Deno.Kv) => T | Promise<T>): Promise<T> {
    return withTempPath(`kv-${name}`, async (path) => {
        const kv = await Deno.openKv(path);
        try {
            return await fn(kv);
        } finally {
            kv.close();
        }
    });
}

async function withTimeout<T>(promise: Promise<T>, ms = 3000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function waitForEntry<T>(kv: Deno.Kv, key: Deno.KvKey, timeout = 3000): Promise<Deno.KvEntryMaybe<T>> {
    const deadline = Date.now() + timeout;
    let entry = await kv.get<T>(key);
    while (entry.value === null && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
        entry = await kv.get<T>(key);
    }
    return entry;
}

async function collect<T>(iter: Deno.KvListIterator<T>): Promise<Deno.KvEntry<T>[]> {
    const entries: Deno.KvEntry<T>[] = [];
    for await (const entry of iter) entries.push(entry);
    return entries;
}

Deno.test({ name: 'deno: KV openKv accepts memory and rejects invalid filenames', timeout: 10000 }, async () => {
    const memory = await Deno.openKv(':memory:');
    try {
        await memory.set(['memory'], 'ok');
        strictEqual((await memory.get(['memory'])).value, 'ok');
    } finally {
        memory.close();
    }

    await rejects(async () => await Deno.openKv(''), /Filename cannot be empty/);
    await rejects(async () => await Deno.openKv(':foo'), /Filename cannot start with ':'/);
});

Deno.test({ name: 'deno: KV set/get/delete round-trip', timeout: 10000 }, async () => {
    await withKv('basic', async (kv) => {
        await kv.set(['a'], 'alpha');
        const entry = await kv.get(['a']);
        strictEqual(entry.value, 'alpha');
        ok(entry.versionstamp, 'entry must carry a versionstamp');

        await kv.delete(['a']);
        const gone = await kv.get(['a']);
        strictEqual(gone.value, null);
        strictEqual(gone.versionstamp, null);
    });
});

Deno.test({ name: 'deno: KV versionstamp changes on update', timeout: 10000 }, async () => {
    await withKv('vs', async (kv) => {
        const r1 = await kv.set(['v'], 'v1');
        const r2 = await kv.set(['v'], 'v2');
        ok(r1.versionstamp !== r2.versionstamp, 'versionstamp must change on update');
        const entry = await kv.get(['v']);
        strictEqual(entry.value, 'v2');
    });
});

Deno.test({ name: 'deno: KV getMany returns entries in order, null for missing', timeout: 10000 }, async () => {
    await withKv('many', async (kv) => {
        await kv.set(['m', 'x'], 1);
        await kv.set(['m', 'y'], 2);
        const [a, b, c] = await kv.getMany([['m', 'x'], ['m', 'y'], ['m', 'z']]);
        strictEqual(a.value, 1);
        strictEqual(b.value, 2);
        strictEqual(c.value, null);
    });
});

Deno.test({ name: 'deno: KV value codec preserves structured edge values', timeout: 10000 }, async () => {
    await withKv('bjson-values', async (kv) => {
        const date = new Date('2026-07-05T12:34:56.789Z');
        await kv.set(['value'], {
            empty: '',
            zero: 0,
            negZero: -0,
            no: false,
            nil: null,
            missing: undefined,
            nan: NaN,
            posInf: Infinity,
            negInf: -Infinity,
            big: -123456789012345678901234567890n,
            bytes: new Uint8Array([0, 1, 2, 255]),
            date,
            nested: [{ a: 1, b: false }],
        });

        const entry = await kv.get<any>(['value']);
        strictEqual(entry.value.empty, '');
        strictEqual(entry.value.zero, 0);
        strictEqual(Object.is(entry.value.negZero, -0), true);
        strictEqual(entry.value.no, false);
        strictEqual(entry.value.nil, null);
        strictEqual(entry.value.missing, undefined);
        strictEqual(Number.isNaN(entry.value.nan), true);
        strictEqual(entry.value.posInf, Infinity);
        strictEqual(entry.value.negInf, -Infinity);
        strictEqual(entry.value.big, -123456789012345678901234567890n);
        deepStrictEqual([...entry.value.bytes], [0, 1, 2, 255]);
        strictEqual(entry.value.date instanceof Date, true);
        strictEqual(entry.value.date.getTime(), date.getTime());
        deepStrictEqual(entry.value.nested, [{ a: 1, b: false }]);
    });
});

Deno.test({ name: 'deno: KV list filters by prefix and returns keys', timeout: 10000 }, async () => {
    await withKv('list', async (kv) => {
        await kv.set(['p', '1'], 'p1');
        await kv.set(['p', '2'], 'p2');
        await kv.set(['q', '1'], 'q1');
        const keys: unknown[] = [];
        for await (const e of kv.list({ prefix: ['p'] })) keys.push(e.key);
        ok(keys.length === 2, `expected 2 entries under prefix p, got ${keys.length}`);
        ok(keys.every((k: any) => Array.isArray(k) && k[0] === 'p'));
    });
});

Deno.test({ name: 'deno: KV list supports limit cursor and reverse iteration', timeout: 10000 }, async () => {
    await withKv('list-cursor', async (kv) => {
        for (const n of [1, 2, 3, 4]) {
            await kv.set(['cursor', n], `v${n}`);
        }

        const first = kv.list<string>({ prefix: ['cursor'] }, { limit: 2 });
        const a = await first.next();
        const b = await first.next();
        const done = await first.next();
        strictEqual(a.value?.value, 'v1');
        strictEqual(b.value?.value, 'v2');
        strictEqual(done.done, true);
        ok(first.cursor, 'iterator cursor must be set after yielding entries');

        const rest: string[] = [];
        for await (const entry of kv.list<string>({ prefix: ['cursor'] }, { cursor: first.cursor })) {
            rest.push(entry.value);
        }
        deepStrictEqual(rest, ['v3', 'v4']);

        const reverse: string[] = [];
        for await (const entry of kv.list<string>({ prefix: ['cursor'] }, { reverse: true, limit: 3 })) {
            reverse.push(entry.value);
        }
        deepStrictEqual(reverse, ['v4', 'v3', 'v2']);
    });
});

Deno.test({ name: 'deno: KV atomic insert with versionstamp:null check only commits once', timeout: 10000 }, async () => {
    await withKv('atomic', async (kv) => {
        // first commit: key absent -> check passes -> inserted
        const r1 = await kv.atomic().check({ key: ['atom'], versionstamp: null }).set(['atom'], 'first').commit();
        ok(r1.ok, 'first atomic insert must commit');

        // second commit: key now present -> check fails -> NOT committed
        const r2 = await kv.atomic().check({ key: ['atom'], versionstamp: null }).set(['atom'], 'second').commit();
        ok(!r2.ok, 'second atomic insert with stale check must NOT commit');

        const entry = await kv.get(['atom']);
        strictEqual(entry.value, 'first', 'value must remain the first insert');
    });
});

Deno.test({ name: 'deno: KV atomic set + delete in one commit', timeout: 10000 }, async () => {
    await withKv('atomic-op', async (kv) => {
        await kv.set(['x'], 'old');
        const r = await kv.atomic().set(['x'], 'new').delete(['y']).commit();
        ok(r.ok);
        strictEqual((await kv.get(['x'])).value, 'new');
        strictEqual((await kv.get(['y'])).value, null);
    });
});

Deno.test({ name: 'deno: KV atomic operations validate keys and cannot be reused', timeout: 10000 }, async () => {
    await withKv('atomic-validation', async (kv) => {
        throws(() => kv.atomic().check({ key: [], versionstamp: null }), /Key cannot be empty/);
        throws(() => kv.atomic().set([], 'x'), /Key cannot be empty/);
        throws(() => kv.atomic().delete([]), /Key cannot be empty/);
        throws(() => kv.atomic().sum([], 1n), /Key cannot be empty/);
        throws(() => kv.atomic().set(['ttl'], 'x', { expireIn: -1 }), /expireIn must be a non-negative integer/);
        throws(() => kv.atomic().enqueue('x', { delay: -1 }), /delay must be a non-negative integer/);
        throws(() => kv.atomic().enqueue('x', { keysIfUndelivered: [[]] }), /Key cannot be empty/);

        const op = kv.atomic().set(['once'], 'value');
        ok((await op.commit()).ok);
        throws(() => op.set(['again'], 'value'), /already committed/);
        throws(() => op.commit(), /already committed/);

        const checks = Array.from({ length: 100 }, (_, index) => ({
            key: ['check-limit', index],
            versionstamp: null,
        }));
        kv.atomic().check(...checks);
        throws(
            () => checks.reduce((atomic, check) => atomic.check(check), kv.atomic()).check({ key: ['too-many'], versionstamp: null }),
            /Too many checks/,
        );

        await rejects(
            async () => await kv.atomic().check({ key: ['bad-versionstamp'], versionstamp: '' }).commit(),
            /Invalid versionstamp/,
        );
        await rejects(
            async () => await kv.atomic().check({ key: ['bad-versionstamp'], versionstamp: 'xx'.repeat(10) }).commit(),
            /Invalid versionstamp/,
        );
        await rejects(
            async () => await kv.atomic().check({ key: ['bad-versionstamp'], versionstamp: 'aa'.repeat(11) }).commit(),
            /Invalid versionstamp/,
        );
    });
});

Deno.test({ name: 'deno: KV atomic U64 shortcuts handle sum max and min', timeout: 10000 }, async () => {
    await withKv('atomic-u64-shortcuts', async (kv) => {
        const first = await kv.atomic()
            .sum(['count'], 5n)
            .max(['highest'], 3n)
            .min(['lowest'], 10n)
            .commit();
        ok(first.ok);
        deepStrictEqual((await kv.get(['count'])).value, new Deno.KvU64(5n));
        deepStrictEqual((await kv.get(['highest'])).value, new Deno.KvU64(3n));
        deepStrictEqual((await kv.get(['lowest'])).value, new Deno.KvU64(10n));

        const second = await kv.atomic()
            .sum(['count'], 7n)
            .max(['highest'], 2n)
            .min(['lowest'], 12n)
            .commit();
        ok(second.ok);
        deepStrictEqual((await kv.get(['count'])).value, new Deno.KvU64(12n));
        deepStrictEqual((await kv.get(['highest'])).value, new Deno.KvU64(3n));
        deepStrictEqual((await kv.get(['lowest'])).value, new Deno.KvU64(10n));
    });
});

Deno.test({ name: 'deno: KV KvU64 constructor coercion inspect and persistence', timeout: 10000 }, async () => {
    strictEqual(new Deno.KvU64(0n).value, 0n);
    strictEqual(new Deno.KvU64((1n << 64n) - 1n).value, (1n << 64n) - 1n);
    strictEqual(Object.prototype.toString.call(new Deno.KvU64(1n)), '[object Deno.KvU64]');
    strictEqual(new Deno.KvU64(1n).valueOf(), 1n);
    strictEqual(new Deno.KvU64(1n).toString(), '1');
    strictEqual((new Deno.KvU64(1n) as unknown as bigint) + 1n, 2n);
    strictEqual(Deno.inspect(new Deno.KvU64(1n), { colors: false }), '[Deno.KvU64: 1n]');
    throws(() => new Deno.KvU64(-1n), RangeError);
    throws(() => new Deno.KvU64(1n << 64n), RangeError);

    await withKv('u64-persist', async (kv) => {
        await kv.set(['u64'], new Deno.KvU64(42n));
        const entry = await kv.get(['u64']);
        ok(entry.value instanceof Deno.KvU64);
        deepStrictEqual(entry.value, new Deno.KvU64(42n));
    });
});

Deno.test({ name: 'deno: KV atomic mutate entry point uses U64 values', timeout: 10000 }, async () => {
    await withKv('atomic-mutate', async (kv) => {
        await kv.set(['mutate', 'delete'], 'old');
        const committed = await kv.atomic().mutate(
            { type: 'set', key: ['mutate', 'set'], value: 'set-by-mutate' },
            { type: 'delete', key: ['mutate', 'delete'] },
            { type: 'sum', key: ['mutate', 'sum'], value: new Deno.KvU64(2n) },
            { type: 'max', key: ['mutate', 'max'], value: new Deno.KvU64(5n) },
            { type: 'min', key: ['mutate', 'min'], value: new Deno.KvU64(7n) },
        ).commit();

        ok(committed.ok);
        strictEqual((await kv.get(['mutate', 'set'])).value, 'set-by-mutate');
        strictEqual((await kv.get(['mutate', 'delete'])).value, null);
        deepStrictEqual((await kv.get(['mutate', 'sum'])).value, new Deno.KvU64(2n));
        deepStrictEqual((await kv.get(['mutate', 'max'])).value, new Deno.KvU64(5n));
        deepStrictEqual((await kv.get(['mutate', 'min'])).value, new Deno.KvU64(7n));
    });
});

Deno.test({ name: 'deno: KV atomic mutate rejects invalid mutation shapes', timeout: 10000 }, async () => {
    await withKv('atomic-mutate-invalid', async (kv) => {
        await rejects(
            async () => await kv.atomic().mutate({ key: ['a'], type: 'set' } as unknown as Deno.KvMutation).commit(),
            /Value cannot be undefined/,
        );
        await rejects(
            async () => await kv.atomic().mutate({ key: ['a'], type: 'delete', value: 'extra' } as unknown as Deno.KvMutation).commit(),
            /delete mutation cannot have a value/,
        );
        await rejects(
            async () => await kv.atomic().mutate({ key: ['a'], type: 'foobar' } as unknown as Deno.KvMutation).commit(),
            /Unknown mutation type/,
        );
        await rejects(
            async () => await kv.atomic().mutate({ key: ['a'], type: 'foobar', value: 'extra' } as unknown as Deno.KvMutation).commit(),
            /Unknown mutation type/,
        );
    });
});

Deno.test({ name: 'deno: KV atomic U64 mutations wrap and reject non-U64 types', timeout: 10000 }, async () => {
    await withKv('atomic-u64-types', async (kv) => {
        await kv.set(['sum'], new Deno.KvU64((1n << 64n) - 1n));
        ok((await kv.atomic().mutate({ type: 'sum', key: ['sum'], value: new Deno.KvU64(10n) }).commit()).ok);
        deepStrictEqual((await kv.get(['sum'])).value, new Deno.KvU64(9n));

        await kv.set(['plain'], 1);
        await rejects(
            kv.atomic().mutate({ type: 'max', key: ['plain'], value: new Deno.KvU64(2n) }).commit(),
            /non-U64 value/,
        );
        throws(
            () => kv.atomic().mutate({ type: 'min', key: ['bad'], value: 1 } as unknown as Deno.KvMutation),
            /non-U64 operand/,
        );
    });
});

Deno.test({ name: 'deno: KV key ordering follows Deno key type ordering', timeout: 10000 }, async () => {
    await withKv('key-ordering', async (kv) => {
        const committed = await kv.atomic()
            .set([new Uint8Array(1)], 0)
            .set(['a'], 0)
            .set([1n], 0)
            .set([3.14], 0)
            .set([false], 0)
            .set([true], 0)
            .commit();
        ok(committed.ok);

        deepStrictEqual((await collect(kv.list({ prefix: [] }))).map((entry) => entry.key), [
            [new Uint8Array(1)],
            ['a'],
            [1n],
            [3.14],
            [false],
            [true],
        ]);
    });
});

Deno.test({ name: 'deno: KV list selector boundaries batch limits and cursors', timeout: 10000 }, async () => {
    await withKv('list-boundaries', async (kv) => {
        const res = await kv.atomic()
            .set(['a'], -1)
            .set(['a', 'a'], 0)
            .set(['a', 'b'], 1)
            .set(['a', 'c'], 2)
            .set(['a', 'd'], 3)
            .set(['a', 'e'], 4)
            .set(['b'], 99)
            .commit();
        ok(res.ok);

        deepStrictEqual((await collect(kv.list({ prefix: [] }))).map((entry) => entry.key), [
            ['a'], ['a', 'a'], ['a', 'b'], ['a', 'c'], ['a', 'd'], ['a', 'e'], ['b'],
        ]);
        deepStrictEqual((await collect(kv.list({ prefix: ['a'], start: ['a', 'c'] }))).map((entry) => entry.key), [
            ['a', 'c'], ['a', 'd'], ['a', 'e'],
        ]);
        deepStrictEqual((await collect(kv.list({ prefix: ['a'], end: ['a', 'c'] }))).map((entry) => entry.key), [
            ['a', 'a'], ['a', 'b'],
        ]);
        deepStrictEqual((await collect(kv.list({ start: ['a'], end: ['a', 'd'] }))).map((entry) => entry.key), [
            ['a'], ['a', 'a'], ['a', 'b'], ['a', 'c'],
        ]);

        const first = kv.list({ prefix: ['a'] }, { limit: 2, batchSize: 2 });
        strictEqual((await first.next()).value?.value, 0);
        strictEqual((await first.next()).value?.value, 1);
        const rest = await collect(kv.list({ prefix: ['a'] }, { cursor: first.cursor, batchSize: 2 }));
        deepStrictEqual(rest.map((entry) => entry.key), [['a', 'c'], ['a', 'd'], ['a', 'e']]);

        await rejects(async () => await collect(kv.list({ prefix: ['a'], start: ['a'] })), /Start key/);
        await rejects(async () => await collect(kv.list({ prefix: ['a'], end: ['b'] })), /End key/);
        await rejects(async () => await collect(kv.list({ start: ['b'], end: ['a'] })), /Start key is greater/);
        await rejects(async () => await collect(kv.list({ prefix: ['a'] }, { batchSize: 1001 })), /Too many entries/);
    });
});

Deno.test({ name: 'deno: KV commitVersionstamp suffix replaces final key part', timeout: 10000 }, async () => {
    await withKv('commit-versionstamp-key', async (kv) => {
        const direct = await kv.set(['versioned', kv.commitVersionstamp()] as unknown as Deno.KvKey, 'direct');
        const directEntries = await collect(kv.list({ prefix: ['versioned'] }));
        strictEqual(directEntries[0].key[1], direct.versionstamp);
        strictEqual(directEntries[0].value, 'direct');

        const atomic = await kv.atomic()
            .set(['versioned', kv.commitVersionstamp()] as unknown as Deno.KvKey, 'atomic')
            .commit();
        ok(atomic.ok);
        const entries = await collect(kv.list({ prefix: ['versioned'] }));
        strictEqual(entries[1].key[1], atomic.versionstamp);
        strictEqual(entries[1].value, 'atomic');

        await rejects(
            async () => await kv.set(['versioned', kv.commitVersionstamp(), 'tail'] as unknown as Deno.KvKey, 'bad'),
            /Invalid key part/,
        );
    });
});

Deno.test({ name: 'deno: KV AtomicOperation exposes state through Deno.inspect', timeout: 10000 }, async () => {
    await withKv('atomic-inspect', async (kv) => {
        strictEqual(Deno.inspect(kv.atomic(), { colors: false }), 'AtomicOperation (empty)');
        const inspected = Deno.inspect(
            kv.atomic()
                .check({ key: ['users', 'alice'], versionstamp: 'version123' })
                .set(['users', 'bob'], { age: 30 })
                .delete(['old'])
                .sum(['visits'], 5n),
            { colors: false },
        );
        ok(inspected.includes('AtomicOperation'));
        ok(inspected.includes('check({ key: [ "users", "alice" ], versionstamp: "version123" })'));
        ok(inspected.includes('set([ "users", "bob" ], { age: 30 })'));
        ok(inspected.includes('delete([ "old" ])'));
        ok(inspected.includes('sum([ "visits" ], [Deno.KvU64: 5n])'));
    });
});

Deno.test({ name: 'deno: KV atomic operation is thenable and commits once', timeout: 10000 }, async () => {
    await withKv('atomic-thenable', async (kv) => {
        const thenResult = await kv.atomic()
            .set(['thenable', 'then'], 'via-then')
            .then((result) => result.ok ? 'committed' : 'failed');
        strictEqual(thenResult, 'committed');
        strictEqual((await kv.get(['thenable', 'then'])).value, 'via-then');

        let finalized = false;
        const finallyResult = await kv.atomic()
            .set(['thenable', 'finally'], 'via-finally')
            .finally(() => { finalized = true; });
        strictEqual(finalized, true);
        ok(finallyResult.ok);
        strictEqual((await kv.get(['thenable', 'finally'])).value, 'via-finally');

        const op = kv.atomic().set(['thenable', 'once'], 'once');
        const first = await op.then((result) => result);
        ok(first.ok);
        throws(() => op.commit(), /already committed/);
    });
});

Deno.test({ name: 'deno: KV atomic commit notifies watch streams', timeout: 10000 }, async () => {
    await withKv('atomic-watch', async (kv) => {
        const reader = kv.watch<[string][]>([['atomic-watch']] as any).getReader();
        try {
            const initial = await reader.read();
            strictEqual(initial.done, false);
            strictEqual(initial.value?.[0]?.value, null);

            const committed = await kv.atomic().set(['atomic-watch'], 'changed').commit();
            ok(committed.ok);

            const changed = await withTimeout(reader.read());
            strictEqual(changed.done, false);
            strictEqual(changed.value?.[0]?.value, 'changed');
        } finally {
            await reader.cancel();
        }
    });
});

Deno.test({ name: 'deno: KV watch yields initial state and later changes', timeout: 10000 }, async () => {
    await withKv('watch', async (kv) => {
        await kv.set(['watch', 'a'], 'initial');
        const reader = kv.watch<[string, string][]>([['watch', 'a'], ['watch', 'b']] as any).getReader();
        try {
            const initial = await reader.read();
            strictEqual(initial.done, false);
            strictEqual(initial.value?.[0]?.value, 'initial');
            strictEqual(initial.value?.[1]?.value, null);

            await kv.set(['watch', 'b'], 'later');
            const changed = await reader.read();
            strictEqual(changed.done, false);
            strictEqual(changed.value?.[0]?.value, 'initial');
            strictEqual(changed.value?.[1]?.value, 'later');
        } finally {
            await reader.cancel();
        }
    });
});

Deno.test({ name: 'deno: KV queue delivers immediate messages and resolves listener on close', timeout: 10000 }, async () => {
    await withKv('queue-deliver', async (kv) => {
        const delivered = new Promise<unknown>((resolve) => {
            kv.listenQueue((value) => resolve(value));
        });

        await kv.enqueue({ kind: 'message', n: 1 });
        deepStrictEqual(await withTimeout(delivered), { kind: 'message', n: 1 });

        const done = kv.listenQueue(() => {});
        kv.close();
        await withTimeout(done, 1000);
    });
});

Deno.test({ name: 'deno: KV queue stores original value in keysIfUndelivered after retries are exhausted', timeout: 10000 }, async () => {
    await withKv('queue-undelivered', async (kv) => {
        let attempts = 0;
        kv.listenQueue(() => {
            attempts++;
            throw new Error('delivery failed');
        });

        await kv.enqueue({ lost: true }, {
            keysIfUndelivered: [['queue', 'undelivered']],
            backoffSchedule: [],
        });

        const entry = await waitForEntry<{ lost: boolean }>(kv, ['queue', 'undelivered']);
        strictEqual(attempts, 1);
        deepStrictEqual(entry.value, { lost: true });
    });
});

Deno.test({ name: 'deno: KV queue validates delay backoff and undelivered keys', timeout: 10000 }, async () => {
    await withKv('queue-validation', async (kv) => {
        throws(() => kv.enqueue('x', { delay: -1 }), /delay must be a non-negative integer/);
        throws(() => kv.enqueue('x', { delay: 1.5 }), /delay must be a non-negative integer/);
        throws(() => kv.enqueue('x', { backoffSchedule: [-1] }), /backoffSchedule values must be a non-negative integer/);
        throws(() => kv.enqueue('x', { keysIfUndelivered: [[]] }), /Key cannot be empty/);
    });
});

Deno.test({ name: 'deno: KV set with expireIn makes entry expire', timeout: 10000 }, async () => {
    await withKv('expire', async (kv) => {
        await kv.set(['e'], 'ttl', { expireIn: 50 });
        strictEqual((await kv.get(['e'])).value, 'ttl');
        const deadline = Date.now() + 2000;
        let after = await kv.get(['e']);
        while (after.value !== null && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
            after = await kv.get(['e']);
        }
        strictEqual(after.value, null, 'entry must be expired');
    });
});

Deno.test({ name: 'deno: KV operations reject after close', timeout: 10000 }, async () => {
    await withTempPath('kv-closed', async (path) => {
        const kv = await Deno.openKv(path);
        kv.close();

        let err: Error | null = null;
        try {
            await kv.get(['closed']);
        } catch (e) {
            err = e as Error;
        }
        ok(err);
        strictEqual(err!.message, 'KV database is closed');

        await rejects(async () => {
            await kv.listenQueue(() => {});
        }, /Queue already closed/);
    });
});
