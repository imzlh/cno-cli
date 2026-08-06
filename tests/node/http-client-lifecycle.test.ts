import { strictEqual, deepStrictEqual, ok, throws } from 'node:assert';
import * as http from 'node:http';
import * as net from 'node:net';

/**
 * Client-side http.request semantics, every expectation measured against real
 * node v24 first (probes in /d/tmp/ag-http/). These cover defects where cno was
 * either silent where node reports, or more permissive than node:
 *   - ClientRequest never emitted 'close' in ANY terminal path
 *   - destroy()/abort() emitted no ECONNRESET
 *   - an AbortSignal produced no AbortError, and a pre-aborted signal was ignored
 *   - duplicate response headers were always arrayed instead of node's
 *     first-wins / comma-join / set-cookie-array split
 *   - an illegal method or path reached the wire
 *   - Expect: 100-continue deadlocked (head was never flushed before end())
 *   - res.destroy() mid-body emitted no 'aborted'
 */

function tcpListen(server: net.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
        server.once('error', reject);
    });
}

function tcpClose(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
        server.once('error', reject);
    });
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

/** A peer that accepts and then says nothing, so the client stays in-flight. */
function silentPeer(): net.Server {
    return net.createServer((s) => {
        s.on('data', () => {});
        s.on('error', () => {});
    });
}

/** Collect events until `until` fires, with a hard cap so a hang is a failure. */
function collect(
    build: (record: (e: string) => void, done: () => void) => void,
    capMs = 4000,
): Promise<string[]> {
    return new Promise((resolve) => {
        const events: string[] = [];
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve(events);
        };
        const timer = setTimeout(() => {
            events.push('TIMEBOX');
            finish();
        }, capMs);
        build((e) => events.push(e), () => {
            clearTimeout(timer);
            finish();
        });
    });
}

// --- 'close' is emitted in every terminal path ------------------------------

Deno.test({ name: "http client: ClientRequest emits 'close' on a successful request", timeout: 15000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('BODY');
    });
    const port = await listen(server);
    try {
        const events = await collect((record, done) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
                res.resume();
                res.on('end', () => record('res-end'));
            });
            req.on('close', () => { record('req-close'); done(); });
            req.on('error', (e: any) => { record('req-error:' + e.code); done(); });
            req.end();
        });
        ok(events.includes('req-close'), `request must emit 'close'; got ${JSON.stringify(events)}`);
        ok(!events.includes('TIMEBOX'), `must not hang; got ${JSON.stringify(events)}`);
    } finally {
        await close(server);
    }
});

Deno.test({ name: "http client: destroy() emits ECONNRESET then 'close'", timeout: 15000 }, async () => {
    const peer = silentPeer();
    const port = await tcpListen(peer);
    try {
        const events = await collect((record, done) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false }, () => record('response'));
            req.on('error', (e: any) => record('error:' + e.code));
            req.on('close', () => { record('close'); done(); });
            req.end();
            setTimeout(() => req.destroy(), 60);
        });
        ok(events.includes('error:ECONNRESET'), `destroy() on an in-flight request must surface ECONNRESET; got ${JSON.stringify(events)}`);
        ok(events.includes('close'), `must emit 'close'; got ${JSON.stringify(events)}`);
        strictEqual(events.indexOf('error:ECONNRESET') < events.indexOf('close'), true, 'error must precede close');
    } finally {
        await tcpClose(peer);
    }
});

Deno.test({ name: "http client: destroy(error) reports that error, not ECONNRESET", timeout: 15000 }, async () => {
    const peer = silentPeer();
    const port = await tcpListen(peer);
    try {
        const events = await collect((record, done) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false }, () => record('response'));
            req.on('error', (e: any) => record('error:' + e.message));
            req.on('close', () => { record('close'); done(); });
            req.end();
            setTimeout(() => req.destroy(new Error('boom')), 60);
        });
        ok(events.includes('error:boom'), `explicit error must be reported verbatim; got ${JSON.stringify(events)}`);
        ok(!events.includes('error:socket hang up'), `must not also raise ECONNRESET; got ${JSON.stringify(events)}`);
        ok(events.includes('close'), `must emit 'close'; got ${JSON.stringify(events)}`);
    } finally {
        await tcpClose(peer);
    }
});

