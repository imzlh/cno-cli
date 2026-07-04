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
    const got = await new Promise<any>((resolve) => {
        port2.onmessage = (ev) => resolve(ev.data);
        const ab = new Uint8Array([1, 2, 3]).buffer;
        port1.postMessage({ buf: ab }, [ab]);
    });
    ok(got.buf instanceof ArrayBuffer);
    port1.close();
    port2.close();
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
