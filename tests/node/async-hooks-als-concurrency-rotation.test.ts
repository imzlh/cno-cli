import { deepStrictEqual, strictEqual } from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as http from 'node:http';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Known gaps run in tests/ci/async-context.test.mjs against Node and an explicit rebuilt cno.

Deno.test({
    name: '[known gap: async-context] concurrent runs do not rotate stores',
    ignore: true,
    fn: async () => {
        const als = new AsyncLocalStorage<{ id: string }>();

        const task = (id: string, delay: number) =>
            als.run({ id }, async () => {
                const before = als.getStore()?.id;
                await sleep(delay); // another task runs here
                const after = als.getStore()?.id;
                return { id, before, after };
            });

        // Interleaved so A is still suspended while B and C start and finish.
        const results = await Promise.all([task('A', 40), task('B', 10), task('C', 25)]);

        for (const r of results) {
            strictEqual(r.before, r.id, `async-context: task ${r.id} before awaiting`);
            strictEqual(r.after, r.id, `async-context: task ${r.id} after awaiting, saw ${r.after}`);
        }
    },
});

Deno.test({
    name: '[known gap: async-context] concurrent HTTP requests attribute to the right store',
    ignore: true,
    fn: async () => {
        const als = new AsyncLocalStorage<{ reqId: string }>();
        const observed: Record<string, string | undefined> = {};

        const server = http.createServer((req, res) => {
            const reqId = String(req.headers['x-req-id']);
            als.run({ reqId }, async () => {
                // Stagger so the three handlers interleave across their awaits.
                await sleep(reqId === 'R1' ? 30 : reqId === 'R2' ? 10 : 20);
                // Where a logger or tracer would read the request context:
                observed[reqId] = als.getStore()?.reqId;
                res.end('ok');
            });
        });

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', reject);
                resolve();
            });
        });
        const { port } = server.address() as { port: number };

        try {
            await Promise.all(['R1', 'R2', 'R3'].map((id) =>
                new Promise<void>((resolve, reject) => {
                    const req = http.request(
                        { host: '127.0.0.1', port, path: '/', headers: { 'x-req-id': id } },
                        (res) => {
                            res.on('error', reject);
                            res.on('data', () => {});
                            res.on('end', () => resolve());
                        },
                    );
                    req.on('error', reject);
                    req.end();
                })
            ));

            for (const id of ['R1', 'R2', 'R3']) {
                strictEqual(observed[id], id, `async-context: request ${id} logged store ${observed[id]}`);
            }
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    },
});

Deno.test({
    name: '[known gap: async-context] many concurrent runs all keep their own store',
    ignore: true,
    fn: async () => {
        // Scale past three: with N tasks and pseudo-random delays, a rotating global
        // slot misattributes most of them. Asserts a relationship (every task sees
        // itself), never an exact interleaving, which is inherently variable.
        const als = new AsyncLocalStorage<{ id: number }>();
        const N = 12;
        const results = await Promise.all(
            Array.from({ length: N }, (_, i) =>
                als.run({ id: i }, async () => {
                    await sleep((i * 7) % 23 + 1);
                    await sleep((i * 5) % 11 + 1); // a second hop
                    return { id: i, seen: als.getStore()?.id };
                })
            ),
        );
        const wrong = results.filter((r) => r.seen !== r.id);
        strictEqual(
            wrong.length,
            0,
            `async-context: ${wrong.length} of ${N} tasks saw another task's store: ` +
                wrong.map((r) => `${r.id}->${r.seen}`).join(', '),
        );
    },
});

Deno.test('ALS: sequential native callbacks preserve each registration store', async () => {
    const als = new AsyncLocalStorage<{ id: string }>();
    const seen: Array<string | undefined> = [];
    for (const id of ['A', 'B']) {
        await new Promise<void>((resolve) => {
            als.run({ id }, () => setTimeout(() => {
                seen.push(als.getStore()?.id);
                resolve();
            }, 1));
        });
    }
    strictEqual(als.getStore(), undefined);
    deepStrictEqual(seen, ['A', 'B']);
});

Deno.test('ALS: nested native callbacks retain inner and outer stores', async () => {
    const als = new AsyncLocalStorage<{ id: string }>();
    const observed = als.run({ id: 'OUT' }, () => {
        const inner = new Promise<string | undefined>((resolve) => {
            als.run({ id: 'IN' }, () => setTimeout(() => resolve(als.getStore()?.id), 1));
        });
        const outer = new Promise<string | undefined>((resolve) => {
            setTimeout(() => resolve(als.getStore()?.id), 1);
        });
        return Promise.all([inner, outer]);
    });
    deepStrictEqual(await observed, ['IN', 'OUT']);
    strictEqual(als.getStore(), undefined);
});

Deno.test({
    name: '[known gap: async-context] sequential awaits preserve the active store',
    ignore: true,
}, async () => {
    const als = new AsyncLocalStorage<{ id: string }>();
    await als.run({ id: 'S' }, async () => {
        await null;
        strictEqual(als.getStore()?.id, 'S', 'async-context: after await null');
        await sleep(1);
        strictEqual(als.getStore()?.id, 'S', 'async-context: after await a timer');
        await Promise.resolve();
        strictEqual(als.getStore()?.id, 'S', 'async-context: after await Promise.resolve');
    });
    strictEqual(als.getStore(), undefined, 'async-context: completed run does not leak its store');
});

Deno.test({
    name: '[known gap: async-context] nested runs across awaits restore the outer store',
    ignore: true,
}, async () => {
    const als = new AsyncLocalStorage<{ id: string }>();
    const result = await als.run({ id: 'OUT' }, async () => {
        await sleep(1);
        const inner = await als.run({ id: 'IN' }, async () => {
            await sleep(1);
            return als.getStore()?.id;
        });
        return { inner, outer: als.getStore()?.id };
    });
    strictEqual(result.inner, 'IN', 'async-context: inner run retains its store');
    strictEqual(result.outer, 'OUT', 'async-context: outer run is restored');
});
