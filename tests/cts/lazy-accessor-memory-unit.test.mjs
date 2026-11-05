// @cno-host: false
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const lazyAccessorUrl = new URL('../../cno/src/utils/lazy-accessor.ts', import.meta.url).href;

test('lazy accessor bookkeeping does not retain completed short-lived targets', () => {
    const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
        import { setImmediate } from 'node:timers/promises';
        import { defineLazy } from ${JSON.stringify(lazyAccessorUrl)};

        async function registerTemporaryTarget() {
            const target = {};
            await defineLazy(target, [{ name: 'value', kind: 'fn' }], async () =>
                new Map([['value', () => 42]]));
            return new WeakRef(target);
        }

        const ref = await registerTemporaryTarget();
        for (let attempt = 0; attempt < 50; attempt++) {
            // A dereferenced target stays alive for the current job. Enter a
            // new job before every collection so the assertion is meaningful.
            await setImmediate();
            gc();
            if (ref.deref() === undefined) process.exit(0);
        }
        throw new Error('lazy bookkeeping retained the completed target');
    `], { encoding: 'utf8', timeout: 10000 });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
});
