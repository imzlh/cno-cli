/**
 * EventSource / WebSocket over a proxy.
 *
 * These cases previously lived in proxy-transport.test.ts and could never pass
 * there. The global `EventSource` / `WebSocket` are the *baked* classes; they
 * resolve `getRawConnectionHook()` against the baked copy of
 * cno/src/utils/network-hooks.ts, whereas a test importing
 * `../../cno/src/utils/network-hooks.ts` writes to a second, disk-loaded copy of
 * that module. Nothing connects the two module instances, so the baked globals
 * dialled the target directly and every proxy counter stayed at 0 — the failure
 * looked like a broken proxy but was a broken harness.
 *
 * The fix is to drive the *disk-imported* EventSource / WebSocket, so the client
 * and the hook are the same instance. That has one side effect worth naming:
 * cno/src/webapi/events.ts installs its classes onto globalThis at module scope
 * (`Reflect.set(globalThis, name, cls)`), so importing the disk graph replaces
 * the global Event / EventTarget / MessageEvent / ... . Left in place, the baked
 * `bridgeEvent` teardown path then dispatches a disk `Event` at a baked
 * `EventTarget` and throws `TypeError: Invalid event object` at worker exit,
 * killing 'beforeunload' / 'unload' for this file. The dynamic import below is
 * therefore bracketed by a snapshot/restore of those globals.
 */
import { ok, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { setRawConnectionHook } from '../../cno/src/utils/network-hooks.ts';
import { createProxyConnector, type ProxyConfig, type ProxyType } from '../../cno/src/utils/proxy.ts';

const ssl = import.meta.use('ssl');

// --- disk client classes, with the global event classes preserved -------------

const BAKED_EVENT_GLOBALS = {
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    CustomEvent: globalThis.CustomEvent,
    ErrorEvent: globalThis.ErrorEvent,
    PromiseRejectionEvent: globalThis.PromiseRejectionEvent,
    CloseEvent: globalThis.CloseEvent,
    MessageEvent: globalThis.MessageEvent,
    DOMException: globalThis.DOMException,
    ProgressEvent: globalThis.ProgressEvent,
} as const;

const { EventSource } = await import('../../cno/src/webapi/sse.ts');
const { WebSocket } = await import('../../cno/src/webapi/websocket.ts');

/**
 * True when the disk graph really did overwrite the globals.
 *
 * The globals must stay clobbered for the duration of the tests: the disk
 * classes `extends EventTarget` against whatever the global was at module-eval
 * time (the disk one), but construct `new Event(...)` from the global at *call*
 * time. Restoring the baked classes up front therefore makes every dispatch
 * throw `Invalid event object` from inside the disk EventTarget. The final test
 * in this file performs the restore, so teardown's `bridgeEvent` sees a matched
 * pair again.
 */
const clobberedGlobals = globalThis.Event !== BAKED_EVENT_GLOBALS.Event;

// --- fixtures ----------------------------------------------------------------

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

    async readUntil(marker: Buffer): Promise<Buffer> {
        let index = -1;
        await this.waitFor(() => (index = this.buffer.indexOf(marker)) >= 0);
        const end = index + marker.length;
        const result = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        return result;
    }

    /** Detach from the socket and return any unread bytes (e.g. a TLS ClientHello). */
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

/** See the twin helper in proxy-transport.test.ts: cno's node:net tries only addresses[0]. */
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
    socket.on('error', () => {});
}

async function startTargetServer(): Promise<ListeningServer | null> {
    return listenServer(createServer(handleTargetSocket));
}

async function startSecureTargetServer(): Promise<(ListeningServer & { cert: string }) | null> {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = createTlsServer({ cert, key }, handleTargetSocket);
    server.on('tlsClientError', () => {});
    const listening = await listenServer(server);
    return listening ? { ...listening, cert } : null;
}

async function startHttpProxy(): Promise<(ListeningServer & { connects: string[]; forwards: string[]; authorizations: string[] }) | null> {
    const connects: string[] = [];
    const forwards: string[] = [];
    const authorizations: string[] = [];
    const listening = await listenServer(createServer((socket: Socket) => {
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
            // Detach reader and pause before 200 so a TLS ClientHello cannot race past us.
            const leftover = reader.takeRest();
            socket.pause();
            if (authority) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            else upstream.write(request.toString().replace(absoluteTarget!, `${target!.pathname}${target!.search}`));
            if (leftover.length) upstream.write(leftover);
            socket.pipe(upstream).pipe(socket);
            socket.resume();
        }).catch(() => socket.destroy());
        socket.on('error', () => {});
    }));
    return listening ? { ...listening, connects, forwards, authorizations } : null;
}

/**
 * Install the proxy connector.
 *
 * `trustRoots` keeps the WSS case honest now that the raw path verifies by
 * default: `new WebSocket(url)` takes no TLS options, so the trust decision has
 * to ride on the connector the test installs. The fixture certificate is named
 * as a root rather than verification being switched off.
 */
