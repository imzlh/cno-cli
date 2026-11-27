import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { quicAvailable, requireQuic } from '../../cno/src/utils/quic-native.ts';
import { within } from '../_helpers/quic.ts';

const ssl = import.meta.use('ssl');

function concat(chunks: Uint8Array[]): Uint8Array {
    const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

Deno.test({
    name: 'quic: verified native connection echoes bidi streams, uni streams and datagrams',
    ignore: !quicAvailable(),
    timeout: 45000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const { Socket } = requireQuic();
    const uniResult = Promise.withResolvers<Uint8Array>();
    const uniParts: Uint8Array[] = [];
    const accepted = Promise.withResolvers<CModuleExternalQuic.Connection>();
    const server = new Socket({
        isServer: true, host: '127.0.0.1', port: 0,
        cert, key, alpn: 'cno-quic',
    });
    const client = new Socket({
        host: '127.0.0.1', port: 0, alpn: 'cno-quic',
        verifyPeer: true, caCerts: [cert],
    });
    try {
        server.onconnection = (conn) => {
            conn.onconnected = () => accepted.resolve(conn);
            conn.onerror = (message) => accepted.reject(new Error(message));
            conn.ondata = (streamId, chunk, fin) => {
                if ((streamId & 2) !== 0) {
                    uniParts.push(chunk);
                    if (fin) uniResult.resolve(concat(uniParts));
                } else {
                    conn.sendStream(streamId, chunk, fin);
                }
            };
            conn.ondatagram = (chunk) => conn.sendDatagram(chunk);
        };
        ok(server.localAddress && server.localAddress.port > 0);
        const port = server.localAddress.port;
        const conn = client.connect('127.0.0.1', port, 'localhost');
        await within(new Promise<void>((resolve, reject) => {
            conn.onerror = message => reject(new Error(message));
            conn.onconnected = resolve;
        }), 'native QUIC handshake');
        const peer = await within(accepted.promise, 'native QUIC accept');
        strictEqual(conn.protocol, 'cno-quic');
        strictEqual(peer.protocol, 'cno-quic');
        strictEqual(peer.serverName, 'localhost');
        strictEqual(conn.peerAddress?.port, port);
        strictEqual(peer.peerAddress?.port, client.localAddress?.port);

        let localStreamsReported = 0;
        conn.onstream = () => localStreamsReported++;
        const id = conn.openStream(true);
        strictEqual(localStreamsReported, 0, 'local streams are not reported as incoming');
        const payload = Uint8Array.from({ length: 256 * 1024 }, (_, index) => index % 251);
        const response = new Promise<Uint8Array>((resolve) => {
            const chunks: Uint8Array[] = [];
            conn.ondata = (streamId, chunk, fin) => {
                if (streamId !== id) return;
                ok(chunk instanceof Uint8Array);
                chunks.push(chunk);
                if (fin) resolve(concat(chunks));
            };
        });
        conn.sendStream(id, payload, true);
        deepStrictEqual(await within(response, 'native QUIC bidi echo'), payload);

        const uniPayload = new Uint8Array([4, 5, 6, 7]);
        conn.sendStream(conn.openStream(false), uniPayload, true);
        deepStrictEqual(await within(uniResult.promise, 'native QUIC uni receive'), uniPayload);

        const datagram = new Promise<Uint8Array>((resolve) => { conn.ondatagram = resolve; });
        const datagramPayload = new Uint8Array([1, 2, 3]);
        conn.sendDatagram(datagramPayload);
        deepStrictEqual(await within(datagram, 'native QUIC datagram echo'), datagramPayload);

        const closed = new Promise<[number, string]>((resolve) => {
            conn.onclose = (code, reason) => resolve([code, reason]);
        });
        conn.close(0, 'done');
        deepStrictEqual(await within(closed, 'native QUIC close'), [0, 'done']);
    } finally {
        client.close();
        server.close();
    }
});
