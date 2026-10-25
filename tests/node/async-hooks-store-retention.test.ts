import { deepStrictEqual, strictEqual } from 'node:assert';
import { AsyncLocalStorage, AsyncResource, createHook } from 'node:async_hooks';

Deno.test('async_hooks: the final hook can be disabled and enabled again', () => {
    const first = createHook({});
    const second = createHook({});
    first.enable();
    second.enable();
    first.disable();
    second.disable();
    first.enable().disable();
});

Deno.test('async_hooks: replacing stores preserves captured contexts', async () => {
    const first = new AsyncLocalStorage<string>();
    const second = new AsyncLocalStorage<string>();
    let earlier: AsyncResource;
    let later: AsyncResource;
    first.run('outer', () => {
        second.run('other', () => {
            earlier = new AsyncResource('store-before-replacement');
            first.enterWith('replacement');
            later = new AsyncResource('store-after-replacement');
            deepStrictEqual([first.getStore(), second.getStore()], ['replacement', 'other']);
            first.exit(() => deepStrictEqual([first.getStore(), second.getStore()], [undefined, 'other']));
            strictEqual(first.getStore(), 'replacement');
        });
    });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    try {
        deepStrictEqual(earlier!.runInAsyncScope(() => [first.getStore(), second.getStore()]), ['outer', 'other']);
        deepStrictEqual(later!.runInAsyncScope(() => [first.getStore(), second.getStore()]), ['replacement', 'other']);
        strictEqual(first.getStore(), undefined);
        strictEqual(second.getStore(), undefined);
    } finally {
        earlier!.emitDestroy();
        later!.emitDestroy();
        first.disable();
        second.disable();
    }
});

const collect = typeof import.meta.use === 'function'
    ? () => import.meta.use('engine').gc.run()
    : (globalThis as typeof globalThis & { gc?: () => void }).gc;

Deno.test({
    name: 'async_hooks: overwritten and disabled stores can be collected',
    ignore: collect === undefined,
    fn: async () => {
        const storage = new AsyncLocalStorage<object>();
        const refs: WeakRef<object>[] = [];
        function replace(): void {
            for (let i = 0; i < 100; i++) {
                const value = { bytes: new Uint8Array(1024) };
                refs.push(new WeakRef(value));
                storage.enterWith(value);
            }
            storage.disable();
        }
        replace();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        collect!();
        strictEqual(refs.filter(ref => ref.deref() !== undefined).length, 0);
        strictEqual(storage.getStore(), undefined);
    },
});
