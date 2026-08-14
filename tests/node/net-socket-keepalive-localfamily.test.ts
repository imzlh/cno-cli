import { ok, strictEqual } from 'node:assert';
import * as net from 'node:net';

// A >=50ms interval spans every close in this file. A microtask enqueued from a
// handle-close callback is invisible to libuv's aliveness test, so without a
// live timer an await after server.close()/socket.destroy() is silently
// abandoned and the test reports a cheerful pass having run nothing.
function keepLoopAlive(): { done: () => void } {
    const handle = setInterval(() => {}, 50);
    return { done: () => clearInterval(handle) };
}

function listen(server: net.Server, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => resolve());
    });
}
function close(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}
function connected(socket: net.Socket): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
    });
}

// --- setKeepAlive with a zero delay must not throw ---------------------------
//
// libuv rejects uv_tcp_keepalive(enable=1, delay=0) with EINVAL on Windows.
// Node hands the same 0 to the same libuv call and ignores the return value, so
// `setKeepAlive()` and `setKeepAlive(true)` — the two most common forms, both
// meaning "delay 0" — are observable no-ops in node rather than throws.
// Verified against node v24.18.0 on the same machine: all forms below return
// the socket. Before the fix cno threw `EINVAL: invalid argument` (uv errno
// -4071) for every zero-delay form while accepting any delay >= 1ms.

Deno.test('net: setKeepAlive with a zero delay is a no-op, not an EINVAL throw', async () => {
    const alive = keepLoopAlive();
    const server = net.createServer();
    try {
        await listen(server);
        const port = (server.address() as net.AddressInfo).port;
        const socket = net.connect(port, '127.0.0.1');
        await connected(socket);

        // Every one of these resolves to a delay of 0 and must not throw.
        strictEqual(socket.setKeepAlive(), socket, 'setKeepAlive() threw or did not return the socket');
        strictEqual(socket.setKeepAlive(true), socket, 'setKeepAlive(true) threw');
        strictEqual(socket.setKeepAlive(true, 0), socket, 'setKeepAlive(true, 0) threw');
        strictEqual(socket.setKeepAlive(true, undefined), socket, 'setKeepAlive(true, undefined) threw');
        strictEqual(socket.setKeepAlive(false), socket, 'setKeepAlive(false) threw');
        strictEqual(socket.setKeepAlive(false, 1000), socket, 'setKeepAlive(false, 1000) threw');

        // A non-zero delay was never broken; keep it covered so a fix that
        // simply swallows every error still has to keep this path working.
        strictEqual(socket.setKeepAlive(true, 1), socket, 'setKeepAlive(true, 1) threw');
        strictEqual(socket.setKeepAlive(true, 1000), socket, 'setKeepAlive(true, 1000) threw');
        strictEqual(socket.setKeepAlive(true, 10000), socket, 'setKeepAlive(true, 10000) threw');

        socket.destroy();
        await close(server);
    } finally {
        alive.done();
    }
});

Deno.test('net: keepAlive via connect options does not reject the connection', async () => {
    const alive = keepLoopAlive();
    const server = net.createServer();
    try {
        await listen(server);
        const port = (server.address() as net.AddressInfo).port;
        // keepAliveInitialDelay 0 is the default, so this exercises the same
        // zero-delay path from the options object rather than the setter.
        const socket = net.connect({ port, host: '127.0.0.1', keepAlive: true });
        await connected(socket);
        ok(!socket.destroyed, 'socket was destroyed by the keepAlive option');
        socket.destroy();
        await close(server);
    } finally {
        alive.done();
    }
});

// --- socket.localFamily / socket.pending ------------------------------------
//
// Both are documented node properties that were `undefined` in cno. `undefined`
// is the quiet failure mode: it passes `if (socket.pending)` while failing
// `socket.pending === false`, and localFamily silently drops out of any
// address-family branch.

Deno.test('net: socket exposes localFamily on both the client and server side', async () => {
    const alive = keepLoopAlive();
    const server = net.createServer();
    const accepted: net.Socket[] = [];
    server.on('connection', (s) => accepted.push(s));
    try {
        await listen(server);
        const port = (server.address() as net.AddressInfo).port;
        const client = net.connect(port, '127.0.0.1');
        await connected(client);
        await new Promise<void>((resolve) => {
            const t = setInterval(() => {
                if (accepted.length > 0) { clearInterval(t); resolve(); }
            }, 10);
        });

        strictEqual(client.localFamily, 'IPv4');
        strictEqual(client.remoteFamily, 'IPv4');
        strictEqual(accepted[0]!.localFamily, 'IPv4');
        strictEqual(accepted[0]!.remoteFamily, 'IPv4');
        // localFamily must agree with what address() reports.
        strictEqual(client.localFamily, (client.address() as net.AddressInfo).family);

        client.destroy();
        await close(server);
    } finally {
        alive.done();
    }
});

Deno.test('net: socket.pending is a boolean, true before connect and false after', async () => {
    const alive = keepLoopAlive();
    const server = net.createServer();
    try {
        await listen(server);
        const port = (server.address() as net.AddressInfo).port;

        // A socket with no handle at all is pending.
        const fresh = new net.Socket();
        strictEqual(typeof fresh.pending, 'boolean', 'pending must be a boolean, not undefined');
        strictEqual(fresh.pending, true);

        const client = net.connect(port, '127.0.0.1');
        await connected(client);
        // Strict false, not merely falsy — `undefined` was the original bug and
        // would satisfy a truthiness assertion.
        strictEqual(client.pending, false);
        strictEqual(typeof client.pending, 'boolean');

        client.destroy();
        await close(server);
    } finally {
        alive.done();
    }
});

// --- server.listen(callback) must invoke the callback ------------------------
//
// Node's normalizeArgs peels a leading callback and binds an ephemeral port.
// cno used to fall through to the object/path branch: the server DID come up
// (listening === true, an ephemeral port bound) but the callback was never
// registered, so the caller's readiness handler silently never ran. That is the
// quiet failure mode — no throw, no error event, a working server, and dead
// application code. Verified against node v24.18.0.

Deno.test('net: server.listen(callback) invokes the callback and emits listening', async () => {
    const alive = keepLoopAlive();
    const server = net.createServer();
    try {
        const events: string[] = [];
        server.on('listening', () => events.push('listening'));
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('listen(cb) never invoked its callback')),
                3000,
            );
            server.listen(() => {
                clearTimeout(timer);
                events.push('callback');
                resolve();
            });
        });

        ok(events.includes('callback'), 'listen(cb) callback did not run');
        ok(events.includes('listening'), "'listening' was not emitted");
        strictEqual(events[0], 'listening', "'listening' must precede the callback");
        strictEqual(server.listening, true);

        // An ephemeral port must actually be bound, not port 0 or 80.
        const addr = server.address() as net.AddressInfo;
        strictEqual(typeof addr.port, 'number');
        ok(addr.port > 0, 'no port was bound');
        ok(addr.port !== 80, 'listen(cb) bound port 80 instead of an ephemeral port');

        await close(server);
    } finally {
        alive.done();
    }
});
