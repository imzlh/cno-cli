import { ok, rejects, strictEqual, throws } from 'node:assert';
import { promiseHooks } from 'node:v8';

const { CURL, ConnPool } = import.meta.use('curl');
const { TCP } = import.meta.use('streams');
const engine = import.meta.use('engine');
const timers = import.meta.use('timers');
const packageUrl = new URL('../../package.json', import.meta.url).href;
const missingUrl = new URL('./fixtures/missing-native-curl-lifetime-file', import.meta.url).href;
const tick = (): Promise<void> => new Promise((resolve) => timers.setTimeout(resolve, 10));
const reply = new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nRESTART');

async function collect(): Promise<void> {
    await tick();
    engine.gc.run();
    await tick();
    engine.gc.run();
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('native CURL request did not arrive');
        await tick();
    }
}

function rawServer(onRequest: (peer: CModuleStreams.Stream) => void) {
    const server = new TCP();
    const peers = new Set<CModuleStreams.Stream>();
    server.onconnection = (error, peer) => {
        if (error) throw error;
        peers.add(peer);
        peer.onclose = () => { peers.delete(peer); };
        peer.onread = (data, readError) => {
            if (readError || data === null) { peer.close(); return; }
            if (!data?.byteLength) return;
            peer.stopRead();
            onRequest(peer);
        };
        peer.startRead();
    };
    server.bind({ ip: '127.0.0.1', port: 0 });
    server.listen();
    return {
        url: `http://127.0.0.1:${server.sockname.port}/`,
        close() {
            for (const peer of peers) peer.close();
            server.close();
        },
    };
}

Deno.test({ name: 'native CURL: settled-hook reuse releases the completed transfer pin', timeout: 10000 }, async () => {
    const pool = new ConnPool();
    async function reuse(): Promise<WeakRef<CModuleCURL.CURL>> {
        const curl = Object.assign(new CURL(pool), { payload: new Uint8Array(1024 * 1024) });
        curl.setUrl(packageUrl).setTimeout(3000);
        const ref = new WeakRef(curl);
        let first: Promise<CModuleCURL.Response> | undefined;
        let second: Promise<CModuleCURL.Response> | undefined;
        let hookError: unknown;
        const stop = promiseHooks.onSettled((promise) => {
            if (promise !== first) return;
            try { second = curl.perform(); }
            catch (error) { hookError = error; }
        });
        try {
            first = curl.perform();
            await first;
            if (hookError) throw hookError;
            ok(second, 'the synchronous hook must restart the same CURL');
            ok((await second).body?.byteLength);
        } finally {
            stop();
            curl.abort();
        }
        return ref;
    }
    try {
        const refs: WeakRef<CModuleCURL.CURL>[] = [];
        for (let i = 0; i < 8; i++) refs.push(await reuse());
        await collect();
        strictEqual(refs.filter((ref) => ref.deref() !== undefined).length, 0,
            'completed CURL handles must not retain a pin from the first transfer');
    } finally {
        pool.close();
        await tick();
    }
});

Deno.test({ name: 'native CURL: a restarted transfer keeps its own pin until completion', timeout: 10000 }, async () => {
    const pool = new ConnPool();
    let peer: CModuleStreams.Stream | undefined;
    const server = rawServer((accepted) => { peer = accepted; });
    async function restartAndDrop() {
        const curl = new CURL(pool);
        const ref = new WeakRef(curl);
        curl.setUrl(packageUrl).setTimeout(3000);
        let first: Promise<CModuleCURL.Response> | undefined;
        let second: Promise<CModuleCURL.Response> | undefined;
        let hookError: unknown;
        const stop = promiseHooks.onSettled((promise) => {
            if (promise !== first) return;
            try { second = curl.setUrl(server.url).perform(); }
            catch (error) { hookError = error; }
        });
        try {
            first = curl.perform();
            await first;
            if (hookError) throw hookError;
            ok(second);
            return { ref, completion: second };
        } finally {
            stop();
        }
    }
    try {
        const { ref, completion } = await restartAndDrop();
        await waitFor(() => peer !== undefined);
        await collect();
        ok(ref.deref(), 'a restarted transfer must survive GC while awaiting its response');
        await peer!.write(reply);
        peer!.close();
        strictEqual((await completion).text, 'RESTART');
        await collect();
        strictEqual(ref.deref(), undefined, 'completion must release the restarted transfer pin');
    } finally {
        pool.close();
        server.close();
        await tick();
    }
});

for (const mode of ['failure', 'abort', 'reset'] as const) {
    Deno.test({ name: `native CURL: ${mode} settlement can restart without retaining the old pin`, timeout: 10000 }, async () => {
        const pool = new ConnPool();
        let writeError: unknown;
        const server = rawServer((peer) => {
            peer.write(reply).then(() => peer.close(), (error) => { writeError = error; peer.close(); });
        });
        async function restart(): Promise<WeakRef<CModuleCURL.CURL>> {
            const curl = new CURL(pool);
            const ref = new WeakRef(curl);
            curl.setUrl(mode === 'failure' ? missingUrl : packageUrl).setTimeout(3000);
            let first: Promise<CModuleCURL.Response> | undefined;
            let second: Promise<CModuleCURL.Response> | undefined;
            let bytes = 0;
            let hookError: unknown;
            const stop = promiseHooks.onSettled((promise) => {
                if (promise !== first) return;
                try {
                    curl.setUrl(server.url).setTimeout(3000);
                    curl.onData((chunk) => { bytes += chunk.byteLength; return false; });
                    second = curl.perform();
                } catch (error) { hookError = error; }
            });
            try {
                first = curl.perform();
                const rejected = rejects(first);
                if (mode === 'abort') curl.abort();
                if (mode === 'reset') curl.reset();
                await rejected;
                if (hookError) throw hookError;
                ok(second, 'rejection must notify the synchronous settled hook');
                strictEqual((await second).status, 200);
                strictEqual(bytes, 7, 'a callback installed by the restart must survive the old terminal path');
                if (writeError) throw writeError;
            } finally {
                stop();
                curl.abort();
            }
            return ref;
        }
        try {
            const ref = await restart();
            await collect();
            strictEqual(ref.deref(), undefined);
        } finally {
            pool.close();
            server.close();
            await tick();
        }
    });
}

Deno.test({ name: 'native CURL: pool teardown finishes before rejection hooks run', timeout: 10000 }, async () => {
    const pool = new ConnPool();
    const refs: WeakRef<CModuleCURL.CURL>[] = [];
    const pending: Promise<CModuleCURL.Response>[] = [];
    function startTransfer(): Promise<CModuleCURL.Response> {
        const curl = new CURL(pool);
        refs.push(new WeakRef(curl));
        return curl.setUrl(packageUrl).perform();
    }
    for (let i = 0; i < 4; i++) pending.push(startTransfer());
    let settled = 0;
    let hookError: unknown;
    const watched = new Set(pending);
    const stop = promiseHooks.onSettled((promise) => {
        if (!watched.has(promise as Promise<CModuleCURL.Response>)) return;
        settled++;
        try {
            throws(() => new CURL(pool), /closed/);
            pool.close();
        } catch (error) { hookError = error; }
    });
    try {
        const results = Promise.allSettled(pending);
        pool.close();
        ok((await results).every((result) => result.status === 'rejected'));
        if (hookError) throw hookError;
        strictEqual(settled, pending.length);
        await collect();
        strictEqual(refs.filter((ref) => ref.deref() !== undefined).length, 0);
    } finally {
        stop();
        pool.close();
        await tick();
    }
});
