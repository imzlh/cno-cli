import { deepStrictEqual, strictEqual } from 'node:assert';
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
