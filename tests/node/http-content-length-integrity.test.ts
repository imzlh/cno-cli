// Regression: a response with an explicit Content-Length must deliver every byte,
// and must keep the Content-Length the handler set.
//
// The defect: the H1 server opportunistically gzipped any response whose handler
// supplied a Content-Length (the `!chunkedEncoding` term meant only the CL shapes
// were affected). That (a) stripped the handler's Content-Length and (b) fed body
// chunks through a streaming compressor that buffers and returns 0 bytes for the
// first chunks -- and a zero-length chunked frame IS the terminator `0\r\n\r\n`,
// so the peer stopped reading mid-body. express.static hits exactly this shape:
// it sets Content-Length from stat() and pipes a createReadStream, which served a
// truncated JS bundle ("Uncaught SyntaxError: Unexpected end of input").
//
// Both shapes below must match the source bytes by hash. `end(buffer)` is
// deliberately NOT the only case covered: a single terminal write happened to
// survive the bug (one 300KB write forces zlib to emit >0 bytes), so a test that
// only used end(buffer) would have stayed green through the outage.
import { strictEqual } from 'node:assert';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/**
 * >64KB so the body crosses the read-stream chunk boundary and the compressor's
 * internal buffering threshold, and compressible/varied so a gzip path would
 * really engage rather than pass through.
 */
function makeAsset(): Uint8Array {
    const size = 300_025;
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        // Printable, repetitive-but-varied: compresses well, and any byte-level
        // shift or truncation changes the hash.
        out[i] = 0x20 + ((i * 7 + (i >> 5)) % 0x5f);
    }
    return out;
}

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
function close(server: http.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

interface Served {
    bytes: Uint8Array;
    contentLength: string | null;
    contentEncoding: string | null;
}

async function serveAndFetch(handler: http.RequestListener): Promise<Served> {
    const server = http.createServer(handler);
    const port = await listen(server);
    try {
        const resp = await fetch(`http://127.0.0.1:${port}/index.js`);
        const bytes = new Uint8Array(await resp.arrayBuffer());
        return {
            bytes,
            contentLength: resp.headers.get('content-length'),
            contentEncoding: resp.headers.get('content-encoding'),
        };
    } finally {
        await close(server);
    }
}

const asset = makeAsset();
const assetHash = sha256(asset);

Deno.test({ name: 'http: Content-Length + pipe() delivers every byte', timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cno-cl-pipe-'));
    const file = join(dir, 'index.js');
    writeFileSync(file, asset);
    try {
        const size = statSync(file).size;
        strictEqual(size, asset.length, 'fixture must land on disk intact');

        // express.static's exact shape: CL from stat(), body from a piped stream.
        const served = await serveAndFetch((_req, res) => {
            res.writeHead(200, {
                'content-type': 'application/javascript',
                'content-length': String(size),
            });
            createReadStream(file).pipe(res);
        });

        strictEqual(served.bytes.length, size, 'served byte count must equal the file size');
        strictEqual(sha256(served.bytes), assetHash, 'served bytes must hash-match the file');
        // Defect 1: the handler's Content-Length must reach the client. A dropped CL
        // breaks any length-dependent client, proxy or progress indicator.
        strictEqual(served.contentLength, String(size), 'Content-Length must survive to the client');
        // The server must not invent a Content-Encoding the handler did not ask for:
        // that is what invalidated the Content-Length.
        strictEqual(served.contentEncoding, null, 'server must not auto-compress');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

Deno.test({ name: 'http: Content-Length + many write() calls delivers every byte', timeout: 30000 }, async () => {
    const size = asset.length;
    const served = await serveAndFetch((_req, res) => {
        res.writeHead(200, {
            'content-type': 'application/javascript',
            'content-length': String(size),
        });
        // Incremental writes: the shape that a single terminal end(buffer) hid.
        const step = Math.ceil(size / 300);
        for (let off = 0; off < size; off += step) {
            res.write(asset.subarray(off, Math.min(off + step, size)));
        }
        res.end();
    });

    strictEqual(served.bytes.length, size, 'served byte count must equal the source length');
    strictEqual(sha256(served.bytes), assetHash, 'served bytes must hash-match the source');
    strictEqual(served.contentLength, String(size), 'Content-Length must survive to the client');
    strictEqual(served.contentEncoding, null, 'server must not auto-compress');
});

Deno.test({ name: 'http: empty write() must not terminate a Content-Length body', timeout: 30000 }, async () => {
    const size = asset.length;
    const served = await serveAndFetch((_req, res) => {
        res.writeHead(200, { 'content-length': String(size) });
        // A zero-length chunked frame is the terminator `0\r\n\r\n`; an empty write
        // must be a no-op on the wire, never an end-of-body signal.
        res.write(new Uint8Array(0));
        res.write(asset.subarray(0, 1000));
        res.write(new Uint8Array(0));
        res.write(asset.subarray(1000));
        res.end();
    });

    strictEqual(served.bytes.length, size, 'empty writes must not truncate the body');
    strictEqual(sha256(served.bytes), assetHash, 'served bytes must hash-match the source');
});