Deno.test({ name: "http client: abort() emits 'abort', ECONNRESET and 'close', and sets req.aborted", timeout: 15000 }, async () => {
    const peer = silentPeer();
    const port = await tcpListen(peer);
    try {
        let abortedFlag: boolean | undefined;
        const events = await collect((record, done) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false }, () => record('response'));
            req.on('abort', () => record('abort'));
            req.on('error', (e: any) => record('error:' + e.code));
            req.on('close', () => { abortedFlag = req.aborted; record('close'); done(); });
            req.end();
            setTimeout(() => req.abort(), 60);
        });
        deepStrictEqual(events, ['abort', 'error:ECONNRESET', 'close'], `unexpected sequence: ${JSON.stringify(events)}`);
        strictEqual(abortedFlag, true, 'legacy abort() must set req.aborted');
    } finally {
        await tcpClose(peer);
    }
});

// --- AbortSignal -----------------------------------------------------------

Deno.test({ name: 'http client: AbortSignal produces an ABORT_ERR AbortError', timeout: 15000 }, async () => {
    const peer = silentPeer();
    const port = await tcpListen(peer);
    try {
        let seen: any = null;
        let abortedFlag: boolean | undefined;
        const events = await collect((record, done) => {
            const ac = new AbortController();
            const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false, signal: ac.signal }, () => record('response'));
            req.on('error', (e: any) => { seen = e; record('error'); });
            req.on('close', () => { abortedFlag = req.aborted; record('close'); done(); });
            req.end();
            setTimeout(() => ac.abort(), 60);
        });
        ok(events.includes('error'), `signal abort must emit 'error'; got ${JSON.stringify(events)}`);
        ok(events.includes('close'), `signal abort must emit 'close'; got ${JSON.stringify(events)}`);
        strictEqual(seen?.name, 'AbortError');
        strictEqual(seen?.code, 'ABORT_ERR');
        // node's http client ignores signal.reason entirely, unlike fetch.
        strictEqual(seen?.message, 'The operation was aborted');
        strictEqual(abortedFlag, false, 'a signal abort must NOT set the legacy req.aborted flag');
    } finally {
        await tcpClose(peer);
    }
});

Deno.test({ name: 'http client: a custom abort reason is still reported as ABORT_ERR', timeout: 15000 }, async () => {
    const peer = silentPeer();
    const port = await tcpListen(peer);
    try {
        let seen: any = null;
        await collect((record, done) => {
            const ac = new AbortController();
            const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false, signal: ac.signal }, () => record('response'));
            req.on('error', (e: any) => { seen = e; record('error'); done(); });
            req.end();
            setTimeout(() => ac.abort(new Error('MYREASON')), 60);
        });
        strictEqual(seen?.name, 'AbortError', 'node substitutes its own AbortError rather than propagating the reason');
        strictEqual(seen?.code, 'ABORT_ERR');
        ok(seen?.message !== 'MYREASON', 'the reason must not leak through on the http client path');
    } finally {
        await tcpClose(peer);
    }
});

Deno.test({ name: 'http client: an already-aborted signal fails the request immediately', timeout: 15000 }, async () => {
    const peer = silentPeer();
    const port = await tcpListen(peer);
    try {
        let seen: any = null;
        const events = await collect((record, done) => {
            const ac = new AbortController();
            ac.abort();
            const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false, signal: ac.signal }, () => record('response'));
            req.on('error', (e: any) => { seen = e; record('error'); });
            req.on('close', () => { record('close'); done(); });
            req.end();
        }, 3000);
        ok(!events.includes('TIMEBOX'), `a pre-aborted signal must not hang; got ${JSON.stringify(events)}`);
        ok(events.includes('error'), `must emit 'error'; got ${JSON.stringify(events)}`);
        strictEqual(seen?.code, 'ABORT_ERR');
        ok(!events.includes('response'), 'must never reach the server');
    } finally {
        await tcpClose(peer);
    }
});

