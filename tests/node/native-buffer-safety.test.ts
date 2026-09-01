/** Regression guards for detached-ArrayBuffer use-after-free in the C layer. */
import { ok, strictEqual, throws } from 'node:assert';

const socket = import.meta.use('socket');
const crypto = import.meta.use('crypto');

const { AF_INET, SOCK_DGRAM } = socket.defines;
const SENTINEL = [0x53, 0x45, 0x4e, 0x54]; // "SENT"

/** Bind a loopback UDP receiver and a sender connected to it. */
function udpPair(): { rx: CModuleSocket.PosixSocket; tx: CModuleSocket.PosixSocket } {
    for (let attempt = 0; attempt < 32; attempt++) {
        const port = 42000 + Math.floor(Math.random() * 8000);
        const rx = new socket.PosixSocket(AF_INET, SOCK_DGRAM, 0);
        try {
            rx.bind(socket.create_sockaddr_inet({ ip: '127.0.0.1', port }));
        } catch {
            rx.close();
            continue;
        }
        const tx = new socket.PosixSocket(AF_INET, SOCK_DGRAM, 0);
        tx.connect(socket.create_sockaddr_inet({ ip: '127.0.0.1', port }));
        return { rx, tx };
    }
    throw new Error('could not bind a loopback UDP port');
}

/** Read the first pending datagram, or null if none arrives within `ms`. */
function firstDatagram(rx: CModuleSocket.PosixSocket, ms: number): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => { try { rx.pollStop(); } catch {} resolve(null); }, ms);
        rx.poll(socket.uv_poll_event_bits.READABLE, () => {
            clearTimeout(timer);
            // pollStop/recv must not run inside the poll callback.
            setTimeout(() => {
                try { rx.pollStop(); } catch {}
                let data: Uint8Array | null = null;
                try { data = rx.recv(65535); } catch { data = null; }
                resolve(data);
            }, 0);
        });
    });
}

