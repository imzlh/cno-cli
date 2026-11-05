import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { connect, listen } from 'bun';

// Inner deadlines stay well below the enclosing test timeouts (AGENT.md).

async function until(condition: () => boolean, label: string, budgetMs = 3000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`condition not met in time: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

const decode = (chunk: unknown): string => Buffer.from(chunk as Uint8Array).toString();

Deno.test({ name: 'bun.net: echo between Bun.listen and Bun.connect', timeout: 10000 }, async () => {
    let opened = 0;
    const listener = listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: {
            open() {
                opened++;
            },
            data(socket, chunk) {
                socket.write(chunk);
            },
        },
    });
    ok(listener.port > 0);
    strictEqual(listener.hostname, '127.0.0.1');

    let closed = false;
    const received: string[] = [];
    try {
        const socket = await connect({
            hostname: '127.0.0.1',
            port: listener.port,
            data: { tag: 'client' },
            socket: {
                binaryType: 'uint8array',
                open(sock) {
                    strictEqual(sock.data.tag, 'client');
                    strictEqual(sock.remoteAddress, '127.0.0.1');
                    strictEqual(sock.remotePort, listener.port);
                    strictEqual(sock.readyState, 1);
                    sock.write('ping');
                },
                data(_socket, chunk) {
                    received.push(decode(chunk));
                    if (received.length === 1) _socket.end();
                },
                close() {
                    closed = true;
                },
            },
        });
        await until(() => closed, 'client close');
        deepStrictEqual(received, ['ping']);
        ok(opened >= 1);
        strictEqual(socket.readyState, 0);
        strictEqual(socket.write('after close'), -1);
    } finally {
        listener.stop();
    }
});

Deno.test({ name: 'bun.net: binaryType controls data chunk shapes', timeout: 10000 }, async () => {
    for (const binaryType of ['arraybuffer', 'buffer', 'uint8array', undefined] as const) {
        const listener = listen({
            hostname: '127.0.0.1',
            port: 0,
            socket: { data(socket, chunk) { socket.write('x'); } },
        });
        let shape: string | undefined;
        let closed = false;
        try {
            await connect({
                hostname: '127.0.0.1',
                port: listener.port,
                socket: {
                    binaryType,
                    open(sock) {
                        sock.write('i');
                    },
                    data(_socket, chunk) {
                        shape = chunk instanceof ArrayBuffer
                            ? 'arraybuffer'
                            : Buffer.isBuffer(chunk)
                            ? 'buffer'
                            : chunk instanceof Uint8Array
                            ? 'uint8array'
                            : 'other';
                        _socket.end();
                    },
                    close() {
                        closed = true;
                    },
                },
            });
            await until(() => closed, `close for ${String(binaryType)}`);
            strictEqual(shape, binaryType ?? 'buffer');
        } finally {
            listener.stop();
        }
    }
});

Deno.test({ name: 'bun.net: allowHalfOpen keeps the server socket writable after client FIN', timeout: 10000 }, async () => {
    let serverSawEnd = false;
    let serverReadyStateAfterEnd: number | undefined;
    const listener = listen({
        hostname: '127.0.0.1',
        port: 0,
        allowHalfOpen: true,
        socket: {
            data(socket, chunk) {
                socket.write(Buffer.from(chunk).toString());
            },
            end(socket) {
                serverSawEnd = true;
                serverReadyStateAfterEnd = socket.readyState;
                socket.write('-ok');
                socket.end();
            },
        },
    });
    const received: string[] = [];
    let closed = false;
    try {
        await connect({
            hostname: '127.0.0.1',
            port: listener.port,
            socket: {
                open(sock) {
                    sock.write('abc');
                },
                data(sock, chunk) {
                    received.push(decode(chunk));
                    if (received.length === 1) sock.end();
                },
                close() {
                    closed = true;
                },
            },
        });
        await until(() => closed, 'client close');
        ok(serverSawEnd);
        strictEqual(serverReadyStateAfterEnd, 1);
        strictEqual(received.join(''), 'abc-ok');
    } finally {
        listener.stop();
    }
});

Deno.test({ name: 'bun.net: connect failure routes connectError then rejects', timeout: 10000 }, async () => {
    let connectError: unknown;
    let rejected = false;
    try {
        // Port 1 on loopback is refused by the kernel in test environments.
        await connect({
            hostname: '127.0.0.1',
            port: 1,
            socket: {
                connectError(_socket, error) {
                    connectError = error;
                },
            },
        });
    } catch (error) {
        rejected = true;
        ok(error instanceof Error);
    }
    ok(rejected, 'Bun.connect should have rejected');
    ok(connectError instanceof Error, 'connectError handler must fire before the rejection');
});

Deno.test({ name: 'bun.net: shutdown(true) terminates the connection (documented deviation)', timeout: 10000 }, async () => {
    const listener = listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: { data(socket, chunk) { socket.write(chunk); } },
    });
    try {
        let echoed = false;
        const socket = await connect({
            hostname: '127.0.0.1',
            port: listener.port,
            socket: {
                open(sock) { sock.write('ping'); },
                data() { echoed = true; },
            },
        });
        await until(() => echoed, 'echo received');
        socket.shutdown(true);
        await until(() => socket.readyState === 0, 'socket closed');
        strictEqual(socket.write('after shutdown(true)'), -1);
    } finally {
        listener.stop();
    }
});

Deno.test({ name: 'bun.net: stop(true) terminates active connections', timeout: 10000 }, async () => {
    const listener = listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: { data(socket, chunk) { socket.write(chunk); } },
    });
    let serverClosed = false;
    const sockets: unknown[] = [];
    const client = await connect({
        hostname: '127.0.0.1',
        port: listener.port,
        socket: {
            data(sock, chunk) {
                sockets.push(chunk);
            },
            close() {
                serverClosed = true;
            },
        },
    });
    strictEqual(client.readyState, 1);
    listener.stop(true);
    await until(() => serverClosed, 'client close after stop(true)');
    strictEqual(client.readyState, 0);
});

Deno.test({ name: 'bun.net: reload replaces handlers for later connections', timeout: 10000 }, async () => {
    const replies: string[] = [];
    const listener = listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: { data(socket) { socket.write('old'); } },
    });
    listener.reload({ socket: { data(socket) { socket.write('new'); } } });
    let closed = false;
    try {
        await connect({
            hostname: '127.0.0.1',
            port: listener.port,
            socket: {
                open(sock) { sock.write('go'); },
                data(_socket, chunk) {
                    replies.push(decode(chunk));
                    _socket.end();
                },
                close() {
                    closed = true;
                },
            },
        });
        await until(() => closed, 'client close after reload');
        deepStrictEqual(replies, ['new']);
    } finally {
        listener.stop();
    }
});

Deno.test({ name: 'bun.net: argument and option validation' }, async () => {
    throws(() => listen({ hostname: '127.0.0.1', port: 0, tls: true, socket: {} } as never), /TLS/);
    await rejects(
        () => connect({ hostname: '127.0.0.1', port: 0, unix: '/tmp/bun-net-test.sock', socket: {} } as never),
        /Unix/,
    );
    throws(() => listen({ hostname: '127.0.0.1', port: 0, reusePort: true, socket: {} } as never), /reusePort/);
    throws(() => listen({ hostname: '127.0.0.1', port: 70000, socket: {} }), RangeError);
    throws(() => listen({ hostname: '', port: 0, socket: {} }), TypeError);
    throws(() => listen({ hostname: '127.0.0.1', port: 0 }), TypeError);
    throws(() => listen({ hostname: '127.0.0.1', port: 0, socket: { binaryType: 'dataview' } as never }), TypeError);
    await rejects(() => connect(null as never), TypeError);
    throws(() => listen(null as never), TypeError);
});
