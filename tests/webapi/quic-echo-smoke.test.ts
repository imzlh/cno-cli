/**
 * Live QUIC stream echo with ephemeral self-signed certs.
 * Skipped when native QUIC is not linked.
 */
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { quicAvailable, requireQuic } from '../../cno/src/quic-native.ts';

async function makePemPair(): Promise<{ cert: string; key: string }> {
    const dir = await Deno.makeTempDir({ prefix: 'cno-quic-' });
    const keyPath = `${dir}/key.pem`;
    const certPath = `${dir}/cert.pem`;
    const cmd = new Deno.Command('openssl', {
        args: [
            'req', '-x509', '-newkey', 'rsa:2048',
            '-keyout', keyPath, '-out', certPath,
            '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
            '-addext', 'subjectAltName=IP:127.0.0.1',
        ],
        stdout: 'piped',
        stderr: 'piped',
    });
    const { code, stderr } = await cmd.output();
    if (code !== 0) {
        const msg = new TextDecoder().decode(stderr);
        throw new Error(`openssl failed to mint test certs: ${msg}`);
    }
    const cert = await Deno.readTextFile(certPath);
    const key = await Deno.readTextFile(keyPath);
    try {
        await Deno.remove(dir, { recursive: true });
    } catch {
        // best-effort
    }
    return { cert, key };
}

Deno.test({
    name: 'quic: client/server stream echo',
    ignore: !quicAvailable(),
    timeout: 20000,
}, async () => {
    const { cert, key } = await makePemPair();
    const { Socket } = requireQuic();
    const port = 19434 + (Math.floor(Math.random() * 200) | 0);
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const uniResult = Promise.withResolvers<Uint8Array>();
    const uniParts: Uint8Array[] = [];

    const server = new Socket({
        isServer: true,
        host: '127.0.0.1',
        port,
        cert,
        key,
        alpn: 'cno-quic',
    });
    server.onconnection = (conn) => {
        conn.ondata = (streamId, chunk, fin) => {
            if ((streamId & 2) !== 0) {
                uniParts.push(chunk);
                if (fin) {
                    const total = uniParts.reduce((size, part) => size + part.byteLength, 0);
                    const received = new Uint8Array(total);
                    let offset = 0;
                    for (const part of uniParts) {
                        received.set(part, offset);
                        offset += part.byteLength;
                    }
                    uniResult.resolve(received);
                }
                return;
            }
            conn.sendStream(streamId, chunk, !!fin);
        };
        conn.ondatagram = (chunk) => conn.sendDatagram(chunk);
    };

    const client = new Socket({
        host: '127.0.0.1',
        port: 0,
        alpn: 'cno-quic',
        verifyPeer: true,
        caCerts: [cert],
    });
    const conn = client.connect('127.0.0.1', port, '127.0.0.1');

    await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('handshake timeout')), 10000);
        conn.onerror = (m) => {
            clearTimeout(t);
            reject(new Error(String(m)));
        };
        conn.onconnected = () => {
            clearTimeout(t);
            resolve();
        };
    });

    let localStreamsReported = 0;
    conn.onstream = () => localStreamsReported++;
    const id = conn.openStream(true);
    strictEqual(localStreamsReported, 0, 'locally opened stream must not be reported as incoming');
    const payload = 'hello-quic';
    const reply = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('data timeout')), 10000);
        const parts: Uint8Array[] = [];
        conn.ondata = (streamId, chunk, fin) => {
            if (streamId !== id) return;
            ok(chunk instanceof Uint8Array, 'stream callback uses Uint8Array');
            parts.push(chunk);
            if (fin) {
                clearTimeout(t);
                const total = parts.reduce((n, b) => n + b.byteLength, 0);
                const out = new Uint8Array(total);
                let o = 0;
                for (const b of parts) {
                    out.set(b, o);
                    o += b.byteLength;
                }
                resolve(dec.decode(out));
            }
        };
        conn.sendStream(id, enc.encode(payload), true);
    });

    strictEqual(reply, payload);
    const uniPayload = new Uint8Array([4, 5, 6, 7]);
    const uniId = conn.openStream(false);
    conn.sendStream(uniId, uniPayload, true);
    deepStrictEqual(await uniResult.promise, uniPayload);

    const datagram = new Promise<Uint8Array>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('datagram timeout')), 10000);
        conn.ondatagram = (chunk) => {
            clearTimeout(t);
            resolve(chunk);
        };
    });
    conn.sendDatagram(new Uint8Array([1, 2, 3]));
    deepStrictEqual(await datagram, new Uint8Array([1, 2, 3]));

    const closed = new Promise<[number, string]>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('close timeout')), 10000);
        conn.onclose = (code, reason) => {
            clearTimeout(t);
            resolve([code, reason]);
        };
    });
    conn.close(0, 'done');
    deepStrictEqual(await closed, [0, 'done']);
    try { client.close(); } catch { /* */ }
    try { server.close(); } catch { /* */ }
});
