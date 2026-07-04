import { strictEqual, ok } from 'node:assert';
import { MessageChannel, MessagePort, Worker, parentPort, isMainThread, threadId } from 'node:worker_threads';

// worker_threads: the刁che cases are (1) MessageChannel two-way round-trip,
// (2) postMessage between ports with onmessage, (3) isMainThread/threadId
// contract, (4) Worker + parentPort ping-pong, (5) workerData passthrough.

Deno.test({ name: 'worker_threads: isMainThread is true on main, threadId >= 0', timeout: 10000 }, () => {
    ok(isMainThread, 'must be main thread');
    ok(Number.isInteger(threadId) && threadId >= 0, 'threadId must be a non-negative integer');
});

Deno.test({ name: 'worker_threads: MessageChannel two-way round-trip', timeout: 10000 }, async () => {
    const { port1, port2 } = new MessageChannel();
    const got = await new Promise<any>((resolve, reject) => {
        port2.onmessage = (ev) => resolve(ev.data);
        port2.onerror = reject;
        port1.postMessage({ hello: 'world' });
    });
    strictEqual(got.hello, 'world');
    port1.close();
    port2.close();
});

Deno.test({ name: 'worker_threads: MessagePort echo (reply on same channel)', timeout: 10000 }, async () => {
    const { port1, port2 } = new MessageChannel();
    const reply = new Promise<any>((resolve) => {
        port2.onmessage = (ev) => {
            // echo back with a tag
            port2.postMessage({ ...ev.data, replied: true });
        };
        port1.onmessage = (ev) => resolve(ev.data);
        port1.postMessage({ ping: 1 });
    });
    const r = await reply;
    strictEqual(r.ping, 1);
    ok(r.replied, 'port2 must have tagged the reply');
    port1.close();
    port2.close();
});

Deno.test({ name: 'worker_threads: Worker ping-pong via parentPort', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.onmessage = (event) => {
            parentPort.postMessage({ echo: event.data });
        };
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.postMessage('ping');
        });
        strictEqual(reply.echo, 'ping');
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: workerData is delivered to the worker', timeout: 10000 }, async () => {
    const src = `
        const { parentPort, workerData } = require('node:worker_threads');
        parentPort.postMessage(workerData);
    `;
    const worker = new Worker(src, { eval: true, workerData: { foo: 42 } });
    try {
        const msg: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        strictEqual(msg.foo, 42);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: Worker threadId differs from main', timeout: 10000 }, async () => {
    const src = `
        const { parentPort, threadId, isMainThread } = require('node:worker_threads');
        parentPort.postMessage({ threadId, isMainThread });
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const msg: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        ok(!msg.isMainThread, 'inside worker, isMainThread must be false');
        ok(msg.threadId !== threadId, 'worker threadId must differ from main');
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: parentPort is null on main thread', timeout: 10000 }, () => {
    strictEqual(parentPort, null, 'main thread parentPort must be null');
});
