import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert';
import { EventEmitter } from 'node:events';
import { H2Stream } from '@cnojs/http/h2';
import { h2Available } from '@cnojs/http/h2-native';
import { Socket } from '../../cno/src/node/net/socket.ts';
import { TLSSocket } from '../../cno/src/node/tls/socket.ts';
import { Http2ServerResponse } from '../../cno/src/node/http2/message.ts';
import { ClientHttp2Stream, ServerHttp2Stream } from '../../cno/src/node/http2/stream.ts';
import { attachServerSession } from '../../cno/src/node/http2/server.ts';
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

function responseTransport() {
    const written = Promise.withResolvers<void>();
    const resets: number[] = [];
    let onError: ((error: Error) => void) | undefined;
    void written.promise.catch(() => {});
    const protocol = {
        id: 1,
        localEnded: false,
        headerList: [[':method', 'GET']],
        whenError(listener: (error: Error) => void) { onError = listener; },
        whenClosed() { return () => {}; },
        async *bodyChunks() {},
        respond(_headers: unknown, endStream: boolean) { this.localEnded = endStream; },
        sendData(_data: Uint8Array, endStream: boolean) {
            strictEqual(this.localEnded, false);
            this.localEnded = endStream;
        },
        waitForLocalEnd() {
            strictEqual(this.localEnded, true);
            return written.promise;
        },
        abort(code: number) { resets.push(code); },
    };
    const stream = new ServerHttp2Stream(protocol as unknown as ConstructorParameters<typeof ServerHttp2Stream>[0]);
    const response = new Http2ServerResponse(stream);
    return {
        stream, response, protocol, resets,
        finishOutput: written.resolve,
        resetPeer(error: Error) {
            onError?.(error);
            written.reject(error);
        },
    };
}

for (const throwing of [false, true]) {
    Deno.test({
        name: `http2: server protocol failures terminate the session (${throwing ? 'throwing' : 'normal'} listener)`,
        ignore: !h2Available(),
    }, () => {
        const host = new EventEmitter();
        const sessions = new Set<NonNullable<ReturnType<typeof attachServerSession>>>();
        const events: string[] = [];
        const socket = new Socket();
        socket._tcp = rawTransport(events);
        const failure = new Error('HTTP/2 transport failed');
        const listenerFailure = new Error('session listener failed');
        host.on('sessionError', (error, session) => {
            strictEqual(error, failure);
            strictEqual(session.destroyed, true);
            events.push('server-error');
        });
        const session = attachServerSession(host, sessions, socket, false)!;
        session.on('error', error => {
            strictEqual(error, failure);
            strictEqual(session.destroyed, true);
            events.push('session-error');
            if (throwing) throw listenerFailure;
        });
        session.on('close', () => {
            strictEqual(Reflect.get(session, 'conn'), null);
            events.push('session-close');
        });
        const conn = Reflect.get(session, 'conn');
        try {
            if (throwing) throws(() => conn.destroy(failure), error => error === listenerFailure);
            else conn.destroy(failure);
            deepStrictEqual(events, ['close', 'server-error', 'session-error', 'session-close']);
            strictEqual(session.destroyed, true);
            strictEqual(sessions.size, 0);
        } finally {
            conn.destroy();
            session.destroy();
        }
    });
}

Deno.test('http2: destroying attached streams resets the protocol once and settles pending input', async () => {
    for (const server of [false, true]) {
        for (const failure of [false, true]) {
            const resets: number[] = [];
            const protocol = new H2Stream({ session: {
                reset(_id: number, code: number) {
                    resets.push(code);
                    protocol.acceptClose(code);
                },
            } } as unknown as ConstructorParameters<typeof H2Stream>[0], 1, server);
            protocol.acceptHeaders([[server ? ':method' : ':status', server ? 'POST' : '200']], 0);
            const input = protocol.bodyChunks().next();
            const endedInput = input.then(() => {}, () => {});
            const stream = server ? new ServerHttp2Stream(protocol) : new ClientHttp2Stream(protocol, 'POST');
            const errors: Error[] = [];
            stream.on('error', error => errors.push(error));
            const closed = new Promise<void>(resolve => stream.once('close', resolve));
            const error = failure ? new Error('cancelled stream') : null;
            stream.destroy(error);
            stream.destroy(error);
            stream.close(8);
            await Promise.all([closed, endedInput]);
            deepStrictEqual(resets, [failure ? 2 : 0]);
            deepStrictEqual(errors, error ? [error] : []);
            strictEqual(protocol.remoteEnded, true);
        }
    }
});

