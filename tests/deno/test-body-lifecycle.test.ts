import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { runTestBody } from '../../cno/src/deno/utils/tests.ts';

Deno.test('test body lifecycle: runs once from an event loop turn', async context => {
    const events: string[] = [];
    const completed = runTestBody({
        name: 'scheduled',
        timeout: 60_000,
        fn() { events.push('body'); },
    }, context);
    events.push('scheduled');
    await Promise.resolve();
    deepStrictEqual(events, ['scheduled']);
    await completed;
    deepStrictEqual(events, ['scheduled', 'body']);
});

Deno.test('test body lifecycle: preserves synchronous and asynchronous failures', async context => {
    const error = new Error('body failed');
    for (const fn of [() => { throw error; }, () => Promise.reject(error)]) {
        await rejects(runTestBody({ name: 'failure', timeout: 60_000, fn }, context), value => {
            strictEqual(value, error);
            return true;
        });
    }
});

Deno.test('test body lifecycle: a timeout releases the attempt and permits another', async context => {
    await rejects(runTestBody({
        name: 'timeout',
        timeout: 10,
        fn: () => new Promise<void>(() => {}),
    }, context), /Test timed out after 10ms/);
    let attempts = 0;
    await runTestBody({ name: 'next attempt', fn() { attempts++; } }, context);
    strictEqual(attempts, 1);
});
