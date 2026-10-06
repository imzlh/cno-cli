import { deepStrictEqual, strictEqual } from 'node:assert';

const engine = import.meta.use('engine');
const timers = import.meta.use('timers');
const tick = () => new Promise<void>(resolve => timers.setTimeout(resolve, 1));

async function collectGarbage(): Promise<void> {
    for (let i = 0; i < 6; i++) {
        await tick();
        engine.gc.run();
    }
    await tick();
}

Deno.test('FinalizationRegistry: targets used as unregister tokens are collectible', async () => {
    const finalized: number[] = [];
    const registry = new FinalizationRegistry<number>(value => { finalized.push(value); });
    function register(index: number): WeakRef<object> {
        const target = { payload: new Uint8Array(64 * 1024) };
        registry.register(target, index, target);
        return new WeakRef(target);
    }
    const refs = Array.from({ length: 32 }, (_, index) => register(index));
    await collectGarbage();
    strictEqual(refs.filter(ref => ref.deref() !== undefined).length, 0);
    deepStrictEqual(finalized.sort((a, b) => a - b), Array.from({ length: 32 }, (_, index) => index));
    strictEqual(registry.unregister({}), false);
});

Deno.test('FinalizationRegistry: an unregister token can die before its live target', async () => {
    const finalized: string[] = [];
    const registry = new FinalizationRegistry<string>(value => { finalized.push(value); });
    let target: object | undefined = { alive: true };
    function register(): WeakRef<object> {
        const token = { payload: new Uint8Array(64 * 1024) };
        registry.register(target!, 'target', token);
        return new WeakRef(token);
    }
    const token = register();
    await collectGarbage();
    strictEqual(token.deref(), undefined);
    deepStrictEqual(finalized, []);
    strictEqual(registry.unregister({}), false);
    target = undefined;
    await collectGarbage();
    deepStrictEqual(finalized, ['target']);
});

Deno.test('FinalizationRegistry: unregister removes every matching record and releases holdings', async () => {
    const finalized: Uint8Array[] = [];
    const registry = new FinalizationRegistry<Uint8Array>(value => { finalized.push(value); });
    const token = {};
    const targets: object[] = [];
    function register(): WeakRef<Uint8Array> {
        const target = {};
        const held = new Uint8Array(64 * 1024);
        targets.push(target);
        registry.register(target, held, token);
        return new WeakRef(held);
    }
    const refs = Array.from({ length: 16 }, register);
    strictEqual(registry.unregister(token), true);
    strictEqual(registry.unregister(token), false);
    await collectGarbage();
    strictEqual(refs.filter(ref => ref.deref() !== undefined).length, 0);
    targets.length = 0;
    await collectGarbage();
    deepStrictEqual(finalized, []);
});

Deno.test('FinalizationRegistry: unregister detaches records before freeing another target', async () => {
    const finalized: unknown[] = [];
    const registry = new FinalizationRegistry(value => { finalized.push(value); });
    const token = {};
    const first = {};
    let second: object | undefined = { payload: new Uint8Array(64 * 1024) };
    registry.register(first, second, token);
    registry.register(second, 'second', token);
    const ref = new WeakRef(second);
    second = undefined;
    await tick();
    strictEqual(registry.unregister(token), true);
    strictEqual(registry.unregister(token), false);
    await collectGarbage();
    strictEqual(ref.deref(), undefined);
    deepStrictEqual(finalized, []);
    strictEqual(typeof first, 'object');
});

Deno.test('FinalizationRegistry: collecting a registry detaches token and target records', async () => {
    const finalized: string[] = [];
    let target: object | undefined = { payload: new Uint8Array(64 * 1024) };
    function register(): WeakRef<FinalizationRegistry<string>> {
        const registry = new FinalizationRegistry<string>(value => { finalized.push(value); });
        registry.register(target!, 'target', target);
        return new WeakRef(registry);
    }
    const ref = register();
    await collectGarbage();
    strictEqual(ref.deref(), undefined);
    target = undefined;
    await collectGarbage();
    deepStrictEqual(finalized, []);
});

Deno.test('FinalizationRegistry: nonregistered symbol targets and tokens remain weak', async () => {
    const finalized: string[] = [];
    const registry = new FinalizationRegistry<string>(value => { finalized.push(value); });
    function register() {
        const target = Symbol('target and token');
        registry.register(target, 'symbol', target);
        return new WeakRef(target);
    }
    const ref = register();
    await collectGarbage();
    strictEqual(ref.deref(), undefined);
    deepStrictEqual(finalized, ['symbol']);
    strictEqual(registry.unregister(Symbol('unknown')), false);
});

Deno.test('FinalizationRegistry: omitted unregister tokens still allow target cleanup', async () => {
    const finalized: number[] = [];
    const registry = new FinalizationRegistry<number>(value => { finalized.push(value); });
    function register() {
        const target = {};
        registry.register(target, 1);
        return new WeakRef(target);
    }
    const ref = register();
    await collectGarbage();
    strictEqual(ref.deref(), undefined);
    deepStrictEqual(finalized, [1]);
    strictEqual(registry.unregister({}), false);
});

Deno.test('FinalizationRegistry: a cyclic registry detaches records from a live target', async () => {
    let callbacks = 0;
    let target: object | undefined = { payload: new Uint8Array(64 * 1024) };
    function register(): WeakRef<object> {
        const registry = new FinalizationRegistry(() => { callbacks++; });
        Object.assign(registry, { self: registry });
        registry.register(target!, 'held', target);
        return new WeakRef(registry);
    }
    const ref = register();
    await collectGarbage();
    strictEqual(ref.deref(), undefined);
    strictEqual(callbacks, 0);
    target = undefined;
    await collectGarbage();
    strictEqual(callbacks, 0);
});

// quickjs-ng bug1318: sweeping a whole registry cycle must not enqueue a dead callback.
Deno.test('FinalizationRegistry: a registry used as its held value can be collected in a cycle', async () => {
    let callbacks = 0;
    function register(): WeakRef<object>[] {
        const target = { payload: new Uint8Array(64 * 1024) };
        const registry = new FinalizationRegistry(() => { callbacks++; });
        registry.register(target, registry, target);
        Object.assign(registry, { target });
        Object.assign(target, { registry });
        return [new WeakRef(target), new WeakRef(registry)];
    }
    const refs = register();
    await collectGarbage();
    strictEqual(refs.filter(ref => ref.deref() !== undefined).length, 0);
    strictEqual(callbacks, 0);
});

Deno.test('FinalizationRegistry: a callback and target reference cycle is collectible', async () => {
    let callbacks = 0;
    function register(): WeakRef<object>[] {
        const target = { payload: new Uint8Array(64 * 1024) };
        const callback = Object.assign(() => { callbacks++; }, { target });
        const registry = new FinalizationRegistry(callback);
        registry.register(target, 42, target);
        Object.assign(registry, { target });
        Object.assign(target, { registry, callback });
        return [new WeakRef(target), new WeakRef(registry), new WeakRef(callback)];
    }
    const refs = register();
    await collectGarbage();
    strictEqual(refs.filter(ref => ref.deref() !== undefined).length, 0);
    strictEqual(callbacks, 0);
});
