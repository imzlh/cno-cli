import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { sleepSync } from '../../cno/src/bun/sleep-sync.ts';

Deno.test('bun: sleepSync validates and truncates its argument', () => {
    throws(() => Reflect.apply(sleepSync, undefined, []), {
        name: 'TypeError',
        message: 'milliseconds must be a number',
        code: 'ERR_INVALID_ARG_TYPE',
    });
    for (const value of [undefined, null, true, '1', 1n, Symbol(), {}, new Number(1), new Date(), new Date(NaN)]) {
        throws(() => sleepSync(value as number), {
            name: 'TypeError',
            message: 'milliseconds must be a number',
            code: 'ERR_INVALID_ARG_TYPE',
        });
    }
    let coerced = false;
    throws(() => sleepSync({ valueOf() { coerced = true; return 0; } } as unknown as number), TypeError);
    strictEqual(coerced, false);
    for (const value of [0, -0, NaN, -0.9, 0.9]) strictEqual(sleepSync(value), undefined);
    for (const [value, result] of [[-1, -1], [-1.9, -1], [-Infinity, -2147483648]]) {
        throws(() => sleepSync(value), {
            name: 'TypeError',
            message: `argument to sleepSync must not be negative, got ${result}`,
            code: 'ERR_INVALID_ARG_TYPE',
        });
    }
});

Deno.test('bun: sleepSync exposes Bun function metadata', () => {
    strictEqual(sleepSync.name, 'sleepSync');
    strictEqual(sleepSync.length, 1);
    strictEqual(Object.hasOwn(sleepSync, 'prototype'), false);
    deepStrictEqual(Object.getOwnPropertyDescriptor(sleepSync, 'name'), {
        value: 'sleepSync', writable: false, enumerable: false, configurable: true,
    });
    deepStrictEqual(Object.getOwnPropertyDescriptor(sleepSync, 'length'), {
        value: 1, writable: false, enumerable: false, configurable: true,
    });
    throws(() => Reflect.construct(sleepSync, [0]), TypeError);
});

Deno.test('bun: sleepSync blocks the thread without running jobs', async () => {
    const events: string[] = [];
    const timer = new Promise<void>((resolve) => setTimeout(() => { events.push('timer'); resolve(); }, 0));
    const job = Promise.resolve().then(() => { events.push('job'); });
    const start = Date.now();
    strictEqual(sleepSync(30), undefined);
    const elapsed = Date.now() - start;
    deepStrictEqual(events, []);
    strictEqual(elapsed >= 25, true, `slept for only ${elapsed}ms`);
    await job;
    await timer;
    deepStrictEqual(events, ['job', 'timer']);
});
