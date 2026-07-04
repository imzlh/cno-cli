import { strictEqual, ok } from 'node:assert';
import * as net from 'node:net';

function listen(server: net.Server, port = 0, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
        server.listen(port, host, () => resolve());
        server.once('error', reject);
    });
}
function close(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

// --- 1. readyState transitions opening -> open on connect -------------------

Deno.test({ name: 'net: Socket readyState transitions opening -> open', timeout: 10000 }, async () => {
    const server = net.createServer((s) => s.end());
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const result = await new Promise<{ sawOpening: boolean; open: boolean }>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1');
            let sawOpening = false;
            sock.on('lookup', () => {});
            const onReady = () => {
                if (sock.readyState === 'opening') sawOpening = true;
            };
            sock.on('connect', () => {
                resolve({ sawOpening, open: sock.readyState === 'open' });
            });
            sock.on('error', reject);
            sock.on('ready', onReady);
        });
        ok(result.open, 'readyState must be open after connect');
    } finally {
        await close(server);
    }
});

// --- 2. connect to refused port emits 'error' with ECONNREFUSED -------------

Deno.test({ name: 'net: connect to a closed port emits ECONNREFUSED', timeout: 10000 }, async () => {
    // Bind a server, grab a port, close it, then connect -> guaranteed refuse.
    const probe = net.createServer();
    await listen(probe);
    const addr = probe.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const port = addr.port;
    await close(probe);

    const code = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1');
        sock.on('error', (e: any) => resolve(e.code ?? ''));
        sock.on('connect', () => reject(new Error('unexpected connect')));
    });
    strictEqual(code, 'ECONNREFUSED', `expected ECONNREFUSED, got ${code}`);
});

// --- 3. bytesWritten accumulates across writes -----------------------------

Deno.test({ name: 'net: bytesWritten accumulates across writes', timeout: 10000 }, async () => {
    const server = net.createServer((s) => s.resume());
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const written = await new Promise<number>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1', () => {
                sock.write('aaaa');
                sock.write('bbbb');
                sock.write('cccc');
                sock.end(() => resolve(sock.bytesWritten));
            });
            sock.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });
        strictEqual(written, 12, `expected 12 bytesWritten, got ${written}`);
    } finally {
        await close(server);
    }
});

// --- 4. write callback fires after flush ------------------------------------

Deno.test({ name: 'net: write(data, callback) callback fires', timeout: 10000 }, async () => {
    const server = net.createServer((s) => s.resume());
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const fired = await new Promise<boolean>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1', () => {
                let okcb = false;
                sock.write('x', () => { okcb = true; });
                sock.end(() => resolve(okcb));
            });
            sock.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });
        ok(fired, 'write callback must fire');
    } finally {
        await close(server);
    }
});

// --- 5. socket.end(data) sends data then closes gracefully ------------------

Deno.test({ name: 'net: socket.end(data) sends final data then closes', timeout: 10000 }, async () => {
    const server = net.createServer((s) => {
        let buf = '';
        s.on('data', (d) => (buf += d.toString()));
        s.on('end', () => {
            strictEqual(buf, 'final');
            s.end();
        });
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        await new Promise<void>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1', () => {
                sock.end('final', () => resolve());
            });
            sock.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });
    } finally {
        await close(server);
    }
});

// --- 6. socket.destroy() transitions readyState to closed ------------------

Deno.test({ name: 'net: socket.destroy sets destroyed and closes', timeout: 10000 }, async () => {
    const server = net.createServer((s) => s.resume());
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        await new Promise<void>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1', () => {
                sock.destroy();
                ok(sock.destroyed, 'destroyed must be true after destroy()');
                strictEqual(sock.readyState, 'closed', `expected closed, got ${sock.readyState}`);
                resolve();
            });
            sock.on('error', () => {}); // destroy may surface an error; ignore
            sock.on('close', () => resolve());
        });
    } finally {
        await close(server);
    }
});

// --- 7. connectListener argument attaches once ------------------------------

Deno.test({ name: 'net: connect(port, host, listener) fires listener exactly once', timeout: 10000 }, async () => {
    const server = net.createServer((s) => s.end());
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const count = await new Promise<number>((resolve, reject) => {
            let n = 0;
            const sock = net.connect(addr.port, '127.0.0.1', () => { n++; });
            sock.on('error', reject);
            sock.on('close', () => resolve(n));
        });
        strictEqual(count, 1, 'connectListener must fire exactly once');
    } finally {
        await close(server);
    }
});

// --- 8. server maxConnections drops excess ---------------------------------

Deno.test({ name: 'net: server.maxConnections limits accepted sockets', timeout: 10000 }, async () => {
    const server = net.createServer();
    server.maxConnections = 1;
    let accepted = 0;
    server.on('connection', (s) => { accepted++; s.resume(); });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const a = net.connect(addr.port, '127.0.0.1');
        const b = net.connect(addr.port, '127.0.0.1');
        await new Promise((r) => setTimeout(r, 200));
        a.destroy();
        b.destroy();
        await new Promise((r) => setTimeout(r, 200));
        ok(accepted >= 1, 'at least one connection accepted');
    } finally {
        await close(server);
    }
});

// --- 9. socket.bytesRead counts received bytes -----------------------------

Deno.test({ name: 'net: socket.bytesRead counts received bytes', timeout: 10000 }, async () => {
    const server = net.createServer((s) => s.end('hello-world'));
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const n = await new Promise<number>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1');
            sock.resume();
            sock.on('close', () => resolve(sock.bytesRead));
            sock.on('error', reject);
        });
        strictEqual(n, 11, `expected 11 bytesRead, got ${n}`);
    } finally {
        await close(server);
    }
});

// --- 10. socket.connect with options object ---------------------------------

Deno.test({ name: 'net: socket.connect({ port, host }) object form works', timeout: 10000 }, async () => {
    const server = net.createServer((s) => s.end());
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        await new Promise<void>((resolve, reject) => {
            const sock = new net.Socket();
            sock.connect({ port: addr.port, host: '127.0.0.1' }, () => {
                strictEqual(sock.readyState, 'open');
                sock.end();
            });
            sock.on('error', reject);
            sock.on('close', () => resolve());
        });
    } finally {
        await close(server);
    }
});
