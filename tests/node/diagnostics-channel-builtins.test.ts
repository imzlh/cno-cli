/**
 * Built-in diagnostics channel coverage.
 *
 * The `node:diagnostics_channel` machinery (subscribe / publish / bindStore /
 * tracingChannel) is covered by diagnostics-channel.test.ts. This file covers
 * the separate question of whether *core modules actually publish* to the
 * built-in channels an APM agent attaches to.
 *
 * Every expected payload key set below was measured on real Node v24.18.0 by
 * subscribing and performing the same loopback operation, and cross-checked
 * against the publish sites in Node's own `_http_client.js`, `_http_server.js`
 * and `net.js`. Asserting only "the event fired" would pass against a publish
 * of `undefined`, so each test asserts the key set too.
 */
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import * as dc from 'node:diagnostics_channel';
import http from 'node:http';
import * as https from 'node:https';
import net from 'node:net';

const ssl = import.meta.use('ssl');

type Captured = { name: string; keys: string[]; message: unknown };

/**
 * Subscribes to `names`, runs `fn`, then always unsubscribes.
 *
 * Unsubscribing matters beyond hygiene: these are process-wide singleton
 * channels, so a leaked subscriber would keep the instrumentation installed and
 * let a later test observe another test's traffic.
 */
async function capture(names: string[], fn: () => Promise<void>): Promise<Captured[]> {
    const seen: Captured[] = [];
    const handlers = names.map((name) => {
        const handler = (message: unknown, channelName: string | symbol): void => {
            seen.push({
                name: String(channelName),
                keys: message && typeof message === 'object' ? Object.keys(message).sort() : [],
                message,
            });
        };
        dc.subscribe(name, handler);
        return { name, handler };
    });
    try {
        await fn();
    } finally {
        for (const { name, handler } of handlers) dc.unsubscribe(name, handler);
    }
    return seen;
}

function only(seen: Captured[], name: string): Captured[] {
    return seen.filter((entry) => entry.name === name);
}

function firstOf(seen: Captured[], name: string): Captured {
    const found = only(seen, name)[0];
    ok(found, `channel ${name} never published`);
    return found;
}

/** Listens on loopback, runs `fn(port)`, always closes. */
async function withHttpServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    fn: (port: number) => Promise<void>,
): Promise<void> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
        await fn(port);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

function get(port: number, path = '/'): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
    });
}

// --- 1. http.client.request.start / .created ------------------------------

Deno.test('dc builtins: http.client request.created + request.start fire with {request}', async () => {
    await withHttpServer((_req, res) => res.end('ok'), async (port) => {
        const seen = await capture(
            ['http.client.request.created', 'http.client.request.start'],
            async () => {
                const { status, body } = await get(port);
                strictEqual(status, 200);
                strictEqual(body, 'ok');
            },
        );

        // Node payload for both: { request } — measured on v24.18.0.
        const created = firstOf(seen, 'http.client.request.created');
        deepStrictEqual(created.keys, ['request']);
        const start = firstOf(seen, 'http.client.request.start');
        deepStrictEqual(start.keys, ['request']);

        // The request must be the real ClientRequest, not a stand-in.
        const request = (created.message as { request: http.ClientRequest }).request;
        strictEqual(typeof request.getHeader, 'function');
        strictEqual(request.method, 'GET');
        strictEqual(request.path, '/');
        strictEqual(
            (start.message as { request: unknown }).request,
            request,
            'created and start must carry the same ClientRequest',
        );

        // Exactly once each per request, as Node does (created from the
        // constructor, start from _finish()).
        strictEqual(only(seen, 'http.client.request.created').length, 1);
        strictEqual(only(seen, 'http.client.request.start').length, 1);
    });
});

// --- 2. http.client.response.finish ---------------------------------------

Deno.test('dc builtins: http.client.response.finish fires with {request,response}', async () => {
    await withHttpServer((_req, res) => {
        res.statusCode = 201;
        res.setHeader('x-probe', 'yes');
        res.end('payload');
    }, async (port) => {
        const seen = await capture(['http.client.response.finish'], async () => {
            const { status } = await get(port);
            strictEqual(status, 201);
        });

        const finish = firstOf(seen, 'http.client.response.finish');
        deepStrictEqual(finish.keys, ['request', 'response']);

        const { request, response } = finish.message as {
            request: http.ClientRequest;
            response: http.IncomingMessage;
        };
        strictEqual(request.method, 'GET');
        strictEqual(response.statusCode, 201);
        strictEqual(response.headers['x-probe'], 'yes');
        strictEqual(only(seen, 'http.client.response.finish').length, 1);
    });
});

