import { ok, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { connectTcp } from '../../cno/src/utils/http.ts';
import { setRawConnectionHook } from '../../cno/src/utils/network-hooks.ts';
import { createProxyConnector, shouldBypassProxy, type ProxyConfig, type ProxyType } from '../../cno/src/utils/proxy.ts';

const ssl = import.meta.use('ssl');

class SocketReader {
    private buffer = Buffer.alloc(0);
    private waiters: Array<() => void> = [];
    private error: Error | null = null;

    constructor(private readonly socket: Socket) {
        socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.wake(); });
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
}

interface ListeningServer { server: Server; port: number; }

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

async function listenTls(handler: (socket: Socket) => void): Promise<ListeningServer | null> {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    return listenServer(createTlsServer({ cert, key }, handler));
}

function closeServer(server: Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
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

async function startSecureTargetServer(): Promise<ListeningServer | null> {
    return listenTls(handleTargetSocket);
}

async function startHttpProxy(secure = false): Promise<(ListeningServer & { connects: string[]; forwards: string[]; authorizations: string[] }) | null> {
    const connects: string[] = [];
    const forwards: string[] = [];
    const authorizations: string[] = [];
    const handler = (socket: Socket) => {
        const reader = new SocketReader(socket);
        void reader.readUntil(Buffer.from('\r\n\r\n')).then(request => {
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
            const upstream = connect(port, host);
            upstream.once('connect', () => {
                if (authority) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                else {
                    const originTarget = `${target!.pathname}${target!.search}`;
                    upstream.write(request.toString().replace(absoluteTarget!, originTarget));
                }
                socket.pipe(upstream).pipe(socket);
            });
            upstream.once('error', () => socket.destroy());
        }).catch(() => socket.destroy());
    };
    const listening = secure ? await listenTls(handler) : await listen(handler);
    return listening ? { ...listening, connects, forwards, authorizations } : null;
}

interface Socks5Request { addressType: number; host: string; port: number; }

async function startSocks5Proxy(credentials?: { user: string; pass: string }): Promise<(ListeningServer & { requests: Socks5Request[] }) | null> {
    const requests: Socks5Request[] = [];
    const listening = await listen(socket => {
        const reader = new SocketReader(socket);
        void (async () => {
            const greeting = await reader.read(2);
            const methods = await reader.read(greeting[1]!);
            const method = credentials ? 2 : 0;
            if (greeting[0] !== 5 || !methods.includes(method)) { socket.end(Buffer.from([5, 0xff])); return; }
            socket.write(Buffer.from([5, method]));
            if (credentials) {
                const authHead = await reader.read(2);
                const user = (await reader.read(authHead[1]!)).toString();
                const passLength = (await reader.read(1))[0]!;
                const pass = (await reader.read(passLength)).toString();
                const accepted = authHead[0] === 1 && user === credentials.user && pass === credentials.pass;
                socket.write(Buffer.from([1, accepted ? 0 : 1]));
                if (!accepted) return;
            }
            const requestHead = await reader.read(4);
            if (requestHead[0] !== 5 || requestHead[1] !== 1 || requestHead[2] !== 0) { socket.destroy(); return; }
            const addressType = requestHead[3]!;
            let host: string;
            if (addressType === 1) host = Array.from(await reader.read(4)).join('.');
            else if (addressType === 3) host = (await reader.read((await reader.read(1))[0]!)).toString();
            else { socket.destroy(); return; }
            const port = (await reader.read(2)).readUInt16BE(0);
            requests.push({ addressType, host, port });
            const upstream = connect(port, host);
            upstream.once('connect', () => {
                socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                socket.pipe(upstream).pipe(socket);
            });
            upstream.once('error', () => socket.destroy());
        })().catch(() => socket.destroy());
    });
    return listening ? { ...listening, requests } : null;
}

interface Socks4aRequest { host: string; port: number; }

async function startSocks4aProxy(): Promise<(ListeningServer & { requests: Socks4aRequest[] }) | null> {
    const requests: Socks4aRequest[] = [];
    const listening = await listen(socket => {
        const reader = new SocketReader(socket);
        void (async () => {
            const head = await reader.read(8);
            if (head[0] !== 4 || head[1] !== 1 || !head.subarray(4, 8).equals(Buffer.from([0, 0, 0, 1]))) { socket.destroy(); return; }
            await reader.readUntil(Buffer.from([0])); // user id
            const hostBytes = await reader.readUntil(Buffer.from([0]));
            const host = hostBytes.subarray(0, -1).toString();
            const port = head.readUInt16BE(2);
            requests.push({ host, port });
            const upstream = connect(port, host);
            upstream.once('connect', () => {
                socket.write(Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]));
                socket.pipe(upstream).pipe(socket);
            });
            upstream.once('error', () => socket.destroy());
        })().catch(() => socket.destroy());
    });
    return listening ? { ...listening, requests } : null;
}

