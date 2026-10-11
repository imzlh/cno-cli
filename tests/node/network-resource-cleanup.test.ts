import { deepStrictEqual, strictEqual } from 'node:assert';
import * as http from 'node:http';
import * as net from 'node:net';

function trackedSignal() {
    const controller = new AbortController();
    const signal = controller.signal;
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...[type, listener, options]: Parameters<AbortSignal['addEventListener']>) => {
        if (type === 'abort' && listener) listeners.add(listener);
        add(type, listener, options);
    };
    signal.removeEventListener = (...[type, listener, options]: Parameters<AbortSignal['removeEventListener']>) => {
        if (type === 'abort' && listener) listeners.delete(listener);
        remove(type, listener, options);
    };
    return { controller, signal, listeners };
}

Deno.test('net: destroying a socket releases its constructor AbortSignal listener', async () => {
    const { signal, listeners } = trackedSignal();
    const socket = new net.Socket({ signal });
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    socket.destroy();
    await closed;
    strictEqual(listeners.size, 0);
});

Deno.test('net: a failed lookup releases its connect AbortSignal listener', async () => {
    const { signal, listeners } = trackedSignal();
    const socket = new net.Socket();
    const error = Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' });
    socket.on('error', (seen: NodeJS.ErrnoException) => strictEqual(seen.code, error.code));
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    const options: net.TcpSocketConnectOpts & { signal: AbortSignal } = {
        host: 'cleanup.invalid', port: 80, signal,
        lookup: (_host, _options, callback) => queueMicrotask(() => callback(error, '', 4)),
    };
    socket.connect(options);
    await closed;
    strictEqual(listeners.size, 0);
});

Deno.test('net: a pre-aborted constructor signal emits AbortError then close', async () => {
    const controller = new AbortController();
    controller.abort();
    const socket = new net.Socket({ signal: controller.signal });
    const events: string[] = [];
    socket.on('error', (error: NodeJS.ErrnoException) => events.push(error.code!));
    await new Promise<void>((resolve) => socket.once('close', () => {
        events.push('close');
        resolve();
    }));
    deepStrictEqual(events, ['ABORT_ERR', 'close']);
});

for (const send of ['end', 'write', 'flushHeaders'] as const) {
    Deno.test(`http: failed ${send} closes the request and releases its AbortSignal listener`, async () => {
        const { signal, listeners } = trackedSignal();
        const error = Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' });
        const request = http.request({
            host: 'cleanup.invalid', port: 80, agent: false, signal,
            lookup: (_host, _options, callback) => queueMicrotask(() => callback(error, '', 4)),
        });
        const events: string[] = [];
        request.on('error', (seen: NodeJS.ErrnoException) => events.push(seen.code!));
        const closed = new Promise<void>((resolve) => request.once('close', () => {
            events.push('close');
            resolve();
        }));
        if (send === 'flushHeaders') request.flushHeaders();
        else request[send]('payload');
        await closed;
        deepStrictEqual(events, ['ENOTFOUND', 'close']);
        strictEqual(listeners.size, 0);
    });
}
