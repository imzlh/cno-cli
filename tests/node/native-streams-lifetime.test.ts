import { ok, strictEqual } from 'node:assert';
import { promiseHooks } from 'node:v8';

const engine = import.meta.use('engine');
const { TCP } = import.meta.use('streams');
const timers = import.meta.use('timers');
const tick = (): Promise<void> => new Promise((resolve) => timers.setTimeout(resolve, 5));

async function collectClosedStreams(): Promise<void> {
    // Let libuv finish uv_close and leave the job that created the WeakRefs.
    await tick();
    engine.gc.run();
    await tick();
    engine.gc.run();
}

Deno.test({
    name: 'native streams: connect releases its pin when a promise hook starts reading',
    timeout: 10000,
}, async () => {
    const server = new TCP();
    server.bind({ ip: '127.0.0.1', port: 0 });
    server.onconnection = (error, peer) => {
        if (error) throw error;
        peer.close();
    };
    server.listen();
    const address = server.sockname;

    async function connectAndClose(): Promise<WeakRef<CModuleStreams.TCP>> {
        const client = new TCP();
        const ref = new WeakRef(client);
        let pending: Promise<void> | undefined;
        let started = false;
        let hookError: unknown;
        client.onread = () => {};
        const stop = promiseHooks.onSettled((promise) => {
            if (promise !== pending) return;
            try {
                // This executes inside the native connect callback, before
                // its operation pin is released, unlike a .then() callback.
                client.startRead();
                started = true;
            } catch (error) {
                hookError = error;
            }
        });
        try {
            pending = client.connect(address);
            await pending;
            if (hookError) throw hookError;
            ok(started, 'the synchronous hook must have started the read');
        } finally {
            stop();
            client.close();
        }
        return ref;
    }

    try {
        const refs: WeakRef<CModuleStreams.TCP>[] = [];
        for (let i = 0; i < 8; i++) refs.push(await connectAndClose());
        await collectClosedStreams();
        strictEqual(refs.filter((ref) => ref.deref() !== undefined).length, 0,
            'closed TCP wrappers must be collectible after both connect and read pins are released');
    } finally {
        server.close();
        await tick();
    }
});

Deno.test({
    name: 'native streams: a read started by a connect hook stays alive until close',
    timeout: 10000,
}, async () => {
    const server = new TCP();
    let peer: CModuleStreams.Stream | undefined;
    server.bind({ ip: '127.0.0.1', port: 0 });
    server.onconnection = (error, client) => {
        if (error) throw error;
        peer = client;
    };
    server.listen();

    let received = 0;
    let readError: unknown;
    async function connectAndDrop(): Promise<WeakRef<CModuleStreams.TCP>> {
        const client = new TCP();
        const ref = new WeakRef(client);
        let pending: Promise<void> | undefined;
        client.onread = (data, error) => {
            if (error) readError = error;
            if (data) received += data.byteLength;
            ref.deref()?.close();
        };
        const stop = promiseHooks.onSettled((promise) => {
            if (promise === pending) client.startRead();
        });
        try {
            pending = client.connect(server.sockname);
            await pending;
        } catch (error) {
            client.close();
            throw error;
        } finally {
            stop();
        }
        return ref;
    }

    let ref: WeakRef<CModuleStreams.TCP> | undefined;
    try {
        ref = await connectAndDrop();
        await collectClosedStreams();
        ok(ref.deref(), 'an active read must keep the TCP wrapper alive');
        ok(peer, 'the server must have accepted the connection');
        await peer.write(new Uint8Array([0x41]));
        const deadline = Date.now() + 3000;
        while (received === 0 && !readError && Date.now() < deadline) await tick();
        if (readError) throw readError;
        strictEqual(received, 1, 'the read callback must still receive data after GC');
        await collectClosedStreams();
        strictEqual(ref.deref(), undefined, 'the read pin must be released after close');
    } finally {
        ref?.deref()?.close();
        peer?.close();
        server.close();
        await tick();
    }
});
