import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { getEventListeners } from 'node:events';
import { setInterval } from 'node:timers/promises';

const nativeTimers = import.meta.use('timers');
const engine = import.meta.use('engine');
const os = import.meta.use('os');

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
    let deadline = 0;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                deadline = nativeTimers.setTimeout(() => reject(new Error('interval operation did not settle')), 1000);
            }),
        ]);
    } finally {
        nativeTimers.clearTimeout(deadline);
    }
}

Deno.test('timers/promises: return waits for a pending next and releases its abort listener', async () => {
    const ac = new AbortController();
    const iterator = setInterval(1, 'tick', { signal: ac.signal });
    try {
        const next = iterator.next();
        const returned = iterator.return!();
        const results = await withDeadline(Promise.all([next, returned]));
        deepStrictEqual(results, [
            { done: false, value: 'tick' },
            { done: true, value: undefined },
        ]);
        strictEqual(getEventListeners(ac.signal, 'abort').length, 0);
        deepStrictEqual(await iterator.next(), { done: true, value: undefined });
    } finally {
        ac.abort();
    }
});

Deno.test('timers/promises: throw settles after a pending next and releases its abort listener', async () => {
    const ac = new AbortController();
    const iterator = setInterval(1, 'tick', { signal: ac.signal });
    const reason = new Error('closed by caller');
    try {
        const next = iterator.next();
        const thrown = rejects(iterator.throw!(reason), (error: unknown) => error === reason);
        const [result] = await withDeadline(Promise.all([next, thrown]));
        deepStrictEqual(result, { done: false, value: 'tick' });
        strictEqual(getEventListeners(ac.signal, 'abort').length, 0);
        deepStrictEqual(await iterator.next(), { done: true, value: undefined });
    } finally {
        ac.abort();
    }
});

Deno.test('timers/promises: concurrent next calls drain before return without stranding a timer', async () => {
    const ac = new AbortController();
    const iterator = setInterval(1, 'tick', { signal: ac.signal });
    try {
        const first = iterator.next();
        const second = iterator.next();
        const returned = iterator.return!();
        deepStrictEqual(await withDeadline(Promise.all([first, second, returned])), [
            { done: false, value: 'tick' },
            { done: false, value: 'tick' },
            { done: true, value: undefined },
        ]);
        strictEqual(getEventListeners(ac.signal, 'abort').length, 0);
    } finally {
        ac.abort();
    }
});

Deno.test('timers/promises: abort settles a pending next while return is queued', async () => {
    const ac = new AbortController();
    const iterator = setInterval(60_000, 'tick', { signal: ac.signal });
    const next = rejects(iterator.next(), { name: 'AbortError', code: 'ABORT_ERR' });
    const returned = iterator.return!();
    ac.abort();
    const [, result] = await withDeadline(Promise.all([next, returned]));
    deepStrictEqual(result, { done: true, value: undefined });
    strictEqual(getEventListeners(ac.signal, 'abort').length, 0);
});

Deno.test('timers/promises: closed pending intervals release payloads with a persistent signal', async () => {
    const ac = new AbortController();
    try {
        for (const mode of ['return', 'throw'] as const) {
            engine.gc.run();
            const before = os.memoryUsage()['vm.used'];
            for (let i = 0; i < 128; i++) {
                const iterator = setInterval(1, new Uint8Array(64 * 1024), { signal: ac.signal });
                void iterator.next().catch(() => {});
                if (mode === 'return') await iterator.return!();
                else await iterator.throw!(undefined).catch(() => {});
            }
            engine.gc.run();
            const growth = os.memoryUsage()['vm.used'] - before;
            ok(growth < 2 * 1024 * 1024, `${mode} retained ${growth} bytes`);
            strictEqual(getEventListeners(ac.signal, 'abort').length, 0);
        }
    } finally {
        ac.abort();
    }
});
