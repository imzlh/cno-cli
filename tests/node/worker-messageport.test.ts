import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import { MessageChannel, MessagePort, receiveMessageOnPort } from 'node:worker_threads';
import { decodeUtf8 } from '../_helpers/bytes.ts';

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
    strictEqual(receiveMessageOnPort(port1), undefined);
    port1.close();
    port2.close();
});

Deno.test('worker_threads upstream: receiveMessageOnPort drains independent pending queues', () => {
    const channels = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
    try {
        strictEqual(receiveMessageOnPort(channels[0].port2), undefined);
        for (const { port2 } of channels) port2.start();

        for (const { port1 } of channels) {
            port1.postMessage({ first: true });
            port1.postMessage({ second: true });
        }

        for (const { port2 } of channels) {
            strictEqual(receiveMessageOnPort(port2)?.message.first, true);
            strictEqual(receiveMessageOnPort(port2)?.message.second, true);
            strictEqual(receiveMessageOnPort(port2), undefined);
        }
    } finally {
        for (const { port1, port2 } of channels) {
            port1.close();
            port2.close();
        }
    }
});

// --- 3. MessagePort.onmessageerror is a settable handler --------------------

Deno.test('worker_threads: MessagePort.onmessageerror is settable', () => {
    const { port1 } = new MessageChannel();
    port1.onmessageerror = () => {};
    ok(typeof port1.onmessageerror === 'function' || port1.onmessageerror === null);
    port1.close();
});

// --- 4. MessagePort.unref is callable ---------------------------------------

