import { rejects, strictEqual } from 'node:assert';
import { Server } from '../../http/src/server.ts';
import { TcpSocket } from '../../http/src/socket.ts';
import type { SocketTransport } from '../../http/src/socket.ts';
import { h1 } from '../../http/src/h1.ts';
import type { ProtocolConnection } from '../../http/src/protocol.ts';

for (const mode of ['close', 'shutdown', 'escalate'] as const) {
    Deno.test(`http server: ${mode} closes a transport still in its handshake`, async () => {
        const server = new Server(() => {}, { port: 0 });
        let listenerClosed = false;
        const listener = {
            onconnection: null as unknown as CModuleStreams.Stream['onconnection'],
            close() { listenerClosed = true; },
        };
        Reflect.set(server, 'listener', listener);
        Reflect.set(server, 'listening', true);
        Reflect.set(server, 'sslContext', {});
        await server.acceptLoop();

        let resolveRead: (size: number) => void = () => {};
        let transportCloses = 0;
        const transport = {
            onread() {},
            startRead() {},
            stopRead() {},
            read: () => new Promise<number>(resolve => { resolveRead = resolve; }),
            write: async () => 0,
            close() { transportCloses++; resolveRead(0); },
        } as SocketTransport;

        const originalHandshake = TcpSocket.prototype.serverHandshake;
        let handshake: Promise<void> | undefined;
        TcpSocket.prototype.serverHandshake = function () {
            return handshake = this.read().then(() => {
                throw Object.assign(new Error('handshake closed'), { code: 'ECONNRESET' });
            });
        };
        try {
            listener.onconnection(undefined, transport as CModuleStreams.Stream);
            strictEqual(transportCloses, 0);
            if (mode === 'close') server.close();
            else {
                const graceful = mode === 'escalate' ? server.closeGracefully() : undefined;
                const drained = server.shutdown();
                strictEqual(transportCloses, 1, 'force shutdown must close the pending read immediately');
                await drained;
                if (graceful) await graceful;
            }
            strictEqual(listenerClosed, true);
            strictEqual(transportCloses, 1);
            await rejects(handshake!, { code: 'ECONNRESET' });
        } finally {
            TcpSocket.prototype.serverHandshake = originalHandshake;
            transport.close();
            server.close();
        }
    });
}

Deno.test('http server: a late accept after close releases its transport', async () => {
    const server = new Server(() => {}, { port: 0 });
    const listener = {
        onconnection: null as unknown as CModuleStreams.Stream['onconnection'],
        close() {},
    };
    Reflect.set(server, 'listener', listener);
    Reflect.set(server, 'listening', true);
    await server.acceptLoop();
    server.close();

    let closed = 0;
    const transport = {
        onread() {}, startRead() {}, stopRead() {},
        read: async () => 0, write: async () => 0,
        close() { closed++; },
    } as unknown as CModuleStreams.Stream;
    listener.onconnection(undefined, transport);
    strictEqual(closed, 1);
});

Deno.test('http server: a protocol accepted during close is released before serving requests', async () => {
    const server = new Server(() => { throw new Error('closed server cannot serve requests'); }, { port: 0 });
    const listener = {
        onconnection: null as unknown as CModuleStreams.Stream['onconnection'],
        close() {},
    };
    Reflect.set(server, 'listener', listener);
    Reflect.set(server, 'listening', true);
    await server.acceptLoop();

    const originalAccept = h1.server.accept;
    let accept: (connection: ProtocolConnection) => void = () => {};
    h1.server.accept = () => new Promise(resolve => { accept = resolve; });
    let protocolCloses = 0;
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const connection = {
        close() { protocolCloses++; resolveClosed(); },
    } as unknown as ProtocolConnection;
    const transport = {
        onread() {}, startRead() {}, stopRead() {}, close() {},
        read: async () => 0, write: async () => 0,
    } as unknown as CModuleStreams.Stream;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        listener.onconnection(undefined, transport);
        server.close();
        accept(connection);
        await Promise.race([
            closed,
            new Promise<void>((_, reject) => {
                timer = setTimeout(() => reject(new Error('protocol connection was retained after close')), 1000);
            }),
        ]);
        strictEqual(protocolCloses, 1);
    } finally {
        clearTimeout(timer);
        h1.server.accept = originalAccept;
        server.close();
    }
});
