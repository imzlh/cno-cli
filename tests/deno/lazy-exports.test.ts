import { deepStrictEqual, ok, strictEqual } from 'node:assert';

Deno.test('Deno lazy exports: every registered API survives module initialization', () => {
    for (const name of [
        'Command', 'ChildProcess', 'Process', 'kill', 'umask', 'spawn', 'spawnAndWait', 'spawnAndWaitSync',
        'connect', 'connectTls', 'listen', 'listenTls', 'startTls', 'listenDatagram', 'networkInterfaces', 'resolveDns',
        'QuicEndpoint', 'connectQuic', 'serve', 'upgradeWebSocket',
        'openKv', 'Kv', 'KvListIterator', 'KvU64', 'AtomicOperation',
        'dlopen', 'UnsafePointer', 'UnsafePointerView', 'UnsafeCallback', 'UnsafeFnPointer',
    ]) {
        strictEqual(typeof Reflect.get(Deno, name), 'function', `Deno.${name} must be callable`);
    }
});

Deno.test({ name: 'Deno lazy exports: Command executes a child and captures its output', timeout: 15000 }, async () => {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', '--ext=js', 'console.log("lazy command ready")'],
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            child.output(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    try { child.kill(); } catch { /* the child may have already exited */ }
                    reject(new Error('lazy command output timed out'));
                }, 10000);
            }),
        ]);
        strictEqual(result.code, 0, new TextDecoder().decode(result.stderr));
        strictEqual(new TextDecoder().decode(result.stdout).trim(), 'lazy command ready');
        ok(child instanceof Deno.ChildProcess);
    } finally {
        clearTimeout(timeout);
    }
});

Deno.test({ name: 'Deno lazy exports: listen and connect exchange bytes', timeout: 5000 }, async () => {
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    let client: Deno.Conn | undefined;
    let server: Deno.Conn | undefined;
    try {
        const accepted = listener.accept();
        client = await Deno.connect({ hostname: '127.0.0.1', port: (listener.addr as Deno.NetAddr).port });
        server = await accepted;
        await client.write(new Uint8Array([42]));
        const bytes = new Uint8Array(1);
        strictEqual(await server.read(bytes), 1);
        strictEqual(bytes[0], 42);
    } finally {
        client?.close();
        server?.close();
        listener.close();
    }
});

Deno.test({ name: 'Deno lazy exports: serve responds and shuts down', timeout: 5000 }, async () => {
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, () => new Response('lazy serve ready'));
    try {
        const response = await fetch(`http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/`);
        strictEqual(await response.text(), 'lazy serve ready');
    } finally {
        await server.shutdown();
        await server.finished;
    }
});

Deno.test('Deno lazy exports: openKv opens a usable database', async () => {
    const kv = await Deno.openKv(':memory:');
    try {
        await kv.set(['lazy-exports'], { ready: true });
        deepStrictEqual((await kv.get(['lazy-exports'])).value, { ready: true });
        ok(kv instanceof Deno.Kv);
    } finally {
        kv.close();
    }
});
