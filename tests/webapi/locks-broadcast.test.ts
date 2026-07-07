import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { writeFileSync, unlinkSync } from 'node:fs';

function writeBroadcastWorker(source: string): string {
    const file = Deno.makeTempFileSync({ prefix: 'cno-broadcast-worker-', suffix: '.ts' });
    writeFileSync(file, source);
    return file;
}

Deno.test('BroadcastChannel: delivers to same-name peers but not the sender', async () => {
    const a = new BroadcastChannel('cno-test-broadcast');
    const b = new BroadcastChannel('cno-test-broadcast');
    const other = new BroadcastChannel('cno-test-broadcast-other');
    try {
        let senderCount = 0;
        let otherCount = 0;
        a.onmessage = () => { senderCount++; };
        other.onmessage = () => { otherCount++; };

        const got = new Promise<any>((resolve) => {
            b.onmessage = (event) => resolve(event.data);
        });
        const payload = { nested: { value: 1 } };
        a.postMessage(payload);
        payload.nested.value = 2;

        const data = await got;
        strictEqual(data.nested.value, 1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        strictEqual(senderCount, 0);
        strictEqual(otherCount, 0);
    } finally {
        a.close();
        b.close();
        other.close();
    }
});

Deno.test('BroadcastChannel: close prevents delivery and postMessage throws after close', async () => {
    const a = new BroadcastChannel('cno-test-broadcast-close');
    const b = new BroadcastChannel('cno-test-broadcast-close');
    try {
        let count = 0;
        b.onmessage = () => { count++; };
        b.close();
        a.postMessage('ignored');
        await new Promise((resolve) => setTimeout(resolve, 5));
        strictEqual(count, 0);

        a.close();
        let err: any;
        try { a.postMessage('after-close'); } catch (e) { err = e; }
        strictEqual(err?.name, 'InvalidStateError');
    } finally {
        a.close();
        b.close();
    }
});

Deno.test('BroadcastChannel: ref and unref are chainable without closing', async () => {
    const a = new BroadcastChannel('cno-test-broadcast-ref');
    const b = new BroadcastChannel('cno-test-broadcast-ref');
    try {
        strictEqual(a.unref(), a);
        strictEqual(a.ref(), a);
        const got = new Promise<string>((resolve) => {
            b.onmessage = (event) => resolve(event.data);
        });
        a.postMessage('still-open');
        strictEqual(await got, 'still-open');
    } finally {
        a.close();
        b.close();
    }
});

Deno.test({ name: 'BroadcastChannel upstream: messages cross worker boundary', timeout: 10000 }, async () => {
    const name = `cno-test-broadcast-worker-${Deno.pid}-${Date.now()}`;
    const file = writeBroadcastWorker(`
        const channel = new BroadcastChannel(${JSON.stringify(name)});
        channel.onmessage = (event) => {
            if (event.data === 'stop') {
                channel.close();
                self.postMessage('done');
                self.close();
                return;
            }
            channel.postMessage(event.data + 1);
        };
        self.postMessage('ready');
    `);
    const channel = new BroadcastChannel(name);
    const worker = new Worker(file, { type: 'module', name: 'broadcast-worker' });
    try {
        await new Promise<void>((resolve, reject) => {
            worker.onerror = reject;
            worker.onmessage = (event) => {
                if (event.data === 'ready') resolve();
            };
        });

        const seen: number[] = [];
        const done = new Promise<void>((resolve) => {
            channel.onmessage = (event) => {
                seen.push(event.data);
                if (event.data < 6) channel.postMessage(event.data + 1);
                else {
                    channel.postMessage('stop');
                    resolve();
                }
            };
        });
        channel.postMessage(1);
        await done;

        const workerDone = new Promise<void>((resolve, reject) => {
            worker.onerror = reject;
            worker.onmessage = (event) => {
                if (event.data === 'done') resolve();
            };
        });
        await workerDone;
        deepStrictEqual(seen, [2, 4, 6]);
    } finally {
        worker.terminate();
        channel.close();
        unlinkSync(file);
    }
});

Deno.test('BroadcastChannel upstream: immediate close after post is allowed', () => {
    const channel = new BroadcastChannel(`cno-test-broadcast-close-after-post-${Deno.pid}-${Date.now()}`);
    channel.postMessage('notification');
    channel.close();
});

Deno.test('navigator.locks: exclusive requests run one at a time in order', async () => {
    const order: string[] = [];
    const first = navigator.locks.request('cno-test-lock-exclusive', async (lock) => {
        strictEqual(lock.name, 'cno-test-lock-exclusive');
        strictEqual(lock.mode, 'exclusive');
        order.push('first-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('first-end');
        return 'one';
    });
    const second = navigator.locks.request('cno-test-lock-exclusive', (lock) => {
        strictEqual(lock.mode, 'exclusive');
        order.push('second');
        return 'two';
    });

    strictEqual(await first, 'one');
    strictEqual(await second, 'two');
    deepStrictEqual(order, ['first-start', 'first-end', 'second']);
});

Deno.test('navigator.locks: shared requests can run concurrently', async () => {
    const seen: string[] = [];
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = navigator.locks.request('cno-test-lock-shared', { mode: 'shared' }, async (lock) => {
        strictEqual(lock.mode, 'shared');
        seen.push('first-start');
        await firstRelease;
        seen.push('first-end');
    });
    const second = navigator.locks.request('cno-test-lock-shared', { mode: 'shared' }, (lock) => {
        strictEqual(lock.mode, 'shared');
        seen.push('second');
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    deepStrictEqual(seen, ['first-start', 'second']);
    releaseFirst();
    await first;
    await second;
    deepStrictEqual(seen, ['first-start', 'second', 'first-end']);
});

Deno.test('navigator.locks: query reports held and pending locks', async () => {
    let releaseHeld!: () => void;
    const heldRelease = new Promise<void>((resolve) => { releaseHeld = resolve; });
    const held = navigator.locks.request('cno-test-lock-query', async () => {
        await heldRelease;
    });
    const pending = navigator.locks.request('cno-test-lock-query', () => 'pending');

    await new Promise((resolve) => setTimeout(resolve, 5));
    const state = await navigator.locks.query();
    ok(state.held.some((entry) => entry.name === 'cno-test-lock-query' && entry.mode === 'exclusive'));
    ok(state.pending.some((entry) => entry.name === 'cno-test-lock-query' && entry.mode === 'exclusive'));

    releaseHeld();
    await held;
    strictEqual(await pending, 'pending');
});

Deno.test('navigator.locks: aborting a pending request rejects it', async () => {
    let releaseHeld!: () => void;
    const heldRelease = new Promise<void>((resolve) => { releaseHeld = resolve; });
    const held = navigator.locks.request('cno-test-lock-abort', async () => {
        await heldRelease;
    });
    const controller = new AbortController();
    const pending = navigator.locks.request('cno-test-lock-abort', { signal: controller.signal }, () => 'never');
    controller.abort(new DOMException('stop', 'AbortError'));

    let err: any;
    try { await pending; } catch (e) { err = e; }
    strictEqual(err?.name, 'AbortError');

    releaseHeld();
    await held;
});

Deno.test('navigator.locks upstream: ifAvailable resolves null instead of queueing', async () => {
    let releaseHeld!: () => void;
    const heldRelease = new Promise<void>((resolve) => { releaseHeld = resolve; });
    const held = navigator.locks.request('cno-test-lock-if-available', async () => {
        await heldRelease;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const seen: Array<Lock | null> = [];
    const result = await navigator.locks.request('cno-test-lock-if-available', { ifAvailable: true }, (lock) => {
        seen.push(lock);
        return 'not-held';
    });
    strictEqual(result, 'not-held');
    deepStrictEqual(seen, [null]);

    const state = await navigator.locks.query();
    ok(!state.pending.some((entry) => entry.name === 'cno-test-lock-if-available'));

    releaseHeld();
    await held;
});

Deno.test('navigator.locks upstream: ifAvailable grants compatible shared lock immediately', async () => {
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = navigator.locks.request('cno-test-lock-if-available-shared', { mode: 'shared' }, async (lock) => {
        strictEqual(lock?.mode, 'shared');
        await firstRelease;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await navigator.locks.request('cno-test-lock-if-available-shared', {
        mode: 'shared',
        ifAvailable: true,
    }, (lock) => lock?.mode);
    strictEqual(second, 'shared');

    releaseFirst();
    await first;
});

Deno.test('navigator.locks upstream: invalid modes and conflicting options reject', async () => {
    await rejects(
        navigator.locks.request('cno-test-lock-invalid-mode', { mode: 'bad' as LockMode }, () => 'never'),
        TypeError,
    );
    await rejects(
        navigator.locks.request('cno-test-lock-conflict', { ifAvailable: true, steal: true }, () => 'never'),
        TypeError,
    );
});
