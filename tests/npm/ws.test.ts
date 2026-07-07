import { ok, strictEqual } from 'node:assert';
import { createServer } from 'node:http';

function once(target: any, event: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
        target.once(event, (...args: any[]) => resolve(args));
        target.once('error', reject);
    });
}

function closeWsServer(server: any): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

async function closeWsClient(client: any): Promise<void> {
    if (!client || client.readyState === client.CLOSED) return;
    const closed = once(client, 'close').then(() => undefined);
    client.close();
    await closed;
}

async function withWsEchoServer(fn: (url: string) => Promise<void>): Promise<void> {
    const mod = await import('npm:ws');
    const server = new mod.WebSocketServer({ host: '127.0.0.1', port: 0 });

    try {
        await once(server, 'listening');
        const address = server.address();
        ok(address && typeof address === 'object', 'server.address() should be an address object');

        server.once('connection', (socket: any) => {
            socket.once('message', (data: unknown) => {
                socket.send(`echo:${String(data)}`);
            });
        });

        await fn(`ws://127.0.0.1:${address.port}`);
    } finally {
        await closeWsServer(server);
    }
}

async function assertEcho(WebSocket: any, url: string): Promise<void> {
    const client = new WebSocket(url);
    await once(client, 'open');
    client.send('hello');
    const [message] = await once(client, 'message');
    strictEqual(String(message), 'echo:hello');
    await closeWsClient(client);
}

Deno.test({ name: 'ws: server and client echo over loopback', timeout: 30000 }, async () => {
    const mod = await import('npm:ws');
    const WebSocket = mod.default ?? mod.WebSocket;
    await withWsEchoServer((url) => assertEcho(WebSocket, url));
});

Deno.test({ name: 'ws: transfers binary frames and ping-pong payloads', timeout: 30000 }, async () => {
    const mod = await import('npm:ws');
    const WebSocket = mod.default ?? mod.WebSocket;
    const server = new mod.WebSocketServer({ host: '127.0.0.1', port: 0 });

    try {
        await once(server, 'listening');
        const address = server.address();
        ok(address && typeof address === 'object', 'server.address() should be an address object');

        server.once('connection', (socket: any) => {
            socket.once('message', (data: unknown) => {
                socket.send(Buffer.from(data as Uint8Array).reverse());
            });
            socket.once('ping', (data: Uint8Array) => {
                socket.pong(data);
            });
        });

        const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
        await once(client, 'open');
        client.send(Buffer.from([1, 2, 3, 4]));
        const [message] = await once(client, 'message');
        strictEqual(Buffer.from(message).join(','), '4,3,2,1');

        client.ping(Buffer.from('hi'));
        const [pong] = await once(client, 'pong');
        strictEqual(Buffer.from(pong).toString('utf8'), 'hi');
        await closeWsClient(client);
    } finally {
        await closeWsServer(server);
    }
});

Deno.test({ name: 'ws: propagates close code and reason between client and server', timeout: 30000 }, async () => {
    const mod = await import('npm:ws');
    const WebSocket = mod.default ?? mod.WebSocket;
    const server = new mod.WebSocketServer({ host: '127.0.0.1', port: 0 });

    try {
        await once(server, 'listening');
        const address = server.address();
        ok(address && typeof address === 'object', 'server.address() should be an address object');

        const serverClosed = new Promise<[number, Buffer]>((resolve) => {
            server.once('connection', (socket: any) => {
                socket.once('close', (code: number, reason: Buffer) => resolve([code, reason]));
            });
        });

        const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
        await once(client, 'open');
        const clientClosed = once(client, 'close');
        client.close(4001, 'client-done');

        const [code, reason] = await serverClosed;
        strictEqual(code, 4001);
        strictEqual(reason.toString('utf8'), 'client-done');
        await clientClosed;
    } finally {
        await closeWsServer(server);
    }
});

Deno.test({ name: 'isomorphic-ws: node client echo over ws server', timeout: 30000 }, async () => {
    const mod = await import('npm:isomorphic-ws');
    const WebSocket = mod.default ?? mod.WebSocket ?? mod;
    await withWsEchoServer((url) => assertEcho(WebSocket, url));
});

Deno.test({ name: 'socket.io: websocket client/server emits acknowledgement over loopback', timeout: 60000 }, async () => {
    const { Server } = await import('npm:socket.io');
    const { io: createClient } = await import('npm:socket.io-client');
    const httpServer = createServer();
    const ioServer = new Server(httpServer);
    let client: any;

    try {
        ioServer.on('connection', (socket: any) => {
            socket.on('ping', (value: string, reply: (value: string) => void) => {
                reply(`pong:${value}`);
            });
        });

        const port = await new Promise<number>((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(0, '127.0.0.1', () => {
                const address = httpServer.address();
                if (!address || typeof address === 'string') reject(new Error('server did not expose a port'));
                else resolve(address.port);
            });
        });

        const reply = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('socket.io timeout')), 5000);
            client = createClient(`http://127.0.0.1:${port}`, {
                transports: ['websocket'],
                upgrade: false,
                reconnection: false,
                timeout: 2000,
            });
            client.once('connect_error', (err: Error) => {
                clearTimeout(timer);
                reject(err);
            });
            client.once('connect', () => {
                client.emit('ping', 'cno', (value: string) => {
                    clearTimeout(timer);
                    resolve(value);
                });
            });
        });

        strictEqual(reply, 'pong:cno');
    } finally {
        client?.close();
        await ioServer.close();
    }
});
