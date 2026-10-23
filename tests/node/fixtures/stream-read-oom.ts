const engine = import.meta.use('engine');
const os = import.meta.use('os');
const streams = import.meta.use('streams');
const timers = import.meta.use('timers');
const log = import.meta.use('console');
const limit = os.memoryUsage().limit;
const tick = () => new Promise<void>(resolve => timers.setTimeout(resolve, 10));
const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
};
check(limit === 32 * 1024 * 1024 || limit === 64 * 1024 * 1024,
      'run with --memory-limit=32MB or --memory-limit=64MB');

const server = new streams.TCP();
let peer: CModuleStreams.Stream | undefined;
server.onconnection = (error, connection) => {
    if (error) throw error;
    peer = connection;
};
server.bind({ ip: '127.0.0.1', port: 0 });
server.listen();

let client: CModuleStreams.TCP | null = new streams.TCP();
const clientRef = new WeakRef(client);
try {
    await client.connect(server.sockname);
    while (!peer) await tick();
    const payload = new Uint8Array([0x41]);
    const samples: number[] = [];
    for (let iteration = 0; iteration < 8; iteration++) {
        await peer.write(payload);
        let filler: Uint8Array | null = null;
        let data: Uint8Array | null | undefined;
        let error: Error | undefined;
        let calls = 0, timedOut = false;
        const done = Promise.withResolvers<void>();
        client.onread = (chunk, readError) => {
            // Release the filler before allocating or asserting in JavaScript.
            filler = null;
            data = chunk;
            error = readError;
            calls++;
            done.resolve();
        };
        const safety = timers.setTimeout(() => {
            filler = null;
            timedOut = true;
            clientRef.deref()?.stopRead();
            done.resolve();
        }, 1000);
        engine.gc.run();
        timers.setTimeout(() => {
            client!.startRead();
            const used = os.memoryUsage().used;
            // libuv allocates 64 KiB; leave insufficient headroom to wrap it.
            filler = new Uint8Array(limit - used - 65536 - 256);
        }, 1);
        await done.promise;
        timers.clearTimeout(safety);
        await tick();
        check(!timedOut && calls === 1, 'OOM must call onread exactly once');
        check(data === undefined && error instanceof Error,
              'OOM must deliver onread(undefined, error)');
        check(/out of memory/i.test(error!.message), 'preserve the allocation error');
        engine.gc.run();
        samples.push(os.memoryUsage().used);
    }
    check(samples.at(-1)! - samples[0]! < 32768,
          'repeated OOM reads must not retain their 64 KiB buffers');

    // An open connected wrapper becomes collectible once OOM releases its read pin.
    client = null;
    await tick();
    engine.gc.run();
    await tick();
    engine.gc.run();
    check(clientRef.deref() === undefined, 'OOM must release the active read pin');
    log.log(JSON.stringify({ limit, samples, growth: samples.at(-1)! - samples[0]! }));
    log.log('PASS: repeated stream-read OOM releases buffers and pins');
} finally {
    clientRef.deref()?.close();
    peer?.close();
    server.close();
    await tick();
}
