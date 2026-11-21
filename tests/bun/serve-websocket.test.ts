import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { serve } from 'bun';

function waitForClose(socket: WebSocket): Promise<void> {
    const deferred = Promise.withResolvers<void>();
    socket.addEventListener('close', () => deferred.resolve(), { once: true });
    socket.addEventListener('error', event => deferred.reject(event), { once: true });
    return deferred.promise;
}

Deno.test({ name: 'bun.serve websocket: upgrade survives handler failure and echoes', timeout: 10000 }, async () => {
    let errors = 0;
    const server = serve({
        hostname: '127.0.0.1',
        port: 0,
        websocket: {
            open(socket) { socket.sendText('ready'); },
            message(socket, message) { socket.sendText(`echo:${message}`); },
        },
        error() { errors++; return new Response('ignored', { status: 500 }); },
        fetch(request, current) {
            ok(current.upgrade(request, { data: { role: 'test' } }));
            throw new Error('after-upgrade');
        },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    const messages: string[] = [];
    const opened = Promise.withResolvers<void>();
    const firstMessage = Promise.withResolvers<void>();
    socket.addEventListener('open', () => { opened.resolve(); socket.send('ping'); });
    socket.addEventListener('message', event => {
        messages.push(String(event.data));
        if (messages.length === 2) firstMessage.resolve();
    });
    try {
        await opened.promise;
        await firstMessage.promise;
        deepStrictEqual(messages, ['ready', 'echo:ping']);
        strictEqual(errors, 1);
    } finally {
        socket.close();
        await waitForClose(socket).catch(() => {});
        await server.stop();
    }
    strictEqual(server.pendingWebSockets, 0);
});

Deno.test({ name: 'bun.serve websocket: async handler rejection reaches error handler', timeout: 10000 }, async () => {
    const failure = new Error('async websocket failure');
    const reported = Promise.withResolvers<Error>();
    const server = serve({
        hostname: '127.0.0.1',
        port: 0,
        websocket: {
            async message() { await Promise.resolve(); throw failure; },
            error(error) { reported.resolve(error); },
        },
        fetch(request, current) {
            current.upgrade(request);
        },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    try {
        await new Promise<void>((resolve, reject) => {
            socket.addEventListener('open', () => { socket.send('fail'); resolve(); }, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        strictEqual(await reported.promise, failure);
    } finally {
        socket.close();
        await waitForClose(socket).catch(() => {});
        await server.stop();
    }
});

Deno.test({ name: 'bun.serve websocket: topic publish excludes source and stop drains clients', timeout: 10000 }, async () => {
    const server = serve({
        hostname: '127.0.0.1',
        port: 0,
        websocket: {
            open(socket) { socket.subscribe('room'); },
            message(_socket, message) { if (message === 'broadcast') server.publish('room', 'published'); },
        },
        fetch(request, current) {
            if (current.upgrade(request)) return;
            return new Response('not upgraded', { status: 400 });
        },
    });
    const first = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    const second = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    const opened = Promise.withResolvers<void>();
    let count = 0;
    first.onopen = () => { if (++count === 2) opened.resolve(); };
    second.onopen = () => { if (++count === 2) opened.resolve(); };
    const secondMessage = Promise.withResolvers<string>();
    const firstMessages: string[] = [];
    first.onmessage = event => firstMessages.push(String(event.data));
    second.onmessage = event => secondMessage.resolve(String(event.data));
    try {
        await opened.promise;
        first.send('broadcast');
        strictEqual(await secondMessage.promise, 'published');
        await new Promise(resolve => setTimeout(resolve, 20));
        deepStrictEqual(firstMessages, ['published']);
        strictEqual(server.subscriberCount('room'), 2);
    } finally {
        first.close();
        second.close();
        await Promise.all([waitForClose(first), waitForClose(second)]).catch(() => {});
        await server.stop();
    }
    strictEqual(server.pendingWebSockets, 0);
});