Deno.test('http2: explicit stream close preserves its reset code without resetting peer failures', async () => {
    for (const server of [false, true]) {
        for (const peerFailure of [false, true]) {
            const resets: number[] = [];
            const protocol = new H2Stream({ session: {
                reset(_id: number, code: number) {
                    resets.push(code);
                    protocol.acceptClose(code);
                },
            } } as unknown as ConstructorParameters<typeof H2Stream>[0], 1, server);
            protocol.acceptHeaders([[server ? ':method' : ':status', server ? 'POST' : '200']], 0);
            const stream = server ? new ServerHttp2Stream(protocol) : new ClientHttp2Stream(protocol, 'POST');
            stream.on('error', () => {});
            const closed = new Promise<void>(resolve => stream.once('close', resolve));
            if (peerFailure) protocol.acceptClose(8);
            else stream.close(8);
            await closed;
            stream.close(0);
            deepStrictEqual(resets, peerFailure ? [] : [8]);
        }
    }
});

Deno.test('http2: a peer reset before the stream finish microtask settles response.end once', async () => {
    const { stream, response, protocol, resetPeer } = responseTransport();
    const failure = Object.assign(new Error('peer reset'), { code: 'ECONNRESET' });
    const errors: Error[] = [];
    const callbacks: Array<Error | null | undefined> = [];
    const events: string[] = [];
    stream.on('error', error => errors.push(error));
    const closed = new Promise<void>(resolve => stream.once('close', resolve));
    response.on('error', error => { errors.push(error); events.push('error'); });
    response.on('close', () => events.push('close'));
    response.on('finish', () => events.push('finish'));
    response.end(error => { callbacks.push(error); events.push('callback'); });
    strictEqual(protocol.localEnded, true);
    resetPeer(failure);
    await closed;
    await Promise.resolve();
    deepStrictEqual(callbacks, [failure]);
    deepStrictEqual(errors, [failure, failure]);
    deepStrictEqual(events, ['error', 'close', 'callback']);
    strictEqual(response.destroyed, true);
    strictEqual(response.writableFinished, false);
});

Deno.test('http2: normal stream autoDestroy waits for physical response output without a reset', async () => {
    const { stream, response, finishOutput, resets } = responseTransport();
    const errors: Error[] = [];
    const callbacks: Array<Error | null | undefined> = [];
    const events: string[] = [];
    stream.on('error', error => errors.push(error));
    const streamClosed = new Promise<void>(resolve => stream.once('close', resolve));
    response.on('error', error => errors.push(error));
    response.on('finish', () => events.push('finish'));
    const responseClosed = new Promise<void>(resolve => response.once('close', resolve));
    stream.resume();
    response.end(error => { callbacks.push(error); events.push('callback'); });
    await streamClosed;
    strictEqual(stream.writableFinished, true);
    strictEqual(response.finished, true, 'finished reflects end() while protocol output is draining');
    strictEqual(response.writableFinished, false);
    deepStrictEqual(callbacks, []);
    deepStrictEqual(events, []);
    deepStrictEqual(resets, []);
    finishOutput();
    await responseClosed;
    strictEqual(callbacks.length, 1);
    strictEqual(callbacks[0] == null, true);
    strictEqual(response.writableFinished, true);
    deepStrictEqual(events, ['callback', 'finish']);
    deepStrictEqual(errors, []);
    deepStrictEqual(resets, []);
});

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
