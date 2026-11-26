import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { writeFileSync, unlinkSync } from 'node:fs';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { createPipeRefLease } from '../../cno/src/utils/worker-pipe-ref.ts';

Deno.test('worker pipe leases aggregate and make transitions and release idempotent', () => {
    const calls: string[] = [];
    const pipe = {
        ref() { calls.push('ref'); },
        unref() { calls.push('unref'); },
    } as unknown as CModuleWorker.MessagePipe;

    const first = createPipeRefLease(pipe, false);
    first.unref();
    first.ref();
    first.ref();
    const second = createPipeRefLease(pipe);
    first.unref();
    second.release();
    second.release();
    first.ref();
    first.release();
    first.release();
    first.ref();

    strictEqual(calls.join(','), 'unref,ref,unref,ref,unref');
});

Deno.test('worker pipe leases aggregate across duplicate helper instances', async () => {
    const calls: string[] = [];
    const pipe = {
        ref() { calls.push('ref'); },
        unref() { calls.push('unref'); },
    } as unknown as CModuleWorker.MessagePipe;
    const helperUrl = new URL('../../cno/src/utils/worker-pipe-ref.ts', import.meta.url);
    const duplicate = await import(`${helperUrl.href}?instance=duplicate`);

    const webLease = createPipeRefLease(pipe, false);
    const nodeLease = duplicate.createPipeRefLease(pipe);
    webLease.release();
    nodeLease.release();

    strictEqual(calls.join(','), 'unref,ref,unref');
});

Deno.test('worker pipe leases keep concurrent ownership balanced when a pipe is dead', () => {
    const calls: string[] = [];
    const pipe = {
        ref() { calls.push('ref'); throw new Error('pipe is closed'); },
        unref() { calls.push('unref'); throw new Error('pipe is closed'); },
    } as unknown as CModuleWorker.MessagePipe;

    const initiallyUnrefed = createPipeRefLease(pipe, false);
    const secondOwner = createPipeRefLease(pipe);
    initiallyUnrefed.ref();
    secondOwner.release();
    initiallyUnrefed.release();
    initiallyUnrefed.release();

    strictEqual(calls.join(','), 'unref,ref,unref');
});

function writeBroadcastWorker(source: string): string {
    const file = Deno.makeTempFileSync({ prefix: 'cno-broadcast-worker-', suffix: '.ts' });
    writeFileSync(file, source);
    return file;
}

