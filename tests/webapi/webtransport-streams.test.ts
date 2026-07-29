import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import {
    WebTransport,
    WebTransportError,
    WebTransportReceiveStream,
    WebTransportSendStream,
    WebTransportSession,
} from '../../cno/src/webapi/webtransport.ts';

class FakeConnection implements CModuleExternalQuic.Connection {
    onstream: CModuleExternalQuic.Callback<[number, boolean]> | null = null;
    ondata: CModuleExternalQuic.Callback<[number, Uint8Array, boolean]> | null = null;
    onstreamreset: CModuleExternalQuic.Callback<[number, number]> | null = null;
    onstreamstop: CModuleExternalQuic.Callback<[number, number]> | null = null;
    ondatagram: CModuleExternalQuic.Callback<[Uint8Array]> | null = null;
    onconnected: CModuleExternalQuic.Callback<[]> | null = null;
    onclose: CModuleExternalQuic.Callback<[number, string]> | null = null;
    onerror: CModuleExternalQuic.Callback<[string]> | null = null;
    readonly streamWrites: { id: number; data: Uint8Array; fin: boolean }[] = [];
    readonly resets: { id: number; code: number }[] = [];
    readonly stops: { id: number; code: number }[] = [];
    readonly datagrams: Uint8Array[] = [];
    #nextStreamId = 0;

    openStream(bidirectional = true): number {
        const id = this.#nextStreamId | (bidirectional ? 0 : 2);
        this.#nextStreamId += 4;
        return id;
    }

    sendStream(streamId: number, data: Uint8Array | ArrayBuffer, fin = false): void {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        this.streamWrites.push({ id: streamId, data: new Uint8Array(bytes), fin });
    }

    resetStream(streamId: number, errorCode = 0): void {
        this.resets.push({ id: streamId, code: errorCode });
    }

    stopSending(streamId: number, errorCode = 0): void {
        this.stops.push({ id: streamId, code: errorCode });
    }

    sendDatagram(data: Uint8Array | ArrayBuffer): void {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        this.datagrams.push(new Uint8Array(bytes));
    }

    close(errorCode = 0, reason = ''): void {
        invoke(this.onclose, errorCode, reason);
    }

    getStats(): CModuleExternalQuic.Stats {
        return {
            rttMin: 0,
            rttLatest: 0,
            rttSmoothed: 0,
            pktSent: 0,
            pktLost: 0,
            pktReceived: 0,
            bytesSent: 0,
            bytesReceived: 0,
            cwnd: 0,
        };
    }
}

function invoke<T extends unknown[]>(callback: CModuleExternalQuic.Callback<T> | null, ...args: T): void {
    if (!callback) return;
    if (Array.isArray(callback)) callback[0].apply(callback[1], args);
    else callback(...args);
}

Deno.test('WebTransport streams: use standard stream primitives and FIN', async () => {
    const conn = new FakeConnection();
    const send = new WebTransportSendStream(conn, 4, { sendOrder: 3 });
    ok(send instanceof WritableStream);
    strictEqual(send.sendOrder, 3);
    const writer = send.getWriter();
    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.close();
    deepStrictEqual(conn.streamWrites.map(write => [write.id, [...write.data], write.fin]), [
        [4, [1, 2, 3], false],
        [4, [], true],
    ]);

    const receive = new WebTransportReceiveStream(conn, 8);
    ok(receive instanceof ReadableStream);
    const reader = receive.getReader();
    receive._push(new Uint8Array([4, 5]));
    receive._close();
    deepStrictEqual(await reader.read(), { done: false, value: new Uint8Array([4, 5]) });
    deepStrictEqual(await reader.read(), { done: true, value: undefined });
});

Deno.test('WebTransport streams: route incoming data, reset, stop and datagrams', async () => {
    const conn = new FakeConnection();
    const session = new WebTransportSession(conn);
    invoke(conn.onconnected);
    await session.ready;

    const incoming = session.incomingUnidirectionalStreams.getReader().read();
    invoke(conn.onstream, 2, false);
    const { value: receive } = await incoming;
    ok(receive instanceof WebTransportReceiveStream);
    const read = receive!.getReader().read();
    invoke(conn.ondata, 2, new Uint8Array([9]), true);
    deepStrictEqual(await read, { done: false, value: new Uint8Array([9]) });

    const bidi = await session.createBidirectionalStream();
    const closed = bidi.writable.getWriter().closed;
    invoke(conn.onstreamstop, bidi.writable.id, 17);
    const streamError = await closed.then(() => null, error => error);
    ok(streamError instanceof WebTransportError);
    strictEqual(streamError.streamErrorCode, 17);

    const datagramRead = session.datagrams.readable.getReader().read();
    invoke(conn.ondatagram, new Uint8Array([7, 8]));
    deepStrictEqual(await datagramRead, { done: false, value: new Uint8Array([7, 8]) });
    const datagramWriter = session.datagrams.writable.getWriter();
    await datagramWriter.write(new Uint8Array([6]));
    deepStrictEqual(conn.datagrams, [new Uint8Array([6])]);
    await rejects(datagramWriter.write(new Uint8Array(1201)), RangeError);
});

Deno.test('WebTransport: rejects insecure URLs and unsupported certificate hashes', () => {
    throws(() => new WebTransport('http://example.com/'), error => {
        return error instanceof DOMException && error.name === 'SyntaxError';
    });
    throws(() => new WebTransport('https://example.com/', {
        serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(32) }],
    }), error => error instanceof DOMException && error.name === 'NotSupportedError');
});
