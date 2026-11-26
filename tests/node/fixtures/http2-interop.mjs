import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import * as http2 from 'node:http2';
import process from 'node:process';

const ssl = typeof import.meta.use === 'function' ? import.meta.use('ssl') : undefined;

const [role, transport, target] = process.argv.slice(2);
const requestCount = 3;

async function echo(session, index) {
    const payload = Buffer.alloc(256 * 1024 + index, index + 1);
    const request = session.request({ ':method': 'POST', ':path': `/echo/${index}` });
    const response = new Promise((resolve, reject) => {
        const chunks = [];
        let headers;
        request.once('response', value => { headers = value; });
        request.on('data', chunk => chunks.push(chunk));
        request.once('error', reject);
        request.once('end', () => {
            try {
                assert.equal(Number(headers?.[':status']), 200);
                assert.equal(headers?.['x-echo-path'], `/echo/${index}`);
                assert.deepEqual(Buffer.concat(chunks), payload);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
    request.end(payload);
    await response;
}

async function client() {
    const secure = transport !== 'h2c';
    const session = http2.connect(`${secure ? 'https' : 'http'}://127.0.0.1:${target}`, {
        rejectUnauthorized: false,
    });
    const failure = new Promise((_, reject) => session.once('error', reject));
    try {
        await Promise.race([
            new Promise(resolve => session.once('connect', resolve)),
            failure,
        ]);
        if (secure) assert.equal(session.alpnProtocol, 'h2');
        await Promise.race([
            Promise.all(Array.from({ length: requestCount }, (_, index) => echo(session, index))),
            failure,
        ]);
        const closed = new Promise(resolve => session.once('close', resolve));
        session.close();
        await Promise.race([closed, failure]);
        console.log('CNO_NODE_HTTP2_CLIENT_OK');
    } finally {
        session.destroy();
    }
}

async function server() {
    const credentials = transport === 'h2c' ? {} : JSON.parse(readFileSync(target, 'utf8'));
    let requests = 0;
    let close;
    let port;
    if (transport === 'deno') {
        const listener = Deno.serve({
            hostname: '127.0.0.1', port: 0, ...credentials, onListen() {},
        }, async request => {
            requests++;
            assert.equal(request.method, 'POST');
            return new Response(await request.arrayBuffer(), {
                headers: { 'x-echo-path': new URL(request.url).pathname },
            });
        });
        port = listener.addr.port;
        close = () => listener.shutdown();
    } else {
        const sessions = new Set();
        const listener = transport === 'h2c'
            ? http2.createServer()
            : http2.createSecureServer(credentials);
        listener.on('session', session => {
            sessions.add(session);
            session.once('close', () => sessions.delete(session));
        });
        listener.on('stream', (stream, headers) => {
            requests++;
            assert.equal(headers[':method'], 'POST');
            stream.respond({ ':status': 200, 'x-echo-path': headers[':path'] });
            stream.pipe(stream);
        });
        await new Promise((resolve, reject) => {
            listener.once('error', reject);
            listener.listen(0, '127.0.0.1', resolve);
        });
        port = listener.address().port;
        close = () => new Promise((resolve, reject) => {
            for (const session of sessions) session.close();
            listener.close(error => error ? reject(error) : resolve());
        });
    }
    console.log(`CNO_NODE_HTTP2_READY:${port}`);
    await new Promise(resolve => process.stdin.once('data', resolve));
    process.stdin.destroy();
    await close();
    assert.equal(requests, requestCount);
    console.log('CNO_NODE_HTTP2_SERVER_OK');
}

if (role === 'credentials') {
    console.log(JSON.stringify(ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 })));
} else if (role === 'client') {
    await client();
} else if (role === 'server') {
    await server();
} else {
    throw new Error(`Unknown HTTP/2 fixture role: ${role}`);
}
