import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import vm from 'node:vm';

async function withTimeout<T>(promise: Promise<T>, ms = 3000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function isSandboxSocketError(error: unknown): boolean {
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase();
    return message.includes('EPERM') || message.includes('operation not permitted');
}

function removeTree(path: string): void {
    try {
        Deno.removeSync(path, { recursive: true });
    } catch {
        // Cleanup is best-effort because some platforms remove socket files on close.
    }
}

function assertNetworkInterface(info: Deno.NetworkInterfaceInfo): void {
    strictEqual(typeof info.name, 'string');
    strictEqual(typeof info.address, 'string');
    strictEqual(typeof info.netmask, 'string');
    strictEqual(typeof info.mac, 'string');
    strictEqual(typeof info.internal, 'boolean');
    ok(info.family === 'IPv4' || info.family === 'IPv6');

    strictEqual(typeof info.cidr, 'string');
    const separator = info.cidr.lastIndexOf('/');
    ok(separator > 0, `network interface cidr must include a prefix: ${info.cidr}`);
    strictEqual(info.cidr.slice(0, separator), info.address);
    const prefix = Number(info.cidr.slice(separator + 1));
    ok(Number.isInteger(prefix), `network interface cidr prefix must be an integer: ${info.cidr}`);

    if (info.family === 'IPv4') {
        ok(!info.address.includes(':'), `IPv4 address must not be IPv6-shaped: ${info.address}`);
        ok(prefix >= 0 && prefix <= 32, `IPv4 cidr prefix out of range: ${info.cidr}`);
        strictEqual(info.scopeid, null);
    } else {
        ok(info.address.includes(':'), `IPv6 address must be IPv6-shaped: ${info.address}`);
        ok(prefix >= 0 && prefix <= 128, `IPv6 cidr prefix out of range: ${info.cidr}`);
        ok(info.scopeid === null || Number.isInteger(info.scopeid));
    }
}

Deno.test('deno stdio: standard streams expose stable shape without consuming input', () => {
    strictEqual(typeof Deno.stdin.read, 'function');
    strictEqual(typeof Deno.stdin.readSync, 'function');
    strictEqual(typeof Deno.stdin.close, 'function');
    strictEqual(typeof Deno.stdin.setRaw, 'function');
    strictEqual(typeof Deno.stdin.isTerminal(), 'boolean');
    ok(Deno.stdin.readable instanceof ReadableStream);

    strictEqual(typeof Deno.stdout.write, 'function');
    strictEqual(typeof Deno.stdout.writeSync, 'function');
    strictEqual(typeof Deno.stdout.close, 'function');
    strictEqual(typeof Deno.stdout.isTerminal(), 'boolean');
    ok(Deno.stdout.writable instanceof WritableStream);

    strictEqual(typeof Deno.stderr.write, 'function');
    strictEqual(typeof Deno.stderr.writeSync, 'function');
    strictEqual(typeof Deno.stderr.close, 'function');
    strictEqual(typeof Deno.stderr.isTerminal(), 'boolean');
    ok(Deno.stderr.writable instanceof WritableStream);

    if (Deno.stdout.isTerminal()) {
        const size = Deno.consoleSize();
        ok(Number.isFinite(size.rows));
        ok(Number.isFinite(size.columns));
    } else {
        throws(() => Deno.consoleSize(), /Only TTY streams have a size/);
    }
});

Deno.test('deno stdio: zero-length read and write operations return zero bytes', async () => {
    const empty = new Uint8Array(0);
    strictEqual(await Deno.stdin.read(empty), 0);
    strictEqual(Deno.stdin.readSync(empty), 0);
    strictEqual(await Deno.stdout.write(empty), 0);
    strictEqual(Deno.stdout.writeSync(empty), 0);
    strictEqual(await Deno.stderr.write(empty), 0);
    strictEqual(Deno.stderr.writeSync(empty), 0);
});

Deno.test('deno process: umask cache, uid gid and signal validation are observable', () => {
    const original = Deno.umask();
    try {
        strictEqual(Deno.umask(0o077), original);
        strictEqual(Deno.umask(), 0o077);
        strictEqual(Deno.umask(0o022), 0o077);
    } finally {
        Deno.umask(original);
    }
    strictEqual(Deno.umask(), original);

    ok(Number.isInteger(Deno.uid()));
    ok(Number.isInteger(Deno.gid()));
    throws(() => Deno.kill(Deno.pid, 'SIGEMT' as Deno.Signal), TypeError);
    Deno.kill(Deno.pid, 0);
    throws(() => Deno.kill(999999, 0), Deno.errors.NotFound);
    throws(() => Deno.addSignalListener('CNO_NO_SUCH_SIGNAL' as Deno.Signal, () => {}), /Invalid signal/);
    throws(() => Deno.removeSignalListener('CNO_NO_SUCH_SIGNAL' as Deno.Signal, () => {}), /Invalid signal/);
    throws(() => Deno.addSignalListener('SIGINT', 'handler' as unknown as () => void), TypeError);
    throws(() => Deno.removeSignalListener('SIGINT', 'handler' as unknown as () => void), TypeError);
    for (const sig of ['SIGKILL', 'SIGSTOP', 'SIGILL', 'SIGFPE', 'SIGSEGV'] as Deno.Signal[]) {
        throws(() => Deno.addSignalListener(sig, () => {}), TypeError);
    }
    if (Deno.build.os === 'linux') {
        const noop = () => {};
        Deno.addSignalListener('SIGUNUSED' as Deno.Signal, noop);
        Deno.addSignalListener('SIGPOLL' as Deno.Signal, noop);
        Deno.removeSignalListener('SIGUNUSED' as Deno.Signal, noop);
        Deno.removeSignalListener('SIGPOLL' as Deno.Signal, noop);
    }
});

Deno.test('deno process: inspect and system memory info expose stable public shapes', () => {
    const inspected = Deno.inspect({ nested: { value: 1 } }, { colors: false, depth: 1 });
    ok(inspected.includes('nested'));
    ok(inspected.includes('value'));

    const customInspect = Symbol.for('Deno.customInspect');
    const custom = {
        [customInspect](inspect: (value: unknown, options?: Deno.InspectOptions) => string, options: Deno.InspectOptions) {
            strictEqual(typeof inspect, 'function');
            strictEqual(options.colors, false);
            return `custom:${inspect({ child: 1 }, { colors: false })}`;
        },
    };
    strictEqual(Deno.inspect(custom, { colors: false }), 'custom:{ child: 1 }');
    ok(!Deno.inspect(custom, { colors: false, customInspect: false }).startsWith('custom:'));

    const memory = Deno.systemMemoryInfo();
    for (const key of ['total', 'free', 'available', 'buffers', 'cached', 'swapTotal', 'swapFree'] as const) {
        ok(typeof memory[key] === 'number', `systemMemoryInfo.${key} must be numeric`);
    }
    strictEqual(typeof Deno.hostname(), 'string');
    strictEqual(typeof Deno.osRelease(), 'string');
    strictEqual(typeof Deno.osUptime(), 'number');
    ok(Array.isArray(Deno.loadavg()));
});

Deno.test('deno process upstream: inspect handles cross-realm built-in objects', () => {
    const values = vm.runInNewContext(`[
        new Map([["x", 1]]),
        new Set(["a", "b"]),
        new Date("2018-12-10T02:26:59.002Z"),
        new Error("cross realm"),
    ]`) as unknown[];

    const inspected = values.map((value) => Deno.inspect(value, { colors: false })).join('\n');
    ok(inspected.includes('Map(1) {x => 1}'));
    ok(inspected.includes('Set(2) {a, b}'));
    ok(inspected.includes('2018-12-10T02:26:59.002Z'));
    ok(inspected.includes('Error: cross realm'));
});

Deno.test('deno net: networkInterfaces returns Deno-shaped interface entries with cidr prefixes', () => {
    let interfaces: Deno.NetworkInterfaceInfo[];
    try {
        interfaces = Deno.networkInterfaces();
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    }
    ok(Array.isArray(interfaces));

    for (const info of interfaces) {
        assertNetworkInterface(info);
    }
});

Deno.test('deno net: validation failures happen before opening sockets', async () => {
    await rejects(
        () => Deno.resolveDns('example.test', 'CNO_BAD_RECORD' as Deno.RecordType),
        /Unsupported DNS record type/,
    );
    await rejects(
        () => Deno.resolveDns('example.test', 'A', { nameServer: { ipAddr: '127.0.0.1', port: 0 } }),
        RangeError,
    );

    await rejects(
        () => Deno.connect({ transport: 'udp' as 'tcp', hostname: '127.0.0.1', port: 1 }),
        Deno.errors.NotSupported,
    );
    throws(
        () => Deno.listen({ transport: 'udp' as 'tcp', hostname: '127.0.0.1', port: 1 }),
        Deno.errors.NotSupported,
    );

    await rejects(
        () => Deno.connectTls({ hostname: '127.0.0.1', port: 1, keyFormat: 'der' as 'pem' }),
        TypeError,
    );
    throws(
        () => Deno.listenTls({ hostname: '127.0.0.1', port: 1, cert: '', key: '', keyFormat: 'der' as 'pem' }),
        TypeError,
    );
    await rejects(
        () => Deno.startTls({} as Deno.Conn, { hostname: 'example.test' }),
        Deno.errors.BadResource,
    );

    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    await rejects(
        () => Deno.connect({ hostname: '127.0.0.1', port: 1, signal: controller.signal }),
        DOMException,
    );
    await rejects(
        () => Deno.resolveDns('example.test', 'A', { signal: controller.signal }),
        DOMException,
    );
});

Deno.test({ name: 'deno net: tcp listen port 0 reports selected port and accepts a connection', timeout: 10000 }, async () => {
    let listener: Deno.Listener;
    try {
        listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    }
    const addr = listener.addr as Deno.NetAddr;
    strictEqual(addr.transport, 'tcp');
    strictEqual(addr.hostname, '127.0.0.1');
    ok(addr.port > 0);

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let client: Deno.Conn;
    try {
        client = await Deno.connect({ hostname: addr.hostname, port: addr.port });
    } catch (error) {
        listener.close();
        if (isSandboxSocketError(error)) return;
        throw error;
    }

    const server = (async () => {
        const conn = await listener.accept();
        try {
            const request = new Uint8Array(4);
            strictEqual(await conn.read(request), 4);
            strictEqual(decoder.decode(request), 'ping');
            strictEqual(await conn.write(encoder.encode('pong')), 4);
        } finally {
            conn.close();
        }
    })();
    try {
        strictEqual(client.remoteAddr.port, addr.port);
        strictEqual(await client.write(encoder.encode('ping')), 4);
        const response = new Uint8Array(4);
        strictEqual(await client.read(response), 4);
        strictEqual(decoder.decode(response), 'pong');
    } finally {
        client.close();
        listener.close();
    }
    await server;
});

Deno.test({ name: 'deno net: listener async iterator and Conn streams exchange bytes', timeout: 10000 }, async () => {
    let listener: Deno.Listener;
    try {
        listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    }

    const addr = listener.addr as Deno.NetAddr;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const iterator = listener[Symbol.asyncIterator]();
    let client: Deno.Conn | undefined;
    let serverConn: Deno.TcpConn | undefined;
    try {
        const accepted = iterator.next();
        client = await Deno.connect({ hostname: addr.hostname, port: addr.port });
        serverConn = (await withTimeout(accepted)).value as Deno.TcpConn;

        serverConn.ref();
        serverConn.unref();
        serverConn.setNoDelay(true);
        serverConn.setKeepAlive(true);

        const serverWriter = serverConn.writable.getWriter();
        await serverWriter.write(encoder.encode('from-server'));
        serverWriter.releaseLock();

        const clientReader = client.readable.getReader();
        const fromServer = await withTimeout(clientReader.read());
        clientReader.releaseLock();
        strictEqual(fromServer.done, false);
        strictEqual(decoder.decode(fromServer.value), 'from-server');

        const clientWriter = client.writable.getWriter();
        await clientWriter.write(encoder.encode('from-client'));
        clientWriter.releaseLock();

        const serverReader = serverConn.readable.getReader();
        const fromClient = await withTimeout(serverReader.read());
        serverReader.releaseLock();
        strictEqual(fromClient.done, false);
        strictEqual(decoder.decode(fromClient.value), 'from-client');
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    } finally {
        await iterator.return?.();
        try { serverConn?.close(); } catch {}
        try { client?.close(); } catch {}
        listener.close();
    }
});

Deno.test({ name: 'deno net: listener close settles pending accept and async iterator', timeout: 10000 }, async () => {
    let listener: Deno.Listener | undefined;
    try {
        listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    }

    const pending = listener.accept();
    await rejects(() => listener.accept(), Deno.errors.Busy);
    listener.close();
    await rejects(() => pending, Deno.errors.BadResource);

    const iterator = listener[Symbol.asyncIterator]();
    deepStrictEqual(await iterator.next(), { value: undefined, done: true });
});

Deno.test({ name: 'deno net: async iterator next resolves done when listener closes', timeout: 10000 }, async () => {
    let listener: Deno.Listener | undefined;
    try {
        listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    }

    const iterator = listener[Symbol.asyncIterator]();
    const next = iterator.next();
    listener.close();
    deepStrictEqual(await next, { value: undefined, done: true });
    deepStrictEqual(await iterator.next(), { value: undefined, done: true });
});

Deno.test({ name: 'deno net: listener async iterator break closes listener', timeout: 10000 }, async () => {
    let listener: Deno.Listener | undefined;
    let client: Deno.Conn | undefined;
    try {
        listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    }

    try {
        const addr = listener.addr as Deno.NetAddr;
        const iterated = (async () => {
            for await (const conn of listener!) {
                conn.close();
                break;
            }
        })();
        client = await Deno.connect({ hostname: addr.hostname, port: addr.port });
        client.close();
        client = undefined;
        await withTimeout(iterated);
        await rejects(() => withTimeout(listener!.accept(), 250), Deno.errors.BadResource);
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    } finally {
        try { client?.close(); } catch {}
        try { listener?.close(); } catch {}
    }
});

Deno.test({ name: 'deno net: explicit undefined hostname binds wildcard address', timeout: 10000 }, () => {
    let listener: Deno.Listener | undefined;
    try {
        listener = Deno.listen({ hostname: undefined, port: 0 });
        const addr = listener.addr as Deno.NetAddr;
        strictEqual(addr.transport, 'tcp');
        strictEqual(addr.hostname, '0.0.0.0');
        ok(addr.port > 0);
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    } finally {
        try { listener?.close(); } catch {}
    }
});

Deno.test({ name: 'deno net: tcp closeWrite half-closes writes while reads continue', timeout: 10000 }, async () => {
    let listener: Deno.Listener;
    try {
        listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    }
    const addr = listener.addr as Deno.NetAddr;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let client: Deno.Conn;
    try {
        const accepted = listener.accept();
        client = await Deno.connect({ hostname: addr.hostname, port: addr.port });
        const serverConn = await accepted;
        const server = (async () => {
            try {
                const request = new Uint8Array(4);
                strictEqual(await serverConn.read(request), 4);
                strictEqual(decoder.decode(request), 'ping');
                strictEqual(await withTimeout(serverConn.read(new Uint8Array(1))), null);
                strictEqual(await serverConn.write(encoder.encode('pong')), 4);
            } finally {
                serverConn.close();
            }
        })();

        strictEqual(await client.write(encoder.encode('ping')), 4);
        await client.closeWrite();
        const response = new Uint8Array(4);
        strictEqual(await withTimeout(client.read(response)), 4);
        strictEqual(decoder.decode(response), 'pong');
        await server;
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    } finally {
        try { client!.close(); } catch {}
        listener.close();
    }
});

Deno.test({
    name: 'deno net: unix listener accepts a connection and reports socket addresses',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
}, async () => {
    const dir = Deno.makeTempDirSync();
    const socketPath = `${dir}/cno.sock`;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let listener: Deno.UnixListener | undefined;
    let client: Deno.UnixConn | undefined;
    let serverConn: Deno.UnixConn | undefined;

    try {
        listener = Deno.listen({ transport: 'unix', path: socketPath });
        strictEqual(listener.addr.transport, 'unix');
        strictEqual(listener.addr.path, socketPath);

        const accepted = listener.accept();
        client = await Deno.connect({ transport: 'unix', path: socketPath });
        serverConn = await withTimeout(accepted);

        strictEqual(client.localAddr.transport, 'unix');
        strictEqual(client.localAddr.path, socketPath);
        strictEqual(client.remoteAddr.transport, 'unix');
        strictEqual(client.remoteAddr.path, socketPath);
        strictEqual(serverConn.localAddr.transport, 'unix');
        strictEqual(serverConn.localAddr.path, socketPath);
        strictEqual(serverConn.remoteAddr.transport, 'unix');
        strictEqual(serverConn.remoteAddr.path, socketPath);

        strictEqual(await serverConn.write(encoder.encode('hello')), 5);
        const fromServer = new Uint8Array(5);
        strictEqual(await withTimeout(client.read(fromServer)), 5);
        strictEqual(decoder.decode(fromServer), 'hello');

        strictEqual(await client.write(encoder.encode('world')), 5);
        const fromClient = new Uint8Array(5);
        strictEqual(await withTimeout(serverConn.read(fromClient)), 5);
        strictEqual(decoder.decode(fromClient), 'world');
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    } finally {
        try { serverConn?.close(); } catch {}
        try { client?.close(); } catch {}
        try { listener?.close(); } catch {}
        removeTree(dir);
    }
});

Deno.test({
    name: 'deno net: unix listener reports address in use for the same socket path',
    ignore: Deno.build.os === 'windows',
}, () => {
    const dir = Deno.makeTempDirSync();
    const socketPath = `${dir}/cno.sock`;
    let listener: Deno.UnixListener | undefined;
    try {
        listener = Deno.listen({ transport: 'unix', path: socketPath });
        throws(() => Deno.listen({ transport: 'unix', path: socketPath }), Deno.errors.AddrInUse);
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    } finally {
        try { listener?.close(); } catch {}
        removeTree(dir);
    }
});

Deno.test({ name: 'deno net: udp listenDatagram sends receives and iterates messages', timeout: 10000 }, async () => {
    let alice: Deno.DatagramConn | undefined;
    let bob: Deno.DatagramConn | undefined;
    try {
        alice = Deno.listenDatagram({ transport: 'udp', hostname: '127.0.0.1', port: 0 });
        bob = Deno.listenDatagram({ transport: 'udp', hostname: '127.0.0.1', port: 0 });
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    }

    try {
        strictEqual(alice.addr.transport, 'udp');
        strictEqual(alice.addr.hostname, '127.0.0.1');
        ok(alice.addr.port > 0);
        strictEqual(bob.addr.transport, 'udp');
        strictEqual(bob.addr.hostname, '127.0.0.1');
        ok(bob.addr.port > 0);

        const first = new Uint8Array([1, 2, 3]);
        strictEqual(await alice.send(first, bob.addr), first.byteLength);
        const [received, remote] = await withTimeout(bob.receive());
        deepStrictEqual([...received], [1, 2, 3]);
        strictEqual(remote.transport, 'udp');
        strictEqual(remote.hostname, '127.0.0.1');
        strictEqual(remote.port, alice.addr.port);

        const iterator = bob[Symbol.asyncIterator]();
        const next = iterator.next();
        const second = new Uint8Array([4, 5]);
        strictEqual(await alice.send(second, bob.addr), second.byteLength);
        const iterated = await withTimeout(next);
        strictEqual(iterated.done, false);
        deepStrictEqual([...iterated.value[0]], [4, 5]);
        strictEqual(iterated.value[1].transport, 'udp');
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    } finally {
        try { alice?.close(); } catch {}
        try { bob?.close(); } catch {}
    }
});

Deno.test({ name: 'deno net: udp concurrent sends and iterator close settle cleanly', timeout: 10000 }, async () => {
    let socket: Deno.DatagramConn | undefined;
    let iteratorSocket: Deno.DatagramConn | undefined;
    try {
        socket = Deno.listenDatagram({ transport: 'udp', hostname: '127.0.0.1', port: 0 });
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    }

    try {
        const receive = socket.receive();
        const sends = Promise.all([
            socket.send(new Uint8Array(), socket.addr),
            socket.send(new Uint8Array([1, 2, 3]), socket.addr),
        ]);
        const [received] = await withTimeout(receive);
        ok(received.byteLength === 0 || received.byteLength === 3);
        const sent = await sends;
        deepStrictEqual(sent.sort((a, b) => a - b), [0, 3]);

        socket.close();
        socket = undefined;

        iteratorSocket = Deno.listenDatagram({ transport: 'udp', hostname: '127.0.0.1', port: 0 });
        const iterator = iteratorSocket[Symbol.asyncIterator]();
        const next = iterator.next();
        iteratorSocket.close();
        deepStrictEqual(await withTimeout(next), { value: undefined, done: true });
        deepStrictEqual(await withTimeout(iterator.next()), { value: undefined, done: true });
    } catch (error) {
        if (isSandboxSocketError(error)) return;
        throw error;
    } finally {
        try { socket?.close(); } catch {}
        try { iteratorSocket?.close(); } catch {}
    }
});
