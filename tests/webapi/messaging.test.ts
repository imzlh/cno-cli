import { strictEqual, ok } from 'node:assert';

// ============================================================================
// MessageChannel / MessagePort
// ============================================================================

// --- 1. MessageChannel creates two connected ports ------------------------

Deno.test('MessageChannel: two ports are connected', async () => {
    const { port1, port2 } = new MessageChannel();
    const got = await new Promise<any>((resolve) => {
        port2.onmessage = (ev) => resolve(ev.data);
        port1.postMessage('ping');
    });
    strictEqual(got, 'ping');
    port1.close();
    port2.close();
});

// --- 2. two-way messaging -------------------------------------------------

Deno.test('MessageChannel: two-way messaging', async () => {
    const { port1, port2 } = new MessageChannel();
    const reply = new Promise<any>((resolve) => {
        port1.onmessage = (ev) => resolve(ev.data);
        port2.onmessage = (ev) => port2.postMessage({ echo: ev.data });
        port1.postMessage('hi');
    });
    const r = await reply;
    strictEqual(r.echo, 'hi');
    port1.close();
    port2.close();
});

// --- 3. postMessage with array + object -----------------------------------

Deno.test('MessageChannel: postMessage structured-clones objects', async () => {
    const { port1, port2 } = new MessageChannel();
    const got = await new Promise<any>((resolve) => {
        port2.onmessage = (ev) => resolve(ev.data);
        port1.postMessage({ a: [1, 2, 3], b: { nested: true } });
    });
    strictEqual(got.a.length, 3);
    ok(got.b.nested);
    port1.close();
    port2.close();
});

// --- 4. onmessage vs addEventListener both work ---------------------------

Deno.test('MessageChannel: onmessage and addEventListener both fire', async () => {
    const { port1, port2 } = new MessageChannel();
    let viaOn = 0, viaAdd = 0;
    port2.onmessage = () => { viaOn++; };
    port2.addEventListener('message', () => { viaAdd++; });
    port1.postMessage('x');
    await new Promise((r) => setTimeout(r, 10));
    strictEqual(viaOn, 1);
    strictEqual(viaAdd, 1);
    port1.close();
    port2.close();
});

// --- 5. close() stops delivery --------------------------------------------

Deno.test('MessageChannel: close stops delivery', async () => {
    const { port1, port2 } = new MessageChannel();
    let count = 0;
    port2.onmessage = () => { count++; };
    port1.postMessage('a');
    await new Promise((r) => setTimeout(r, 10));
    port1.close();
    port2.close();
    // After close, further posts throw
    let threw = false;
    try { port1.postMessage('b'); } catch { threw = true; }
    ok(threw, 'postMessage on closed port must throw');
    strictEqual(count, 1);
});

// --- 6. start() flushes queued messages -----------------------------------

Deno.test('MessageChannel: start flushes queued messages', async () => {
    const { port1, port2 } = new MessageChannel();
    let got: any = null;
    // post before onmessage is set; start() should still deliver
    port1.postMessage('queued');
    port2.onmessage = (ev) => { got = ev.data; };
    port2.start();
    await new Promise((r) => setTimeout(r, 10));
    strictEqual(got, 'queued');
    port1.close();
    port2.close();
});

// --- 7. postMessage with transfer list ------------------------------------

Deno.test('MessageChannel: postMessage with transfer list', async () => {
    const { port1, port2 } = new MessageChannel();
    const ab = new Uint8Array([1, 2, 3]).buffer;
    const got = await new Promise<any>((resolve) => {
        port2.onmessage = (ev) => resolve(ev.data);
        port1.postMessage({ buf: ab }, [ab]);
    });
    ok(got.buf instanceof ArrayBuffer);
    strictEqual(new Uint8Array(got.buf)[2], 3);
    strictEqual(ab.byteLength, 0);
    port1.close();
    port2.close();
});

