/**
 * net.Server / net.Socket lifetime + half-open regressions.
 * Every expectation below was measured against real Node v24.18 first.
 */
import { strictEqual, ok } from 'node:assert';
import * as net from 'node:net';

function listen(server: net.Server, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port));
    });
}

function closeServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

Deno.test({
    name: "net: server.listen(p) then server.on('listening') still fires",
    timeout: 10000,
}, async () => {
    // `listen()` used to emit 'listening' INLINE, so this idiom — attaching the
    // handler on the line after listen() — never fired at all.
    const server = net.createServer();
    let fired = false;
    server.listen(0, '127.0.0.1');
    server.on('listening', () => { fired = true; });
    await delay(150);
    strictEqual(fired, true);
    strictEqual(server.listening, true);
    await closeServer(server);
});

Deno.test({
    name: 'net: listen callback does not run before listen() returns',
    timeout: 10000,
}, async () => {
    const server = net.createServer();
    const order: string[] = [];
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => { order.push('listen-cb'); resolve(); });
        order.push('after-listen-returns');
    });
    strictEqual(order.join(','), 'after-listen-returns,listen-cb');
    await closeServer(server);
});

Deno.test({
    name: 'net: repeated listen/close rounds driven by await all complete',
    timeout: 15000,
}, async () => {
    // A close-cb resolving a promise whose continuation opened the next server
    // used to lose the second round entirely and abort the process.
    const closed: number[] = [];
    for (let i = 0; i < 3; i++) {
        const server = net.createServer();
        await listen(server);
        await closeServer(server);
        closed.push(i);
    }
    strictEqual(closed.join(','), '0,1,2');
});

Deno.test({
    name: 'net: allowHalfOpen=false flushes a write made from the end handler',
    timeout: 10000,
}, async () => {
    // THE DATA-LOSS CASE. Node treats allowHalfOpen:false as "auto-end after the
    // 'end' handler has run", so a farewell written from 'end' is delivered.
    // cno used to call end() inline, flipping `writable` false first, and the
    // peer silently received "" instead of the payload.
    let writableAtEnd = false;
    let writeAccepted = false;
    const server = net.createServer({ allowHalfOpen: false }, (socket) => {
        socket.resume();
        socket.on('error', () => { /* ignore */ });
        socket.on('end', () => {
            writableAtEnd = socket.writable;
            writeAccepted = socket.write('AFTER-END');
            socket.end();
        });
    });
    const port = await listen(server);

    const received = await new Promise<string>((resolve, reject) => {
        const client = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
        let seen = '';
        client.on('data', (chunk) => { seen += chunk.toString(); });
        client.on('end', () => resolve(seen));
        client.on('error', reject);
        client.on('connect', () => client.end('HELLO'));
    });

    strictEqual(writableAtEnd, true);
    strictEqual(writeAccepted, true);
    strictEqual(received, 'AFTER-END');
    await closeServer(server);
});

Deno.test({
    name: 'net: a peer reset emits exactly one string-coded error then close',
    timeout: 10000,
}, async () => {
    // A fatal read error used to be emitted bare and left the socket open, so it
    // re-fired dozens of times — later ones raw native objects whose `.code` was
    // the NUMBER -4047 — and 'close' never arrived at all.
    const server = net.createServer((socket) => {
        socket.on('error', () => { /* ignore */ });
        setTimeout(() => socket.destroy(), 60);
    });
    const port = await listen(server);

    const result = await new Promise<{ codes: unknown[]; hadError: boolean }>((resolve) => {
        const client = net.connect(port, '127.0.0.1');
        const codes: unknown[] = [];
        client.on('error', (err: NodeJS.ErrnoException) => codes.push(err.code));
        client.on('close', (hadError: boolean) => resolve({ codes, hadError }));
        client.on('connect', () => {
            const chunk = Buffer.alloc(64 * 1024, 0x61);
            const pump = (): void => {
                if (client.destroyed) return;
                client.write(chunk);
                setTimeout(pump, 10);
            };
            pump();
        });
    });

    strictEqual(result.codes.length, 1);
    strictEqual(typeof result.codes[0], 'string');
    strictEqual(result.hadError, true);
    await closeServer(server);
});

Deno.test({
    name: "net: destroy(err) then attaching 'error' synchronously still catches it",
    timeout: 10000,
}, async () => {
    // Node defers the emit to nextTick precisely so this works; emitting inline
    // made the listener miss it.
    const server = net.createServer((socket) => socket.on('error', () => { /* ignore */ }));
    const port = await listen(server);

    const caught = await new Promise<boolean>((resolve) => {
        const client = net.connect(port, '127.0.0.1');
        client.on('connect', () => {
            let seen = false;
            client.destroy(Object.assign(new Error('boom'), { code: 'EBOOM' }));
            client.on('error', () => { seen = true; });
            setTimeout(() => resolve(seen), 120);
        });
    });

    strictEqual(caught, true);
    await closeServer(server);
});

