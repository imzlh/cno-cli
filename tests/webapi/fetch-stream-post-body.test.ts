import { rejects, strictEqual } from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

Deno.test({ name: 'fetch: abort interrupts a pending upload read and releases its reader', timeout: 5000 }, async () => {
    const controller = new AbortController();
    const reason = new Error('upload canceled');
    const reading = Promise.withResolvers<void>();
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
        pull() {
            reading.resolve();
            return new Promise<void>(() => {});
        },
        cancel(value) {
            cancelReason = value;
            return new Promise<void>(() => {});
        },
    });
    const pending = fetch('http://127.0.0.1:1/', {
        method: 'POST', body, duplex: 'half', signal: controller.signal,
    });
    const rejected = rejects(pending, error => error === reason);
    await reading.promise;
    controller.abort(reason);
    await rejected;
    strictEqual(cancelReason, reason);
    strictEqual(body.locked, false);
});

Deno.test({ name: 'fetch: streamed POST bodies stay in memory and use POST semantics', timeout: 10000 }, async () => {
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
            res.setHeader('content-type', 'text/plain');
            res.end(`${req.method}:${Buffer.concat(chunks).toString('hex')}`);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
        const port = (server.address() as AddressInfo).port;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([0, 1, 2, 255]));
                controller.close();
            },
        });
        const response = await fetch(`http://127.0.0.1:${port}/git-upload-pack`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-git-upload-pack-request' },
            body,
            duplex: 'half',
        });
        strictEqual(await response.text(), 'POST:000102ff');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test({ name: 'fetch: delayed response consumption keeps all streamed chunks', timeout: 10000 }, async () => {
    const chunkSize = 64 * 1024;
    const chunks = [
        new Uint8Array(chunkSize).fill(0x11),
        new Uint8Array(chunkSize).fill(0x22),
        new Uint8Array(chunkSize).fill(0x33),
    ];
    const server = createServer((_req, res) => {
        res.setHeader('content-type', 'application/octet-stream');
        for (const chunk of chunks) res.write(chunk);
        res.end();
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
        const port = (server.address() as AddressInfo).port;
        const response = await fetch(`http://127.0.0.1:${port}/large-response`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const body = new Uint8Array(await response.arrayBuffer());
        strictEqual(body.byteLength, chunkSize * chunks.length);
        strictEqual(body[0], 0x11);
        strictEqual(body[chunkSize - 1], 0x11);
        strictEqual(body[chunkSize], 0x22);
        strictEqual(body[chunkSize * 2 - 1], 0x22);
        strictEqual(body[chunkSize * 2], 0x33);
        strictEqual(body[body.length - 1], 0x33);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
