import { ok, rejects, strictEqual } from 'node:assert';
import { Server } from '../../http/src/server.ts';
import { TcpSocket } from '../../http/src/socket.ts';
import type { SocketTransport } from '../../http/src/socket.ts';
import { h1 } from '../../http/src/h1.ts';
import type { ProtocolConnection } from '../../http/src/protocol.ts';
import { H2Connection } from '../../http/src/h2.ts';
import { h2Available, requireH2 } from '../../http/src/h2-native.ts';

for (const fail of [false, true]) {
    Deno.test({ name: `http h2: output ${fail ? 'failure rejects completion after native close' : 'completion and graceful drain wait for transport writes'}`, ignore: !h2Available() }, async () => {
        const gate = Promise.withResolvers<void>();
        const submitted = Promise.withResolvers<void>();
        const written: Uint8Array[] = [];
        const fault = Object.assign(new Error('transport write failed'), { code: 'EPIPE' });
        let closed = false;
        let terminal = 0;
        let settled = false;
        let output: Promise<void> | undefined;
        const transport = {
            onReadable() {},
            async write(bytes: Uint8Array) {
                await gate.promise;
                if (fail) throw fault;
                ok(!closed, 'graceful close must preserve queued writes');
                written.push(bytes.slice());
            },
            close() { closed = true; },
        } as unknown as TcpSocket;
        const connection = new H2Connection(transport, true, false);
        const client = new (requireH2().Session)(false);
        client.onsend = bytes => connection.receive(bytes);
        connection.onStreamOpen = stream => {
            stream.whenClosed(() => { if (!stream.localComplete) terminal++; });
            stream.respond([[':status', '200']]);
            stream.sendData(new TextEncoder().encode('tail-response'), true);
            output = stream.waitForLocalEnd();
            void output.then(() => { settled = true; }, () => { settled = true; });
            submitted.resolve();
        };
        try {
            client.request([
                [':method', 'GET'], [':path', '/'], [':scheme', 'http'], [':authority', 'local'],
            ], true);
            await submitted.promise;
            connection.beginDrain();
            await Promise.resolve();
            await Promise.resolve();
            strictEqual(settled, false);
            strictEqual(closed, false);
            gate.resolve();
            if (fail) {
                await rejects(output!, error => error === fault);
                strictEqual(terminal, 1, 'write failure must still reach a natively closed stream');
            } else {
                await output;
                for (let turn = 0; turn < 100 && !closed; turn++) await Promise.resolve();
                strictEqual(closed, true, 'drain must finish after writes settle');
                strictEqual(terminal, 0);
                let body = '';
                let ended = false;
                client.ondata = (_id, bytes, end) => { body += new TextDecoder().decode(bytes); ended ||= end; };
                client.onsend = () => {};
                for (const bytes of written) client.receive(bytes);
                strictEqual(body, 'tail-response');
                strictEqual(ended, true);
            }
        } finally {
            gate.resolve();
            connection.destroy();
            client.destroy();
        }
    });
}

Deno.test({ name: 'http h2: bodyless client HEADERS completion survives synchronous native flush', ignore: !h2Available() }, async () => {
    const gate = Promise.withResolvers<void>();
    const socket = { onReadable() {}, write: () => gate.promise, close() {} } as unknown as TcpSocket;
    const connection = new H2Connection(socket, false, false);
    try {
        const stream = connection.request([
            [':method', 'GET'], [':path', '/'], [':scheme', 'http'], [':authority', 'local'],
        ], true);
        strictEqual(stream.localEnded, true);
        strictEqual(stream.localComplete, false);
        const complete = stream.waitForLocalEnd();
        gate.resolve();
        await complete;
        strictEqual(stream.localComplete, true);
    } finally {
        gate.resolve();
        connection.destroy();
    }
});

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

Deno.test('http server: maxConnections includes transports in protocol handshake', async () => {
    const server = new Server(() => {}, { port: 0, maxConnections: 1 });
    const listener = {
        onconnection: null as unknown as CModuleStreams.Stream['onconnection'],
        close() {},
    };
    Reflect.set(server, 'listener', listener);
    Reflect.set(server, 'listening', true);
    Reflect.set(server, 'sslContext', {});
    await server.acceptLoop();

    let rejectHandshake: ((error: Error) => void) | undefined;
    let firstClosed = 0;
    const first = {
        onread() {}, startRead() {}, stopRead() {},
        read: async () => 0,
        write: async () => 0,
        close() {
            firstClosed++;
            rejectHandshake?.(Object.assign(new Error('handshake closed'), { code: 'ECONNRESET' }));
        },
    } as unknown as CModuleStreams.Stream;
    let secondClosed = 0;
    const second = {
        onread() {}, startRead() {}, stopRead() {},
        read: async () => 0, write: async () => 0,
        close() { secondClosed++; },
    } as unknown as CModuleStreams.Stream;

    const originalHandshake = TcpSocket.prototype.serverHandshake;
    TcpSocket.prototype.serverHandshake = function () {
        return new Promise<void>((_resolve, reject) => { rejectHandshake = reject; });
    };
    try {
        listener.onconnection(undefined, first);
        strictEqual(Reflect.get(server, 'pendingConnections').size, 1);
        listener.onconnection(undefined, second);
        strictEqual(secondClosed, 1);
    } finally {
        TcpSocket.prototype.serverHandshake = originalHandshake;
        server.close();
        strictEqual(firstClosed, 1);
    }
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
