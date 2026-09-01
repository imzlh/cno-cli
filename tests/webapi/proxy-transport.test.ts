import { ok, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { connectHttp, connectTcp } from '../../cno/src/utils/http.ts';
import { setRawConnectionHook } from '../../cno/src/utils/network-hooks.ts';
import { createProxyConnector, shouldBypassProxy, type ProxyConfig, type ProxyType } from '../../cno/src/utils/proxy.ts';

const ssl = import.meta.use('ssl');

class SocketReader {
    private buffer = Buffer.alloc(0);
    private waiters: Array<() => void> = [];
    private error: Error | null = null;

    constructor(private readonly socket: Socket) {
        socket.on('data', this.onData);
        socket.on('error', error => { this.error = error; this.wake(); });
        socket.on('close', () => { this.error ??= new Error('socket closed'); this.wake(); });
    }

    private wake(): void { for (const waiter of this.waiters.splice(0)) waiter(); }

    private async waitFor(predicate: () => boolean): Promise<void> {
        while (!predicate()) {
            if (this.error) throw this.error;
            await new Promise<void>(resolve => this.waiters.push(resolve));
        }
    }

    async read(size: number): Promise<Buffer> {
        await this.waitFor(() => this.buffer.length >= size);
        const result = this.buffer.subarray(0, size);
        this.buffer = this.buffer.subarray(size);
        return result;
    }

    async readUntil(marker: Buffer): Promise<Buffer> {
        let index = -1;
        await this.waitFor(() => (index = this.buffer.indexOf(marker)) >= 0);
        const end = index + marker.length;
        const result = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        return result;
    }

    /** Detach from socket and return any unread bytes (e.g. TLS ClientHello after CONNECT). */
    takeRest(): Buffer {
        this.socket.removeListener('data', this.onData);
        const rest = this.buffer;
        this.buffer = Buffer.alloc(0);
        return rest;
    }

    private onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.wake();
    };
}

interface ListeningServer { server: Server; port: number; }

/**
 * Connect to `host:port` trying every resolved address in turn.
 *
 * The proxy fixtures below are handed a hostname by the client under test — that
 * is the whole point of the SOCKS5h / SOCKS4a cases, where the *proxy* is the one
 * that must resolve it. A real proxy (and Node's own `net.connect`, via
 * `autoSelectFamily`) walks the whole address list. cno's `node:net` takes only
 * `addresses[0]` (cno/src/node/net/mod.ts), so on a box where `localhost`
 * resolves to `::1` first a fixture that connected by name would never reach a
 * listener bound to `127.0.0.1` — the client would then see the proxy hang up and
 * report "Proxy closed during handshake", blaming the handshake for a fixture
 * problem. Resolving explicitly here keeps these tests about the proxy protocol.
 */
async function connectUpstream(port: number, host: string): Promise<Socket> {
    const addresses = await new Promise<Array<{ address: string }>>(resolve => {
        lookup(host, { all: true }, (error, result) => resolve(error ? [{ address: host }] : result));
    });
    let failure: unknown = null;
    for (const { address } of addresses.length ? addresses : [{ address: host }]) {
        try {
            return await new Promise<Socket>((resolve, reject) => {
                const socket = connect(port, address);
                socket.once('connect', () => resolve(socket));
                socket.once('error', reject);
            });
        } catch (error) { failure = error; }
    }
    throw failure ?? new Error(`upstream connect failed for ${host}:${port}`);
}

async function listenServer(server: Server): Promise<ListeningServer | null> {
    try {
        await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    } catch (error) {
        if (String(error).includes('EPERM') || String(error).includes('operation not permitted')) return null;
        throw error;
    }
    return { server, port: (server.address() as { port: number }).port };
}

async function listen(handler: (socket: Socket) => void): Promise<ListeningServer | null> {
    return listenServer(createServer(handler));
}

/**
 * A TLS fixture. `commonName` exists so two fixtures in the same test can hold
 * distinct identities: `createSelfSignedCert` hardcodes serial 1, so two certs
 * sharing a CN also share subject+serial and collide inside a single X509_STORE —
 * measured, only the later-added one then validates. Hostname verification is off
 * for IP-literal targets, so a CN that is not the dialled address is harmless here.
 */
