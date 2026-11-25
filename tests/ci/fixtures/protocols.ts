import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import * as http2 from 'node:http2';
import { quicConcurrentConnections, quicRoundTrip, within } from '../../_helpers/quic.ts';

const ssl = import.meta.use('ssl');
const nativeH2 = import.meta.use('@cnojs/http/ext-h2');
if (typeof nativeH2.Session !== 'function') throw new Error('Compiled HTTP/2 module is required');

async function request(session: http2.ClientHttp2Session, payload: Uint8Array): Promise<void> {
    if (session.connecting) {
        await within(new Promise<void>((resolve, reject) => {
            session.once('connect', resolve);
            session.once('error', reject);
        }), 'HTTP/2 session connect');
    }
    const response = new Promise<Uint8Array>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        const stream = session.request({ ':method': 'POST', ':path': '/echo' }, { endStream: false });
        stream.on('error', reject);
        stream.on('response', headers => {
            try { strictEqual(Number(headers[':status']), 200); }
            catch (error) { reject(error); }
        });
        stream.on('data', (chunk: Uint8Array) => chunks.push(chunk));
        stream.on('end', () => {
            const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            resolve(bytes);
        });
        stream.end(payload);
    });
    deepStrictEqual(await within(response, 'HTTP/2 response across flow-control windows'), payload);
}

const payload = Uint8Array.from({ length: 256 * 1024 }, (_, index) => index % 251);
const cleartext = http2.createServer();
cleartext.on('stream', (stream) => {
    stream.respond({ ':status': 200 });
    stream.pipe(stream);
});
await within(new Promise<void>((resolve, reject) => {
    cleartext.once('error', reject);
    cleartext.listen(0, '127.0.0.1', resolve);
}), 'HTTP/2 cleartext listen');
const address = cleartext.address();
ok(address && typeof address === 'object');
const cleartextSession = http2.connect(`http://127.0.0.1:${address.port}`);
try {
    await request(cleartextSession, payload);
} finally {
    cleartextSession.destroy();
    await within(new Promise<void>((resolve, reject) => {
        cleartext.close(error => error ? reject(error) : resolve());
    }), 'HTTP/2 cleartext shutdown');
}

const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
let secureRequests = 0;
const secure = http2.createSecureServer({ cert, key }, (incoming, outgoing) => {
    strictEqual(incoming.method, 'POST');
    strictEqual(incoming.url, '/echo');
    strictEqual(incoming.httpVersion, '2.0');
    ok(incoming instanceof http2.Http2ServerRequest);
    ok(outgoing instanceof http2.Http2ServerResponse);
    secureRequests++;
    outgoing.writeHead(200, { 'content-type': 'application/octet-stream' });
    incoming.pipe(outgoing);
});
await within(new Promise<void>((resolve, reject) => {
    secure.once('error', reject);
    secure.listen(0, '127.0.0.1', resolve);
}), 'Node HTTP/2 TLS listen');
const secureAddress = secure.address();
ok(secureAddress && typeof secureAddress === 'object');
const secureSession = http2.connect(`https://127.0.0.1:${secureAddress.port}`, {
    rejectUnauthorized: false,
});
try {
    await Promise.all([1, 2, 3].map(value => request(secureSession, new Uint8Array(payload.length).fill(value))));
    strictEqual(secureSession.alpnProtocol, 'h2');
    strictEqual(secureSession.encrypted, true);
    strictEqual(secureRequests, 3);
} finally {
    secureSession.destroy();
    await within(new Promise<void>((resolve, reject) => {
        secure.close(error => error ? reject(error) : resolve());
    }), 'Node HTTP/2 TLS shutdown');
}

const server = Deno.serve({
    hostname: '127.0.0.1', port: 0, cert, key, onListen() {},
}, async incoming => new Response(await incoming.arrayBuffer()));
const session = http2.connect(`https://127.0.0.1:${server.addr.port}`, {
    rejectUnauthorized: false, ALPNProtocols: ['h2'],
});
try {
    await request(session, payload);
    strictEqual(session.alpnProtocol, 'h2');
} finally {
    session.destroy();
    await within(server.shutdown(), 'HTTP/2 TLS server shutdown');
}

if (Deno.build.os !== 'windows') {
    const nativeQuic = import.meta.use('@cnojs/quic');
    if (typeof nativeQuic.Socket !== 'function') throw new Error('Compiled QUIC module is required');
    await quicRoundTrip();
    await quicConcurrentConnections();
}
console.log('CNO_CI_PROTOCOLS_OK');
