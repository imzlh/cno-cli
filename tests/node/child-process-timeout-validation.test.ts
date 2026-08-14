/** Node v24.18 validates child_process timeout before spawning. */
import { strictEqual, throws } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';

const invalidTimeouts: unknown[] = [-1, NaN, 1.5, '5', Infinity, true];

for (const timeout of invalidTimeouts) {
    for (const [name, invoke] of [
        ['spawn', () => spawn(process.execPath, ['eval', 'void 0'], { timeout } as never)],
        ['spawnSync', () => spawnSync(process.execPath, ['eval', 'void 0'], { timeout } as never)],
    ] as const) {
        Deno.test(`child_process: ${name} rejects invalid timeout ${String(timeout)}`, () => {
            throws(invoke, (error: unknown) => {
                if (error === null || typeof error !== 'object') return false;
                strictEqual(Reflect.get(error, 'name'), 'RangeError');
                strictEqual(Reflect.get(error, 'code'), 'ERR_OUT_OF_RANGE');
                return true;
            });
        });
    }
}

Deno.test('child_process: null and zero timeouts remain valid', () => {
    const nullTimeout = spawnSync(process.execPath, ['eval', 'void 0'], { timeout: null } as never);
    const zeroTimeout = spawnSync(process.execPath, ['eval', 'void 0'], { timeout: 0 });
    strictEqual(nullTimeout.status, 0);
    strictEqual(zeroTimeout.status, 0);
});
