import { strictEqual } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '../../cts/src/api/index.ts';
import { withTempDir } from '../_helpers/temp.ts';

const PROBE = '__cts_polyfill_require_cycle_code__';

Deno.test('cts polyfill: ESM-CJS self-cycle throws instead of re-evaluating the active module', async () => {
    await withTempDir('polyfill-cycle', async (root) => {
        const polyfill = join(root, 'polyfill.mjs');
        writeFileSync(polyfill, `import './bridge.cjs';\nexport const loaded = true;\n`);
        writeFileSync(join(root, 'bridge.cjs'), `
            try {
                require('./polyfill.mjs');
                globalThis[${JSON.stringify(PROBE)}] = 'namespace-leaked';
            } catch (error) {
                globalThis[${JSON.stringify(PROBE)}] = error && error.code;
            }
            module.exports = {};
        `);

        const runtime = createRuntime({
            cacheDir: join(root, 'cache'),
            disableLock: true,
            enableCache: false,
            enableNode: false,
            silent: true,
        }, root);
        try {
            await runtime.loadPolyfill(polyfill);
            strictEqual(Reflect.get(globalThis, PROBE), 'ERR_REQUIRE_CYCLE_MODULE');
        } finally {
            Reflect.deleteProperty(globalThis, PROBE);
            runtime.cleanup();
        }
    });
});
