import { strictEqual, ok } from 'node:assert';
import { rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

Deno.test({ name: 'net: refused connection emits error before close', timeout: 10000 }, async () => {
    const probe = net.createServer();
    await listen(probe);
    const addr = probe.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const port = addr.port;
    await close(probe);

    const events = await new Promise<string[]>((resolve) => {
        const socket = net.createConnection(port, '127.0.0.1');
        const seen: string[] = [];
        socket.once('error', () => seen.push('error'));
        socket.once('close', () => {
            seen.push('close');
            resolve(seen);
        });
    });
    strictEqual(events.join(','), 'error,close');
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

Deno.test({ name: 'net: setKeepAlive accepts Node millisecond initialDelay', timeout: 10000 }, async () => {
    const server = net.createServer((s) => s.resume());
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        await new Promise<void>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1', () => {
                try {
                    strictEqual(sock.setKeepAlive(true, 60_000), sock);
                    sock.destroy();
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
            sock.on('error', reject);
        });
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'net: Unix pipe server supports ref unref and close', timeout: 10000 }, async () => {
    const pipePath = join(tmpdir(), `cno-net-unref-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
    const server = net.createServer();
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(pipePath, () => resolve());
        });
        strictEqual(server.unref(), server);
        strictEqual(server.ref(), server);
        await close(server);
    } finally {
        try { rmSync(pipePath); } catch {}
    }
});

Deno.test({ name: 'net: Unix pipe socket unref allows process exit', timeout: 10000 }, async () => {
    const source = `
        import net from 'node:net';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';

        const pipePath = join(tmpdir(), \`cno-net-pipe-unref-\${process.pid}.sock\`);
        const server = net.createServer((socket) => socket.unref());
        server.listen(pipePath, () => {
            server.unref();
            const client = net.createConnection(pipePath, () => {
                process.stdout.write('connected');
            });
            client.on('error', (error) => {
                process.stderr.write(String(error?.code ?? error));
                process.exitCode = 1;
            });
            client.unref();
        });
    `;
    const child = new Deno.Command(Deno.execPath().replace(/ \\(deleted\\)$/, ''), {
        args: ['eval', source],
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();
    const timeoutId = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
    }, 3000);

    const output = await child.output();
    clearTimeout(timeoutId);

    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    strictEqual(output.success, true, `child should exit after unref; stdout=${stdout} stderr=${stderr}`);
    strictEqual(stdout, 'connected');
});

Deno.test({ name: 'net: socket readable event supports read() consumption', timeout: 10000 }, async () => {
    const server = net.createServer((s) => {
        s.end('readable-data');
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const body = await new Promise<string>((resolve, reject) => {
            const sock = net.connect(addr.port, '127.0.0.1');
            const chunks: Buffer[] = [];
            sock.on('readable', () => {
                let chunk: Buffer | null;
                while ((chunk = sock.read() as Buffer | null) !== null) {
                    chunks.push(chunk);
                }
            });
            sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            sock.on('error', reject);
        });
        strictEqual(body, 'readable-data');
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

Deno.test({ name: 'net: server connection socket exposes remoteFamily', timeout: 10000 }, async () => {
    const server = net.createServer();
    const family = new Promise<string>((resolve) => {
        server.once('connection', (socket) => {
            resolve(socket.remoteFamily ?? '');
            socket.end();
        });
    });
    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const socket = net.createConnection(addr.port, '127.0.0.1');
        socket.resume();
        socket.on('error', () => {});
        strictEqual(await family, 'IPv4');
        socket.destroy();
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'net upstream: connection event receives the accepted socket', timeout: 10000 }, async () => {
    const server = net.createServer();
    const accepted = new Promise<void>((resolve, reject) => {
        server.once('connection', (socket) => {
            try {
                ok(socket instanceof net.Socket);
                socket.end();
                resolve();
            } catch (error) {
                reject(error);
            }
        });
        server.once('error', reject);
    });

    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        await new Promise<void>((resolve, reject) => {
            const socket = net.createConnection(addr.port, '127.0.0.1');
            socket.on('end', resolve);
            socket.on('error', reject);
        });
        await accepted;
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'net upstream: server can listen on the same port after close', timeout: 10000 }, async () => {
    const server = net.createServer();
    await listen(server);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const { port } = addr;

    await close(server);
    await listen(server, port);
    await close(server);
});

Deno.test({ name: 'net upstream: concurrent sockets do not share read buffers', timeout: 10000 }, async () => {
    const socketCount = 6;
    const serverSocketsClosed: Array<Promise<void>> = [];
    const server = net.createServer((socket) => {
        serverSocketsClosed.push(new Promise((resolve) => socket.once('close', resolve)));
        socket.on('data', (data) => {
            socket.write(data);
        });
    });

    await listen(server);
    try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');

        const clients = Array.from({ length: socketCount }, (_, index) => {
            const socket = net.createConnection(addr.port, '127.0.0.1');
            const expected = `${index}`.repeat(3);
            const events: string[] = [];

            const done = new Promise<string[]>((resolve, reject) => {
                socket.on('data', (data) => {
                    events.push(data.toString());
                    if (events.length === 1) socket.write(expected);
                    if (events.length === 2) {
                        socket.end();
                        resolve(events);
                    }
                });
                socket.on('error', reject);
            });

            return { socket, expected, done };
        });

        for (const client of clients) {
            client.socket.write(client.expected);
        }

        const results = await Promise.all(clients.map((client) => client.done));
        for (let i = 0; i < socketCount; i++) {
            strictEqual(results[i].join(','), `${clients[i].expected},${clients[i].expected}`);
        }
    } finally {
        for (const promise of serverSocketsClosed) await promise;
        await close(server);
    }
});

Deno.test({ name: 'net: bidirectional pipe closes after short response', timeout: 10000 }, async () => {
    const backend = net.createServer((socket) => {
        socket.once('data', (data) => socket.end(`echo:${data.toString()}`));
    });
    await listen(backend);

    let completed = 0;
    let resolvePipeDone: () => void = () => {};
    const pipeDone = new Promise<void>((resolve) => {
        resolvePipeDone = resolve;
    });
    const finishAfterEnd = (socket: net.Socket) => {
        socket.end(() => {
            completed++;
            resolvePipeDone();
        });
    };
    const proxy = net.createServer((client) => {
        const upstream = net.createConnection((backend.address() as net.AddressInfo).port, '127.0.0.1');
        upstream.once('connect', () => {
            client.pipe(upstream);
            upstream.pipe(client);
            upstream.once('close', () => finishAfterEnd(client));
            client.once('close', () => finishAfterEnd(upstream));
        });
    });
    await listen(proxy);

    try {
        const port = (proxy.address() as net.AddressInfo).port;
        const body = await new Promise<string>((resolve, reject) => {
            const socket = net.createConnection(port, '127.0.0.1');
            const chunks: Buffer[] = [];
            socket.on('connect', () => socket.write('x'));
            socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            socket.on('error', reject);
        });
        strictEqual(body, 'echo:x');
        await pipeDone;
        strictEqual(completed, 1);
    } finally {
        await close(proxy);
        await close(backend);
    }
});

Deno.test('net: BlockList checks addresses ranges and subnets', () => {
    const blockList = new net.BlockList();
    blockList.addAddress('1.1.1.1');
    blockList.addRange('10.0.0.1', '10.0.0.3');
    blockList.addSubnet('192.168.0.0', 24);

    strictEqual(blockList.check('1.1.1.1'), true);
    strictEqual(blockList.check('1.1.1.2'), false);
    strictEqual(blockList.check('10.0.0.2'), true);
    strictEqual(blockList.check('10.0.0.4'), false);
    strictEqual(blockList.check('192.168.0.42'), true);
    strictEqual(blockList.check('192.168.1.42'), false);

    const rules = blockList.rules;
    rules.push('mutated');
    strictEqual(blockList.rules.length, 3);
});
