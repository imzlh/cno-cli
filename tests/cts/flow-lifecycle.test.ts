import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { runAsync, StepType, type Flow } from '../../cts/src/flow.ts';

function* ticks(count: number): Flow<void> {
    for (let i = 0; i < count; i++) {
        yield { type: StepType.FLOW, flow: ticks(0) };
    }
}

Deno.test('cts flow: batch failure drains started work and leaves queued work unstarted', async () => {
    const events: string[] = [];
    const failure = new Error('first failure');
    function* slow(): Flow<void> {
        events.push('started');
        try {
            yield* ticks(5);
        } finally {
            events.push('released');
        }
    }
    function* failed(): Flow<void> {
        throw failure;
    }
    function* queued(): Flow<void> {
        events.push('queued');
    }
    function* batch(): Flow<void> {
        yield { type: StepType.FLOW_ALL, flows: [slow(), failed(), queued()], concurrency: 2 };
    }

    await rejects(runAsync(batch()), (error) => error === failure);
    deepStrictEqual(events, ['started', 'released']);
});

Deno.test('cts flow: draining sibling failures preserves the first error, including undefined', async () => {
    let released = false;
    function* first(): Flow<void> {
        throw undefined;
    }
    function* second(): Flow<void> {
        try {
            yield* ticks(3);
            throw new Error('later failure');
        } finally {
            released = true;
        }
    }
    function* batch(): Flow<void> {
        yield { type: StepType.FLOW_ALL, flows: [first(), second()], concurrency: 2 };
    }

    await rejects(runAsync(batch()), (error) => error === undefined);
    strictEqual(released, true);
});

Deno.test('cts flow: successful batches honor their concurrency limit and finish the queue', async () => {
    let active = 0;
    let peak = 0;
    const finished: number[] = [];
    function* child(index: number): Flow<void> {
        peak = Math.max(peak, ++active);
        try {
            yield* ticks(2);
            finished.push(index);
        } finally {
            active--;
        }
    }
    function* batch(): Flow<void> {
        yield {
            type: StepType.FLOW_ALL,
            flows: Array.from({ length: 5 }, (_, index) => child(index)),
            concurrency: 2,
        };
    }

    await runAsync(batch());
    strictEqual(peak, 2);
    strictEqual(active, 0);
    deepStrictEqual(finished, [0, 1, 2, 3, 4]);
});
