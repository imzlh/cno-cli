import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { EventEmitter } from 'node:events';
import { Socket } from '../../cno/src/node/net/socket.ts';
import { TLSSocket } from '../../cno/src/node/tls/socket.ts';
import { takeTcpForH2, takeTlsForH2 } from '../../cno/src/node/http2/transport.ts';

function rawTransport(events: string[]) {
    return {
        onread: null,
        startRead() {},
        stopRead() {},
        read: async () => 0,
        write: async () => { events.push('write'); return 0; },
        close() { events.push('close'); },
    } as unknown as CModuleStreams.TCP;
}

Deno.test('http2: an adopted underlying socket emits TLS error before close', async () => {
    const events: string[] = [];
    const underlying = new Socket();
    underlying._tcp = rawTransport(events);
    const tls = Object.assign(new EventEmitter(), {
        _underlying: underlying,
        _sslPipe: { shutdown() { events.push('shutdown'); } },
        _destroyed: false,
        destroy: TLSSocket.prototype.destroy,
    }) as unknown as TLSSocket;
    // Preserve the forwarding listeners installed by TLSSocket._initTls.
    underlying.on('error', error => tls.emit('error', error));
    underlying.on('close', () => { if (!tls._destroyed) tls.destroy(); });
    tls.on('error', () => events.push('tls-error'));
    const closed = new Promise<void>(resolve => tls.once('close', () => {
        events.push('tls-close');
        resolve();
    }));
    const transport = takeTlsForH2(tls);
    underlying.destroy(new Error('underlying failed'));
    await closed;
    transport.close();
    deepStrictEqual(events, ['shutdown', 'close', 'tls-error', 'tls-close']);
    strictEqual(transport.sslPipe, null);
});

Deno.test('http2: destroying an adopted TCP facade closes the transport once', async () => {
    const events: string[] = [];
    const socket = new Socket();
    socket._tcp = rawTransport(events);
    const transport = takeTcpForH2(socket);
    const queued = transport.write(new Uint8Array([1]));
    socket.destroy();
    transport.close();
    await rejects(queued, { code: 'ECONNRESET' });
    deepStrictEqual(events, ['close']);
});

for (const wrapped of [false, true]) {
    for (const closer of ['transport', 'tls'] as const) {
        Deno.test(`http2: adopted TLS releases its pipe (${wrapped ? 'Socket' : 'native'}, ${closer})`, async () => {
            const events: string[] = [];
            const raw = rawTransport(events);
            const underlying = wrapped ? new Socket() : raw;
            if (underlying instanceof Socket) underlying._tcp = raw;
            const tls = {
                _underlying: underlying,
                _sslPipe: { shutdown() { events.push('shutdown'); } },
                destroy() { events.push('destroy'); return this; },
            } as unknown as TLSSocket;
            const transport = takeTlsForH2(tls);
            transport.onReadable(() => {});
            const queued = transport.write(new Uint8Array([1]));
            if (closer === 'transport') transport.close();
            else tls.destroy();
            tls.destroy();
            transport.close();
            await rejects(queued, { code: 'ECONNRESET' });
            deepStrictEqual(events, ['shutdown', 'close', 'destroy']);
            strictEqual(raw.onread, null);
            strictEqual(transport.sslPipe, null);
            strictEqual(tls._sslPipe, null);
            strictEqual(tls._underlying, null);
        });
    }
}