Deno.test({
    name: 'net: write() returns false at the high-water mark and drain follows',
    timeout: 15000,
}, async () => {
    const server = net.createServer((socket) => {
        socket.pause();
        setTimeout(() => socket.resume(), 200);
    });
    const port = await listen(server);

    const result = await new Promise<{ sawFalse: boolean; drained: boolean }>((resolve) => {
        const client = net.connect(port, '127.0.0.1');
        client.on('connect', () => {
            const chunk = Buffer.alloc(65536, 0x41);
            let sawFalse = false;
            for (let i = 0; i < 64 && !sawFalse; i++) {
                if (!client.write(chunk)) sawFalse = true;
            }
            let drained = false;
            client.once('drain', () => { drained = true; });
            setTimeout(() => {
                client.destroy();
                resolve({ sawFalse, drained });
            }, 1200);
        });
    });

    ok(result.sawFalse, 'write() must return false at the high-water mark');
    ok(result.drained, "'drain' must follow a false write()");
    await closeServer(server);
});

Deno.test({
    name: 'net: listen() rejects out-of-range ports instead of silently misbinding',
    timeout: 10000,
}, async () => {
    // cno performed NO port validation, so the value reached bind() and was
    // silently coerced: listen(-1) bound 65535, listen(1.5) bound 1, and
    // listen(65536)/listen(NaN) bound an arbitrary ephemeral port. A server
    // that asked for one port and quietly listens on another is a security bug.
    for (const bad of [-1, 65536, 1.5, NaN, Infinity]) {
        const server = net.createServer();
        let code: string | undefined;
        try {
            server.listen(bad, '127.0.0.1');
        } catch (err) {
            code = (err as NodeJS.ErrnoException).code;
        }
        strictEqual(code, 'ERR_SOCKET_BAD_PORT', `listen(${String(bad)}) must throw`);
        try { server.close(); } catch { /* never listened */ }
    }
});

Deno.test({
    name: 'net: listen() accepts a numeric string port (process.env.PORT form)',
    timeout: 10000,
}, async () => {
    // Every string used to be treated as a pipe path, so listen('8080') bound a
    // pipe literally named "8080" and failed EACCES — breaking the extremely
    // common `server.listen(process.env.PORT)`, since env vars are strings.
    const probe = net.createServer();
    const free = await listen(probe);
    await closeServer(probe);

    const server = net.createServer();
    const bound = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(String(free), '127.0.0.1', () => {
            resolve((server.address() as net.AddressInfo).port);
        });
    });
    strictEqual(bound, free);
    await closeServer(server);
});

Deno.test({
    name: 'net: listen(undefined) binds an ephemeral port rather than hanging',
    timeout: 10000,
}, async () => {
    // listen(undefined) / listen(null) used to do nothing at all: no
    // 'listening', no 'error', a silent hang. Node binds an ephemeral port.
    const server = net.createServer();
    const bound = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        const timer = setTimeout(() => reject(new Error('listen(undefined) never settled')), 3000);
        server.listen(undefined, '127.0.0.1', () => {
            clearTimeout(timer);
            resolve((server.address() as net.AddressInfo).port);
        });
    });
    ok(bound > 0, 'must bind a real ephemeral port');
    await closeServer(server);
});

Deno.test({
    name: 'net: an explicit numeric-looking path stays a pipe, not a TCP port',
    timeout: 10000,
}, async () => {
    // Guards the numeric-string coercion added for listen('8080'): it must not
    // reach an explicit `path`, or listen({path:'8080'}) would silently bind TCP
    // port 8080 instead of a pipe named "8080".
    const server = net.createServer();
    const outcome = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('nothing'), 2500);
        server.once('error', () => { clearTimeout(timer); resolve('error'); });
        server.listen({ path: '8080' }, () => {
            clearTimeout(timer);
            const addr = server.address();
            resolve(typeof addr === 'string' ? 'pipe:' + addr : 'TCP:' + JSON.stringify(addr));
        });
    });
    // Either the bogus pipe name is rejected by the OS, or it binds as a pipe —
    // but it must never come back as a TCP AddressInfo.
    ok(!outcome.startsWith('TCP:'), `path must not become a TCP port (got ${outcome})`);
    try { server.close(); } catch { /* may never have listened */ }
});
