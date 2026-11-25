import { deepStrictEqual, strictEqual } from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Known gaps run in tests/ci/async-context.test.mjs against Node and an explicit rebuilt cno.
Deno.test({
    name: '[known gap: async-context] concurrent AsyncLocalStorage runs keep separate stores',
    ignore: true,
    fn: async () => {
        const als = new AsyncLocalStorage<{ id: string }>();

        const task = (id: string, delay: number) =>
            als.run({ id }, async () => {
                const seen: (string | undefined)[] = [];
                for (let i = 0; i < 2; i++) {
                    await sleep(delay);
                    seen.push(als.getStore()?.id);
                }
                return seen;
            });

        // Interleaved delays force B to resume between A's two awaits.
        const [a, b] = await Promise.all([task('A', 6), task('B', 2)]);
        strictEqual(a.join(','), 'A,A', 'async-context: task A must only ever see its own store');
        strictEqual(b.join(','), 'B,B', 'async-context: task B must only ever see its own store');
    },
});

Deno.test({
    name: '[known gap: async-context] concurrent async runs do not leak a store to the top level',
    ignore: true,
    fn: async () => {
        const als = new AsyncLocalStorage<{ id: string }>();
        const task = (id: string, delays: number[]) =>
            als.run({ id }, async () => {
                for (const d of delays) await sleep(d);
            });
        await Promise.all([
            task('T1', [5, 5, 5]),
            task('T2', [1, 12, 1]),
            task('T3', [3, 3, 20]),
        ]);
        strictEqual(als.getStore(), undefined, 'async-context: no store may outlive its run()');
        await sleep(50);
        strictEqual(als.getStore(), undefined, 'async-context: store must not come back later');
    },
});

Deno.test('async_hooks: sequential native callbacks retain each run store', async () => {
    const als = new AsyncLocalStorage<{ id: string }>();

    const seen: Array<string | undefined> = [];
    for (const id of ['A', 'B', 'C']) {
        await new Promise<void>((resolve) => {
            als.run({ id }, () => setTimeout(() => {
                seen.push(als.getStore()?.id);
                resolve();
            }, 1));
        });
    }
    strictEqual(als.getStore(), undefined);
    deepStrictEqual(seen, ['A', 'B', 'C']);
});

Deno.test('async_hooks: nested run shadows then restores, and exit clears', () => {
    const als = new AsyncLocalStorage<{ id: string }>();
    als.run({ id: 'outer' }, () => {
        als.run({ id: 'inner' }, () => {
            strictEqual(als.getStore()?.id, 'inner');
        });
        strictEqual(als.getStore()?.id, 'outer', 'outer store restored after inner run');
        als.exit(() => {
            strictEqual(als.getStore(), undefined, 'exit clears the store');
        });
        strictEqual(als.getStore()?.id, 'outer', 'store restored after exit');
    });
    strictEqual(als.getStore(), undefined, 'sync run does not leak');
});

Deno.test('async_hooks: a throw inside run restores the previous store', () => {
    const als = new AsyncLocalStorage<{ id: string }>();
    let caught = '';
    als.run({ id: 'keep' }, () => {
        try {
            als.run({ id: 'doomed' }, () => {
                throw new Error('boom');
            });
        } catch (error) {
            caught = (error as Error).message;
        }
        strictEqual(als.getStore()?.id, 'keep', 'store restored after an inner throw');
    });
    strictEqual(caught, 'boom');
    strictEqual(als.getStore(), undefined);
});

Deno.test({
    name: '[known gap: async-context] two AsyncLocalStorage instances do not observe each other',
    ignore: true,
}, async () => {
    const a = new AsyncLocalStorage<{ id: string }>();
    const b = new AsyncLocalStorage<{ id: string }>();
    await a.run({ id: 'A' }, async () => {
        await b.run({ id: 'B' }, async () => {
            await sleep(1);
            strictEqual(a.getStore()?.id, 'A', 'async-context: outer instance visible inside inner run');
            strictEqual(b.getStore()?.id, 'B', 'async-context: inner instance visible');
        });
        strictEqual(b.getStore(), undefined, 'async-context: inner instance cleared after its run');
        strictEqual(a.getStore()?.id, 'A', 'async-context: outer instance still set');
    });
});
