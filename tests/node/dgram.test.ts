import { strictEqual, ok } from 'node:assert';
import * as dgram from 'node:dgram';

// --- 1. createSocket returns a Socket --------------------------------------

Deno.test('dgram: createSocket returns a Socket', () => {
    const s = dgram.createSocket('udp4');
    ok(s);
    s.close();
});

// --- 2. Socket.bind assigns a port -----------------------------------------

Deno.test('dgram: bind assigns a port', async () => {
    const s = dgram.createSocket('udp4');
    const port = await new Promise<number>((resolve, reject) => {
        s.bind(0, '127.0.0.1', () => {
            const a = s.address();
            resolve(a?.port ?? -1);
        });
        s.on('error', reject);
    });
    ok(port > 0, `expected positive port, got ${port}`);
    s.close();
});

// --- 3. Socket.address() returns family/port -------------------------------

Deno.test('dgram: address() returns family and port', async () => {
    const s = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => s.bind(0, '127.0.0.1', resolve));
    const a = s.address();
    ok(a);
    strictEqual(a!.family, 'IPv4');
    ok(typeof a!.port === 'number' && a!.port > 0);
    s.close();
});

// --- 4. send + receive round-trip on loopback ------------------------------

Deno.test('dgram: send/receive round-trip', async () => {
    const sender = dgram.createSocket('udp4');
    const receiver = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => receiver.bind(0, '127.0.0.1', resolve));
    const recvPort = receiver.address().port;

    const msg = await new Promise<string>((resolve, reject) => {
        receiver.on('message', (buf, rinfo) => {
            resolve(buf.toString());
        });
        receiver.on('error', reject);
        sender.send('hello-dgram', recvPort, '127.0.0.1', (err) => {
            if (err) reject(err);
        });
        setTimeout(() => reject(new Error('timeout')), 3000);
    });
    strictEqual(msg, 'hello-dgram');
    sender.close();
    receiver.close();
});

// --- 5. Socket.setBroadcast -----------------------------------------------

Deno.test('dgram: setBroadcast is callable', () => {
    const s = dgram.createSocket('udp4');
    s.setBroadcast(true);
    s.close();
});

// --- 6. Socket.setTTL ------------------------------------------------------

Deno.test('dgram: setTTL is callable', () => {
    const s = dgram.createSocket('udp4');
    s.setTTL(64);
    s.close();
});

// --- 7. Socket ref/unref ---------------------------------------------------

Deno.test('dgram: ref/unref are callable', () => {
    const s = dgram.createSocket('udp4');
    s.ref();
    s.unref();
    s.close();
});

// --- 8. createSocket with options ------------------------------------------

Deno.test('dgram: createSocket accepts options object', () => {
    const s = dgram.createSocket({ type: 'udp4' });
    ok(s);
    s.close();
});

// --- 9. Socket remoteAddress returns null before recv ---------------------

Deno.test('dgram: remoteAddress returns null initially', () => {
    const s = dgram.createSocket('udp4');
    strictEqual(s.remoteAddress(), null);
    s.close();
});

// --- 10. close fires 'close' event ----------------------------------------

Deno.test('dgram: close fires close event', async () => {
    const s = dgram.createSocket('udp4');
    let closed = false;
    s.on('close', () => { closed = true; });
    s.close();
    await new Promise((r) => setTimeout(r, 20));
    ok(closed, 'close must emit');
});
