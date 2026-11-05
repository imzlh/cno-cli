// @cno-host: false
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bundled = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['cno/src/bun/serve.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    write: false,
});
const { serve } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

function host(t) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
    const bindings = [];
    let shutdowns = 0;
    Object.defineProperty(globalThis, 'Deno', {
        configurable: true,
        value: {
            serve(options, handler) {
                bindings.push({ options, handler });
                return {
                    addr: { transport: 'tcp', port: 43112 },
                    async shutdown() { shutdowns++; },
                };
            },
        },
    });
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, 'Deno', previous);
        else delete globalThis.Deno;
    });
    return {
        get shutdowns() { return shutdowns; },
        async request(path, method = 'GET') {
            const { handler, options } = bindings.at(-1);
            try {
                return await handler(new Request(`http://localhost${path}`, { method }));
            } catch (error) {
                return await options.onError(error) ?? new Response(null, { status: 500 });
            }
        },
    };
}

function sequencedStaticResponses() {
    // Keep each snapshot's retained capacity equal to its logical size. A
    // fragmented stream would exercise geometric growth peaks rather than the
    // process-wide cached-body budget this fixture is intended to verify.
    const chunk = new Uint8Array(11 * 1024 * 1024);
    const gates = [Promise.resolve(), Promise.withResolvers(), Promise.withResolvers()];
    const sources = [];
    for (let index = 0; index < 3; index++) {
        let remaining = 1;
        const source = new Response(new ReadableStream({
            async pull(controller) {
                await (index === 0 ? gates[0] : gates[index].promise);
                if (remaining === 0) {
                    controller.close();
                    return;
                }
                remaining--;
                controller.enqueue(chunk);
                // Let the next stream start only after this snapshot has
                // retained its 11 MiB body.
                if (remaining === 0 && index < 2) gates[index + 1].resolve();
            },
        }, { highWaterMark: 0 }));
        sources.push(source);
    }
    return sources;
}

async function drain(response) {
    const reader = response.body.getReader();
    try {
        while (!(await reader.read()).done) {
            // Consume and discard each chunk so the original tee branch does
            // not retain the whole body in an ArrayBuffer.
        }
    } finally {
        reader.releaseLock();
    }
}

test('serve routes: aggregate static snapshot budget rejects a third large stream', { timeout: 15000 }, async t => {
    const mock = host(t);
    const sources = sequencedStaticResponses();
    const errors = [];
    const server = serve({
        routes: { '/first': sources[0], '/second': sources[1], '/third': sources[2] },
        error(error) {
            errors.push(String(error?.message ?? error));
            return new Response(String(error?.message ?? error), { status: 503 });
        },
    });

    // Drain the original tee branches so the source-side queues do not retain
    // the 33 MiB of shared chunks while the route snapshots are built.
    const drains = sources.map(drain);
    try {
        for (const path of ['/first', '/second']) {
            const response = await mock.request(path);
            assert.equal(response.status, 200, path);
            assert.equal((await response.arrayBuffer()).byteLength, 11 * 1024 * 1024);
        }
        const rejected = await mock.request('/third');
        assert.equal(rejected.status, 503);
        assert.match(await rejected.text(), /32 MiB/);
        assert.equal(errors.length, 1);
        await Promise.all(drains);
    } finally {
        await server.stop();
        await Promise.allSettled(drains);
    }
    assert.equal(mock.shutdowns, 1);
});

test('serve routes: failed static snapshots reach error handling for GET and HEAD', { timeout: 5000 }, async t => {
    const mock = host(t);
    let controller;
    const source = new Response(new ReadableStream({ start(value) { controller = value; } }));
    const errors = [];
    const server = serve({
        routes: { '/broken': source, '/ok': new Response('body') },
        error(error) {
            errors.push(String(error?.message ?? error));
            return new Response('handled:' + String(error?.message ?? error), { status: 503 });
        },
    });
    try {
        controller.error(new Error('snapshot failed'));
        for (const method of ['GET', 'HEAD']) {
            const response = await mock.request('/broken', method);
            assert.equal(response.status, 503, method);
            assert.match(await response.text(), /handled:snapshot failed/);
        }
        const head = await mock.request('/ok', 'HEAD');
        assert.equal(head.status, 200);
        assert.equal(await head.text(), '');
        assert.deepEqual(errors, ['snapshot failed', 'snapshot failed']);
    } finally {
        await server.stop();
    }
});
