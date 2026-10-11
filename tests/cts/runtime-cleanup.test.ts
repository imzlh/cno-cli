import { ok, rejects, strictEqual, throws } from 'node:assert';
import { createRuntime } from '../../cts/src/api/index.ts';
import { LockStore } from '../../cts/src/lock.ts';
import { ParseDriver } from '../../cts/src/parse.ts';
import { PrecacheProgress } from '../../cts/src/utils/progress.ts';
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

Deno.test('cts runtime cleanup releases resources when its lock close fails', async () => {
    await withTempDir('runtime-cleanup-failure', (root) => {
        const runtime = createRuntime({ cacheDir: `${root}/cache`, silent: true });
        const close = runtime.resolver.close;
        const failure = new Error('lock close failed');
        let released = 0;
        runtime.resources.register(() => released++);
        runtime.resolver.close = () => { throw failure; };
        try {
            throws(() => runtime.cleanup(), (error) => error === failure);
            strictEqual(released, 1);
            strictEqual(runtime.resources.released, true);
        } finally {
            runtime.resolver.close = close;
            runtime.cleanup();
        }
        strictEqual(released, 1);
    });
});

for (const failureTarget of ['progress', 'worker']) {
    Deno.test(`cts precache releases resources when ${failureTarget} cleanup fails`, async () => {
        await withTempDir('precache-cleanup-failure', async (root) => {
            const runtime = createRuntime({
                cacheDir: `${root}/cache`,
                silent: failureTarget !== 'progress',
                disableLock: true,
                ignoreScripts: true,
            });
            const stop = PrecacheProgress.prototype.stop;
            const terminate = ParseDriver.prototype.terminate;
            const failure = new Error(`${failureTarget} cleanup failed`);
            let released = 0;
            let terminated = 0;
            runtime.resources.register(() => released++);
            PrecacheProgress.prototype.stop = function () {
                stop.call(this);
                if (failureTarget === 'progress') throw failure;
            };
            ParseDriver.prototype.terminate = async function () {
                await terminate.call(this);
                terminated++;
                if (failureTarget === 'worker') throw failure;
            };
            try {
                await rejects(runtime.precacheFromSpecifiers([], root), (error) => error === failure);
                strictEqual(released, 1);
                strictEqual(terminated, 1);
                strictEqual(runtime.resources.released, true);
            } finally {
                PrecacheProgress.prototype.stop = stop;
                ParseDriver.prototype.terminate = terminate;
                runtime.cleanup();
            }
            strictEqual(released, 1);
        });
    });
}