function useProxy(type: ProxyType, port: number, extras: Partial<ProxyConfig> = {}): void {
    const scheme = type === 'https' ? 'https' : type.startsWith('socks') ? type : 'http';
    const config: ProxyConfig = { url: `${scheme}://127.0.0.1:${port}`, type, ...extras };
    setRawConnectionHook(createProxyConnector(() => config));
}

async function readRawTarget(port: number, hostname = '127.0.0.1'): Promise<string> {
    const socket = await connectTcp(new URL(`http://${hostname}:${port}/raw`));
    await socket.write(new TextEncoder().encode(`GET /raw HTTP/1.1\r\nHost: ${hostname}\r\n\r\n`));
    let response = '';
    while (!response.includes('proxy-ok')) {
        const chunk = await socket.read(256);
        if (!chunk) break;
        response += new TextDecoder().decode(chunk);
    }
    socket.close();
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
        useProxy('http', proxy.port);
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
        useProxy('https', proxy.port);
        ok((await readSecureTarget(target.port)).endsWith('proxy-ok'));
        strictEqual(proxy.connects.length, 1);
    } finally {
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'EventSource: receives SSE through HTTP proxy', timeout: 10000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startHttpProxy();
    if (!proxy) { await closeServer(target.server); return; }
    useProxy('http', proxy.port);
    const eventSource = new EventSource(`http://127.0.0.1:${target.port}/sse`);
    try {
        const message = await new Promise<MessageEvent>((resolve, reject) => {
            eventSource.onmessage = resolve;
            eventSource.onerror = () => reject(new Error('EventSource proxy request failed'));
        });
        strictEqual(message.data, 'proxy-sse');
        strictEqual(proxy.connects.length, 0);
        strictEqual(proxy.forwards.length, 1);
    } finally {
        eventSource.close();
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'WebSocket: upgrades and receives a frame through HTTP proxy', timeout: 10000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startHttpProxy();
    if (!proxy) { await closeServer(target.server); return; }
    useProxy('http', proxy.port);
    const socket = new WebSocket(`ws://127.0.0.1:${target.port}/ws`);
    try {
        const message = await new Promise<MessageEvent>((resolve, reject) => {
            socket.onmessage = resolve;
            socket.onerror = () => reject(new Error('WebSocket proxy request failed'));
        });
        strictEqual(message.data, 'proxy-ws');
        strictEqual(proxy.connects.length, 0);
        strictEqual(proxy.forwards.length, 1);
    } finally {
        socket.close();
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'WebSocket: WSS uses CONNECT, TLS, upgrade and frames', timeout: 10000 }, async () => {
    const target = await startSecureTargetServer();
    if (!target) return;
    const proxy = await startHttpProxy();
    if (!proxy) { await closeServer(target.server); return; }
    useProxy('http', proxy.port);
    const socket = new WebSocket(`wss://127.0.0.1:${target.port}/ws`);
    try {
        const message = await new Promise<MessageEvent>((resolve, reject) => {
            socket.onmessage = resolve;
            socket.onerror = () => reject(new Error('WSS proxy request failed'));
        });
        strictEqual(message.data, 'proxy-ws');
        strictEqual(proxy.connects.length, 1);
        strictEqual(proxy.forwards.length, 0);
    } finally {
        socket.close();
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

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
    const proxy = await startSocks4aProxy();
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

Deno.test('raw transport: NO_PROXY respects domain boundaries and ports', () => {
    strictEqual(shouldBypassProxy(new URL('http://api.example.com/'), 'example.com'), true);
    strictEqual(shouldBypassProxy(new URL('http://badexample.com/'), 'example.com'), false);
    strictEqual(shouldBypassProxy(new URL('http://example.com:8080/'), 'example.com:8080'), true);
    strictEqual(shouldBypassProxy(new URL('http://example.com:8081/'), 'example.com:8080'), false);
    strictEqual(shouldBypassProxy(new URL('http://intranet/'), '<local>'), true);
});