async function listenTls(handler: (socket: Socket) => void, commonName = '127.0.0.1'): Promise<(ListeningServer & { cert: string }) | null> {
    const { cert, key } = ssl.createSelfSignedCert({ commonName, days: 1 });
    const listening = await listenServer(createTlsServer({ cert, key }, handler));
    return listening ? { ...listening, cert } : null;
}

function closeServer(server: Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

function toHex(bytes: Buffer | Uint8Array): string {
    return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join(' ');
}

function handleTargetSocket(socket: Socket): void {
        const reader = new SocketReader(socket);
        void reader.readUntil(Buffer.from('\r\n\r\n')).then(request => {
            const text = request.toString();
            if (text.startsWith('GET /sse ')) {
                socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: proxy-sse\n\n');
                return;
            }
            if (text.startsWith('GET /ws ')) {
                const key = text.match(/sec-websocket-key:\s*([^\r\n]+)/i)?.[1];
                if (!key) { socket.destroy(); return; }
                const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
                socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
                setTimeout(() => socket.write(Buffer.from([0x81, 0x08, ...Buffer.from('proxy-ws')])), 10);
                return;
            }
            socket.end('HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nproxy-ok');
        }).catch(() => socket.destroy());
}

async function startTargetServer(): Promise<ListeningServer | null> {
    return listen(handleTargetSocket);
}

async function startSecureTargetServer(): Promise<(ListeningServer & { cert: string }) | null> {
    return listenTls(handleTargetSocket);
}

async function startHttpProxy(secure = false): Promise<(ListeningServer & { connects: string[]; forwards: string[]; authorizations: string[]; cert?: string }) | null> {
    const connects: string[] = [];
    const forwards: string[] = [];
    const authorizations: string[] = [];
    const handler = (socket: Socket) => {
        // SocketReader consumes only the first request head; then we pipe the rest.
        const reader = new SocketReader(socket);
        void reader.readUntil(Buffer.from('\r\n\r\n')).then(async request => {
            const text = request.toString();
            const authorization = text.match(/^proxy-authorization:\s*([^\r\n]+)/im)?.[1];
            if (authorization) authorizations.push(authorization);
            const authority = text.match(/^CONNECT\s+([^\s]+)/)?.[1];
            const absoluteTarget = text.match(/^GET\s+(https?:\/\/[^\s]+)\s+HTTP\/1\.1/)?.[1];
            if (!authority && !absoluteTarget) { socket.destroy(); return; }
            const target = authority ? null : new URL(absoluteTarget!);
            if (authority) connects.push(authority);
            else forwards.push(absoluteTarget!);
            const separator = authority?.lastIndexOf(':') ?? -1;
            const host = authority ? authority.slice(0, separator).replace(/^\[(.*)\]$/, '$1') : target!.hostname;
            const port = authority ? Number(authority.slice(separator + 1)) : Number(target!.port || 80);
            const upstream = await connectUpstream(port, host);
            upstream.on('error', () => socket.destroy());
            // Detach reader and pause before 200 so TLS ClientHello cannot race past us.
            const leftover = reader.takeRest();
            socket.pause();
            if (authority) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            else {
                const originTarget = `${target!.pathname}${target!.search}`;
                upstream.write(request.toString().replace(absoluteTarget!, originTarget));
            }
            if (leftover.length) upstream.write(leftover);
            socket.pipe(upstream).pipe(socket);
            socket.resume();
        }).catch(() => socket.destroy());
    };
    const listening = secure ? await listenTls(handler, 'proxy.test') : await listen(handler);
    return listening ? { ...listening, connects, forwards, authorizations } : null;
}

interface Socks5Request { addressType: number; host: string; port: number; }

/** Bytes captured on the wire, so the handshake shape can be pinned against the RFCs. */
interface SocksWire { greeting?: string; auth?: string; request?: string }

async function startSocks5Proxy(credentials?: { user: string; pass: string }): Promise<(ListeningServer & { requests: Socks5Request[]; wire: SocksWire[] }) | null> {
    const requests: Socks5Request[] = [];
    const wire: SocksWire[] = [];
    const listening = await listen(socket => {
        const reader = new SocketReader(socket);
        const frame: SocksWire = {};
        wire.push(frame);
        void (async () => {
            const greeting = await reader.read(2);
            const methods = await reader.read(greeting[1]!);
            frame.greeting = toHex(Buffer.concat([greeting, methods]));
            const method = credentials ? 2 : 0;
            if (greeting[0] !== 5 || !methods.includes(method)) { socket.end(Buffer.from([5, 0xff])); return; }
            socket.write(Buffer.from([5, method]));
            if (credentials) {
                const authHead = await reader.read(2);
                const userBytes = await reader.read(authHead[1]!);
                const passLength = (await reader.read(1))[0]!;
                const passBytes = await reader.read(passLength);
                frame.auth = toHex(Buffer.concat([authHead, userBytes, Buffer.from([passLength]), passBytes]));
                const accepted = authHead[0] === 1 && userBytes.toString() === credentials.user && passBytes.toString() === credentials.pass;
                socket.write(Buffer.from([1, accepted ? 0 : 1]));
                if (!accepted) return;
            }
            const requestHead = await reader.read(4);
            if (requestHead[0] !== 5 || requestHead[1] !== 1 || requestHead[2] !== 0) { socket.destroy(); return; }
            const addressType = requestHead[3]!;
            let host: string;
            let addressBytes: Buffer;
            if (addressType === 1) { addressBytes = await reader.read(4); host = Array.from(addressBytes).join('.'); }
            else if (addressType === 3) {
                const length = await reader.read(1);
                const name = await reader.read(length[0]!);
                addressBytes = Buffer.concat([length, name]);
                host = name.toString();
            }
            else { socket.destroy(); return; }
            const portBytes = await reader.read(2);
            const port = portBytes.readUInt16BE(0);
            frame.request = toHex(Buffer.concat([requestHead, addressBytes, portBytes]));
            requests.push({ addressType, host, port });
            const upstream = await connectUpstream(port, host);
            upstream.on('error', () => socket.destroy());
            const leftover = reader.takeRest();
            socket.pause();
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            if (leftover.length) upstream.write(leftover);
            socket.pipe(upstream).pipe(socket);
            socket.resume();
        })().catch(() => socket.destroy());
    });
    return listening ? { ...listening, requests, wire } : null;
}

interface Socks4aRequest { host: string; port: number; userId: string; destinationIp: string; remoteDns: boolean; }

/**
 * Accepts both SOCKS4 and the SOCKS4a extension. SOCKS4a is signalled by an
 * otherwise-invalid DSTIP of 0.0.0.x, after which a NUL-terminated hostname
 * follows the NUL-terminated USERID.
 */
async function startSocks4Proxy(): Promise<(ListeningServer & { requests: Socks4aRequest[]; wire: SocksWire[] }) | null> {
    const requests: Socks4aRequest[] = [];
    const wire: SocksWire[] = [];
    const listening = await listen(socket => {
        const reader = new SocketReader(socket);
        const frame: SocksWire = {};
        wire.push(frame);
        void (async () => {
            const head = await reader.read(8);
            if (head[0] !== 4 || head[1] !== 1) { socket.destroy(); return; }
            const destinationIp = Array.from(head.subarray(4, 8)).join('.');
            const remoteDns = head[4] === 0 && head[5] === 0 && head[6] === 0 && head[7] !== 0;
            const userBytes = await reader.readUntil(Buffer.from([0]));
            let hostBytes = Buffer.alloc(0);
            let host = destinationIp;
            if (remoteDns) {
                hostBytes = await reader.readUntil(Buffer.from([0]));
                host = hostBytes.subarray(0, -1).toString();
            }
            frame.request = toHex(Buffer.concat([head, userBytes, hostBytes]));
            const port = head.readUInt16BE(2);
            requests.push({ host, port, userId: userBytes.subarray(0, -1).toString(), destinationIp, remoteDns });
            const upstream = await connectUpstream(port, host);
            upstream.on('error', () => socket.destroy());
            const leftover = reader.takeRest();
            socket.pause();
            socket.write(Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]));
            if (leftover.length) upstream.write(leftover);
            socket.pipe(upstream).pipe(socket);
            socket.resume();
        })().catch(() => socket.destroy());
    });
    return listening ? { ...listening, requests, wire } : null;
}

