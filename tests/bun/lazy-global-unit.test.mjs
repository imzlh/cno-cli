// Run with: node --test tests/bun/lazy-global-unit.test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const result = await build({
    absWorkingDir: repository,
    entryPoints: ['cno/src/bun/_internal/inject.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2024',
    write: false,
    metafile: true,
    define: { 'import.meta.use': '__test_use__' },
});
const source = result.outputFiles[0].text;

// The injector discovers CTS through the `cts.internal` evbus channel only.
// An explicit `native` owns every lookup; the default publishes `bridge` there.
function realm(bridge, native) {
    const holder = { bridge };
    const use = native ?? (name => {
        if (name === 'evbus') {
            return {
                get: (namespace, key) =>
                    namespace === 'cts.internal' && key === 'bridge' ? holder.bridge : undefined,
                set() { throw new Error('injector must not publish a bridge'); },
            };
        }
        return undefined;
    });
    const context = { __test_use__: use };
    runInNewContext(source, context);
    return context;
}

test('bootstrap dependency graph contains only the injector and CTS bridge accessor', () => {
    assert.deepEqual(Object.keys(result.metafile.inputs).sort(), [
        'cno/src/bun/_internal/inject.ts',
        'cno/src/node/_internal/cts-bridge.ts',
    ]);
});

test('global Bun lazily loads the canonical builtin once and preserves its identity', () => {
    const bun = {};
    const calls = [];
    const context = realm({
        mkRequire(parent) {
            calls.push(parent);
            return id => { calls.push(id); return bun; };
        },
    });
    assert.deepEqual(calls, []);
    const lazy = Object.getOwnPropertyDescriptor(context, 'Bun');
    assert.equal(typeof lazy.get, 'function');
    assert.equal(lazy.set, undefined);
    assert.equal(lazy.configurable, true);
    assert.equal(lazy.enumerable, true);
    assert.equal(Reflect.set(context, 'Bun', {}), false);
    assert.deepEqual(calls, []);
    assert.equal(context.Bun, bun);
    assert.equal(context.Bun, bun);
    assert.deepEqual(calls, ['<bun-global>', 'bun']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(context, 'Bun'), {
        value: bun, writable: false, configurable: false, enumerable: true,
    });
    assert.equal(Reflect.set(context, 'Bun', {}), false);
    assert.equal(Reflect.deleteProperty(context, 'Bun'), false);
    runInNewContext(source, context);
    assert.equal(context.Bun, bun);
    assert.equal(calls.length, 2);
});

test('access before ModuleCompiler is ready fails synchronously and remains retryable', () => {
    const holder = { bridge: undefined };
    const context = {
        __test_use__: name => {
            if (name === 'evbus') {
                return {
                    get: (namespace, key) =>
                        namespace === 'cts.internal' && key === 'bridge' ? holder.bridge : undefined,
                    set() { throw new Error('injector must not publish a bridge'); },
                };
            }
            return () => undefined;
        },
    };
    runInNewContext(source, context);
    assert.throws(() => context.Bun, { code: 'ERR_CTS_BRIDGE_UNAVAILABLE' });
    holder.bridge = {};
    assert.throws(() => context.Bun, { code: 'ERR_CTS_BRIDGE_UNAVAILABLE' });
    const bun = {};
    holder.bridge.mkRequire = () => id => {
        assert.equal(id, 'bun');
        return bun;
    };
    assert.equal(context.Bun, bun);
});

test('load failures and recursive global access never cache a partial Bun value', () => {
    const failure = new Error('builtin unavailable');
    const bridge = { mkRequire: () => () => { throw failure; } };
    const context = realm(bridge);
    assert.throws(() => context.Bun, error => error === failure);
    assert.equal(typeof Object.getOwnPropertyDescriptor(context, 'Bun').get, 'function');
    bridge.mkRequire = () => () => context.Bun;
    assert.throws(() => context.Bun, { code: 'ERR_BUN_GLOBAL_INITIALIZING' });
    const bun = {};
    bridge.mkRequire = () => () => bun;
    assert.equal(context.Bun, bun);
});

test('the registry bridge is looked up at access time independently in each realm', () => {
    function workerRealm() {
        let bridge;
        const context = realm(undefined, name => {
            assert.equal(name, 'evbus');
            return {
                get(namespace, key) {
                    assert.equal(namespace, 'cts.internal');
                    assert.equal(key, 'bridge');
                    return bridge;
                },
                set() { throw new Error('injector must not publish a bridge'); },
            };
        });
        const bun = {};
        bridge = { mkRequire: () => () => bun };
        return { context, bun };
    }
    const first = workerRealm();
    const second = workerRealm();
    assert.equal(first.context.Bun, first.bun);
    assert.equal(second.context.Bun, second.bun);
    assert.notEqual(first.context.Bun, second.context.Bun);
});

test('existing own Bun descriptors are preserved without invoking their getters', () => {
    const getter = () => { throw new Error('must not inspect a preexisting Bun'); };
    const context = { __test_use__: () => undefined };
    Object.defineProperty(context, 'Bun', { get: getter, configurable: false });
    runInNewContext(source, context);
    assert.equal(Object.getOwnPropertyDescriptor(context, 'Bun').get, getter);
    assert.equal(Object.getOwnPropertyDescriptor(context, 'Bun').configurable, false);
});
