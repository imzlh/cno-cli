// Regression: async-iterating a Readable must NOT switch it to flowing mode.
//
// Node's `createAsyncIterator` waits on 'readable' and pulls with `read()`; it
// never calls `resume()`. cno's `Readable.prototype[Symbol.asyncIterator]` used
// to attach a 'data' listener and call `readable.resume()` whenever its initial
// `read()` came back empty. That forced the stream into flowing mode, and
// flowing delivery hands each chunk to the 'data' listeners instead of buffering
// it for `read()` -- so any *other* consumer reading the same stream in paused
// mode starved and saw a silently empty body.
//
// Measured against node v24.18.0. The npm package `got` is the real-world
// casualty: with its default `strictContentLength: true` it attaches a
// byte-counting 'data' listener to the native response, then reads the body
// through its own `highWaterMark: 0` Duplex via `read()`. Awaiting that Duplex
// (`toArray()`) resumed the response through got's `on('resume')` bridge, the 26
// body bytes went to the counter and were discarded, and `got(url)` resolved
// with a 0-byte body -- `.json()` returned the string "" rather than throwing,
// so callers silently read `undefined`. node returned 26 bytes from the same
// server. `decompress: false` masked it by removing the extra listener.
//
// These assert BODY BYTES, not "it worked": a chunk count alone would pass while
// the payload was empty.
import { deepStrictEqual, strictEqual } from 'node:assert';
import * as http from 'node:http';
import { Duplex, Readable } from 'node:stream';

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') reject(new Error('no port'));
            else resolve(addr.port);
        });
        server.once('error', reject);
    });
}
const close = (s: http.Server): Promise<void> => new Promise((r) => s.close(() => r()));

Deno.test('async iteration does not resume the stream it consumes', async () => {
    const readable = new Readable({ read() {} });
    const events: string[] = [];
    readable.on('resume', () => events.push('resume'));

    // Feed the data only after the iterator has parked on an empty buffer -- that is
    // the state that used to call resume(). Pushing up front would let the very first
    // read() satisfy the iterator and never exercise this path.
    const timer = setTimeout(() => {
        readable.push(Buffer.from('hello'));
        readable.push(null);
    }, 10);

    try {
        const chunks = await readable.toArray();
        const bytes = (chunks as Buffer[]).reduce((n, c) => n + c.length, 0);

        strictEqual(bytes, 5);
        strictEqual(Buffer.concat(chunks as Buffer[]).toString(), 'hello');
        // node emits no 'resume' at all for async iteration.
        deepStrictEqual(events, []);
    } finally {
        clearTimeout(timer);
    }
});

Deno.test('http response body survives a concurrent data listener (got shape)', async () => {
    const PAYLOAD = JSON.stringify({ ok: true, method: 'GET' });
    strictEqual(PAYLOAD.length, 26);

    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(PAYLOAD);
    });
    const port = await listen(server);

    try {
        const result = await new Promise<{ bytes: number; text: string; counted: number }>((resolve, reject) => {
            const req = http.get({ host: '127.0.0.1', port, path: '/json' }, (res) => {
                let counted = 0;
                let stopReading = false;
                let triggerRead = true;

                const out: Duplex = new Duplex({
                    autoDestroy: false,
                    highWaterMark: 0,
                    write(_chunk, _enc, cb) { cb(); },
                    read() {
                        triggerRead = true;
                        if (stopReading) return;
                        if (res.readableLength) triggerRead = false;
                        let chunk: unknown;
                        while ((chunk = res.read()) !== null) out.push(chunk);
                    },
                });

                // got index.js:741 -- the strictContentLength byte counter.
                res.on('data', (c: Buffer) => { counted += c.length; });
                res.on('readable', () => { if (triggerRead) out._read(0); });
                out.on('resume', () => res.resume());
                out.on('pause', () => res.pause());
                res.once('end', () => { stopReading = true; out.push(null); });

                out.toArray().then((chunks) => {
                    const list = chunks as Buffer[];
                    resolve({
                        bytes: list.reduce((n, c) => n + c.length, 0),
                        text: Buffer.concat(list).toString(),
                        counted,
                    });
                }, reject);
            });
            req.once('error', reject);
        });

        strictEqual(result.bytes, 26);
        strictEqual(result.text, PAYLOAD);
        strictEqual(result.counted, 26);
    } finally {
        await close(server);
    }
});
