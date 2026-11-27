import { ok, rejects, strictEqual, throws } from 'node:assert';
import { Worker } from 'node:worker_threads';
import { quicAvailable } from '../../cno/src/utils/quic-native.ts';
import { quicConcurrentConnections, quicRoundTrip, within } from '../_helpers/quic.ts';

const ssl = import.meta.use('ssl');

Deno.test({
    name: 'Deno QUIC: verified endpoint round trip, ALPN, streams, datagrams and peer close',
    ignore: !quicAvailable(),
    timeout: 45000,
}, () => quicRoundTrip());

function supportsIpv6(): boolean {
    try {
        const socket = Deno.listenDatagram({ hostname: '::1', port: 0, transport: 'udp' });
        socket.close();
        return true;
    } catch (error) {
        if (error instanceof Error && /EAFNOSUPPORT|EADDRNOTAVAIL|ENETUNREACH|address family not supported|address not available|network is unreachable/i.test(error.message)) {
            return false;
        }
        throw error;
    }
}

Deno.test({
    name: 'Deno QUIC: IPv6 loopback round trip with an implicit client endpoint',
    ignore: !quicAvailable() || !supportsIpv6(),
    timeout: 45000,
}, () => quicRoundTrip('::1', true));

Deno.test({
    name: 'Deno QUIC: endpoint.close and listener.stop reject pending accepts',
    ignore: !quicAvailable(),
    timeout: 10000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    for (const method of ['close', 'stop'] as const) {
        const endpoint = new Deno.QuicEndpoint({ hostname: '127.0.0.1', port: 0 });
        try {
            const listener = endpoint.listen({ cert, key, alpnProtocols: ['cno-quic'] });
            const pending = listener.accept();
            const rejected = rejects(pending, /closed|stopped/i);
            if (method === 'close') endpoint.close();
            else listener.stop();
            await within(rejected, `pending accept after ${method}`, 3000);
            await rejects(listener.incoming(), /closed|stopped/i);
        } finally {
            endpoint.close();
        }
    }
});

Deno.test({
    name: 'Deno QUIC: rejects incompatible ALPN protocols',
    ignore: !quicAvailable(),
    timeout: 15000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const endpoint = new Deno.QuicEndpoint({ hostname: '127.0.0.1', port: 0 });
    try {
        endpoint.listen({ cert, key, alpnProtocols: ['server-only'] });
        await rejects(within(Deno.connectQuic({
            hostname: '127.0.0.1', port: endpoint.addr.port,
            serverName: 'localhost', caCerts: [cert], alpnProtocols: ['client-only'],
        }), 'ALPN rejection', 10000), error => {
            ok(error instanceof Error);
            ok(!/timed out/.test(error.message), error.message);
            return true;
        });
    } finally {
        endpoint.close();
    }
});

Deno.test({
    name: 'Deno QUIC: honors client bind port, reuses explicit endpoints and releases implicit endpoints',
    ignore: !quicAvailable(),
    timeout: 25000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const serverEndpoint = new Deno.QuicEndpoint({ hostname: '127.0.0.1', port: 0 });
    const reservation = Deno.listenDatagram({ hostname: '127.0.0.1', port: 0, transport: 'udp' });
    const localPort = (reservation.addr as Deno.NetAddr).port;
    reservation.close();
    const clientEndpoint = new Deno.QuicEndpoint({ hostname: '127.0.0.1', port: localPort });
    try {
        const listenOptions = { cert, key, alpnProtocols: ['cno-quic'] };
        const listener = serverEndpoint.listen(listenOptions);
        const connectOptions = {
            hostname: '127.0.0.1', port: serverEndpoint.addr.port,
            serverName: 'localhost', alpnProtocols: ['cno-quic'],
        };
        for (let index = 0; index < 2; index++) {
            const [server, client] = await within(Promise.all([
                listener.accept(),
                Deno.connectQuic({
                    ...connectOptions, endpoint: clientEndpoint,
                    ...(index === 0 ? { caCerts: [cert] } : {}),
                }),
            ]), 'explicit QUIC endpoint connect', 5000);
            strictEqual(client.endpoint, clientEndpoint);
            strictEqual(clientEndpoint.addr.port, localPort);
            strictEqual(server.remoteAddr.port, localPort);
            client.close();
            await within(Promise.all([client.closed, server.closed]), 'explicit connection close', 5000);
        }
        const [server, implicit] = await within(Promise.all([
            listener.accept(),
            Deno.connectQuic({ ...connectOptions, caCerts: [cert] }),
        ]), 'implicit QUIC endpoint connect', 5000);
        implicit.close();
        await within(Promise.all([implicit.closed, server.closed]), 'implicit connection close', 5000);
        await Promise.resolve();
        throws(() => implicit.endpoint.listen(listenOptions), /endpoint closed/i);
    } finally {
        clientEndpoint.close();
        serverEndpoint.close();
    }
});

