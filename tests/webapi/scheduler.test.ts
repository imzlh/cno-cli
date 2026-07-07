import { deepStrictEqual, rejects, strictEqual, ok, throws } from 'node:assert';

// ============================================================================
// Web API — Scheduler (scheduler.postTask)
// ============================================================================

Deno.test('webapi: scheduler.postTask exists', () => {
    ok(typeof scheduler === 'object');
    ok(typeof scheduler.postTask === 'function');
    ok(typeof scheduler.yield === 'function');
});

Deno.test('webapi: scheduler.postTask resolves', async () => {
    const result = await scheduler.postTask(() => 42);
    strictEqual(result, 42);
});

Deno.test('webapi: scheduler.postTask with priority option', async () => {
    const result = await scheduler.postTask(() => 'done', { priority: 'user-blocking' });
    strictEqual(result, 'done');
});

Deno.test('scheduler upstream: postTask runs asynchronously and resolves async callbacks', async () => {
    const order: string[] = [];
    const task = scheduler.postTask(async () => {
        order.push('task');
        await Promise.resolve();
        return 'async-result';
    });
    order.push('sync');

    strictEqual(await task, 'async-result');
    deepStrictEqual(order, ['sync', 'task']);
});

Deno.test('scheduler upstream: postTask propagates thrown and rejected callback errors', async () => {
    await rejects(
        scheduler.postTask(() => {
            throw new Error('sync-fail');
        }),
        /sync-fail/,
    );
    await rejects(
        scheduler.postTask(async () => {
            throw new Error('async-fail');
        }),
        /async-fail/,
    );
});

Deno.test('webapi: scheduler.postTask with delay', async () => {
    const start = Date.now();
    await scheduler.postTask(() => {}, { delay: 50 });
    ok(Date.now() - start >= 40, 'should wait ~50ms');
});

Deno.test('webapi: scheduler.postTask with AbortSignal rejects', async () => {
    const ac = new AbortController();
    ac.abort();
    await rejects(() => scheduler.postTask(() => {}, { signal: ac.signal }), ac.signal.reason);
});

Deno.test('scheduler upstream: delayed postTask aborts before callback runs', async () => {
    const ac = new AbortController();
    let ran = false;
    const task = scheduler.postTask(() => {
        ran = true;
    }, { delay: 50, signal: ac.signal });
    ac.abort('stop-task');

    await rejects(task, 'stop-task');
    await new Promise((resolve) => setTimeout(resolve, 70));
    strictEqual(ran, false);
});

Deno.test('scheduler upstream: postTask validates callback priority and delay', async () => {
    throws(() => scheduler.postTask(undefined as unknown as () => void), TypeError);
    throws(() => scheduler.postTask(() => {}, { priority: 'urgent' as SchedulerPostTaskOptions['priority'] }), TypeError);
    throws(() => scheduler.postTask(() => {}, { delay: -1 }), TypeError);
    throws(() => scheduler.postTask(() => {}, { delay: Infinity }), TypeError);
});

Deno.test('webapi: scheduler.yield resolves', async () => {
    await scheduler.yield();
    ok(true);
});

Deno.test('webapi: scheduler.yield with options', async () => {
    await scheduler.yield({ priority: 'background' });
    ok(true);
});

Deno.test('webapi: TaskController exists and works', () => {
    ok(typeof TaskController === 'function');
    const tc = new TaskController();
    ok(typeof tc.signal === 'object');
    ok(tc.signal.priority === 'user-visible');
    ok(typeof tc.abort === 'function');
});

Deno.test('webapi: TaskController with priority', () => {
    const tc = new TaskController({ priority: 'background' });
    ok(tc.signal.priority === 'background');
});

Deno.test('scheduler upstream: TaskController validates priority and exposes web shape', () => {
    throws(() => new TaskController({ priority: 'urgent' as TaskPriority }), TypeError);
    const tc = new TaskController({ priority: 'user-blocking' });
    strictEqual(Object.prototype.toString.call(tc), '[object TaskController]');
    strictEqual(Object.prototype.toString.call(tc.signal), '[object TaskSignal]');
    strictEqual(tc.signal.priority, 'user-blocking');
});

Deno.test('webapi: TaskSignal readonly priority', () => {
    const tc = new TaskController({ priority: 'user-blocking' });
    ok(tc.signal.priority === 'user-blocking');
});

Deno.test('webapi: TaskController.abort sets aborted', () => {
    const tc = new TaskController();
    tc.abort();
    ok(tc.signal.aborted);
});

Deno.test('scheduler upstream: TaskSignal forwards abort events reason and throwIfAborted', () => {
    const tc = new TaskController();
    const events: Event[] = [];
    tc.signal.addEventListener('abort', (event) => events.push(event));
    tc.abort('task-stop');
    tc.abort('ignored');

    strictEqual(tc.signal.aborted, true);
    strictEqual(tc.signal.reason, 'task-stop');
    strictEqual(events.length, 1);
    throws(() => tc.signal.throwIfAborted(), 'task-stop');
});