/** Compact description of a datagram, so a 4096-byte leak does not flood the log. */
function describe(data: Uint8Array): string {
    const head = Array.from(data.subarray(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return `${data.length} bytes [${head}${data.length > 8 ? ' …' : ''}]`;
}

Deno.test({
    name: 'native buffer safety: socket.send must not transmit a buffer detached by the flags valueOf',
    timeout: 15000,
}, async () => {
    const { rx, tx } = udpPair();
    try {
        const payload = new Uint8Array(4096);
        payload.fill(0x41);
        // JS_ToUint32 on the flags argument runs this valueOf. If it runs after
        // the payload pointer is captured, send() reads freed heap memory.
        const evilFlags = { valueOf() { payload.buffer.transfer(); return 0; } };

        let sendResult: unknown = '<no return>';
        let sendError: unknown = null;
        try {
            sendResult = tx.send(payload, evilFlags as unknown as number);
        } catch (error) {
            sendError = error;
        }

        // The detach itself must have happened — otherwise this test proves nothing.
        strictEqual(payload.buffer.detached, true, 'valueOf must have detached the payload buffer');
        strictEqual(payload.byteLength, 0);

        // Observable correctness first: nothing may reach the wire. A sentinel
        // sent afterwards must be the FIRST datagram the receiver sees; a
        // 4096-byte first datagram is freed heap memory on the network.
        tx.send(new Uint8Array(SENTINEL));
        const first = await firstDatagram(rx, 5000);
        ok(first, 'sentinel datagram must arrive');
        strictEqual(
            first.length,
            SENTINEL.length,
            `first datagram must be the ${SENTINEL.length}-byte sentinel, not leaked heap: got ${describe(first)}`,
        );
        strictEqual(Array.from(first).join(','), SENTINEL.join(','), `first datagram must be the sentinel, got ${describe(first)}`);

        // A send of a detached buffer must fail, never report bytes sent.
        ok(sendError instanceof TypeError, `send() of a detached buffer must throw TypeError, got ${String(sendError)} / returned ${String(sendResult)}`);
        strictEqual(sendResult, '<no return>', 'send() must not return a byte count for a detached buffer');

        // Ordering-independent backstop: the sentinel must be the ONLY datagram,
        // so a leak is caught even if it somehow arrived after the sentinel.
        // recv() is blocking and mod_socket.c exposes no MSG_DONTWAIT, so
        // emptiness is probed with a short poll rather than a read that hangs.
        const extra = await firstDatagram(rx, 300);
        strictEqual(extra, null, `no datagram may follow the sentinel, got ${extra ? describe(extra) : 'none'}`);
    } finally {
        try { rx.close(); } catch {}
        try { tx.close(); } catch {}
    }
});

Deno.test({
    name: 'native buffer safety: socket.send still works with an honest flags valueOf',
    timeout: 15000,
}, async () => {
    const { rx, tx } = udpPair();
    try {
        const payload = new Uint8Array(SENTINEL);
        const honestFlags = { valueOf() { return 0; } };
        const sent = tx.send(payload, honestFlags as unknown as number);
        strictEqual(sent, SENTINEL.length, 'hoisting the flags conversion must not break a normal send');
        const first = await firstDatagram(rx, 5000);
        ok(first, 'datagram must arrive');
        strictEqual(Array.from(first).join(','), SENTINEL.join(','));
    } finally {
        try { rx.close(); } catch {}
        try { tx.close(); } catch {}
    }
});

Deno.test({
    name: 'native buffer safety: socket.sendmsg must not transmit a buffer detached by the flags valueOf',
    ignore: Deno.build.os === 'windows', // sendmsg/recvmsg are POSIX-only in mod_socket.c
    timeout: 15000,
}, async () => {
    const { rx, tx } = udpPair();
    try {
        const payload = new Uint8Array(4096);
        payload.fill(0x41);
        const evilFlags = { valueOf() { payload.buffer.transfer(); return 0; } };

        let sendResult: unknown = '<no return>';
        let sendError: unknown = null;
        try {
            sendResult = tx.sendmsg(undefined, undefined, evilFlags as unknown as number, payload);
        } catch (error) {
            sendError = error;
        }

        strictEqual(payload.buffer.detached, true, 'valueOf must have detached the payload buffer');

        tx.sendmsg(undefined, undefined, 0, new Uint8Array(SENTINEL));
        const first = await firstDatagram(rx, 5000);
        ok(first, 'sentinel datagram must arrive');
        strictEqual(
            first.length,
            SENTINEL.length,
            `first datagram must be the ${SENTINEL.length}-byte sentinel, not leaked heap: got ${describe(first)}`,
        );
        strictEqual(Array.from(first).join(','), SENTINEL.join(','), `first datagram must be the sentinel, got ${describe(first)}`);

        ok(sendError instanceof TypeError, `sendmsg() of a detached buffer must throw TypeError, got ${String(sendError)} / returned ${String(sendResult)}`);
        strictEqual(sendResult, '<no return>', 'sendmsg() must not return a byte count for a detached buffer');
    } finally {
        try { rx.close(); } catch {}
        try { tx.close(); } catch {}
    }
});

const hex = (data: ArrayBuffer | Uint8Array): string =>
    Array.from(new Uint8Array(data as ArrayBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');

/** A DataView whose own `prop` property shadows the prototype accessor. */
function hostileDataView(source: Uint8Array, onGet: () => void, prop: 'buffer' | 'byteOffset' | 'byteLength') {
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    const real = prop === 'buffer' ? source.buffer : prop === 'byteOffset' ? source.byteOffset : source.byteLength;
    Object.defineProperty(view, prop, {
        configurable: true,
        get() { onGet(); return real; },
    });
    return view;
}

Deno.test({
    name: 'native buffer safety: JS_GetAnyBuffer reads DataView internal slots without invoking own accessors',
    timeout: 15000,
}, () => {
    for (const prop of ['buffer', 'byteOffset', 'byteLength'] as const) {
        const key = new Uint8Array(4096);
        key.fill(0x41);
        const data = new Uint8Array(64);
        data.fill(0x42);

        let getterRuns = 0;
        // The hostile view is the SECOND argument, so hmac already holds a raw
        // pointer into `key`'s backing store when this getter would run.
        const view = hostileDataView(data, () => { getterRuns++; key.buffer.transfer(); }, prop);

        const digest = hex(crypto.hmacSha256(key, view as unknown as Uint8Array));
        strictEqual(getterRuns, 0, `the own '${prop}' getter must never run inside JS_GetAnyBuffer`);
        strictEqual(key.buffer.detached, false, `the key buffer must not have been detached via '${prop}'`);
        strictEqual(digest, hex(crypto.hmacSha256(key, data)), 'DataView must use its internal buffer range');
    }
});

Deno.test({
    name: 'native buffer safety: JS_GetAnyBuffer still accepts a genuine DataView',
    timeout: 15000,
}, () => {
    const key = new Uint8Array(32);
    key.fill(0x41);
    const data = new Uint8Array(64);
    data.fill(0x42);

    const expected = hex(crypto.hmacSha256(key, data));
    // Plain DataView: buffer/byteOffset/byteLength come from the prototype.
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    strictEqual(Object.getOwnPropertyDescriptor(view, 'buffer'), undefined);
    strictEqual(hex(crypto.hmacSha256(key, view as unknown as Uint8Array)), expected);

    // A non-zero byteOffset sub-view must still be honoured, not silently
    // treated as the whole buffer.
    const offsetView = new DataView(data.buffer, 32, 32);
    const half = new Uint8Array(32);
    half.fill(0x42);
    strictEqual(hex(crypto.hmacSha256(key, offsetView as unknown as Uint8Array)), hex(crypto.hmacSha256(key, half)));

    // A DataView over a detached buffer must fail cleanly, not read freed memory.
    const doomed = new Uint8Array(32);
    const doomedView = new DataView(doomed.buffer);
    doomed.buffer.transfer();
    throws(() => crypto.hmacSha256(key, doomedView as unknown as Uint8Array), TypeError);
});
