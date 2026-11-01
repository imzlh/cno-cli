import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { sleepSync } from '../../cno/src/bun/sleep-sync.ts';

Deno.test('bun: sleepSync validates and truncates its argument', () => {
    for (const value of [undefined, null, true, '1', 1n, Symbol(), {}, new Number(1), new Date(), new Date(NaN)]) {
        throws(() => sleepSync(value as number), {
            name: 'TypeError',
            message: "Expected milliseconds to be a number for 'sleepSync'.",
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
        });
    }
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
