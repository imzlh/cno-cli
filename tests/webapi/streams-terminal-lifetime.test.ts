import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { createServer } from 'node:http';

const engine = import.meta.use('engine');
const timers = import.meta.use('timers');
const tick = () => new Promise<void>(resolve => timers.setTimeout(resolve, 10));

async function collect(): Promise<void> {
    await tick();
    engine.gc.run();
    await tick();
    engine.gc.run();
}

for (const terminal of ['close', 'error', 'cancel'] as const) {
    Deno.test({ name: `ReadableStream: ${terminal} releases source and backpressure callbacks`, timeout: 5000 }, async () => {
        async function terminate() {
            let controller!: ReadableStreamDefaultController<Uint8Array>;
            let cancelReason: unknown;
            const source = {
                payload: new Uint8Array(256 * 1024),
                start(value: ReadableStreamDefaultController<Uint8Array>) { controller = value; },
                cancel(reason: unknown) { cancelReason = reason; },
            };
            const callback = () => { source.payload[0] = 1; };
            const stream = new ReadableStream(source);
            Reflect.set(controller, '_onEnqueueCallback', callback);
            Reflect.set(controller, '_onDequeueCallback', callback);
            const sourceRef = new WeakRef(source);
            const callbackRef = new WeakRef(callback);
            const reader = stream.getReader();
            if (terminal === 'close') {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
                deepStrictEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
                strictEqual((await reader.read()).done, true);
                await reader.closed;
            } else if (terminal === 'error') {
                const reason = new Error('producer failed');
                const pendingRead = reader.read();
                const closed = reader.closed;
                void pendingRead.catch(() => {});
                void closed.catch(() => {});
                controller.error(reason);
                await rejects(pendingRead, error => error === reason);
                await rejects(closed, error => error === reason);
                await rejects(reader.read(), error => error === reason);
            } else {
                const reason = { canceled: true };
                const pendingRead = reader.read();
                await reader.cancel(reason);
                strictEqual((await pendingRead).done, true);
                await reader.closed;
                strictEqual(cancelReason, reason);
            }
            reader.releaseLock();
            return { stream, sourceRef, callbackRef };
        }

        const retained = await terminate();
        await collect();
        strictEqual(retained.sourceRef.deref() === undefined, true, 'a terminal stream must release its producer');
        strictEqual(retained.callbackRef.deref() === undefined, true, 'a terminal stream must release backpressure callbacks');
        strictEqual(retained.stream.locked, false);
    });
}

Deno.test({ name: 'fetch: retaining an errored response releases its CURL transport', timeout: 10000 }, async () => {
    const curlModule = import.meta.use('curl');
    const OriginalCurl = curlModule.CURL;
    const refs: WeakRef<object>[] = [];
    Reflect.set(curlModule, 'CURL', new Proxy(OriginalCurl, {
        construct(target, args, newTarget) {
            const curl = Reflect.construct(target, args, newTarget);
            refs.push(new WeakRef(curl));
            return curl;
        },
    }));
    const server = createServer((request, response) => {
        request.resume();
        request.once('end', () => {
            response.writeHead(200, { 'content-length': '1000' });
            response.write('short');
            timers.setTimeout(() => response.socket?.destroy(), 20);
        });
    });
    const held: Response[] = [];
    try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('missing server address');
        for (let i = 0; i < 4; i++) {
            const response = await fetch(`http://127.0.0.1:${address.port}/`, {
                method: 'POST', body: new Uint8Array(256 * 1024),
            });
            held.push(response);
            await rejects(response.text());
        }
        await collect();
        strictEqual(refs.length, 4);
        strictEqual(refs.filter(ref => ref.deref()).length, 0,
            'completed failed transfers must be collectible while Response metadata remains available');
        strictEqual(held.length, 4);
        strictEqual(held[0]!.status, 200);
    } finally {
        Reflect.set(curlModule, 'CURL', OriginalCurl);
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