Deno.test('worker_threads: MessagePort.ref and unref return undefined', () => {
    const { port1 } = new MessageChannel();
    strictEqual(port1.ref(), undefined);
    strictEqual(port1.unref(), undefined);
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

Deno.test('worker_threads upstream: MessagePort.off removes a message listener', async () => {
    const { port1, port2 } = new MessageChannel();
    try {
        const messages: unknown[] = [];
        const removed = (message: unknown) => messages.push(['removed', message]);
        const kept = (message: unknown) => {
            messages.push(message);
            port1.close();
            port2.close();
        };
        port1.on('message', removed);
        port1.on('message', kept);
        port1.off('message', removed);
        port2.postMessage('Hello World!');
        await new Promise((resolve) => port1.on('close', resolve));
        deepStrictEqual(messages, ['Hello World!']);
    } finally {
        port1.close();
        port2.close();
    }
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

Deno.test('worker_threads: receiveMessageOnPort clones Buffer payloads as Uint8Array', () => {
    const { port1, port2 } = new MessageChannel();
    port2.postMessage(Buffer.from('abc'));
    const msg = receiveMessageOnPort(port1);
    ok(msg);
    ok(msg!.message instanceof Uint8Array);
    ok(!Buffer.isBuffer(msg!.message));
    strictEqual(decodeUtf8(msg!.message as Uint8Array), 'abc');
    port1.close();
    port2.close();
});

Deno.test('worker_threads: postMessage transfer detaches source ArrayBuffer', async () => {
    const { port1, port2 } = new MessageChannel();
    try {
        const buffer = new ArrayBuffer(4);
        new Uint8Array(buffer).set([1, 2, 3, 4]);
        const got = new Promise<Uint8Array>((resolve) => {
            port1.on('message', (value) => resolve(value as Uint8Array));
        });
        port2.postMessage(new Uint8Array(buffer), [buffer]);
        const received = await got;
        ok(received instanceof Uint8Array);
        strictEqual(received.length, 4);
        strictEqual(received[2], 3);
        strictEqual(buffer.byteLength, 0);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test('worker_threads: postMessage transfer preserves typed array view metadata', async () => {
    const { port1, port2 } = new MessageChannel();
    try {
        const buffer = new ArrayBuffer(8);
        const view = new Uint8Array(buffer, 2, 3);
        view.set([5, 6, 7]);
        const got = new Promise<Uint8Array>((resolve) => {
            port1.on('message', (value) => resolve((value as { view: Uint8Array }).view));
        });
        port2.postMessage({ view }, [buffer]);
        const received = await got;
        ok(received instanceof Uint8Array);
        strictEqual(received.byteOffset, 2);
        strictEqual(received.length, 3);
        strictEqual(received[1], 6);
        strictEqual(received.buffer.byteLength, 8);
        strictEqual(buffer.byteLength, 0);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test('worker_threads: postMessage transfer preserves shared backing buffer across views', async () => {
    const { port1, port2 } = new MessageChannel();
    try {
        const buffer = new ArrayBuffer(8);
        const a = new Uint8Array(buffer, 0, 4);
        const b = new Uint8Array(buffer, 2, 4);
        a.set([1, 2, 3, 4]);
        b.set([5, 6], 2);
        const got = new Promise<{ a: Uint8Array; b: Uint8Array }>((resolve) => {
            port1.on('message', (value) => resolve(value as { a: Uint8Array; b: Uint8Array }));
        });
        port2.postMessage({ a, b }, [buffer]);
        const received = await got;
        strictEqual(received.a.buffer, received.b.buffer);
        strictEqual(received.a.byteOffset, 0);
        strictEqual(received.b.byteOffset, 2);
        strictEqual(received.b[3], 6);
        strictEqual(buffer.byteLength, 0);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test('worker_threads: postMessage transfer preserves DataView metadata', async () => {
    const { port1, port2 } = new MessageChannel();
    try {
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer, 2, 4);
        view.setUint16(0, 0xabcd);
        const got = new Promise<DataView>((resolve) => {
            port1.on('message', (value) => resolve((value as { view: DataView }).view));
        });
        port2.postMessage({ view }, [buffer]);
        const received = await got;
        ok(received instanceof DataView);
        strictEqual(received.byteOffset, 2);
        strictEqual(received.byteLength, 4);
        strictEqual(received.getUint16(0), 0xabcd);
        strictEqual(received.buffer.byteLength, 8);
        strictEqual(buffer.byteLength, 0);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test('worker_threads: transfer-only ArrayBuffer detaches without payload reference', async () => {
    const { port1, port2 } = new MessageChannel();
    try {
        const buffer = new ArrayBuffer(4);
        new Uint8Array(buffer).set([1, 2, 3, 4]);
        const got = new Promise<any>((resolve) => {
            port1.on('message', (value) => resolve(value));
        });
        port2.postMessage({ tag: 'buffer-only' }, [buffer]);
        strictEqual(buffer.byteLength, 0);
        const received = await got;
        strictEqual(received.tag, 'buffer-only');
        strictEqual('buffer' in received, false);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test('worker_threads: postMessage preserves shared backing buffer without transfer', async () => {
    const { port1, port2 } = new MessageChannel();
    try {
        const buffer = new ArrayBuffer(8);
        const a = new Uint8Array(buffer, 0, 4);
        const b = new Uint8Array(buffer, 2, 4);
        a.set([1, 2, 3, 4]);
        b.set([5, 6], 2);
        const got = new Promise<{ a: Uint8Array; b: Uint8Array }>((resolve) => {
            port1.on('message', (value) => resolve(value as { a: Uint8Array; b: Uint8Array }));
        });
        port2.postMessage({ a, b });
        const received = await got;
        ok(received.a instanceof Uint8Array);
        ok(received.b instanceof Uint8Array);
        strictEqual(received.a.buffer, received.b.buffer);
        ok(received.a.buffer !== buffer);
        strictEqual(received.a.byteOffset, 0);
        strictEqual(received.b.byteOffset, 2);
        strictEqual(received.b[3], 6);
        strictEqual(buffer.byteLength, 8);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test('worker_threads: ArrayBuffer view is not transferable', () => {
    const { port1, port2 } = new MessageChannel();
    try {
        const buffer = new ArrayBuffer(4);
        const view = new Uint8Array(buffer);
        let threw = false;
        try { port2.postMessage({ view }, [view]); } catch { threw = true; }
        ok(threw, 'typed array views must not be accepted as transfer entries');
        strictEqual(buffer.byteLength, 4);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test('worker_threads: duplicate transfer list throws before detach', () => {
    const { port1, port2 } = new MessageChannel();
    try {
        const buffer = new ArrayBuffer(4);
        let threw = false;
        try { port2.postMessage({ buffer }, [buffer, buffer]); } catch { threw = true; }
        ok(threw, 'duplicate transfer list entries must throw');
        strictEqual(buffer.byteLength, 4);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test('worker_threads: MessagePort without transfer list is rejected', () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    try {
        let threw = false;
        try { main.port2.postMessage({ port: extra.port1 }); } catch { threw = true; }
        ok(threw, 'MessagePort must be listed in transfer list');
        strictEqual(extra.port1.postMessage('still-open'), true);
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port1.close();
        extra.port2.close();
    }
});

Deno.test('worker_threads: duplicate MessagePort transfer throws before detach', () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    try {
        let threw = false;
        try { main.port2.postMessage({ port: extra.port1 }, [extra.port1, extra.port1]); } catch { threw = true; }
        ok(threw, 'duplicate transferred MessagePort must throw');
        strictEqual(extra.port1.postMessage('still-open'), true);
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port1.close();
        extra.port2.close();
    }
});

Deno.test('worker_threads: transferred MessagePort cannot be transferred again', async () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    const moved: MessagePort[] = [];
    try {
        const got = new Promise<void>((resolve) => {
            main.port1.onmessage = (event) => {
                moved.push((event.data as { port: MessagePort }).port);
                resolve();
            };
        });
        main.port2.postMessage({ port: extra.port1 }, [extra.port1]);
        await got;

        let threw = false;
        try { main.port2.postMessage({ port: extra.port1 }, [extra.port1]); } catch { threw = true; }
        ok(threw, 'already transferred source port must not be transferable again');
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port2.close();
        for (const port of moved) port.close();
    }
});

Deno.test('worker_threads: postMessage can transfer a MessagePort', async () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    try {
        const got = new Promise<string>((resolve) => {
            main.port1.on('message', (value) => {
                const transferredPort = (value as { port: MessagePort }).port;
                transferredPort.on('message', (message) => {
                    transferredPort.close();
                    resolve(message as string);
                });
                transferredPort.start();
                extra.port2.postMessage('hello');
            });
        });
        main.port2.postMessage({ port: extra.port1 }, [extra.port1]);
        strictEqual(await got, 'hello');
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port2.close();
    }
});

Deno.test('worker_threads: transfer list MessagePort appears in event.ports without payload reference', async () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    const moved: MessagePort[] = [];
    try {
        const got = new Promise<string>((resolve) => {
            main.port1.onmessage = (event) => {
                strictEqual((event.data as any).tag, 'transfer-only');
                strictEqual(event.ports?.length, 1);
                moved.push(event.ports![0]);
                event.ports![0].onmessage = (message) => resolve(message.data as string);
                extra.port2.postMessage('from-other-end');
            };
        });
        main.port2.postMessage({ tag: 'transfer-only' }, [extra.port1]);
        strictEqual(extra.port1.postMessage('after-transfer'), true);
        strictEqual(await got, 'from-other-end');
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port2.close();
        for (const port of moved) port.close();
    }
});

Deno.test('worker_threads: onmessage event exposes transferred ports in order', async () => {
    const main = new MessageChannel();
    const first = new MessageChannel();
    const second = new MessageChannel();
    const moved: MessagePort[] = [];
    try {
        const got = new Promise<string[]>((resolve) => {
            const replies: string[] = [];
            main.port1.onmessage = (event) => {
                strictEqual(event.ports?.length, 2);
                strictEqual((event.data as any).first, event.ports![0]);
                strictEqual((event.data as any).second, event.ports![1]);
                moved.push(event.ports![0], event.ports![1]);
                event.ports![0].onmessage = (message) => {
                    replies.push(message.data as string);
                    if (replies.length === 2) resolve(replies);
                };
                event.ports![1].onmessage = (message) => {
                    replies.push(message.data as string);
                    if (replies.length === 2) resolve(replies);
                };
                first.port2.postMessage('first');
                second.port2.postMessage('second');
            };
        });
        main.port2.postMessage({ first: first.port1, second: second.port1 }, [first.port1, second.port1]);
        strictEqual((await got).sort().join(','), 'first,second');
    } finally {
        main.port1.close();
        main.port2.close();
        first.port2.close();
        second.port2.close();
        for (const port of moved) port.close();
    }
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

Deno.test('worker_threads: postMessage to closed port returns true without throwing', () => {
    const { port1, port2 } = new MessageChannel();
    port2.close();
    strictEqual(port1.postMessage('to-closed'), true);
    port1.close();
});

Deno.test('worker_threads: MessagePort.start and close return undefined', () => {
    const { port1, port2 } = new MessageChannel();
    strictEqual(port1.start(), undefined);
    strictEqual(port1.close(), undefined);
    port2.close();
});

Deno.test('worker_threads: on("message") receives values after start()', async () => {
    const { port1, port2 } = new MessageChannel();
    try {
        const got = new Promise<number>((resolve) => {
            port1.on('message', (value) => resolve(value as number));
        });
        port1.start();
        port2.postMessage(123);
        strictEqual(await got, 123);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test('worker_threads upstream: MessagePort.on invokes all message listeners in order', async () => {
    const { port1, port2 } = new MessageChannel();
    try {
        const output: string[] = [];
        const done = new Promise<void>((resolve) => {
            port1.on('message', (value) => output.push(value as string));
            port1.on('message', (value) => output.push(`${value as string}:two`));
            port1.on('message', (value) => {
                output.push(`${value as string}:three`);
                resolve();
            });
        });
        port2.postMessage('hi');
        await done;
        strictEqual(output.join(','), 'hi,hi:two,hi:three');
    } finally {
        port1.close();
        port2.close();
    }
});
