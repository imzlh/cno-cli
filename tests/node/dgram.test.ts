import { ok, strictEqual, throws } from 'node:assert';
import * as dgram from 'node:dgram';

let udp4Probe: Promise<boolean> | undefined;

async function closeSocket(socket: dgram.Socket): Promise<void> {
    try { socket.close(); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
}

function hasUdp4(): Promise<boolean> {
    if (udp4Probe) return udp4Probe;
    udp4Probe = new Promise((resolve) => {
        let done = false;
        const finish = (value: boolean) => {
            if (done) return;
            done = true;
            resolve(value);
        };
        const s = dgram.createSocket('udp4');
        s.once('error', () => {
            closeSocket(s).then(() => finish(false));
        });
        s.bind(0, '127.0.0.1', () => {
            closeSocket(s).then(() => finish(true));
        });
        setTimeout(() => {
            closeSocket(s).then(() => finish(false));
        }, 1000);
    });
    return udp4Probe;
}

Deno.test('dgram: createSocket returns a Socket', () => {
    const s = dgram.createSocket('udp4');
    ok(s);
    s.close();
});

Deno.test('dgram: bind assigns a port', async () => {
    if (!await hasUdp4()) return;
    const s = dgram.createSocket('udp4');
    try {
        const port = await new Promise<number>((resolve, reject) => {
            s.on('error', reject);
            s.bind(0, '127.0.0.1', () => resolve(s.address().port));
        });
        ok(port > 0, `expected positive port, got ${port}`);
    } finally {
        await closeSocket(s);
    }
});

Deno.test('dgram: address() returns family and port', async () => {
    if (!await hasUdp4()) return;
    const s = dgram.createSocket('udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            s.on('error', reject);
            s.bind(0, '127.0.0.1', resolve);
        });
        const a = s.address();
        strictEqual(a.family, 'IPv4');
        ok(typeof a.port === 'number' && a.port > 0);
    } finally {
        await closeSocket(s);
    }
});

Deno.test('dgram: send/receive round-trip', async () => {
    if (!await hasUdp4()) return;
    const sender = dgram.createSocket('udp4');
    const receiver = dgram.createSocket('udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            receiver.on('error', reject);
            receiver.bind(0, '127.0.0.1', resolve);
        });
        const recvPort = receiver.address().port;

        const msg = await new Promise<string>((resolve, reject) => {
            receiver.on('message', (buf) => resolve(buf.toString()));
            receiver.on('error', reject);
            sender.send('hello-dgram', recvPort, '127.0.0.1', (err) => {
                if (err) reject(err);
            });
            setTimeout(() => reject(new Error('timeout')), 3000);
        });
        strictEqual(msg, 'hello-dgram');
    } finally {
        await Promise.all([closeSocket(sender), closeSocket(receiver)]);
    }
});

Deno.test('dgram: setBroadcast returns undefined once socket is bound', async () => {
    if (!await hasUdp4()) return;
    const s = dgram.createSocket('udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            s.on('error', reject);
            s.bind(0, '127.0.0.1', resolve);
        });
        strictEqual(s.setBroadcast(true), undefined);
    } finally {
        await closeSocket(s);
    }
});

Deno.test('dgram: setTTL returns the configured ttl once socket is bound', async () => {
    if (!await hasUdp4()) return;
    const s = dgram.createSocket('udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            s.on('error', reject);
            s.bind(0, '127.0.0.1', resolve);
        });
        strictEqual(s.setTTL(64), 64);
    } finally {
        await closeSocket(s);
    }
});

Deno.test('dgram: ref/unref return the socket itself', () => {
    const s = dgram.createSocket('udp4');
    strictEqual(s.ref(), s);
    strictEqual(s.unref(), s);
    s.close();
});

Deno.test('dgram: createSocket accepts options object', () => {
    const s = dgram.createSocket({ type: 'udp4' });
    ok(s);
    s.close();
});

Deno.test('dgram upstream: reuseAddr allows multiple sockets to bind the same UDP port', async () => {
    if (!await hasUdp4()) return;
    const socket0 = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let socket1: dgram.Socket | undefined;
    const sender = dgram.createSocket('udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            socket0.once('error', reject);
            socket0.bind(0, '0.0.0.0', resolve);
        });
        const port = socket0.address().port;

        socket1 = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        await new Promise<void>((resolve, reject) => {
            socket1!.once('error', reject);
            socket1!.bind(port, '0.0.0.0', resolve);
        });

        const received = new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
            const onMessage = (msg: Buffer) => {
                clearTimeout(timeout);
                resolve(msg.toString());
            };
            socket0.once('message', onMessage);
            socket1!.once('message', onMessage);
        });
        sender.send('reuse-ok', port, '127.0.0.1');
        strictEqual(await received, 'reuse-ok');
    } finally {
        await Promise.all([
            closeSocket(socket0),
            socket1 ? closeSocket(socket1) : Promise.resolve(),
            closeSocket(sender),
        ]);
    }
});