// --- 3. http.client.request.error -----------------------------------------

Deno.test('dc builtins: http.client.request.error fires with {request,error}', async () => {
    // Port 1 on loopback refuses; no server involved.
    const seen = await capture(['http.client.request.error'], async () => {
        await new Promise<void>((resolve) => {
            const req = http.get({ host: '127.0.0.1', port: 1, path: '/' });
            req.on('error', () => resolve());
        });
        // Let any duplicate emit land before we assert on the payload.
        await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const failed = firstOf(seen, 'http.client.request.error');
    deepStrictEqual(failed.keys, ['error', 'request']);

    const { request, error } = failed.message as { request: http.ClientRequest; error: Error };
    strictEqual(request.method, 'GET');
    ok(error instanceof Error, 'error must be an Error instance');
    strictEqual((error as Error & { code?: string }).code, 'ECONNREFUSED');
});

// --- 4. the error channel must publish before the 'error' event -----------

Deno.test('dc builtins: request.error publishes before the request emits error', async () => {
    const order: string[] = [];
    const handler = (): void => { order.push('channel'); };
    dc.subscribe('http.client.request.error', handler);
    try {
        await new Promise<void>((resolve) => {
            const req = http.get({ host: '127.0.0.1', port: 1, path: '/' });
            req.on('error', () => {
                order.push('event');
                resolve();
            });
        });
    } finally {
        dc.unsubscribe('http.client.request.error', handler);
    }
    // Node's emitErrorEvent() publishes, then calls request.emit('error').
    strictEqual(order[0], 'channel', 'channel must publish before the error event');
    strictEqual(order[1], 'event');
});

// --- 5. adding a subscriber must not swallow an unhandled 'error' ---------

Deno.test('dc builtins: subscribing to request.error adds no error listener', async () => {
    // Regression guard: instrumenting by *adding an error listener* would make
    // an otherwise-unhandled 'error' silently disappear, because EventEmitter
    // only throws when the listener count is zero. So the listener count must be
    // identical whether or not the channel has a subscriber — the absolute count
    // is an implementation detail, the delta is the contract.
    const baselineReq = http.get({ host: '127.0.0.1', port: 1, path: '/' });
    const baseline = baselineReq.listenerCount('error');
    baselineReq.on('error', () => {});

    const handler = (): void => {};
    dc.subscribe('http.client.request.error', handler);
    let instrumented: number;
    try {
        const req = http.get({ host: '127.0.0.1', port: 1, path: '/' });
        instrumented = req.listenerCount('error');
        req.on('error', () => {});
    } finally {
        dc.unsubscribe('http.client.request.error', handler);
    }

    strictEqual(
        instrumented,
        baseline,
        'subscribing must not change the request error-listener count',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
});

// --- 6. http.server.request.start / response.finish ----------------------

Deno.test('dc builtins: http.server request.start + response.finish carry 4 keys', async () => {
    let seen: Captured[] = [];
    await withHttpServer((_req, res) => res.end('served'), async (port) => {
        seen = await capture(
            ['http.server.request.start', 'http.server.response.finish'],
            async () => {
                const { body } = await get(port, '/srv');
                strictEqual(body, 'served');
                await new Promise((resolve) => setTimeout(resolve, 50));
            },
        );
    });

    // Node payload for both: { request, response, server, socket }.
    const start = firstOf(seen, 'http.server.request.start');
    deepStrictEqual(start.keys, ['request', 'response', 'server', 'socket']);
    const finish = firstOf(seen, 'http.server.response.finish');
    deepStrictEqual(finish.keys, ['request', 'response', 'server', 'socket']);

    const startMsg = start.message as {
        request: http.IncomingMessage;
        response: http.ServerResponse;
        server: http.Server;
        socket: unknown;
    };
    strictEqual(startMsg.request.url, '/srv');
    strictEqual(startMsg.request.method, 'GET');
    strictEqual(typeof startMsg.response.setHeader, 'function');
    strictEqual(typeof startMsg.server.listen, 'function');

    const finishMsg = finish.message as { request: http.IncomingMessage; response: http.ServerResponse };
    strictEqual(finishMsg.request, startMsg.request, 'same IncomingMessage in both payloads');
    strictEqual(finishMsg.response, startMsg.response, 'same ServerResponse in both payloads');
    // response.finish must land after the response was actually completed.
    strictEqual(finishMsg.response.writableEnded, true);
});

// --- 7. server request.start must precede the request listener -----------

Deno.test('dc builtins: http.server.request.start publishes before the handler runs', async () => {
    const order: string[] = [];
    const handler = (): void => { order.push('channel'); };
    dc.subscribe('http.server.request.start', handler);
    try {
        await withHttpServer((_req, res) => {
            order.push('handler');
            res.end('x');
        }, async (port) => {
            await get(port);
        });
    } finally {
        dc.unsubscribe('http.server.request.start', handler);
    }
    strictEqual(order[0], 'channel', 'request.start must publish before the request listener');
    strictEqual(order[1], 'handler');
});

// --- 8. http.server.response.created ------------------------------------

Deno.test('dc builtins: http.server.response.created fires with {request,response}', async () => {
    let seen: Captured[] = [];
    await withHttpServer((_req, res) => res.end('c'), async (port) => {
        seen = await capture(['http.server.response.created'], async () => {
            await get(port, '/created');
        });
    });
    const created = firstOf(seen, 'http.server.response.created');
    deepStrictEqual(created.keys, ['request', 'response']);
    const msg = created.message as { request: http.IncomingMessage; response: http.ServerResponse };
    strictEqual(typeof msg.response.writeHead, 'function');
    strictEqual(msg.response.req, msg.request, 'response.req must be the paired request');
    // Node's payload carries a fully populated IncomingMessage — publishing
    // before the request line is parsed would hand subscribers a blank request.
    strictEqual(msg.request.method, 'GET');
    strictEqual(msg.request.url, '/created');
});

// --- 9-12. net.client.socket / net.server.socket -------------------------
//
// These share ONE net.Server for a reason: cno currently segfaults when a
// net.Server accepts a connection after any earlier net.Server was closed
// (minimal repro in the audit notes; `net.createServer` + listen + close, then
// listen + dial a second one → 0xC0000005). That fault is unrelated to
// diagnostics_channel — it reproduces with no subscriber and no dc import — but
// creating a server per test would trip it and take the worker down before these
// assertions could run. One long-lived server keeps the channel coverage honest
// without depending on the broken path.
let sharedServer: net.Server | null = null;
let sharedPort = 0;
const connectionOrder: string[] = [];

async function sharedNetServer(): Promise<number> {
    if (sharedServer) return sharedPort;
    const server = net.createServer((socket) => {
        connectionOrder.push('connection');
        // A half-close race on loopback surfaces as ECONNRESET from the pending
        // write; it is not what these tests are measuring, so absorb it rather
        // than let it reach the uncaught handler.
        socket.on('error', () => {});
        socket.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    sharedPort = typeof address === 'object' && address ? address.port : 0;
    // Unref'd so it never holds the loop open; see the teardown note below for
    // why it is never explicitly closed.
    server.unref();
    sharedServer = server;
    return sharedPort;
}

/** Dials the shared server and resolves once the socket is fully closed. */
function dialShared(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => { socket.end(); });
        socket.on('close', () => resolve());
        socket.on('error', (err: Error & { code?: string }) => {
            // The server half-closes immediately; a reset here is benign.
            if (err.code === 'ECONNRESET') return;
            reject(err);
        });
    });
}

Deno.test('dc builtins: net.client.socket fires once with {socket} on connect', async () => {
    const port = await sharedNetServer();
    const seen = await capture(['net.client.socket'], async () => {
        await dialShared(port);
    });

    const published = firstOf(seen, 'net.client.socket');
    deepStrictEqual(published.keys, ['socket']);
    const socket = (published.message as { socket: net.Socket }).socket;
    strictEqual(typeof socket.write, 'function');
    strictEqual(typeof socket.destroy, 'function');
    // Exactly once per connect() call — no double publish from re-entry.
    strictEqual(only(seen, 'net.client.socket').length, 1);
});

Deno.test('dc builtins: net.client.socket publishes before connect completes', async () => {
    const port = await sharedNetServer();
    let connectingAtPublish: boolean | undefined;
    const handler = (message: unknown): void => {
        // Node publishes at the top of connect(), before any dial work.
        connectingAtPublish = (message as { socket: net.Socket }).socket.connecting;
    };
    dc.subscribe('net.client.socket', handler);
    try {
        await dialShared(port);
    } finally {
        dc.unsubscribe('net.client.socket', handler);
    }
    strictEqual(connectingAtPublish, false, 'must publish before connect() starts dialling');
});

Deno.test('dc builtins: net.server.socket fires with {socket} for an accepted socket', async () => {
    const port = await sharedNetServer();
    const seen = await capture(['net.server.socket'], async () => {
        await dialShared(port);
        await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const published = firstOf(seen, 'net.server.socket');
    deepStrictEqual(published.keys, ['socket']);
    const socket = (published.message as { socket: net.Socket }).socket;
    // An accepted socket knows its peer; that is what distinguishes it from the
    // client-side publish.
    ok(socket.remoteAddress, 'accepted socket must expose remoteAddress');
    strictEqual(only(seen, 'net.server.socket').length, 1);
});

Deno.test('dc builtins: net.server.socket publishes after emit(connection)', async () => {
    const port = await sharedNetServer();
    connectionOrder.length = 0;
    const handler = (): void => { connectionOrder.push('channel'); };
    dc.subscribe('net.server.socket', handler);
    try {
        await dialShared(port);
        await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
        dc.unsubscribe('net.server.socket', handler);
    }
    // Node's onconnection() emits 'connection' first, then publishes.
    strictEqual(connectionOrder[0], 'connection', "'connection' must be emitted before the publish");
    strictEqual(connectionOrder[1], 'channel');
});

// --- 13. an http request also publishes net.client.socket -------------

Deno.test('dc builtins: an http request publishes net.client.socket', async () => {
    // In Node the http Agent dials through net.createConnection, so an APM
    // subscriber sees the underlying socket for HTTP traffic too.
    await withHttpServer((_req, res) => res.end('n'), async (port) => {
        const seen = await capture(['net.client.socket'], async () => {
            await get(port);
        });
        ok(only(seen, 'net.client.socket').length >= 1, 'http request must publish net.client.socket');
        deepStrictEqual(firstOf(seen, 'net.client.socket').keys, ['socket']);
    });
});

// --- 14. nothing publishes when nothing is subscribed -----------------

Deno.test('dc builtins: no publish reaches a channel after unsubscribe', async () => {
    let afterUnsubscribe = 0;
    const names = [
        'http.client.request.created', 'http.client.request.start',
        'http.client.response.finish', 'http.server.request.start',
        'http.server.response.created', 'http.server.response.finish',
        'net.client.socket', 'net.server.socket',
    ];
    const handler = (): void => { afterUnsubscribe++; };

    await withHttpServer((_req, res) => res.end('u'), async (port) => {
        // Subscribe, then unsubscribe before doing any work at all.
        for (const name of names) dc.subscribe(name, handler);
        for (const name of names) strictEqual(dc.unsubscribe(name, handler), true);
        for (const name of names) {
            strictEqual(dc.hasSubscribers(name), false, `${name} must report no subscribers`);
        }
        await get(port);
        await new Promise((resolve) => setTimeout(resolve, 50));
    });

    strictEqual(afterUnsubscribe, 0, 'an unsubscribed handler must never be called');
});

// --- 15. https uses the same http.client.* / http.server.* channels ------

Deno.test({ name: 'dc builtins: https publishes the same client and server channels', timeout: 20000 }, async () => {
    // Node's https.request returns an http.ClientRequest and https.Server
    // reuses the http server machinery, so the same channel names must fire with
    // the same payload shapes over TLS. cno implements https separately, so this
    // is the parity check for that second implementation.
    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const server = https.createServer({ cert, key }, (_req, res) => {
        res.statusCode = 202;
        res.end('tls-ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    let seen: Captured[] = [];
    try {
        seen = await capture([
            'http.client.request.created', 'http.client.request.start',
            'http.client.response.finish',
            'http.server.response.created', 'http.server.request.start',
            'http.server.response.finish',
        ], async () => {
            const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
                const req = https.request(
                    `https://127.0.0.1:${port}/tls`,
                    { rejectUnauthorized: false },
                    (res) => {
                        let body = '';
                        res.setEncoding('utf8');
                        res.on('data', (chunk: string) => { body += chunk; });
                        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
                    },
                );
                req.once('error', reject);
                req.end();
            });
            strictEqual(result.status, 202);
            strictEqual(result.body, 'tls-ok');
            await new Promise((resolve) => setTimeout(resolve, 80));
        });
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Same key sets as the plaintext path.
    deepStrictEqual(firstOf(seen, 'http.client.request.created').keys, ['request']);
    deepStrictEqual(firstOf(seen, 'http.client.request.start').keys, ['request']);
    deepStrictEqual(firstOf(seen, 'http.client.response.finish').keys, ['request', 'response']);
    deepStrictEqual(firstOf(seen, 'http.server.response.created').keys, ['request', 'response']);
    deepStrictEqual(
        firstOf(seen, 'http.server.request.start').keys,
        ['request', 'response', 'server', 'socket'],
    );
    deepStrictEqual(
        firstOf(seen, 'http.server.response.finish').keys,
        ['request', 'response', 'server', 'socket'],
    );

    // And the payloads describe the real TLS exchange, not placeholders.
    const clientFinish = firstOf(seen, 'http.client.response.finish').message as {
        request: { protocol?: string };
        response: { statusCode?: number };
    };
    strictEqual(clientFinish.response.statusCode, 202);
    strictEqual(clientFinish.request.protocol, 'https:');

    const serverStart = firstOf(seen, 'http.server.request.start').message as {
        request: { url?: string; method?: string };
    };
    strictEqual(serverStart.request.url, '/tls');
    strictEqual(serverStart.request.method, 'GET');
});

// --- 17. dns.lookup.* channels do not exist in Node ----------------------

Deno.test('dc builtins: node has no dns.lookup diagnostics channels', async () => {
    // Measured against real Node v24.18.0: `dns.lookup.start` / `.end` /
    // `.error` are NOT built-in channels. Node's full built-in set was
    // enumerated by wrapping dc.channel() before loading any builtin, and by
    // grepping the node binary for dc.channel(...) call sites — neither yields
    // any `dns.*` name. Subscribing therefore creates a fresh user channel that
    // nothing publishes to, in Node exactly as in cno.
    //
    // This test pins that as intended behaviour: publishing to these names would
    // be a cno-only invention that no APM tool listens for, and would then have
    // to be maintained as a divergence.
    const names = ['dns.lookup.start', 'dns.lookup.end', 'dns.lookup.error'];
    let fired = 0;
    const handler = (): void => { fired++; };
    for (const name of names) dc.subscribe(name, handler);
    try {
        // hasSubscribers is true because subscribe() created the channel — this
        // is the exact trap: a truthy hasSubscribers does not imply a publisher.
        for (const name of names) strictEqual(dc.hasSubscribers(name), true);

        const dns = await import('node:dns');
        await new Promise<void>((resolve) => {
            dns.lookup('localhost', () => resolve());
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
        for (const name of names) dc.unsubscribe(name, handler);
    }
    strictEqual(fired, 0, 'no dns.* channel is published to, matching Node');
});

// --- 18. shared net server is intentionally left to process teardown -----

Deno.test('dc builtins: shared net server needs no explicit close', () => {
    // Deliberately NOT calling sharedServer.close(). Closing a net.Server
    // destabilises the cts worker in this build: with the close in place the
    // worker dies with an uncaught ECONNRESET out of the harness's own IPC pipe
    // (ipc_channel/mod.ts _writeRaw), and with `unref()` before the close it
    // exits before reporting results at all. The server is unref'd at creation,
    // so it does not hold the loop open, and process teardown reclaims it.
    ok(sharedServer, 'shared server should still be open at teardown');
});
