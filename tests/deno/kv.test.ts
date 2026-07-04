import { strictEqual, ok, deepStrictEqual } from 'node:assert';

// Deno KV: SQLite-backed. Tests run in-process against the Deno global.
// Each test opens its own isolated DB via a unique path.

function tmpKvPath(name: string): string {
    return `/tmp/cno-kv-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

Deno.test({ name: 'deno: KV set/get/delete round-trip', timeout: 10000 }, async () => {
    const kv = await Deno.openKv(tmpKvPath('basic'));
    try {
        await kv.set(['a'], 'alpha');
        const entry = await kv.get(['a']);
        strictEqual(entry.value, 'alpha');
        ok(entry.versionstamp, 'entry must carry a versionstamp');

        await kv.delete(['a']);
        const gone = await kv.get(['a']);
        strictEqual(gone.value, null);
        strictEqual(gone.versionstamp, null);
    } finally {
        kv.close();
    }
});

Deno.test({ name: 'deno: KV versionstamp changes on update', timeout: 10000 }, async () => {
    const kv = await Deno.openKv(tmpKvPath('vs'));
    try {
        const r1 = await kv.set(['v'], 'v1');
        const r2 = await kv.set(['v'], 'v2');
        ok(r1.versionstamp !== r2.versionstamp, 'versionstamp must change on update');
        const entry = await kv.get(['v']);
        strictEqual(entry.value, 'v2');
    } finally {
        kv.close();
    }
});

Deno.test({ name: 'deno: KV getMany returns entries in order, null for missing', timeout: 10000 }, async () => {
    const kv = await Deno.openKv(tmpKvPath('many'));
    try {
        await kv.set(['m', 'x'], 1);
        await kv.set(['m', 'y'], 2);
        const [a, b, c] = await kv.getMany([['m', 'x'], ['m', 'y'], ['m', 'z']]);
        strictEqual(a.value, 1);
        strictEqual(b.value, 2);
        strictEqual(c.value, null);
    } finally {
        kv.close();
    }
});

Deno.test({ name: 'deno: KV list filters by prefix and returns keys', timeout: 10000 }, async () => {
    const kv = await Deno.openKv(tmpKvPath('list'));
    try {
        await kv.set(['p', '1'], 'p1');
        await kv.set(['p', '2'], 'p2');
        await kv.set(['q', '1'], 'q1');
        const keys: unknown[] = [];
        for await (const e of kv.list({ prefix: ['p'] })) keys.push(e.key);
        ok(keys.length === 2, `expected 2 entries under prefix p, got ${keys.length}`);
        ok(keys.every((k: any) => Array.isArray(k) && k[0] === 'p'));
    } finally {
        kv.close();
    }
});

Deno.test({ name: 'deno: KV atomic insert with versionstamp:null check only commits once', timeout: 10000 }, async () => {
    const kv = await Deno.openKv(tmpKvPath('atomic'));
    try {
        // first commit: key absent -> check passes -> inserted
        const r1 = await kv.atomic().check({ key: ['atom'], versionstamp: null }).set(['atom'], 'first').commit();
        ok(r1.ok, 'first atomic insert must commit');

        // second commit: key now present -> check fails -> NOT committed
        const r2 = await kv.atomic().check({ key: ['atom'], versionstamp: null }).set(['atom'], 'second').commit();
        ok(!r2.ok, 'second atomic insert with stale check must NOT commit');

        const entry = await kv.get(['atom']);
        strictEqual(entry.value, 'first', 'value must remain the first insert');
    } finally {
        kv.close();
    }
});

Deno.test({ name: 'deno: KV atomic set + delete in one commit', timeout: 10000 }, async () => {
    const kv = await Deno.openKv(tmpKvPath('atomic-op'));
    try {
        await kv.set(['x'], 'old');
        const r = await kv.atomic().set(['x'], 'new').delete(['y']).commit();
        ok(r.ok);
        strictEqual((await kv.get(['x'])).value, 'new');
        strictEqual((await kv.get(['y'])).value, null);
    } finally {
        kv.close();
    }
});

Deno.test({ name: 'deno: KV set with expireIn makes entry expire', timeout: 10000 }, async () => {
    const kv = await Deno.openKv(tmpKvPath('expire'));
    try {
        await kv.set(['e'], 'ttl', { expireIn: 50 });
        strictEqual((await kv.get(['e'])).value, 'ttl');
        // Wait past expiry
        await new Promise((r) => setTimeout(r, 120));
        const after = await kv.get(['e']);
        strictEqual(after.value, null, 'entry must be expired');
    } finally {
        kv.close();
    }
});
