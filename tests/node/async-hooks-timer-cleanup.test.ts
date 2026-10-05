import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import * as timers from 'node:timers';

const engine = import.meta.use('engine');
const nativeTimers = import.meta.use('timers');
const os = import.meta.use('os');

type GlobalTimer = ReturnType<typeof setTimeout> & {
    close(): unknown;
    refresh(): unknown;
    [Symbol.dispose](): void;
};

Deno.test('async_hooks: every timer cancellation path destroys its resource once', () => {
    const initialized: number[] = [];
    const destroyed: number[] = [];
    const hook = createHook({
        init(id, type) { if (type === 'Timeout' || type === 'Interval' || type === 'Immediate') initialized.push(id); },
        destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
    }).enable();
    try {
        const byId = setTimeout(() => {}, 60_000);
        clearTimeout(Number(byId));
        const byModule = setTimeout(() => {}, 60_000);
        timers.clearTimeout(byModule as unknown as NodeJS.Timeout);
        const byClose = setTimeout(() => {}, 60_000) as GlobalTimer;
        byClose.close();
        byClose.close();
        const byDispose = setTimeout(() => {}, 60_000) as GlobalTimer;
        byDispose[Symbol.dispose]();
        const interval = setInterval(() => {}, 60_000);
        timers.clearInterval(interval as unknown as NodeJS.Timeout);
        const immediate = setImmediate(() => {});
        timers.clearImmediate(immediate as unknown as NodeJS.Immediate);
        strictEqual(initialized.length, 6);
        deepStrictEqual(destroyed, initialized);
    } finally {
        hook.disable();
    }
});

Deno.test('async_hooks: canceled timers release request stores after GC', () => {
    const als = new AsyncLocalStorage<Uint8Array>();
    const hook = createHook({}).enable();
    try {
        engine.gc.run();
        const before = os.memoryUsage()['vm.used'];
        for (let i = 0; i < 128; i++) {
            als.run(new Uint8Array(64 * 1024), () => {
                const handle = setTimeout(() => {}, 60_000) as GlobalTimer;
                if (i % 2 === 0) handle.close();
                else timers.clearTimeout(handle as unknown as NodeJS.Timeout);
            });
        }
        engine.gc.run();
        const growth = os.memoryUsage()['vm.used'] - before;
        ok(growth < 2 * 1024 * 1024, `canceled timer stores retained ${growth} bytes`);
    } finally {
        hook.disable();
        als.disable();
    }
});

Deno.test('async_hooks: refresh preserves tracking until the last timer callback', async () => {
    const initialized: number[] = [];
    const destroyed: number[] = [];
    const hook = createHook({
        init(id, type) { if (type === 'Timeout') initialized.push(id); },
        destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
    }).enable();
    let count = 0;
    let handle: GlobalTimer | undefined;
    let deadline: number | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            deadline = nativeTimers.setTimeout(() => reject(new Error('refreshed timer did not fire')), 1000);
            handle = setTimeout(() => {
                if (++count === 1) handle!.refresh();
                else resolve();
            }, 1) as GlobalTimer;
            handle.refresh();
            strictEqual(destroyed.length, 0, 'refresh is not cancellation');
        });
        strictEqual(count, 2);
        deepStrictEqual(destroyed, initialized);
    } finally {
        if (deadline !== undefined) nativeTimers.clearTimeout(deadline);
        handle?.close();
        hook.disable();
    }
});

Deno.test('async_hooks: refreshing an already fired timer creates a new lifetime', async () => {
    const initialized: number[] = [];
    const destroyed: number[] = [];
    const hook = createHook({
        init(id, type) { if (type === 'Timeout') initialized.push(id); },
        destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
    }).enable();
    let handle: GlobalTimer | undefined;
    let deadline: number | undefined;
    try {
        let complete: () => void;
        const first = new Promise<void>(resolve => { complete = resolve; });
        handle = setTimeout(() => complete(), 1) as GlobalTimer;
        await first;
        deepStrictEqual(destroyed, initialized);
        strictEqual(initialized.length, 1);
        await new Promise<void>((resolve, reject) => {
            deadline = nativeTimers.setTimeout(() => reject(new Error('refreshed timer did not fire')), 1000);
            complete = resolve;
            handle!.refresh();
            strictEqual(initialized.length, 2);
            strictEqual(destroyed.length, 1);
        });
        deepStrictEqual(destroyed, initialized);
        ok(initialized[0] !== initialized[1], 'a timer rearmed after destruction gets a new async id');
    } finally {
        if (deadline !== undefined) nativeTimers.clearTimeout(deadline);
        handle?.close();
        hook.disable();
    }
});

Deno.test('async_hooks: a refreshed interval releases its current native id on cancellation', async () => {
    const initialized: number[] = [];
    const destroyed: number[] = [];
    const hook = createHook({
        init(id, type) { if (type === 'Interval') initialized.push(id); },
        destroy(id) { if (initialized.includes(id)) destroyed.push(id); },
    }).enable();
    let handle: GlobalTimer | undefined;
    let deadline: number | undefined;
    let count = 0;
    try {
        await new Promise<void>((resolve, reject) => {
            deadline = nativeTimers.setTimeout(() => reject(new Error('refreshed interval did not fire')), 1000);
            handle = setInterval(() => {
                if (++count === 1) handle!.refresh();
                else {
                    timers.clearInterval(Number(handle));
                    resolve();
                }
            }, 1) as GlobalTimer;
            handle.refresh();
            strictEqual(destroyed.length, 0);
        });
        strictEqual(count, 2);
        strictEqual(initialized.length, 1);
        deepStrictEqual(destroyed, initialized);
    } finally {
        if (deadline !== undefined) nativeTimers.clearTimeout(deadline);
        handle?.close();
        hook.disable();
    }
});