// --- duplicate response headers -------------------------------------------

function rawHeaderPeer(rawResponse: string): net.Server {
    return net.createServer((s) => {
        s.on('error', () => {});
        s.on('data', () => s.write(rawResponse));
    });
}

async function fetchHeaders(raw: string): Promise<http.IncomingHttpHeaders> {
    const peer = rawHeaderPeer(raw);
    const port = await tcpListen(peer);
    try {
        return await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
                res.resume();
                res.on('end', () => resolve(res.headers));
            });
            req.on('error', reject);
            req.end();
        });
    } finally {
        await tcpClose(peer);
    }
}

Deno.test({ name: 'http client: duplicate set-cookie becomes an array', timeout: 15000 }, async () => {
    const headers = await fetchHeaders('HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 2\r\n\r\nok');
    deepStrictEqual(headers['set-cookie'], ['a=1', 'b=2']);
});

Deno.test({ name: 'http client: duplicate ordinary header joins with a comma', timeout: 15000 }, async () => {
    const headers = await fetchHeaders('HTTP/1.1 200 OK\r\nX-Custom: A\r\nX-Custom: B\r\nContent-Length: 2\r\n\r\nok');
    // node gives the STRING "A, B" here; cno used to give ["A","B"], so any
    // consumer calling .split() on the value broke only when a duplicate arrived.
    strictEqual(headers['x-custom'], 'A, B');
    strictEqual(typeof headers['x-custom'], 'string');
});

Deno.test({ name: 'http client: duplicate single-value header keeps the first', timeout: 15000 }, async () => {
    const headers = await fetchHeaders('HTTP/1.1 200 OK\r\nContent-Type: A\r\nContent-Type: B\r\nContent-Length: 2\r\n\r\nok');
    strictEqual(headers['content-type'], 'A', 'content-type is first-wins in node, not arrayed and not joined');
});

Deno.test({ name: 'http client: duplicate cookie joins with a semicolon', timeout: 15000 }, async () => {
    const headers = await fetchHeaders('HTTP/1.1 200 OK\r\nCookie: A\r\nCookie: B\r\nContent-Length: 2\r\n\r\nok');
    strictEqual(headers['cookie'], 'A; B');
});

Deno.test({ name: 'http client: headersDistinct keeps every duplicate value', timeout: 15000 }, async () => {
    const peer = rawHeaderPeer('HTTP/1.1 200 OK\r\nContent-Type: A\r\nContent-Type: B\r\nContent-Length: 2\r\n\r\nok');
    const port = await tcpListen(peer);
    try {
        const distinct = await new Promise<Record<string, string[]>>((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
                res.resume();
                res.on('end', () => resolve(res.headersDistinct as Record<string, string[]>));
            });
            req.on('error', reject);
            req.end();
        });
        // headersDistinct must NOT lose the value that `headers` discards.
        deepStrictEqual(distinct['content-type'], ['A', 'B']);
    } finally {
        await tcpClose(peer);
    }
});

// --- method / path validation ---------------------------------------------

Deno.test({ name: 'http client: an illegal method throws ERR_INVALID_HTTP_TOKEN', timeout: 10000 }, () => {
    throws(
        () => http.request({ host: '127.0.0.1', port: 1, path: '/x', method: 'BAD METHOD' }),
        (e: any) => e.code === 'ERR_INVALID_HTTP_TOKEN',
        'a method with a space must be rejected before it can reach the wire',
    );
});

Deno.test({ name: 'http client: a CRLF method throws synchronously', timeout: 10000 }, () => {
    throws(
        () => http.request({ host: '127.0.0.1', port: 1, path: '/x', method: 'GET / HTTP/1.1\r\nX-Injected: yes\r\nGET' }),
        (e: any) => e.code === 'ERR_INVALID_HTTP_TOKEN',
    );
});

