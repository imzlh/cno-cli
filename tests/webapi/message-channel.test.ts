import { strictEqual, ok } from 'node:assert';

// ============================================================================
// Web API — MessageChannel / MessagePort
// ============================================================================

Deno.test('webapi: MessageChannel creates two ports', () => {
    const { MessageChannel } = require('node:worker_threads');
    const { port1, port2 } = new MessageChannel();
    ok(typeof port1 === 'object');
    ok(typeof port2 === 'object');
    port1.close();
    port2.close();
});

Deno.test('webapi: MessagePort postMessage and onmessage', async () => {
    const { MessageChannel } = require('node:worker_threads');
    const { port1, port2 } = new MessageChannel();
    const result = await new Promise<any>((resolve) => {
        port1.onmessage = (e) => resolve(e.data);
        port2.postMessage({ hello: 'world' });
    });
    strictEqual(result.hello, 'world');
    port1.close();
    port2.close();
});

Deno.test('MessageChannel upstream: global ports can be transferred in event.ports', async () => {
    const channel = new MessageChannel();
    const transferChannel = new MessageChannel();
    try {
        const done = new Promise<void>((resolve) => {
            channel.port2.onmessage = (event) => {
                strictEqual(event.data, 'hello');
                strictEqual(event.ports.length, 1);
                ok(event.ports[0] instanceof MessagePort);
                event.ports[0].close();
                resolve();
            };
        });

        channel.port1.postMessage('hello', [transferChannel.port1]);
        await done;
    } finally {
        channel.port1.close();
        channel.port2.close();
        transferChannel.port2.close();
    }
});

Deno.test('MessageChannel upstream: transferred port identity is shared between data and ports', async () => {
    const channel = new MessageChannel();
    const transferChannel = new MessageChannel();
    try {
        const done = new Promise<void>((resolve) => {
            channel.port2.onmessage = (event) => {
                const { port } = event.data;
                strictEqual(event.ports.length, 1);
                ok(event.ports[0] instanceof MessagePort);
                strictEqual(event.ports[0], port);
                event.ports[0].close();
                resolve();
            };
        });

        channel.port1.postMessage({ port: transferChannel.port1 }, [transferChannel.port1]);
        await done;
    } finally {
        channel.port1.close();
        channel.port2.close();
        transferChannel.port2.close();
    }
});

Deno.test('webapi: MessagePort postMessage with transfer', async () => {
    const { MessageChannel } = require('node:worker_threads');
    const { port1, port2 } = new MessageChannel();
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = 99.5;
    const result = await new Promise<any>((resolve) => {
        port1.onmessage = (e) => resolve(e.data);
        port2.postMessage({ buf }, [buf]);
    });
    ok(result.buf instanceof ArrayBuffer);
    strictEqual(new Float64Array(result.buf)[0], 99.5);
    port1.close();
    port2.close();
});

Deno.test('webapi: MessagePort close event fires', async () => {
    const { MessageChannel } = require('node:worker_threads');
    const { port1 } = new MessageChannel();
    let closed = false;
    port1.on('close', () => { closed = true; });
    port1.close();
    await new Promise(r => setTimeout(r, 20));
    ok(closed);
});

Deno.test('webapi: MessagePort onmessageerror is settable', () => {
    const { MessagePort } = require('node:worker_threads');
    // MessagePort constructor is internal, but we can test via MessageChannel
    const { MessageChannel: MC } = require('node:worker_threads');
    const { port1 } = new MC();
    port1.onmessageerror = () => {};
    port1.close();
});

Deno.test('webapi: MessagePort start() begins message flow', () => {
    const { MessageChannel } = require('node:worker_threads');
    const { port1, port2 } = new MessageChannel();
    port1.start();
    port2.start();
    port1.close();
    port2.close();
});

Deno.test('webapi: MessagePort ref/unref are callable', () => {
    const { MessageChannel } = require('node:worker_threads');
    const { port1 } = new MessageChannel();
    port1.unref();
    port1.ref();
    port1.close();
});
