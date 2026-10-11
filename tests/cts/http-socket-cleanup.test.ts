import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { TcpSocket } from '../../http/src/socket.ts';
import type { SocketTransport } from '../../http/src/socket.ts';

Deno.test('http socket: TLS input failure reaches the owner after detaching the reader', () => {
    const fault = new Error('invalid TLS record');
    const events: string[] = [];
    const transport = {
        onread: null,
        startRead() {},
        stopRead() {},
        read: async () => 0,
        write: async () => 0,
        close() { events.push('close'); },
    } as unknown as SocketTransport;
    const socket = new TcpSocket(transport);
    socket.sslPipe = {
        feed() { throw fault; },
        shutdown() {},
    } as unknown as CModuleSSL.Pipe;

    socket.onReadable(() => { events.push('data'); }, error => {
        strictEqual(error, fault);
        strictEqual(transport.onread, null, 'the failing reader must be detached before delivery');
        events.push('error');
        socket.close();
    });
    try {
        transport.onread(new Uint8Array([0xff]), undefined);
        deepStrictEqual(events, ['error', 'close']);
        strictEqual(socket.sslPipe, null, 'the owner must be able to release the TLS session');
    } finally {
        socket.close();
    }
});

Deno.test('http socket: close releases TLS and transport when stopping reads fails', () => {
    const events: string[] = [];
    const transport = {
        onread() {},
        startRead() {},
        stopRead() { throw new Error('read already stopped'); },
        read: async () => 0,
        write: async () => 0,
        close() { events.push('close'); },
    } as SocketTransport;
    const socket = new TcpSocket(transport);
    socket.sslPipe = {
        shutdown() { events.push('shutdown'); },
    } as CModuleSSL.Pipe;

    socket.close();
    socket.close();
    deepStrictEqual(events, ['shutdown', 'close']);
    strictEqual(transport.onread, null);
    strictEqual(socket.sslPipe, null);
});

for (const tls of [false, true]) {
    Deno.test(`http socket: queued writes after close never reach the transport (${tls ? 'TLS' : 'TCP'})`, async () => {
        let writes = 0;
        const transport = {
            onread() {},
            startRead() {},
            stopRead() {},
            read: async () => 0,
            write: async () => ++writes,
            close() {},
        } as SocketTransport;
        const socket = new TcpSocket(transport);
        if (tls) socket.sslPipe = { shutdown() {} } as CModuleSSL.Pipe;

        const queued = socket.write(new Uint8Array([1, 2, 3]));
        socket.close();
        await rejects(queued, { code: 'ECONNRESET' });
        await rejects(socket.write(new Uint8Array([4])), { code: 'ECONNRESET' });
        strictEqual(writes, 0);
    });
}

Deno.test('http socket: partial TLS input survives reuse of the raw read buffer', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const fed: number[][] = [];
    const transport = {
        onread() {},
        startRead() {},
        stopRead() {},
        async read(buffer: Uint8Array) {
            const chunk = chunks.shift();
            if (!chunk) return 0;
            buffer.set(chunk);
            return chunk.length;
        },
        write: async () => 0,
        close() {},
    } as SocketTransport;
    const socket = new TcpSocket(transport);
    socket.sslPipe = {
        feed(data: Uint8Array) {
            fed.push([...data]);
            return fed.length === 1 ? 1 : data.length;
        },
        read: () => fed.length === 2 ? new Uint8Array([9]).buffer : null,
        handshake: () => true,
        getOutput: () => null,
        shutdown() {},
    } as unknown as CModuleSSL.Pipe;

    try {
        deepStrictEqual(await socket.read(), new Uint8Array([9]));
        deepStrictEqual(fed, [[1, 2], [2, 3, 4]]);
    } finally {
        socket.close();
    }
});

Deno.test({ name: 'http socket: a stalled TLS write cancels its own read at the deadline', timeout: 20000 }, async () => {
    let resolveRead: (size: number) => void = () => {};
    let closed = 0;
    const transport = {
        onread() {}, startRead() {}, stopRead() {},
        read: () => new Promise<number>(resolve => { resolveRead = resolve; }),
        write: async () => 0,
        close() { closed++; resolveRead(0); },
    } as SocketTransport;
    const socket = new TcpSocket(transport);
    socket.sslPipe = {
        write: () => null,
        getOutput: () => null,
        shutdown() {},
    } as unknown as CModuleSSL.Pipe;
    const cleanup = setTimeout(() => socket.close(), 15000);
    try {
        await rejects(socket.write(new Uint8Array([1])), { code: 'ETIMEDOUT' });
        strictEqual(closed, 1, 'timing out must cancel the transport read');
    } finally {
        clearTimeout(cleanup);
        socket.close();
    }
});