Deno.test({ name: 'http client: an unescaped path throws ERR_UNESCAPED_CHARACTERS', timeout: 10000 }, () => {
    throws(
        () => http.request({ host: '127.0.0.1', port: 1, path: '/he llo' }),
        (e: any) => e.code === 'ERR_UNESCAPED_CHARACTERS',
    );
    throws(
        () => http.request({ host: '127.0.0.1', port: 1, path: '/x\r\nX-Injected: yes\r\n' }),
        (e: any) => e.code === 'ERR_UNESCAPED_CHARACTERS',
        'CRLF in the path must be a synchronous throw, not a deferred request error',
    );
});

Deno.test({ name: 'http client: header validation errors carry node error codes', timeout: 10000 }, () => {
    const req = http.request({ host: '127.0.0.1', port: 1, path: '/x' });
    throws(() => req.setHeader('X-Ok', 'bad\nvalue'), (e: any) => e.code === 'ERR_INVALID_CHAR');
    throws(() => req.setHeader('X:Y', 'v'), (e: any) => e.code === 'ERR_INVALID_HTTP_TOKEN');
    req.destroy();
});

// --- Expect: 100-continue -------------------------------------------------

Deno.test({ name: 'http client: Expect 100-continue completes the handshake', timeout: 20000 }, async () => {
    // Raw peer so the 100 is emitted deliberately, and so the test can observe
    // that the head arrived BEFORE any body was written.
    let headSeenBeforeBody = false;
    const peer = net.createServer((s) => {
        let buf = '';
        let replied = false;
        s.on('error', () => {});
        s.on('data', (d) => {
            buf += d.toString('latin1');
            if (!replied && buf.includes('\r\n\r\n')) {
                replied = true;
                const [head, ...rest] = buf.split('\r\n\r\n');
                headSeenBeforeBody = rest.join('').length === 0;
                if (/expect:\s*100-continue/i.test(head)) s.write('HTTP/1.1 100 Continue\r\n\r\n');
                const waitBody = () => {
                    const body = buf.split('\r\n\r\n').slice(1).join('\r\n\r\n');
                    if (body.length >= 3) s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');
                    else setTimeout(waitBody, 20);
                };
                setTimeout(waitBody, 10);
            }
        });
    });
    const port = await tcpListen(peer);
    try {
        const events = await collect((record, done) => {
            const req = http.request({
                host: '127.0.0.1', port, path: '/', method: 'POST', agent: false,
                headers: { Expect: '100-continue', 'Content-Length': '3' },
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => { record('res:' + res.statusCode + ':' + Buffer.concat(chunks).toString()); done(); });
            });
            // Deliberately do NOT call end() until 'continue' arrives: this is
            // node's documented flow and it deadlocked before the head was
            // flushed at construction time.
            req.on('continue', () => { record('continue'); req.end('abc'); });
            req.on('information', (info: any) => record('info:' + info.statusCode));
            req.on('error', (e: any) => { record('error:' + e.code); done(); });
        }, 8000);
        ok(!events.includes('TIMEBOX'), `the 100-continue flow must not deadlock; got ${JSON.stringify(events)}`);
        deepStrictEqual(events, ['continue', 'info:100', 'res:200:OK'], `unexpected sequence: ${JSON.stringify(events)}`);
        ok(headSeenBeforeBody, 'the head must reach the server before any body byte');
    } finally {
        await tcpClose(peer);
    }
});

