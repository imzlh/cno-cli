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
        // Range validation precedes libuv's INVALID_SOCKET check, so an
        // out-of-range value is EINVAL while an in-range one is EBADF until the
        // socket is bound. Matches Node v24.18 on Windows.
        throws(() => socket.setTTL('1' as unknown as number), TypeError);
        throws(() => socket.setTTL(0), /EINVAL/);
        throws(() => socket.setTTL(256), /EINVAL/);
        throws(() => socket.setTTL(64), /EBADF/);
        throws(() => socket.setMulticastTTL(0), /EBADF/);
        throws(() => socket.setMulticastTTL(1), /EBADF/);
        throws(() => socket.setMulticastTTL(256), /EINVAL/);
    } finally {
        socket.close();
    }
});

Deno.test('dgram edge: buffer size accessors reject a never-bound socket', () => {
    const socket = dgram.createSocket('udp4');
    try {
        // libuv routes these through uv__udp_maybe_bind, but on Windows the
        // SOCKET is still INVALID there, so Node reports ERR_SOCKET_BUFFER_SIZE.
        throws(() => socket.getRecvBufferSize(), /ERR_SOCKET_BUFFER_SIZE|buffer size/);
        throws(() => socket.setRecvBufferSize(8192), /ERR_SOCKET_BUFFER_SIZE|buffer size/);
        throws(() => socket.getSendBufferSize(), /ERR_SOCKET_BUFFER_SIZE|buffer size/);
        throws(() => socket.setSendBufferSize(8192), /ERR_SOCKET_BUFFER_SIZE|buffer size/);
    } finally {
        socket.close();
    }
});

Deno.test('dgram edge: addMembership implicitly binds the socket', () => {
    const socket = dgram.createSocket('udp4');
    try {
        // uv__udp_set_membership4 calls uv__udp_maybe_bind, so the OS socket
        // exists afterwards and later options stop reporting EBADF.
        socket.addMembership('224.0.0.115');
        strictEqual(socket.setTTL(64), 64);
        strictEqual(typeof socket.address().port, 'number');
    } finally {
        socket.close();
    }
});
