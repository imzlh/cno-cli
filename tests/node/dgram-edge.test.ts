import { strictEqual, throws } from 'node:assert';
import * as dgram from 'node:dgram';

Deno.test('dgram edge: createSocket validates socket type before native UDP init', () => {
    throws(() => dgram.createSocket('bad' as 'udp4'), /Bad socket type/);
    throws(() => dgram.createSocket({ type: 'bad' as 'udp4' }), /Bad socket type/);
    throws(() => dgram.createSocket(null as unknown as 'udp4'), /Bad socket type/);
});

Deno.test('dgram edge: address and remoteAddress report unbound state', () => {
    const socket = dgram.createSocket('udp4');
    try {
        throws(() => socket.address(), /EBADF/);
        throws(() => socket.remoteAddress(), /Not connected/);
    } finally {
        socket.close();
    }
});

Deno.test('dgram edge: ttl arguments are validated before socket options', () => {
    const socket = dgram.createSocket('udp4');
    try {
        throws(() => socket.setTTL('1' as unknown as number), TypeError);
        throws(() => socket.setTTL(0), /EINVAL/);
        throws(() => socket.setTTL(256), /EINVAL/);
        strictEqual(socket.setTTL(64), 64);
        throws(() => socket.setMulticastTTL(0), /EINVAL/);
        strictEqual(socket.setMulticastTTL(1), 1);
    } finally {
        socket.close();
    }
});
