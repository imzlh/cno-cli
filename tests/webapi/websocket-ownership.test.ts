import { deepStrictEqual, strictEqual } from 'node:assert';
import { createWebSocketFromConnection, type ServerWebSocketConnection } from '../../cno/src/webapi/websocket.ts';

Deno.test('WebSocket server: rejected connection handoff closes instead of staying CONNECTING', async () => {
    const connection = Promise.withResolvers<ServerWebSocketConnection>();
    const socket = createWebSocketFromConnection(connection.promise);
    const events: string[] = [];
    const closed = new Promise<void>(resolve => {
        socket.onerror = () => { events.push('error'); };
        socket.onclose = () => { events.push('close'); resolve(); };
    });
    connection.reject(new Error('upgrade failed'));
    await closed;
    strictEqual(socket.readyState, WebSocket.CLOSED);
    deepStrictEqual(events, ['error', 'close']);
});