Deno.test('dgram: remoteAddress throws before connect', () => {
    const s = dgram.createSocket('udp4');
    try {
        throws(() => s.remoteAddress(), /Not connected/);
    } finally {
        s.close();
    }
});

Deno.test('dgram: close fires close event', async () => {
    const s = dgram.createSocket('udp4');
    let closed = false;
    s.on('close', () => { closed = true; });
    s.close();
    await new Promise((r) => setTimeout(r, 20));
    ok(closed, 'close must emit');
});

Deno.test('dgram: send(Buffer, offset, length, ...) sends slice and reports byte count', async () => {
    if (!await hasUdp4()) return;
    const sender = dgram.createSocket('udp4');
    const receiver = dgram.createSocket('udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            receiver.on('error', reject);
            receiver.bind(0, '127.0.0.1', resolve);
        });
        const port = receiver.address().port;
        const messagePromise = new Promise<{ msg: string; family: string; address: string }>((resolve, reject) => {
            receiver.once('message', (buf, rinfo) => {
                resolve({ msg: buf.toString(), family: rinfo.family, address: rinfo.address });
            });
            receiver.once('error', reject);
        });
        const bytesPromise = new Promise<number>((resolve, reject) => {
            sender.send(Buffer.from('hello'), 1, 3, port, '127.0.0.1', (err, bytes) => {
                if (err) reject(err);
                else resolve(bytes);
            });
        });
        const [message, bytes] = await Promise.all([messagePromise, bytesPromise]);
        strictEqual(message.msg, 'ell');
        strictEqual(bytes, 3);
        strictEqual(message.family, 'IPv4');
        strictEqual(message.address, '127.0.0.1');
    } finally {
        await Promise.all([closeSocket(sender), closeSocket(receiver)]);
    }
});

Deno.test('dgram: connected socket send omits port and address', async () => {
    if (!await hasUdp4()) return;
    const sender = dgram.createSocket('udp4');
    const receiver = dgram.createSocket('udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            receiver.on('error', reject);
            receiver.bind(0, '127.0.0.1', resolve);
        });
        const port = receiver.address().port;
        const messagePromise = new Promise<string>((resolve, reject) => {
            receiver.once('message', (buf) => resolve(buf.toString()));
            receiver.once('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });

        await new Promise<void>((resolve, reject) => {
            sender.once('error', reject);
            strictEqual(sender.connect(port, '127.0.0.1', resolve), undefined);
        });

        strictEqual(sender.remoteAddress().port, port);
        const bytes = await new Promise<number>((resolve, reject) => {
            strictEqual(sender.send('connected-dgram', (err, sent) => {
                if (err) reject(err);
                else resolve(sent ?? -1);
            }), undefined);
        });
        strictEqual(bytes, 'connected-dgram'.length);
        strictEqual(await messagePromise, 'connected-dgram');
        strictEqual(sender.disconnect(), undefined);
        throws(() => sender.remoteAddress(), /Not connected/);
    } finally {
        await Promise.all([closeSocket(sender), closeSocket(receiver)]);
    }
});

Deno.test('dgram: validates socket type and unbound address state', () => {
    throws(() => dgram.createSocket('bad' as 'udp4'), /Bad socket type/);
    throws(() => dgram.createSocket({ type: 'bad' as 'udp4' }), /Bad socket type/);
    throws(() => dgram.createSocket(null as unknown as 'udp4'), /Bad socket type/);

    const s = dgram.createSocket('udp4');
    try {
        throws(() => s.address(), /EBADF/);
    } finally {
        s.close();
    }
});

Deno.test('dgram: validates ttl arguments before socket options', () => {
    const s = dgram.createSocket('udp4');
    try {
        throws(() => s.setTTL('1' as unknown as number), TypeError);
        throws(() => s.setTTL(0), /EINVAL/);
        throws(() => s.setTTL(256), /EINVAL/);
        strictEqual(s.setTTL(64), 64);
        throws(() => s.setMulticastTTL(0), /EINVAL/);
        strictEqual(s.setMulticastTTL(1), 1);
    } finally {
        s.close();
    }
});
