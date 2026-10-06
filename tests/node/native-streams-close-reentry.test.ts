import { ok, rejects, strictEqual } from 'node:assert';
import { promiseHooks } from 'node:v8';

const { TCP } = import.meta.use('streams');
const engine = import.meta.use('engine');
const timers = import.meta.use('timers');
const tick = (): Promise<void> => new Promise((resolve) => timers.setTimeout(resolve, 10));

Deno.test({ name: 'native streams: a rejected-read hook cannot acquire a second close pin', timeout: 10000 }, async () => {
    const server = new TCP();
    const peers = new Set<CModuleStreams.Stream>();
    server.onconnection = (error, peer) => {
        if (error) throw error;
        peers.add(peer);
    };
    server.bind({ ip: '127.0.0.1', port: 0 });
    server.listen();
    let closeHooks = 0;
    async function closeAndDrop(): Promise<WeakRef<CModuleStreams.TCP>> {
        const client = Object.assign(new TCP(), { payload: new Uint8Array(1024 * 1024) });
        const ref = new WeakRef(client);
        await client.connect(server.sockname);
        let pending: Promise<number> | undefined;
        let hookError: unknown;
        const stop = promiseHooks.onSettled((promise) => {
            if (promise !== pending) return;
            closeHooks++;
            try { client.close(); }
            catch (error) { hookError = error; }
        });
        try {
            pending = client.read(new Uint8Array(16));
            const rejected = rejects(pending);
            client.close();
            await rejected;
            if (hookError) throw hookError;
        } finally {
            stop();
            client.close();
        }
        return ref;
    }
    try {
        const refs: WeakRef<CModuleStreams.TCP>[] = [];
        for (let i = 0; i < 8; i++) refs.push(await closeAndDrop());
        strictEqual(closeHooks, refs.length, 'each read rejection must synchronously reenter close');
        await tick();
        engine.gc.run();
        await tick();
        engine.gc.run();
        ok(refs.every((ref) => ref.deref() === undefined), 'reentrant close must release all native pins');
    } finally {
        for (const peer of peers) peer.close();
        server.close();
        await tick();
    }
});