Deno.test({
    name: 'Deno QUIC: one endpoint isolates concurrent connections to the same peer',
    ignore: !quicAvailable(),
    timeout: 60000,
}, quicConcurrentConnections);

Deno.test({
    name: 'Deno QUIC: idle expiry settles pending operations and preserves reusable endpoints',
    ignore: !quicAvailable(),
    timeout: 20000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const serverEndpoint = new Deno.QuicEndpoint({ hostname: '127.0.0.1', port: 0 });
    const clientEndpoint = new Deno.QuicEndpoint({ hostname: '127.0.0.1', port: 0 });
    try {
        const listener = serverEndpoint.listen({ cert, key, alpnProtocols: ['cno-quic'], maxIdleTimeout: 200 });
        for (let index = 0; index < 3; index++) {
            const implicit = index === 2;
            const [server, client] = await within(Promise.all([
                listener.accept(),
                Deno.connectQuic({
                    endpoint: implicit ? undefined : clientEndpoint,
                    hostname: '127.0.0.1', port: serverEndpoint.addr.port,
                    serverName: 'localhost', alpnProtocols: ['cno-quic'], maxIdleTimeout: 200,
                    ...(index !== 1 ? { caCerts: [cert] } : {}),
                }),
            ]), 'QUIC idle connection handshake', 5000);
            const incomingReader = server.incomingBidirectionalStreams.getReader();
            const receiving = incomingReader.read();
            const outgoing = await client.createBidirectionalStream();
            const writer = outgoing.writable.getWriter();
            await writer.write(new Uint8Array([1]));
            const { value: incoming, done } = await within(receiving, 'QUIC stream before idle expiry', 3000);
            ok(!done && incoming);
            const streamReader = incoming.readable.getReader();
            strictEqual((await within(streamReader.read(), 'QUIC data before idle expiry', 3000)).value?.[0], 1);
            const receiveRejected = rejects(streamReader.read(), /closed|timeout|timed out/i);
            const sendRejected = rejects(writer.closed, /closed|timeout|timed out/i);
            const datagramsRejected = rejects(client.readDatagram(), /QUIC.*closed|timeout|timed out/i);
            const incomingClosed = incomingReader.read();
            await within(Promise.all([
                client.closed, server.closed, datagramsRejected, receiveRejected, sendRejected,
                incomingClosed.then(result => strictEqual(result.done, true)),
            ]), 'QUIC idle expiry notification', 5000);
            incomingReader.releaseLock();
            streamReader.releaseLock();
            writer.releaseLock();
            await rejects(client.createBidirectionalStream(), /closed/i);
            if (implicit) {
                await Promise.resolve();
                throws(() => client.endpoint.listen({ cert, key }), /endpoint closed/i);
            } else {
                strictEqual(client.endpoint, clientEndpoint);
            }
        }
    } finally {
        clientEndpoint.close();
        serverEndpoint.close();
    }
});

Deno.test({
    name: 'Deno QUIC: rejects untrusted certificates and hostname mismatches',
    ignore: !quicAvailable(),
    timeout: 30000,
}, async () => {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const endpoint = new Deno.QuicEndpoint({ hostname: '127.0.0.1', port: 0 });
    try {
        endpoint.listen({ cert, key, alpnProtocols: ['cno-quic'] });
        for (const options of [
            { serverName: 'localhost', caCerts: [] },
            { serverName: 'wrong.example.invalid', caCerts: [cert] },
        ]) {
            await rejects(within(Deno.connectQuic({
                hostname: '127.0.0.1', port: endpoint.addr.port,
                alpnProtocols: ['cno-quic'], ...options,
            }), 'certificate validation', 10000), error => {
                ok(error instanceof Error);
                ok(!/timed out/.test(error.message), error.message);
                return true;
            });
        }
    } finally {
        endpoint.close();
    }
});

Deno.test({
    name: 'Deno QUIC: compiled transport works in workers and releases live handles on terminate',
    ignore: !quicAvailable(),
    timeout: 30000,
}, async () => {
    for (let index = 0; index < 3; index++) {
        const worker = new Worker(new URL('./fixtures/quic-worker.ts', import.meta.url));
        try {
            const message = await within(new Promise<{ port: number; protocol: string }>((resolve, reject) => {
                worker.once('message', resolve);
                worker.once('error', reject);
                worker.once('exit', code => reject(new Error(`QUIC worker exited before readiness (${code})`)));
            }), 'QUIC worker ready', 10000);
            ok(message.port > 0);
            strictEqual(message.protocol, 'cno-quic-worker');
            strictEqual(await within(worker.terminate(), 'QUIC worker terminate', 5000), 1);
        } finally {
            await worker.terminate();
        }
    }
});
