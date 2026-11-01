import { rejects, strictEqual } from 'node:assert';
import { InspectorProtocolClient } from '../../cno/src/node/inspector/client';

class ClientSocket {
    static OPEN = 1;
    readyState = 0;
    closed = false;
    sent: string[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;

    open(): void { this.readyState = 1; this.onopen?.(); }
    close(): void { this.closed = true; this.readyState = 3; this.onclose?.(); }
    send(data: string): void { this.sent.push(data); }
}

async function tick(): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
}

async function withTransport(fn: (client: InspectorProtocolClient, mock: {
    sockets: ClientSocket[];
    open: () => Promise<string>;
}) => Promise<void>): Promise<void> {
    const bus = import.meta.use('evbus');
    const published = bus.get('cno.inspector', 'bridge');
    const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    const mock = { sockets: [] as ClientSocket[], open: () => Promise.resolve('ws://127.0.0.1:9229') };
    const client = new InspectorProtocolClient();
    bus.set('cno.inspector', 'bridge', {
        open: () => mock.open(), close: async () => {}, url: () => undefined,
        waitForConnection: async () => {}, waitForDebugger: async () => {}, isActive: () => false,
    });
    Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        value: class extends ClientSocket {
            constructor() { super(); mock.sockets.push(this); }
        },
    });
    try { await fn(client, mock); }
    finally {
        client.disconnect();
        if (published !== undefined) bus.set('cno.inspector', 'bridge', published);
        else bus.delete('cno.inspector', 'bridge');
        if (socketDescriptor) Object.defineProperty(globalThis, 'WebSocket', socketDescriptor);
        else Reflect.deleteProperty(globalThis, 'WebSocket');
    }
}

Deno.test('inspector client: disconnect cancels socket creation while the bridge opens', async () => {
    await withTransport(async (client, mock) => {
        let finishOpen!: (url: string) => void;
        mock.open = () => new Promise(resolve => { finishOpen = resolve; });
        client.connect(false, false);
        client.disconnect();
        finishOpen('ws://127.0.0.1:9229');
        await tick();
        strictEqual(mock.sockets.length, 0);
    });
});

Deno.test('inspector client: disconnect closes an opening WebSocket and permits reconnect', async () => {
    await withTransport(async (client, mock) => {
        client.connect(false, false);
        await tick();
        const first = mock.sockets[0]!;
        client.disconnect();
        strictEqual(first.closed, true);
        client.connect(false, false);
        await tick();
        strictEqual(mock.sockets.length, 2);
        const second = mock.sockets[1]!;
        second.open();
        first.open();
        const response = client.post('Runtime.enable');
        await tick();
        strictEqual(first.sent.length, 0);
        const request = JSON.parse(second.sent[0]!);
        second.onmessage?.({ data: JSON.stringify({ id: request.id, result: { connected: true } }) });
        strictEqual((await response).connected, true);
    });
});

Deno.test('inspector client: stale socket close cannot reject requests on a reconnected session', async () => {
    await withTransport(async (client, mock) => {
        client.connect(false, false);
        await tick();
        const first = mock.sockets[0]!;
        first.open();
        await tick();
        const oldClose = first.onclose;
        client.disconnect();
        client.connect(false, false);
        await tick();
        const second = mock.sockets[1]!;
        second.open();
        const response = client.post('Runtime.enable');
        await tick();
        oldClose?.();
        const request = JSON.parse(second.sent[0]!);
        second.onmessage?.({ data: JSON.stringify({ id: request.id, result: { connected: true } }) });
        strictEqual((await response).connected, true);
    });
});

Deno.test('inspector client: an active connection failure preserves its error and permits retry', async () => {
    await withTransport(async (client, mock) => {
        const failure = new Error('attach failed');
        mock.open = () => Promise.reject(failure);
        await rejects(client.post('Runtime.enable'), error => error === failure);
        mock.open = () => Promise.resolve('ws://127.0.0.1:9229');
        const response = client.post('Runtime.enable');
        await tick();
        const socket = mock.sockets[0]!;
        socket.open();
        await tick();
        const request = JSON.parse(socket.sent[0]!);
        socket.onmessage?.({ data: JSON.stringify({ id: request.id, result: { connected: true } }) });
        strictEqual((await response).connected, true);
    });
});
