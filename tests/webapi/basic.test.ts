import { strictEqual, ok } from 'node:assert';

// ============================================================================
// basic: queueMicrotask / timers / structuredClone / atob / btoa
// ============================================================================

// --- 1. queueMicrotask defers to after current work ------------------------

Deno.test('queueMicrotask: defers after current work', async () => {
    let order = '';
    order += 'a';
    queueMicrotask(() => { order += 'b'; });
    order += 'c';
    await new Promise((r) => setTimeout(r, 10));
    strictEqual(order, 'acb');
});

// --- 2. queueMicrotask passes no args -------------------------------------

Deno.test('queueMicrotask: callback receives no arguments', async () => {
    const args = await new Promise<any[]>((resolve) => {
        queueMicrotask((...a: any[]) => resolve(a));
    });
    strictEqual(args.length, 0);
});

// --- 3. setTimeout fires after delay --------------------------------------

Deno.test('setTimeout: fires after delay', async () => {
    const start = Date.now();
    const elapsed = await new Promise<number>((resolve) => {
        setTimeout(() => resolve(Date.now() - start), 30);
    });
    ok(elapsed >= 25, `elapsed must be >= ~30ms, got ${elapsed}`);
});

// --- 4. setTimeout passes arguments ---------------------------------------

Deno.test('setTimeout: forwards arguments', async () => {
    const args = await new Promise<any[]>((resolve) => {
        setTimeout((a: number, b: string) => resolve([a, b]), 1, 42, 'hi');
    });
    strictEqual(args[0], 42);
    strictEqual(args[1], 'hi');
});

// --- 5. clearTimeout cancels a pending timer ------------------------------

Deno.test('clearTimeout: cancels pending timer', async () => {
    let fired = false;
    const id = setTimeout(() => { fired = true; }, 10);
    clearTimeout(id);
    await new Promise((r) => setTimeout(r, 30));
    ok(!fired, 'cleared timer must not fire');
});

// --- 6. setInterval fires multiple times ----------------------------------

Deno.test('setInterval: fires multiple times', async () => {
    let count = 0;
    const id = setInterval(() => {
        count++;
        if (count >= 3) clearInterval(id);
    }, 5);
    await new Promise((r) => setTimeout(r, 30));
    ok(count >= 3, `expected >= 3 fires, got ${count}`);
});

// --- 7. structuredClone deep clones ---------------------------------------

Deno.test('structuredClone: deep clones nested object', () => {
    const o = { a: { b: [1, 2, 3] } };
    const c = structuredClone(o);
    (o.a.b as number[]).push(4);
    strictEqual(c.a.b.length, 3);
    ok(c !== o);
    ok(c.a !== o.a);
});

// --- 8. structuredClone handles Map/Set -----------------------------------

Deno.test('structuredClone: clones Map and Set', () => {
    const m = new Map([['k', 'v']]);
    const s = new Set([1, 2, 3]);
    const cm = structuredClone(m);
    const cs = structuredClone(s);
    strictEqual(cm.get('k'), 'v');
    ok(cs.has(2));
    ok(cm !== m && cs !== s);
});

// --- 9. structuredClone handles Date --------------------------------------

Deno.test('structuredClone: clones Date', () => {
    const d = new Date(2020, 0, 1);
    const cd = structuredClone(d);
    strictEqual(cd.getTime(), d.getTime());
    ok(cd !== d);
});

// --- 10. structuredClone handles ArrayBuffer -------------------------------

Deno.test('structuredClone: clones ArrayBuffer', () => {
    const ab = new Uint8Array([1, 2, 3]).buffer;
    const cab = structuredClone(ab);
    ok(cab instanceof ArrayBuffer);
    ok(cab !== ab);
    strictEqual(new Uint8Array(cab)[1], 2);
});

// --- 11. atob/btoa round-trip ---------------------------------------------

Deno.test('atob/btoa: round-trip binary-safe', () => {
    const bin = 'Hello, world! 123';
    strictEqual(atob(btoa(bin)), bin);
});

// --- 12. btoa encodes binary ----------------------------------------------

Deno.test('btoa: produces base64', () => {
    ok(btoa('f') === 'Zg==');
    ok(btoa('fo') === 'Zm8=');
    ok(btoa('foo') === 'Zm9v');
});

// --- 13. atob decodes -----------------------------------------------------

Deno.test('atob: decodes base64', () => {
    strictEqual(atob('Zg=='), 'f');
    strictEqual(atob('Zm8='), 'fo');
    strictEqual(atob('Zm9v'), 'foo');
});

// --- 14. structuredClone throws on functions ------------------------------

Deno.test('structuredClone: throws on function', () => {
    let threw = false;
    try { structuredClone(() => {}); } catch { threw = true; }
    ok(threw, 'functions must not be cloneable');
});
