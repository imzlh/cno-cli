import { ok, strictEqual } from 'node:assert';
import * as net from 'node:net';

// A >=50ms interval spans every close. A microtask enqueued from a handle-close
// callback is invisible to libuv's aliveness test, so without a live timer an
// await after server.close() is abandoned and the file exits 0 having asserted
// nothing — indistinguishable from a clean pass.
function keepLoopAlive(): { done: () => void } {
    const handle = setInterval(() => {}, 50);
    return { done: () => clearInterval(handle) };
}

// `allowHalfOpen` governs whether a socket auto-ends its writable side when the
// peer ends. Node's stream Duplex defaults it to TRUE, but node's net.Socket
// overrides that to FALSE; cno inherited the stream default and reported `true`.
//
// Worth being precise about what was and was not broken, because the two come
// apart: teardown BEHAVIOUR was already node-identical (cno auto-ended and closed on
// peer end via a separate private `_allowHalfOpen` flag that did default to
// false). It was the public property that lied. So this is a wrong-answer defect
// in a documented, readable property — code that branches on
// `socket.allowHalfOpen` took the wrong path — not a teardown divergence.
// Verified against node v24.18.0 on the same machine.

Deno.test('net.Socket: allowHalfOpen defaults to false like node, not the stream default', () => {
    strictEqual(new net.Socket().allowHalfOpen, false);
    strictEqual(new net.Socket({}).allowHalfOpen, false);
    strictEqual(new net.Socket({ allowHalfOpen: undefined }).allowHalfOpen, false);
    // An explicit value must still win in both directions.
    strictEqual(new net.Socket({ allowHalfOpen: true }).allowHalfOpen, true);
    strictEqual(new net.Socket({ allowHalfOpen: false }).allowHalfOpen, false);
    // Strictly boolean — `undefined` would satisfy a falsy check but fail this.
    strictEqual(typeof new net.Socket().allowHalfOpen, 'boolean');
});

Deno.test('net.Server: allowHalfOpen and pauseOnConnect are readable booleans', () => {
    // Both were `undefined`, which reads as "off" only by accident.
    strictEqual(net.createServer().allowHalfOpen, false);
    strictEqual(net.createServer().pauseOnConnect, false);
    strictEqual(net.createServer(() => {}).allowHalfOpen, false, 'createServer(cb) path');
    strictEqual(net.createServer(() => {}).pauseOnConnect, false, 'createServer(cb) path');
    strictEqual(net.createServer({ allowHalfOpen: true }).allowHalfOpen, true);
    strictEqual(net.createServer({ pauseOnConnect: true }).pauseOnConnect, true);
    strictEqual(net.createServer({ allowHalfOpen: false }).allowHalfOpen, false);
    strictEqual(typeof net.createServer().allowHalfOpen, 'boolean');
    strictEqual(typeof net.createServer().pauseOnConnect, 'boolean');
});

// The property must keep agreeing with the behaviour it names. These two tests
// are the guard against a "fix" that flips the reported value without the
// mechanism, or vice versa.

async function peerEndTeardown(
    makeSocket: () => net.Socket,
): Promise<{ events: string[]; writable: boolean; destroyed: boolean }> {
    const server = net.createServer((s) => s.end('bye'));
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as net.AddressInfo).port;
    const socket = makeSocket();
    const events: string[] = [];
    socket.on('end', () => events.push('end'));
    socket.on('close', () => events.push('close'));
    socket.on('finish', () => events.push('finish'));
    // The readable side must reach EOF for 'end' to fire at all — a paused
    // socket never emits it, which would make both columns look inert and hide
    // the very semantics under test.
    socket.on('data', () => {});
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
        socket.connect(port, '127.0.0.1');
    });
    await new Promise<void>((r) => setTimeout(r, 400));
    // Snapshot before the cleanup below. Returning the live array lets the
    // explicit socket.destroy() append a synthetic 'close' to the result and
    // falsely reports a half-open socket as having closed on peer EOF.
    const result = { events: [...events], writable: socket.writable, destroyed: socket.destroyed };
    socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setTimeout(r, 60));
    return result;
}

Deno.test('net.Socket: the default socket auto-ends when the peer ends', async () => {
    const alive = keepLoopAlive();
    try {
        const r = await peerEndTeardown(() => new net.Socket());
        ok(r.events.includes('end'), "'end' never fired — the readable side did not reach EOF");
        ok(r.events.includes('finish'), 'the writable side was not auto-ended');
        ok(r.events.includes('close'), 'the socket did not close');
        strictEqual(r.writable, false);
        strictEqual(r.destroyed, true);
    } finally {
        alive.done();
    }
});

Deno.test('net.Socket: allowHalfOpen true keeps the socket writable after peer end', async () => {
    const alive = keepLoopAlive();
    try {
        const r = await peerEndTeardown(() => new net.Socket({ allowHalfOpen: true }));
        ok(r.events.includes('end'), "'end' never fired");
        ok(!r.events.includes('finish'), 'the writable side was ended despite allowHalfOpen');
        ok(!r.events.includes('close'), 'the socket closed despite allowHalfOpen');
        strictEqual(r.writable, true);
        strictEqual(r.destroyed, false);
    } finally {
        alive.done();
    }
});