/**
 * Install the proxy connector.
 *
 * `trustRoots` is how the TLS cases stay honest now that the raw path verifies by
 * default: these fixtures use locally generated self-signed certificates, so the
 * test names each one as a trust root rather than switching verification off.
 * Passing nothing keeps full default verification, which is what the plaintext
 * cases want.
 */
function useProxy(type: ProxyType, port: number, extras: Partial<ProxyConfig> = {}, trustRoots?: string[]): void {
    const scheme = type === 'https' ? 'https' : type.startsWith('socks') ? type : 'http';
    const config: ProxyConfig = { url: `${scheme}://127.0.0.1:${port}`, type, ...extras };
    setRawConnectionHook(createProxyConnector(() => config, trustRoots ? { caCerts: trustRoots } : undefined));
}

async function readRawTarget(port: number, hostname = '127.0.0.1'): Promise<string> {
    // HTTP proxies need absolute-form request-target (connectHttp.requestTarget).
    const url = new URL(`http://${hostname}:${port}/raw`);
    const connection = await connectHttp(url);
    const target = connection.requestTarget ?? `${url.pathname}${url.search}`;
    let head = `GET ${target} HTTP/1.1\r\nHost: ${hostname}\r\n`;
    if (connection.proxyAuthorization) {
        head += `Proxy-Authorization: ${connection.proxyAuthorization}\r\n`;
    }
    await connection.socket.write(new TextEncoder().encode(`${head}\r\n`));
    let response = '';
    while (!response.includes('proxy-ok')) {
        const chunk = await connection.socket.read(256);
        if (!chunk) break;
        response += new TextDecoder().decode(chunk);
    }
    connection.socket.close();
    return response;
}

