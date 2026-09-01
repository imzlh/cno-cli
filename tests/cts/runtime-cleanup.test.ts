import { ok, strictEqual } from 'node:assert';
import { createRuntime } from '../../cts/src/api/index.ts';
import { LockStore } from '../../cts/src/lock.ts';
import { withTempDir } from '../_helpers/temp.ts';

/** Read the private registry without expanding LockStore's public API. */
function openStores(): Set<unknown> {
    const stores = Reflect.get(LockStore, 'openStores');
    if (!(stores instanceof Set)) throw new Error('LockStore.openStores is unavailable');
    return stores;
}

Deno.test('cts runtime cleanup closes its owned lock store', async () => {
    await withTempDir('runtime-cleanup', (root) => {
        const runtime = createRuntime({
            cacheDir: `${root}/cache`,
            silent: true,
        });
        const store = runtime.resolver.lockStore;
        const registry = openStores();

        ok(registry.has(store), 'runtime construction must register its lock store');
        runtime.cleanup();
        strictEqual(registry.has(store), false,
            'cleanup must close the SQLite store instead of retaining it until process exit');

        // Cleanup is documented as terminal but idempotent; a second call must
        // not re-open or otherwise disturb the already-closed store.
        runtime.cleanup();
        strictEqual(registry.has(store), false);
    });
});