function useProxy(type: ProxyType, port: number, extras: Partial<ProxyConfig> = {}, trustRoots?: string[]): void {
    const scheme = type === 'https' ? 'https' : type.startsWith('socks') ? type : 'http';
    const config: ProxyConfig = { url: `${scheme}://127.0.0.1:${port}`, type, ...extras };
    setRawConnectionHook(createProxyConnector(() => config, trustRoots ? { caCerts: trustRoots } : undefined));
}

/** Resolve on the first message, reject on error, and never hang forever. */
function firstMessage(source: { onmessage: unknown; onerror: unknown }, label: string, ms = 8000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} produced no message within ${ms}ms`)), ms);
        Reflect.set(source, 'onmessage', (event: { data: string }) => { clearTimeout(timer); resolve(event.data); });
        Reflect.set(source, 'onerror', () => { clearTimeout(timer); reject(new Error(`${label} failed`)); });
    });
}

// --- tests -------------------------------------------------------------------

Deno.test('proxy clients: disk import replaced the global event classes', () => {
    // Documents the hazard the header describes, and keeps the restore at the
    // bottom of this file from becoming dead weight unnoticed: if the import
    // graph ever stops installing globals, this says so.
    strictEqual(clobberedGlobals, true);
    strictEqual(globalThis.Event === BAKED_EVENT_GLOBALS.Event, false);
});

Deno.test({ name: 'EventSource: receives SSE through HTTP proxy', timeout: 15000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startHttpProxy();
    if (!proxy) { await closeServer(target.server); return; }
    useProxy('http', proxy.port);
    const eventSource = new EventSource(`http://127.0.0.1:${target.port}/sse`);
    try {
        strictEqual(await firstMessage(eventSource, 'EventSource'), 'proxy-sse');
        // Plain http: target => absolute-form forwarding, never CONNECT.
        strictEqual(proxy.connects.length, 0);
        strictEqual(proxy.forwards.length, 1);
        ok(proxy.forwards[0]!.endsWith('/sse'));
    } finally {
        eventSource.close();
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'EventSource: sends Proxy-Authorization through HTTP proxy', timeout: 15000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startHttpProxy();
    if (!proxy) { await closeServer(target.server); return; }
    useProxy('http', proxy.port, { user: 'u', pass: 'p' });
    const eventSource = new EventSource(`http://127.0.0.1:${target.port}/sse`);
    try {
        strictEqual(await firstMessage(eventSource, 'EventSource'), 'proxy-sse');
        strictEqual(proxy.authorizations[0], `Basic ${btoa('u:p')}`);
    } finally {
        eventSource.close();
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'WebSocket: upgrades and receives a frame through HTTP proxy', timeout: 15000 }, async () => {
    const target = await startTargetServer();
    if (!target) return;
    const proxy = await startHttpProxy();
    if (!proxy) { await closeServer(target.server); return; }
    useProxy('http', proxy.port);
    const socket = new WebSocket(`ws://127.0.0.1:${target.port}/ws`);
    try {
        strictEqual(await firstMessage(socket, 'WebSocket'), 'proxy-ws');
        strictEqual(proxy.connects.length, 0);
        strictEqual(proxy.forwards.length, 1);
        // ws: is rewritten to http: for the absolute-form request-target.
        ok(proxy.forwards[0]!.startsWith('http://'));
    } finally {
        try { socket.close(); } catch { /* already closing */ }
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

Deno.test({ name: 'WebSocket: WSS uses CONNECT, TLS, upgrade and frames', timeout: 15000 }, async () => {
    const target = await startSecureTargetServer();
    if (!target) return;
    const proxy = await startHttpProxy();
    if (!proxy) { await closeServer(target.server); return; }
    // The target certificate is self-signed, so the test names it as a trust
    // root. Before the raw path verified anything this passed only because no
    // check ran at all.
    useProxy('http', proxy.port, {}, [target.cert]);
    const socket = new WebSocket(`wss://127.0.0.1:${target.port}/ws`);
    try {
        strictEqual(await firstMessage(socket, 'WSS WebSocket'), 'proxy-ws');
        strictEqual(proxy.connects.length, 1);
        strictEqual(proxy.connects[0], `127.0.0.1:${target.port}`);
        strictEqual(proxy.forwards.length, 0);
    } finally {
        try { socket.close(); } catch { /* already closing */ }
        setRawConnectionHook(null);
        await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
    }
});

// MUST STAY LAST. Puts the baked event classes back so the worker's teardown
// path (bridgeEvent -> globalEvent.dispatchEvent(new Event('beforeunload'))) is
// not handed a disk Event by a baked EventTarget, which throws
// `TypeError: Invalid event object` at exit and silently kills
// 'beforeunload' / 'unload' for this file.
Deno.test('proxy clients: baked event globals restored for teardown', () => {
    for (const [name, cls] of Object.entries(BAKED_EVENT_GLOBALS)) Reflect.set(globalThis, name, cls);
    strictEqual(globalThis.Event, BAKED_EVENT_GLOBALS.Event);
    strictEqual(globalThis.MessageEvent, BAKED_EVENT_GLOBALS.MessageEvent);
    new EventTarget().dispatchEvent(new Event('probe'));
});