Deno.test('MessageChannel: postMessage accepts transfer options object', async () => {
    const { port1, port2 } = new MessageChannel();
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([9, 8, 7, 6]);
    try {
        const got = new Promise<any>((resolve) => {
            port2.onmessage = (ev) => resolve(ev.data);
        });
        port1.postMessage({ buf: ab }, { transfer: [ab] });
        const data = await got;
        ok(data.buf instanceof ArrayBuffer);
        strictEqual(new Uint8Array(data.buf)[1], 8);
        strictEqual(ab.byteLength, 0);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test('MessageChannel: transfer-only ArrayBuffer detaches without payload reference', async () => {
    const { port1, port2 } = new MessageChannel();
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([1, 2, 3, 4]);
    try {
        const got = new Promise<any>((resolve) => {
            port2.onmessage = (ev) => resolve(ev.data);
        });
        port1.postMessage({ tag: 'buffer-only' }, [ab]);
        strictEqual(ab.byteLength, 0);
        const data = await got;
        strictEqual(data.tag, 'buffer-only');
        strictEqual('buffer' in data, false);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test('MessageChannel: postMessage preserves shared backing buffer without transfer', async () => {
    const { port1, port2 } = new MessageChannel();
    const ab = new ArrayBuffer(8);
    const a = new Uint8Array(ab, 0, 4);
    const b = new Uint8Array(ab, 2, 4);
    a.set([1, 2, 3, 4]);
    b.set([5, 6], 2);
    try {
        const got = new Promise<any>((resolve) => {
            port2.onmessage = (ev) => resolve(ev.data);
        });
        port1.postMessage({ a, b });
        const data = await got;
        ok(data.a instanceof Uint8Array);
        ok(data.b instanceof Uint8Array);
        strictEqual(data.a.buffer, data.b.buffer);
        ok(data.a.buffer !== ab);
        strictEqual(data.a.byteOffset, 0);
        strictEqual(data.b.byteOffset, 2);
        strictEqual(data.b[3], 6);
        strictEqual(ab.byteLength, 8);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test('MessageChannel: transferring MessagePort moves the endpoint', async () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    let moved: MessagePort | null = null;
    try {
        const got = new Promise<string>((resolve) => {
            main.port2.onmessage = (ev) => {
                moved = ev.data.port;
                ok(moved instanceof MessagePort);
                moved.onmessage = (message) => resolve(message.data);
                extra.port2.postMessage('hello');
            };
        });
        main.port1.postMessage({ port: extra.port1 }, [extra.port1]);
        strictEqual(await got, 'hello');
        let threw = false;
        try { extra.port1.postMessage('after-transfer'); } catch { threw = true; }
        ok(threw, 'transferred source port must be detached');
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port2.close();
        moved?.close();
    }
});

Deno.test('MessageChannel: transfer options object can move MessagePort', async () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    let moved: MessagePort | null = null;
    try {
        const got = new Promise<string>((resolve) => {
            main.port2.onmessage = (ev) => {
                moved = ev.data.port;
                moved.onmessage = (message) => resolve(message.data);
                extra.port2.postMessage('from-options');
            };
        });
        main.port1.postMessage({ port: extra.port1 }, { transfer: [extra.port1] });
        strictEqual(await got, 'from-options');
        let threw = false;
        try { extra.port1.postMessage('after-transfer'); } catch { threw = true; }
        ok(threw, 'source port must be detached after options transfer');
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port2.close();
        moved?.close();
    }
});

Deno.test('MessageChannel: transferred MessagePort payload matches event ports entry', async () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    let moved: MessagePort | null = null;
    try {
        const got = new Promise<void>((resolve) => {
            main.port2.onmessage = (event) => {
                strictEqual(event.ports.length, 1);
                strictEqual(event.data.port, event.ports[0]);
                ok(event.ports[0] instanceof MessagePort);
                moved = event.ports[0];
                resolve();
            };
        });
        main.port1.postMessage({ port: extra.port1 }, [extra.port1]);
        await got;
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port2.close();
        moved?.close();
    }
});

Deno.test('MessageChannel: transfer list MessagePort appears in event.ports without payload reference', async () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    let moved: MessagePort | null = null;
    try {
        const got = new Promise<string>((resolve) => {
            main.port2.onmessage = (event) => {
                strictEqual(event.data.tag, 'transfer-only');
                strictEqual(event.ports.length, 1);
                moved = event.ports[0];
                ok(moved instanceof MessagePort);
                moved.onmessage = (message) => resolve(message.data);
                extra.port2.postMessage('from-other-end');
            };
        });
        main.port1.postMessage({ tag: 'transfer-only' }, [extra.port1]);
        let threw = false;
        try { extra.port1.postMessage('after-transfer'); } catch { threw = true; }
        ok(threw, 'source port must be detached even when only listed in transfer');
        strictEqual(await got, 'from-other-end');
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port2.close();
        moved?.close();
    }
});

Deno.test('MessageChannel: transferring multiple MessagePorts preserves event.ports order', async () => {
    const main = new MessageChannel();
    const first = new MessageChannel();
    const second = new MessageChannel();
    const moved: MessagePort[] = [];
    try {
        const got = new Promise<string[]>((resolve) => {
            const replies: string[] = [];
            main.port2.onmessage = (event) => {
                strictEqual(event.ports.length, 2);
                strictEqual(event.data.first, event.ports[0]);
                strictEqual(event.data.second, event.ports[1]);
                moved.push(event.ports[0], event.ports[1]);
                event.ports[0].onmessage = (message) => {
                    replies.push(message.data);
                    if (replies.length === 2) resolve(replies);
                };
                event.ports[1].onmessage = (message) => {
                    replies.push(message.data);
                    if (replies.length === 2) resolve(replies);
                };
                first.port2.postMessage('first');
                second.port2.postMessage('second');
            };
        });
        main.port1.postMessage({ first: first.port1, second: second.port1 }, [first.port1, second.port1]);
        deepStrictEqual((await got).sort(), ['first', 'second']);
    } finally {
        main.port1.close();
        main.port2.close();
        first.port2.close();
        second.port2.close();
        for (const port of moved) port.close();
    }
});

Deno.test('MessageChannel: queued transfer keeps MessagePort in event.ports', async () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    let moved: MessagePort | null = null;
    try {
        main.port1.postMessage('queued-before-transfer');
        main.port1.postMessage({ port: extra.port1 }, [extra.port1]);
        const got = new Promise<string>((resolve) => {
            main.port2.addEventListener('message', (event) => {
                if (!event.ports.length) return;
                moved = event.ports[0];
                moved.onmessage = (message) => resolve(message.data);
                extra.port2.postMessage('queued-port');
            });
        });
        strictEqual(await got, 'queued-port');
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port2.close();
        moved?.close();
    }
});

Deno.test('MessageChannel: MessagePort without transfer list is rejected', () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    try {
        let threw = false;
        try { main.port1.postMessage({ port: extra.port1 }); } catch { threw = true; }
        ok(threw, 'MessagePort must be listed in transfer list');
        extra.port1.postMessage('still-open');
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port1.close();
        extra.port2.close();
    }
});

Deno.test('MessageChannel: duplicate MessagePort transfer throws before detach', () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    try {
        let threw = false;
        try { main.port1.postMessage({ port: extra.port1 }, [extra.port1, extra.port1]); } catch { threw = true; }
        ok(threw, 'duplicate transferred MessagePort must throw');
        extra.port1.postMessage('still-open');
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port1.close();
        extra.port2.close();
    }
});

Deno.test('MessageChannel: transferred MessagePort cannot be transferred again', async () => {
    const main = new MessageChannel();
    const extra = new MessageChannel();
    let moved: MessagePort | null = null;
    try {
        const got = new Promise<void>((resolve) => {
            main.port2.onmessage = (event) => {
                moved = event.data.port;
                resolve();
            };
        });
        main.port1.postMessage({ port: extra.port1 }, [extra.port1]);
        await got;

        let threw = false;
        try { main.port1.postMessage({ port: extra.port1 }, [extra.port1]); } catch { threw = true; }
        ok(threw, 'already transferred source port must not be transferable again');
    } finally {
        main.port1.close();
        main.port2.close();
        extra.port2.close();
        moved?.close();
    }
});

// --- 8. MessagePort extends EventTarget ----------------------------------

Deno.test('MessagePort is an EventTarget', () => {
    const { port1 } = new MessageChannel();
    ok(port1 instanceof EventTarget);
    port1.close();
});

// --- 9. multiple messages are delivered in order -------------------------

Deno.test('MessageChannel: messages delivered in order', async () => {
    const { port1, port2 } = new MessageChannel();
    const out: number[] = [];
    port2.onmessage = (ev) => out.push(ev.data);
    for (let i = 0; i < 5; i++) port1.postMessage(i);
    await new Promise((r) => setTimeout(r, 20));
    deepStrictEqual(out, [0, 1, 2, 3, 4]);
    port1.close();
    port2.close();
});

function deepStrictEqual(a: unknown, b: unknown) {
    strictEqual(JSON.stringify(a), JSON.stringify(b));
}
