import { parentPort } from 'node:worker_threads';

const ssl = import.meta.use('ssl');
const nativeQuic = import.meta.use('@cnojs/quic');
if (typeof nativeQuic.Socket !== 'function') throw new Error('Compiled QUIC module missing in worker');
const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
const endpoint = new Deno.QuicEndpoint({ hostname: '127.0.0.1', port: 0 });
const listener = endpoint.listen({ cert, key, alpnProtocols: ['cno-quic-worker'] });
const [server, client] = await Promise.all([
    listener.accept(),
    Deno.connectQuic({
        hostname: '127.0.0.1', port: endpoint.addr.port,
        serverName: 'localhost', caCerts: [cert], alpnProtocols: ['cno-quic-worker'],
    }),
]);
if (server.protocol !== 'cno-quic-worker') throw new Error('Worker QUIC ALPN was not negotiated');
parentPort!.postMessage({ port: endpoint.addr.port, protocol: client.protocol });