Deno.test({ name: 'BroadcastChannel: send failures release only their own pipe leases', timeout: 10000 }, async () => {
    const name = `cno-test-broadcast-worker-send-failure-${Deno.pid}-${Date.now()}`;
    const file = writeBroadcastWorker(`
        const { pipe } = import.meta.use('worker');
        const nativePostMessage = pipe.postMessage;
        const nativeRef = pipe.ref;
        const nativeUnref = pipe.unref;
        let refs = 0;
        let unrefs = 0;
        let constructorFailed = false;
        pipe.ref = () => { refs++; nativeRef.call(pipe); };
        pipe.unref = () => { unrefs++; nativeUnref.call(pipe); };
        pipe.postMessage = () => { throw new Error('simulated closed pipe'); };
        try { new BroadcastChannel(${JSON.stringify(name)}); }
        catch { constructorFailed = true; }
        pipe.postMessage = nativePostMessage;

        const channel = new BroadcastChannel(${JSON.stringify(name)});
        pipe.postMessage = () => { throw new Error('simulated closed pipe'); };
        channel.close();
        pipe.postMessage = nativePostMessage;
        self.postMessage({ constructorFailed, closed: channel.closed, refs, unrefs });
        self.close();
    `);
    const worker = new Worker(file, { type: 'module', name: 'broadcast-worker-send-failure' });
    try {
        const result = await new Promise<unknown>((resolve, reject) => {
            worker.onerror = reject;
            worker.onmessage = (event) => resolve(event.data);
        });
        deepStrictEqual(result, {
            constructorFailed: true,
            closed: true,
            refs: 2,
            unrefs: 2,
        });
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

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

Deno.test({ name: 'BroadcastChannel upstream: closing one worker channel keeps another alive', timeout: 10000 }, async () => {
    const name = `cno-test-broadcast-worker-multi-${Deno.pid}-${Date.now()}`;
    const file = writeBroadcastWorker(`
        const first = new BroadcastChannel(${JSON.stringify(name)});
        const second = new BroadcastChannel(${JSON.stringify(name)});
        first.onmessage = (event) => {
            if (event.data === 'close-first') {
                first.close();
                self.postMessage('first-closed');
            }
        };
        second.onmessage = (event) => {
            if (event.data === 'second-ping') self.postMessage('second-alive');
        };
        self.postMessage('ready');
    `);
    const channel = new BroadcastChannel(name);
    const worker = new Worker(file, { type: 'module', name: 'broadcast-worker-multi' });
    try {
        const messages: string[] = [];
        const next = (expected: string) => new Promise<void>((resolve, reject) => {
            worker.onerror = reject;
            worker.onmessage = (event) => {
                messages.push(event.data);
                if (event.data === expected) resolve();
            };
        });
        await next('ready');
        channel.postMessage('close-first');
        await next('first-closed');
        channel.postMessage('second-ping');
        await next('second-alive');
        deepStrictEqual(messages, ['ready', 'first-closed', 'second-alive']);
    } finally {
        worker.terminate();
        channel.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'BroadcastChannel upstream: a worker message listener survives channel close', timeout: 10000 }, async () => {
    const name = `cno-test-broadcast-worker-listener-${Deno.pid}-${Date.now()}`;
    const file = writeBroadcastWorker(`
        const channel = new BroadcastChannel(${JSON.stringify(name)});
        self.onmessage = (event) => {
            if (event.data === 'close-channel') {
                channel.close();
                self.postMessage('channel-closed');
            } else if (event.data === 'listener-ping') {
                self.postMessage('listener-alive');
                self.close();
            }
        };
        self.postMessage('ready');
    `);
    const worker = new Worker(file, { type: 'module', name: 'broadcast-worker-listener' });
    try {
        const next = (expected: string) => new Promise<void>((resolve, reject) => {
            worker.onerror = reject;
            worker.onmessage = (event) => {
                if (event.data === expected) resolve();
            };
        });
        await next('ready');
        worker.postMessage('close-channel');
        await next('channel-closed');
        worker.postMessage('listener-ping');
        await next('listener-alive');
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'BroadcastChannel upstream: worker close detaches its channels', timeout: 10000 }, async () => {
    const name = `cno-test-broadcast-worker-close-${Deno.pid}-${Date.now()}`;
    const file = writeBroadcastWorker(`
        const channel = new BroadcastChannel(${JSON.stringify(name)});
        let closeEvents = 0;
        channel.addEventListener('close', () => { closeEvents++; });
        self.onmessage = () => {
            try { self.close(); } catch { /* close exits the worker after unwinding */ }
            self.postMessage({ closed: channel.closed, closeEvents });
        };
        self.postMessage('ready');
    `);
    const worker = new Worker(file, { type: 'module', name: 'broadcast-worker-close' });
    try {
        const next = () => new Promise<unknown>((resolve, reject) => {
            worker.onerror = reject;
            worker.onmessage = (event) => resolve(event.data);
        });
        strictEqual(await next(), 'ready');
        worker.postMessage('close');
        deepStrictEqual(await next(), { closed: true, closeEvents: 1 });
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker upstream: worker close releases transferred port endpoints', timeout: 10000 }, async () => {
    const file = writeBroadcastWorker(`
        const { port1 } = new MessageChannel();
        self.onmessage = () => {
            try { self.close(); } catch { /* close exits the worker after unwinding */ }
            self.postMessage('closed');
        };
        self.postMessage('ready', [port1]);
    `);
    const worker = new Worker(file, { type: 'module', name: 'worker-close-transferred-port' });
    let transferredPort: MessagePort | undefined;
    try {
        const next = () => new Promise<MessageEvent>((resolve, reject) => {
            worker.onerror = reject;
            worker.onmessage = (event) => resolve(event);
        });
        const ready = await next();
        strictEqual(ready.data, 'ready');
        transferredPort = ready.ports[0];
        ok(transferredPort);

        worker.postMessage('close');
        strictEqual((await next()).data, 'closed');
        let err: unknown;
        try { transferredPort.postMessage('after-close'); } catch (error) { err = error; }
        strictEqual((err as Error | undefined)?.name, 'InvalidStateError');
    } finally {
        worker.terminate();
        transferredPort?.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'BroadcastChannel upstream: unref does not unref parentPort', timeout: 10000 }, async () => {
    const source = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (message) => {
            if (message === 'ping') parentPort.postMessage('pong');
        });
        const channel = new BroadcastChannel('cno-test-broadcast-node-port');
        channel.unref();
        channel.close();
        parentPort.postMessage('ready');
    `;
    const worker = new ThreadWorker(source, { eval: true });
    try {
        const nextMessage = (expected: string) => new Promise<void>((resolve, reject) => {
            const onMessage = (message: unknown) => {
                if (message !== expected) return;
                worker.off('message', onMessage);
                worker.off('error', onError);
                resolve();
            };
            const onError = (error: Error) => {
                worker.off('message', onMessage);
                reject(error);
            };
            worker.on('message', onMessage);
            worker.on('error', onError);
        });
        const ready = nextMessage('ready');
        await ready;
        const pong = nextMessage('pong');
        worker.postMessage('ping');
        await pong;
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'BroadcastChannel: node worker messages cross the broker', timeout: 10000 }, async () => {
    const name = `cno-test-broadcast-node-worker-${Deno.pid}-${Date.now()}`;
    const source = `
        const { parentPort } = require('node:worker_threads');
        const channel = new BroadcastChannel(${JSON.stringify(name)});
        channel.onmessage = (event) => parentPort.postMessage(['broadcast', event.data]);
        parentPort.postMessage('ready');
    `;
    const worker = new ThreadWorker(source, { eval: true });
    const channel = new BroadcastChannel(name);
    const nextMessage = (expected: unknown) => new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
            worker.off('message', onMessage);
            worker.off('error', onError);
            reject(new Error(`timed out waiting for ${String(expected)}`));
        }, 5000);
        const onMessage = (message: unknown) => {
            if (message !== expected && expected !== undefined) return;
            clearTimeout(timer);
            worker.off('message', onMessage);
            worker.off('error', onError);
            resolve(message);
        };
        const onError = (error: Error) => {
            clearTimeout(timer);
            worker.off('message', onMessage);
            reject(error);
        };
        worker.on('message', onMessage);
        worker.on('error', onError);
    });
    try {
        await nextMessage('ready');
        channel.postMessage('ping');
        deepStrictEqual(await nextMessage(undefined), ['broadcast', 'ping']);
    } finally {
        channel.close();
        await worker.terminate();
    }
});

Deno.test({ name: 'BroadcastChannel upstream: unref leaves an idle worker free to exit', timeout: 10000 }, async () => {
    const source = `
        const { parentPort } = require('node:worker_threads');
        const channel = new BroadcastChannel('cno-test-broadcast-idle-worker');
        channel.unref();
        parentPort.postMessage('ready');
    `;
    const worker = new ThreadWorker(source, { eval: true });
    try {
        const exited = new Promise<number>((resolve) => worker.once('exit', resolve));
        await new Promise<void>((resolve, reject) => {
            const onMessage = (message: unknown) => {
                if (message !== 'ready') return;
                worker.off('message', onMessage);
                worker.off('error', onError);
                resolve();
            };
            const onError = (error: Error) => {
                worker.off('message', onMessage);
                reject(error);
            };
            worker.on('message', onMessage);
            worker.on('error', onError);
        });
        const exitCode = await exited;
        strictEqual(exitCode, 0);
    } finally {
        await worker.terminate();
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
    const firstStarted = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();

    const first = navigator.locks.request('cno-test-lock-shared', { mode: 'shared' }, async (lock) => {
        strictEqual(lock.mode, 'shared');
        seen.push('first-start');
        firstStarted.resolve();
        await firstRelease.promise;
        seen.push('first-end');
    });
    await firstStarted.promise;

    const secondStarted = Promise.withResolvers<void>();
    const second = navigator.locks.request('cno-test-lock-shared', { mode: 'shared' }, (lock) => {
        strictEqual(lock.mode, 'shared');
        seen.push('second');
        secondStarted.resolve();
    });

    await secondStarted.promise;
    deepStrictEqual(seen, ['first-start', 'second']);
    firstRelease.resolve();
    await first;
    await second;
    deepStrictEqual(seen, ['first-start', 'second', 'first-end']);
});

Deno.test('navigator.locks: query reports held and pending locks', async () => {
    const holderStarted = Promise.withResolvers<void>();
    const heldRelease = Promise.withResolvers<void>();
    const held = navigator.locks.request('cno-test-lock-query', async () => {
        holderStarted.resolve();
        await heldRelease.promise;
    });
    await holderStarted.promise;

    const pending = navigator.locks.request('cno-test-lock-query', () => 'pending');

    const state = await navigator.locks.query();
    ok(state.held.some((entry) => entry.name === 'cno-test-lock-query' && entry.mode === 'exclusive'));
    ok(state.pending.some((entry) => entry.name === 'cno-test-lock-query' && entry.mode === 'exclusive'));

    heldRelease.resolve();
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
    const holderStarted = Promise.withResolvers<void>();
    const heldRelease = Promise.withResolvers<void>();
    const held = navigator.locks.request('cno-test-lock-if-available', async () => {
        holderStarted.resolve();
        await heldRelease.promise;
    });
    await holderStarted.promise;

    const seen: Array<Lock | null> = [];
    const result = await navigator.locks.request('cno-test-lock-if-available', { ifAvailable: true }, (lock) => {
        seen.push(lock);
        return 'not-held';
    });
    strictEqual(result, 'not-held');
    deepStrictEqual(seen, [null]);

    const state = await navigator.locks.query();
    ok(!state.pending.some((entry) => entry.name === 'cno-test-lock-if-available'));

    heldRelease.resolve();
    await held;
});

Deno.test('navigator.locks upstream: ifAvailable grants compatible shared lock immediately', async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();
    const first = navigator.locks.request('cno-test-lock-if-available-shared', { mode: 'shared' }, async (lock) => {
        strictEqual(lock?.mode, 'shared');
        firstStarted.resolve();
        await firstRelease.promise;
    });
    await firstStarted.promise;

    const second = await navigator.locks.request('cno-test-lock-if-available-shared', {
        mode: 'shared',
        ifAvailable: true,
    }, (lock) => lock?.mode);
    strictEqual(second, 'shared');

    firstRelease.resolve();
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
