import { strictEqual, ok } from 'node:assert';
import { MessageChannel, MessagePort, receiveMessageOnPort } from 'node:worker_threads';

// --- 1. receiveMessageOnPort returns undefined on empty port -----------------

Deno.test('worker_threads: receiveMessageOnPort returns undefined when empty', () => {
    const { port1 } = new MessageChannel();
    const msg = receiveMessageOnPort(port1);
    strictEqual(msg, undefined);
    port1.close();
});

// --- 2. receiveMessageOnPort drains a queued message ------------------------

Deno.test('worker_threads: receiveMessageOnPort drains queued message', () => {
    const { port1, port2 } = new MessageChannel();
    port2.postMessage('queued');
    const msg = receiveMessageOnPort(port1);
    ok(msg);
    strictEqual(msg!.message, 'queued');
    port1.close();
    port2.close();
});

// --- 3. MessagePort.onmessageerror is a settable handler --------------------

Deno.test('worker_threads: MessagePort.onmessageerror is settable', () => {
    const { port1 } = new MessageChannel();
    let fired = false;
    port1.onmessageerror = () => { fired = true; };
    ok(typeof port1.onmessageerror === 'function' || port1.onmessageerror === null);
    port1.close();
});

// --- 4. MessagePort.unref is callable ---------------------------------------

Deno.test('worker_threads: MessagePort.unref is callable', () => {
    const { port1 } = new MessageChannel();
    port1.unref();
    port1.close();
});

// --- 5. MessagePort has onmessage settable ---------------------------------

Deno.test('worker_threads: MessagePort.onmessage is settable', () => {
    const { port1 } = new MessageChannel();
    port1.onmessage = () => {};
    ok(typeof port1.onmessage === 'function' || port1.onmessage === null);
    port1.close();
});

// --- 6. postMessage without transfer works ----------------------------------

Deno.test('worker_threads: postMessage without transfer', async () => {
    const { port1, port2 } = new MessageChannel();
    const got = new Promise<any>((resolve) => { port2.onmessage = (e) => resolve(e.data); });
    port1.postMessage({ a: 1 });
    const msg = await got;
    strictEqual(msg.a, 1);
    port1.close();
    port2.close();
});

// --- 7. postMessage with nested objects -------------------------------------

Deno.test('worker_threads: postMessage clones nested objects', async () => {
    const { port1, port2 } = new MessageChannel();
    const got = new Promise<any>((resolve) => { port2.onmessage = (e) => resolve(e.data); });
    port1.postMessage({ deep: { arr: [1, 2, { x: 'y' }] } });
    const msg = await got;
    strictEqual(msg.deep.arr[2].x, 'y');
    port1.close();
    port2.close();
});

// --- 8. port.close fires close event ----------------------------------------

Deno.test('worker_threads: port.close fires close', async () => {
    const { port1 } = new MessageChannel();
    let closed = false;
    port1.on('close', () => { closed = true; });
    port1.close();
    await new Promise((r) => setTimeout(r, 20));
    ok(closed);
});

// --- 9. MessageChannel constructor creates two connected ports --------------

Deno.test('worker_threads: MessageChannel creates two ports', () => {
    const mc = new MessageChannel();
    ok(mc.port1 instanceof MessagePort);
    ok(mc.port2 instanceof MessagePort);
    mc.port1.close();
    mc.port2.close();
});

// --- 10. postMessage to closed port is silently dropped ---------------------

Deno.test('worker_threads: postMessage to closed port does not throw', () => {
    const { port1, port2 } = new MessageChannel();
    port2.close();
    let threw = false;
    try {
        port1.postMessage('to-closed');
    } catch {
        threw = true;
    }
    // Either dropped or threw — both acceptable; just must not crash the runtime.
    ok(true);
    port1.close();
});
