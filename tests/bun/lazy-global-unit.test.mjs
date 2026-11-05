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

// The injector owns the lazy `Bun` global outright: it resolves
// `bun:index` through the ambient CJS require (CTS-backed in the embedded
// runtime), swaps the accessor for a sealed data descriptor on success,
// and keeps the accessor retryable when the load fails.
function realm(requireImpl) {
    const context = { require: requireImpl };
    runInNewContext(source, context);
    return context;
}

test('bootstrap dependency graph contains only the injector', () => {
    assert.deepEqual(Object.keys(result.metafile.inputs).sort(), [
        'cno/src/bun/_internal/inject.ts',
    ]);
});

test('global Bun lazily loads bun:index once and seals the descriptor', () => {
    const bun = {};
    const ids = [];
    const context = realm(id => { ids.push(id); return bun; });
    assert.deepEqual(ids, []);
    const lazy = Object.getOwnPropertyDescriptor(context, 'Bun');
    assert.equal(typeof lazy.get, 'function');
    assert.equal(lazy.set, undefined);
    assert.equal(lazy.configurable, true);
    assert.equal(lazy.enumerable, true);
    assert.equal(context.Bun, bun);
    assert.deepEqual(ids, ['bun:index']);
    assert.equal(context.Bun, bun);
    assert.deepEqual(ids, ['bun:index']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(context, 'Bun'), {
        value: bun, writable: false, configurable: false, enumerable: true,
    });
    assert.equal(Reflect.set(context, 'Bun', {}), false);
    assert.equal(Reflect.deleteProperty(context, 'Bun'), false);
});

test('recursive access during initialization surfaces the reentry guard', () => {
    const bun = {};
    let impl = () => context.Bun;
    const context = realm(() => impl());
    assert.throws(() => context.Bun, { code: 'ERR_BUN_GLOBAL_INITIALIZING' });
    // The accessor survives the reentry and the next access retries.
    assert.equal(typeof Object.getOwnPropertyDescriptor(context, 'Bun').get, 'function');
    impl = () => bun;
    assert.equal(context.Bun, bun);
});

test('load failures stay retryable and never cache a partial Bun value', () => {
    const failure = new Error('builtin unavailable');
    let impl = () => { throw failure; };
    const context = realm(id => impl(id));
    assert.throws(() => context.Bun, error => error === failure);
    assert.equal(typeof Object.getOwnPropertyDescriptor(context, 'Bun').get, 'function');
    const bun = {};
    impl = () => bun;
    assert.equal(context.Bun, bun);
    assert.equal(context.Bun, bun);
});

test('each realm resolves bun:index independently through its own require', () => {
    const firstBun = {};
    const secondBun = {};
    const first = realm(() => firstBun);
    const second = realm(() => secondBun);
    assert.equal(first.Bun, firstBun);
    assert.equal(second.Bun, secondBun);
    assert.notEqual(first.Bun, second.Bun);
});

test('the injector takes over an existing configurable Bun and rejects frozen ones', () => {
    const getter = () => { throw new Error('stale getter'); };
    // A configurable preexisting descriptor is replaced by the accessor.
    const takeover = { require: () => ({}) };
    Object.defineProperty(takeover, 'Bun', { get: getter, configurable: true });
    runInNewContext(source, takeover);
    assert.notEqual(Object.getOwnPropertyDescriptor(takeover, 'Bun').get, getter);
    // A non-configurable preexisting descriptor makes the takeover throw at
    // bootstrap instead of silently leaving a half-installed injector.
    const frozen = { require: () => ({}) };
    Object.defineProperty(frozen, 'Bun', { get: getter, configurable: false });
    // The TypeError comes from the vm realm, so match by shape not prototype.
    assert.throws(() => runInNewContext(source, frozen), { name: 'TypeError', message: /Cannot redefine property: Bun/ });
    assert.equal(Object.getOwnPropertyDescriptor(frozen, 'Bun').get, getter);
});