async function readSecureTarget(port: number): Promise<string> {
    const socket = await connectTcp(new URL(`https://127.0.0.1:${port}/raw`));
    await socket.write(new TextEncoder().encode('GET /raw HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
    let response = '';
    while (!response.includes('proxy-ok')) {
        const chunk = await socket.read(256);
        if (!chunk) break;
        response += new TextDecoder().decode(chunk);
    }
    socket.close();
    return response;
}

Deno.test({ name: 'raw transport: HTTP proxy uses absolute-form forwarding', timeout: 10000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startHttpProxy();
    if (!proxy) { await closeServer(target.server); return; }
    try {
        useProxy('http', proxy.port, { user: 'u', pass: 'p' });
        ok((await readRawTarget(target.port)).endsWith('proxy-ok'));
        strictEqual(proxy.connects.length, 0);
        strictEqual(proxy.forwards.length, 1);
        strictEqual(proxy.authorizations[0], `Basic ${btoa('u:p')}`);
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'raw transport: HTTPS target uses CONNECT then TLS', timeout: 10000 }, async () => {
    const target = await startSecureTargetServer();
    if (!target) return;
    const proxy = await startHttpProxy();
    if (!proxy) { await closeServer(target.server); return; }
    try {
        // The target's certificate is named as a trust root. This test is about
        // CONNECT-then-TLS mechanics, not about trust, and before the raw path
        // verified anything it passed only because nothing was checked.
        useProxy('http', proxy.port, {}, [target.cert]);
        ok((await readSecureTarget(target.port)).endsWith('proxy-ok'));
        strictEqual(proxy.connects.length, 1);
        strictEqual(proxy.forwards.length, 0);
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'raw transport: HTTPS proxy supports nested TLS to HTTPS target', timeout: 10000 }, async () => {
    const target = await startSecureTargetServer();
    if (!target) return;
    const proxy = await startHttpProxy(true);
    if (!proxy) { await closeServer(target.server); return; }
    try {
        // Two separate handshakes, so both certificates must be trusted: the
        // proxy's own, and the target's inside the tunnel.
        useProxy('https', proxy.port, {}, [target.cert, ...(proxy.cert ? [proxy.cert] : [])]);
        ok((await readSecureTarget(target.port)).endsWith('proxy-ok'));
        strictEqual(proxy.connects.length, 1);
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

/*
 * The EventSource / WebSocket cases live in proxy-transport-clients.test.ts.
 * They cannot run here: the global `EventSource` / `WebSocket` are the *baked*
 * classes, which read `getRawConnectionHook()` from the baked copy of
 * cno/src/utils/network-hooks.ts, while `setRawConnectionHook` imported above
 * writes to the disk copy. Two module instances, two separate hook variables —
 * so the baked globals connect straight to the target and the proxy counters
 * stay at 0. The sibling file drives the disk-imported classes instead, so the
 * client and the hook share one instance.
 */

Deno.test({ name: 'raw transport: SOCKS5 authenticates and resolves DNS locally', timeout: 10000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startSocks5Proxy({ user: 'u', pass: 'p' });
    if (!proxy) { await closeServer(target.server); return; }
    try {
        useProxy('socks5', proxy.port, { user: 'u', pass: 'p' });
        ok((await readRawTarget(target.port, 'localhost')).endsWith('proxy-ok'));
        strictEqual(proxy.requests.length, 1);
        strictEqual(proxy.requests[0]!.addressType, 1);
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'raw transport: SOCKS5h delegates hostname resolution to proxy', timeout: 10000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startSocks5Proxy();
    if (!proxy) { await closeServer(target.server); return; }
    try {
        useProxy('socks5h', proxy.port);
        ok((await readRawTarget(target.port, 'localhost')).endsWith('proxy-ok'));
        strictEqual(proxy.requests[0]?.addressType, 3);
        strictEqual(proxy.requests[0]?.host, 'localhost');
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'raw transport: SOCKS4a delegates hostname resolution to proxy', timeout: 10000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startSocks4Proxy();
    if (!proxy) { await closeServer(target.server); return; }
    try {
        useProxy('socks4a', proxy.port);
        ok((await readRawTarget(target.port, 'localhost')).endsWith('proxy-ok'));
        strictEqual(proxy.requests[0]?.host, 'localhost');
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

/*
 * Wire-shape conformance. cno/src/utils/proxy.ts is baked into the binary, so a
 * regression there is invisible until something downstream fails obscurely.
 * These pin the exact bytes against RFC 1928 (SOCKS5), RFC 1929 (SOCKS5
 * username/password auth) and the SOCKS4a extension.
 */

Deno.test({ name: 'raw transport: SOCKS5 greeting and auth match RFC 1928/1929', timeout: 10000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startSocks5Proxy({ user: 'u', pass: 'p' });
    if (!proxy) { await closeServer(target.server); return; }
    try {
        useProxy('socks5', proxy.port, { user: 'u', pass: 'p' });
        ok((await readRawTarget(target.port)).endsWith('proxy-ok'));
        // RFC 1928 s3: VER=05, NMETHODS=02, METHODS=[00 NO_AUTH, 02 USER/PASS].
        strictEqual(proxy.wire[0]?.greeting, '05 02 00 02');
        // RFC 1929 s2: VER=01, ULEN=01, 'u'=75, PLEN=01, 'p'=70.
        strictEqual(proxy.wire[0]?.auth, '01 01 75 01 70');
        // RFC 1928 s4: VER=05 CMD=01(CONNECT) RSV=00 ATYP=01(IPv4) 127.0.0.1 + port.
        const port = target.port;
        strictEqual(proxy.wire[0]?.request, `05 01 00 01 7f 00 00 01 ${toHex(Buffer.from([port >> 8, port & 255]))}`);
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'raw transport: SOCKS5 without credentials offers NO_AUTH only', timeout: 10000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startSocks5Proxy();
    if (!proxy) { await closeServer(target.server); return; }
    try {
        useProxy('socks5h', proxy.port);
        ok((await readRawTarget(target.port, 'localhost')).endsWith('proxy-ok'));
        strictEqual(proxy.wire[0]?.greeting, '05 01 00');
        strictEqual(proxy.wire[0]?.auth, undefined);
        // ATYP=03 DOMAINNAME, LEN=09, "localhost" — resolution left to the proxy.
        const port = target.port;
        strictEqual(proxy.wire[0]?.request, `05 01 00 03 09 ${toHex(Buffer.from('localhost'))} ${toHex(Buffer.from([port >> 8, port & 255]))}`);
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'raw transport: SOCKS5 rejects a proxy that demands an unoffered method', timeout: 10000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    // Proxy wants username/password; client is configured without credentials,
    // so it offers NO_AUTH only and the fixture answers 05 ff (no acceptable method).
    const proxy = await startSocks5Proxy({ user: 'u', pass: 'p' });
    if (!proxy) { await closeServer(target.server); return; }
    try {
        useProxy('socks5', proxy.port);
        let message = 'no error';
        try { await readRawTarget(target.port); } catch (error) { message = String(error); }
        ok(/unsupported authentication method: 255/.test(message), message);
        strictEqual(proxy.requests.length, 0);
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'raw transport: SOCKS4 sends a resolved IPv4 and no hostname field', timeout: 10000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startSocks4Proxy();
    if (!proxy) { await closeServer(target.server); return; }
    try {
        useProxy('socks4', proxy.port, { user: 'bob' });
        ok((await readRawTarget(target.port, 'localhost')).endsWith('proxy-ok'));
        const request = proxy.requests[0]!;
        strictEqual(request.remoteDns, false);
        strictEqual(request.destinationIp, '127.0.0.1');
        strictEqual(request.userId, 'bob');
        // VN=04 CD=01 DSTPORT DSTIP USERID NUL — no trailing hostname.
        const port = target.port;
        strictEqual(proxy.wire[0]?.request, `04 01 ${toHex(Buffer.from([port >> 8, port & 255]))} 7f 00 00 01 ${toHex(Buffer.from('bob'))} 00`);
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'raw transport: SOCKS4a uses the 0.0.0.x sentinel then a NUL-terminated host', timeout: 10000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startSocks4Proxy();
    if (!proxy) { await closeServer(target.server); return; }
    try {
        useProxy('socks4a', proxy.port, { user: 'bob' });
        ok((await readRawTarget(target.port, 'localhost')).endsWith('proxy-ok'));
        const request = proxy.requests[0]!;
        strictEqual(request.remoteDns, true);
        strictEqual(request.destinationIp, '0.0.0.1');
        strictEqual(request.userId, 'bob');
        strictEqual(request.host, 'localhost');
        const port = target.port;
        strictEqual(
            proxy.wire[0]?.request,
            `04 01 ${toHex(Buffer.from([port >> 8, port & 255]))} 00 00 00 01 ${toHex(Buffer.from('bob'))} 00 ${toHex(Buffer.from('localhost'))} 00`,
        );
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'raw transport: NO_PROXY match bypasses the proxy entirely', timeout: 10000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startHttpProxy();
    if (!proxy) { await closeServer(target.server); return; }
    try {
        useProxy('http', proxy.port, { noProxy: '127.0.0.1' });
        const response = await readRawTarget(target.port);
        ok(response.endsWith('proxy-ok'));
        // Bypassed: the connection went straight to the target, so the proxy saw
        // neither an absolute-form forward nor a CONNECT.
        strictEqual(proxy.forwards.length, 0);
        strictEqual(proxy.connects.length, 0);
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test('raw transport: NO_PROXY respects domain boundaries and ports', () => {
    strictEqual(shouldBypassProxy(new URL('http://api.example.com/'), 'example.com'), true);
    strictEqual(shouldBypassProxy(new URL('http://badexample.com/'), 'example.com'), false);
    strictEqual(shouldBypassProxy(new URL('http://example.com:8080/'), 'example.com:8080'), true);
    strictEqual(shouldBypassProxy(new URL('http://example.com:8081/'), 'example.com:8080'), false);
    strictEqual(shouldBypassProxy(new URL('https://api.example.com/'), 'other.invalid; example.com:443'), true);
    strictEqual(shouldBypassProxy(new URL('http://intranet/'), '<local>'), true);
    strictEqual(shouldBypassProxy(new URL('http://api.example.com/'), '*.example.com'), true);
    strictEqual(shouldBypassProxy(new URL('http://[::1]:8080/'), '[::1]:8080'), true);
    strictEqual(shouldBypassProxy(new URL('http://[::1]:8081/'), '[::1]:8080'), false);
});
