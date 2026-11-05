import { ok, rejects, strictEqual } from 'node:assert';
import Bun, { spawn, stdout, write } from 'bun';

function requestWithBody(body: BodyInit): Request {
    const init: RequestInit = { method: 'POST', body };
    // Fetch requires an explicit duplex mode for streaming request bodies.
    if (body instanceof ReadableStream) init.duplex = 'half';
    return new Request('https://example.invalid/upload', init);
}

Deno.test({ name: 'bun.write: streams Request bodies into stdout and stderr', timeout: 15000 }, async () => {
    const script = `
        const requestBody = () => new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('chunk-one|'));
                controller.enqueue(new TextEncoder().encode('chunk-two'));
                controller.close();
            },
        });
        // Request bodies are single-use, so each destination gets its own.
        const first = await Bun.write(Bun.stdout, new Request('https://example.invalid/upload', {
            method: 'POST', body: requestBody(), duplex: 'half',
        }));
        const bodyless = await Bun.write(Bun.stdout, new Request('https://example.invalid/empty'));
        const second = await Bun.write(Bun.stderr, new Request('https://example.invalid/upload', {
            method: 'POST', body: requestBody(), duplex: 'half',
        }));
        await Bun.write(Bun.stdout, String(first) + ':' + String(bodyless) + ':' + String(second));
    `;
    const child = spawn([process.execPath, 'eval', script], { stdout: 'pipe', stderr: 'pipe' });
    strictEqual(await child.exited, 0);
    strictEqual(await child.stdout.text(), 'chunk-one|chunk-two19:0:19');
    strictEqual(await child.stderr.text(), 'chunk-one|chunk-two');
});

Deno.test({ name: 'bun.write: stdio Request writes reject used and locked bodies', timeout: 10000 }, async () => {
    strictEqual(Bun.write, write);

    const used = requestWithBody('used');
    await used.text();
    await rejects(() => write(stdout, used), /Request body is already used or locked/);

    const locked = requestWithBody('locked');
    const reader = locked.body!.getReader();
    try {
        await rejects(() => write(stdout, locked), /Request body is already used or locked/);
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
});

Deno.test({ name: 'bun.write: a failing stdio destination cancels the Request stream', timeout: 10000 }, async () => {
    let cancelled = false;
    const failing = requestWithBody(new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
        },
        cancel() {
            cancelled = true;
            controller.close();
        },
    }));
    // A stand-in destination whose write always fails: the error must surface
    // and the request body must be cancelled without touching real stdout.
    const failingStdio = Object.create(stdout) as typeof stdout;
    failingStdio.write = async () => {
        throw new Error('pipe closed');
    };
    await rejects(() => write(failingStdio, failing), /pipe closed/);
    ok(cancelled, 'the request body stream was cancelled');
});