Deno.test({ name: 'http client: flushHeaders() puts the head on the wire before end()', timeout: 20000 }, async () => {
    let sawHead = false;
    const peer = net.createServer((s) => {
        let buf = '';
        s.on('error', () => {});
        s.on('data', (d) => {
            buf += d.toString('latin1');
            if (buf.includes('\r\n\r\n')) {
                sawHead = true;
                s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');
            }
        });
    });
    const port = await tcpListen(peer);
    try {
        const req = http.request({
            host: '127.0.0.1', port, path: '/', method: 'POST', agent: false,
            headers: { 'Content-Length': '3' },
        });
        req.on('error', () => {});
        req.flushHeaders();
        // Give the flush a chance to reach the peer with no end() call at all.
        await new Promise((r) => setTimeout(r, 400));
        ok(sawHead, 'flushHeaders() must actually write the head, not just set headersSent');
        req.destroy();
    } finally {
        await tcpClose(peer);
    }
});

// --- res.destroy() mid-body ------------------------------------------------

Deno.test({ name: "http client: res.destroy() mid-body emits 'aborted'", timeout: 15000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('AAAA');
        setTimeout(() => res.write('BBBB'), 80);
        setTimeout(() => res.end('CCCC'), 160);
    });
    const port = await listen(server);
    try {
        const events = await collect((record, done) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
                res.on('data', (c: Buffer) => { record('data:' + c.length); res.destroy(); });
                res.on('aborted', () => record('aborted'));
                res.on('close', () => { record('close:complete=' + res.complete); done(); });
                res.on('error', (e: any) => record('res-error:' + e.code));
            });
            req.on('error', (e: any) => record('req-error:' + e.code));
            req.end();
        });
        ok(events.includes('aborted'), `destroying an incomplete response must emit 'aborted'; got ${JSON.stringify(events)}`);
        ok(events.includes('close:complete=false'), `got ${JSON.stringify(events)}`);
    } finally {
        await close(server);
    }
});

Deno.test({ name: 'http client: a complete response is not marked aborted by destroy()', timeout: 15000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('DONE');
    });
    const port = await listen(server);
    try {
        const result = await new Promise<{ aborted: boolean; sawAborted: boolean }>((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
                let sawAborted = false;
                res.on('aborted', () => { sawAborted = true; });
                res.resume();
                res.on('end', () => {
                    res.destroy();
                    setTimeout(() => resolve({ aborted: res.aborted, sawAborted }), 50);
                });
            });
            req.on('error', reject);
            req.end();
        });
        strictEqual(result.aborted, false, 'destroying an already-complete response must not set aborted');
        strictEqual(result.sawAborted, false, "and must not emit 'aborted'");
    } finally {
        await close(server);
    }
});

// --- Agent.getName pool key ----------------------------------------------

Deno.test({ name: 'http client: Agent.getName matches node exactly', timeout: 10000 }, () => {
    const agent = new http.Agent();
    strictEqual(agent.getName({ host: 'h', port: 8080 } as any), 'h:8080:');
    strictEqual(agent.getName({ host: 'h', port: 8080, localAddress: '1.2.3.4' } as any), 'h:8080:1.2.3.4');
    // family is part of the key: a v4 and a v6 socket are not interchangeable.
    strictEqual(agent.getName({ host: 'h', port: 8080, family: 6 } as any), 'h:8080::6');
    strictEqual(agent.getName({ host: 'h', port: 8080, family: 4 } as any), 'h:8080::4');
    // no port => empty segment, NOT the agent's defaultPort.
    strictEqual(agent.getName({} as any), 'localhost::');
    agent.destroy();
});

Deno.test({ name: "http client: Agent emits 'free' when a socket returns to the pool", timeout: 15000 }, async () => {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x');
    });
    const port = await listen(server);
    const agent = new http.Agent({ keepAlive: true });
    try {
        let freeCount = 0;
        agent.on('free', () => { freeCount++; });
        await new Promise<void>((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
                res.resume();
                res.on('end', () => resolve());
            });
            req.on('error', reject);
            req.end();
        });
        await new Promise((r) => setTimeout(r, 120));
        strictEqual(freeCount, 1, "a pooled socket must raise exactly one 'free'");
    } finally {
        agent.destroy();
        await close(server);
    }
});
