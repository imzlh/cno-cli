import { deepStrictEqual, notStrictEqual, strictEqual, ok, throws } from 'node:assert';

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

Deno.test('WeakRef: deref remains stable across same-turn promise resolution', async () => {
    const target = { ok: true };
    const ref = new WeakRef(target);
    strictEqual(ref.deref(), target);
    strictEqual(await Promise.resolve(ref.deref()), target);
    throws(() => new WeakRef(null as unknown as object), TypeError);
});

Deno.test('WeakRef: immediate deref keeps temporary targets alive in same job', async () => {
    const ref = new WeakRef({ ok: true });
    strictEqual(ref.deref()?.ok, true);
    strictEqual(await Promise.resolve(ref.deref()?.ok), true);
});

Deno.test('global aliases: window and self point at globalThis', () => {
    strictEqual(globalThis.window, globalThis);
    strictEqual(globalThis.self, globalThis);
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

Deno.test('timers upstream: string callbacks execute in global scope', async () => {
    const global = globalThis as typeof globalThis & {
        timeoutStringValue?: number;
        timeoutStringResolve?: () => void;
        intervalStringValue?: number;
        intervalStringResolve?: () => void;
    };

    try {
        await new Promise<void>((resolve) => {
            global.timeoutStringValue = 0;
            global.timeoutStringResolve = resolve;
            setTimeout('globalThis.timeoutStringValue = 42; globalThis.timeoutStringResolve();', 1);
        });
        strictEqual(global.timeoutStringValue, 42);

        await new Promise<void>((resolve) => {
            global.intervalStringValue = 0;
            global.intervalStringResolve = resolve;
            const id = setInterval(
                'globalThis.intervalStringValue += 10; if (globalThis.intervalStringValue >= 20) globalThis.intervalStringResolve();',
                1,
            );
            Promise.resolve().then(async () => {
                while ((global.intervalStringValue ?? 0) < 20) await new Promise((r) => setTimeout(r, 1));
                clearInterval(id);
            });
        });
        ok((global.intervalStringValue ?? 0) >= 20);
    } finally {
        Reflect.deleteProperty(global, 'timeoutStringValue');
        Reflect.deleteProperty(global, 'timeoutStringResolve');
        Reflect.deleteProperty(global, 'intervalStringValue');
        Reflect.deleteProperty(global, 'intervalStringResolve');
    }
});

Deno.test('timers upstream: callback this and illegal invocation binding', async () => {
    let capturedThis: unknown;
    await new Promise<void>((resolve) => {
        setTimeout(function() {
            capturedThis = this;
            resolve();
        }, 1);
    });
    strictEqual(capturedThis, globalThis);

    await new Promise<void>((resolve) => {
        setTimeout.call(null, () => resolve(), 1);
    });
    await new Promise<void>((resolve) => {
        setTimeout.call(globalThis, () => resolve(), 1);
    });

    for (const thisArg of [0, '', true, false, {}, [], 'foo', () => {}]) {
        throws(() => setTimeout.call(thisArg, () => {}, 1), TypeError);
    }
});

Deno.test('timers upstream: metadata, ToNumber and BigInt validation', () => {
    strictEqual(setTimeout.length, 1);
    strictEqual(setInterval.length, 1);
    strictEqual(clearTimeout.length, 0);
    strictEqual(clearInterval.length, 0);
    strictEqual(clearTimeout.name, 'clearTimeout');
    strictEqual(clearInterval.name, 'clearInterval');
    notStrictEqual(clearTimeout, clearInterval);

    let converted = false;
    clearTimeout({
        valueOf() {
            converted = true;
            return 1;
        },
    } as unknown as number);
    strictEqual(converted, true);

    clearTimeout(undefined);
    clearInterval(2147483647);
    throws(() => setTimeout(() => {}, 1n as unknown as number), TypeError);
    throws(() => clearTimeout(1n as unknown as number), TypeError);
});

Deno.test('timers upstream: timeout ordering and microtask checkpoints', async () => {
    const order: number[] = [];
    await new Promise<void>((resolve) => {
        function push(value: number) {
            order.push(value);
            if (order.length === 6) resolve();
        }

        setTimeout(() => {
            push(1);
            setTimeout(() => push(4));
        });
        setTimeout(() => {
            push(2);
            setTimeout(() => push(5));
        });
        setTimeout(() => {
            push(3);
            setTimeout(() => push(6));
        });
    });
    deepStrictEqual(order, [1, 2, 3, 4, 5, 6]);

    let microtaskOrder = '';
    await new Promise<void>((resolve) => {
        let count = 0;
        setTimeout(() => {
            Promise.resolve().then(() => {
                count++;
                microtaskOrder += 'de';
                if (count === 2) resolve();
            });
        });
        setTimeout(() => {
            count++;
            microtaskOrder += 'no';
            if (count === 2) resolve();
        });
    });
    strictEqual(microtaskOrder, 'deno');
});

Deno.test('timers upstream: nested microtasks run before following timer turns', async () => {
    let order = '';
    await new Promise<void>((resolve) => {
        order += '0';
        setTimeout(() => {
            order += '4';
            setTimeout(() => { order += 'A'; });
            Promise.resolve()
                .then(() => {
                    setTimeout(() => {
                        order += 'B';
                        resolve();
                    });
                })
                .then(() => {
                    order += '5';
                });
        });
        setTimeout(() => { order += '6'; });
        Promise.resolve().then(() => { order += '2'; });
        Promise.resolve().then(() =>
            setTimeout(() => {
                order += '7';
                Promise.resolve()
                    .then(() => { order += '8'; })
                    .then(() => { order += '9'; });
            })
        );
        Promise.resolve().then(() => Promise.resolve().then(() => { order += '3'; }));
        order += '1';
    });
    strictEqual(order, '0123456789AB');
});

Deno.test('timers upstream: queueMicrotask ignores global Date overrides', async () => {
    const OriginalDate = Date;
    try {
        let overrideCalled = false;
        const markOverride = () => {
            overrideCalled = true;
            return 0;
        };
        const DateOverride = () => {
            markOverride();
        };
        globalThis.Date = DateOverride as unknown as DateConstructor;
        globalThis.Date.now = markOverride;
        globalThis.Date.UTC = markOverride;
        globalThis.Date.parse = markOverride;

        await new Promise<void>((resolve) => queueMicrotask(resolve));
        strictEqual(overrideCalled, false);
    } finally {
        globalThis.Date = OriginalDate;
    }
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

Deno.test('structuredClone: clones RegExp source and flags', () => {
    const re = /a+b/gi;
    re.lastIndex = 2;
    const cloned = structuredClone(re);
    ok(cloned instanceof RegExp);
    strictEqual(cloned.source, 'a+b');
    strictEqual(cloned.flags, 'gi');
    strictEqual(cloned.lastIndex, 0);
    ok(cloned !== re);
});

Deno.test('structuredClone: preserves sparse array holes', () => {
    const arr = [1, , 3] as number[];
    const cloned = structuredClone(arr);
    strictEqual(cloned.length, 3);
    strictEqual(0 in cloned, true);
    strictEqual(1 in cloned, false);
    strictEqual(2 in cloned, true);
});

Deno.test('structuredClone: clones class and null-prototype objects as plain objects', () => {
    class Box {
        value = 12;
        read() { return this.value; }
    }
    const boxed = new Box();
    const nullProto = Object.create(null);
    nullProto.label = 'plain';
    const cloned = structuredClone({ boxed, nullProto });
    strictEqual(Object.getPrototypeOf(cloned.boxed), Object.prototype);
    strictEqual(cloned.boxed.value, 12);
    strictEqual('read' in cloned.boxed, false);
    strictEqual(Object.getPrototypeOf(cloned.nullProto), Object.prototype);
    strictEqual(cloned.nullProto.label, 'plain');
});

Deno.test('structuredClone: ignores symbol-keyed properties and rejects symbol values', () => {
    const key = Symbol('key');
    const value = { regular: 1 };
    Object.defineProperty(value, key, { value: 2, enumerable: true });
    const cloned = structuredClone(value);
    strictEqual(cloned.regular, 1);
    strictEqual(Object.getOwnPropertySymbols(cloned).length, 0);

    let threw = false;
    try { structuredClone({ value: Symbol('value') }); } catch { threw = true; }
    ok(threw, 'symbol values must not be cloneable');
});

Deno.test('structuredClone: clones boxed primitives without custom properties', () => {
    const number = new Number(7) as Number & { extra?: string };
    number.extra = 'drop';
    const string = new String('abc');
    const boolean = new Boolean(true);
    const cloned = structuredClone({ number, string, boolean });
    ok(cloned.number instanceof Number);
    ok(cloned.string instanceof String);
    ok(cloned.boolean instanceof Boolean);
    strictEqual(cloned.number.valueOf(), 7);
    strictEqual(cloned.string.valueOf(), 'abc');
    strictEqual(cloned.boolean.valueOf(), true);
    strictEqual('extra' in cloned.number, false);
});

// --- 10. structuredClone handles ArrayBuffer -------------------------------

Deno.test('structuredClone: clones ArrayBuffer', () => {
    const ab = new Uint8Array([1, 2, 3]).buffer;
    const cab = structuredClone(ab);
    ok(cab instanceof ArrayBuffer);
    ok(cab !== ab);
    strictEqual(new Uint8Array(cab)[1], 2);
});

Deno.test('structuredClone: preserves ArrayBuffer identity without transfer', () => {
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([1, 2, 3, 4]);
    const cloned = structuredClone({ a: ab, b: ab });
    ok(cloned.a instanceof ArrayBuffer);
    strictEqual(cloned.a, cloned.b);
    ok(cloned.a !== ab);
    strictEqual(new Uint8Array(cloned.a)[2], 3);
    strictEqual(ab.byteLength, 4);
});

Deno.test('structuredClone: preserves shared backing buffer across views without transfer', () => {
    const ab = new ArrayBuffer(8);
    const a = new Uint8Array(ab, 0, 4);
    const b = new Uint8Array(ab, 2, 4);
    a.set([1, 2, 3, 4]);
    b.set([5, 6], 2);
    const cloned = structuredClone({ a, b });
    ok(cloned.a instanceof Uint8Array);
    ok(cloned.b instanceof Uint8Array);
    strictEqual(cloned.a.buffer, cloned.b.buffer);
    ok(cloned.a.buffer !== ab);
    strictEqual(cloned.a.byteOffset, 0);
    strictEqual(cloned.b.byteOffset, 2);
    strictEqual(cloned.b[3], 6);
    strictEqual(ab.byteLength, 8);
});

Deno.test('structuredClone: transfer detaches ArrayBuffer and preserves typed view', () => {
    const ab = new ArrayBuffer(8);
    const view = new Uint8Array(ab, 2, 3);
    view.set([7, 8, 9]);
    const cloned = structuredClone({ view }, { transfer: [ab] });
    ok(cloned.view instanceof Uint8Array);
    strictEqual(cloned.view.byteOffset, 2);
    strictEqual(cloned.view.length, 3);
    strictEqual(cloned.view[1], 8);
    strictEqual(cloned.view.buffer.byteLength, 8);
    strictEqual(ab.byteLength, 0);
});

Deno.test('structuredClone: transfer preserves BigInt typed arrays', () => {
    const ab = new ArrayBuffer(16);
    const view = new BigInt64Array(ab);
    view[0] = -12n;
    view[1] = 34n;
    const cloned = structuredClone({ view }, { transfer: [ab] });
    ok(cloned.view instanceof BigInt64Array);
    strictEqual(cloned.view.length, 2);
    strictEqual(cloned.view[0], -12n);
    strictEqual(cloned.view[1], 34n);
    strictEqual(ab.byteLength, 0);
});

Deno.test('structuredClone: transfer preserves shared backing buffer across views', () => {
    const ab = new ArrayBuffer(8);
    const a = new Uint8Array(ab, 0, 4);
    const b = new Uint8Array(ab, 2, 4);
    a.set([1, 2, 3, 4]);
    b.set([5, 6], 2);
    const cloned = structuredClone({ a, b }, { transfer: [ab] });
    ok(cloned.a instanceof Uint8Array);
    ok(cloned.b instanceof Uint8Array);
    strictEqual(cloned.a.buffer, cloned.b.buffer);
    strictEqual(cloned.a.byteOffset, 0);
    strictEqual(cloned.b.byteOffset, 2);
    strictEqual(cloned.b[3], 6);
    strictEqual(ab.byteLength, 0);
});

Deno.test('structuredClone: transfer preserves DataView metadata', () => {
    const ab = new ArrayBuffer(8);
    const view = new DataView(ab, 2, 4);
    view.setUint16(0, 0x1234);
    const cloned = structuredClone({ view }, { transfer: [ab] });
    ok(cloned.view instanceof DataView);
    strictEqual(cloned.view.byteOffset, 2);
    strictEqual(cloned.view.byteLength, 4);
    strictEqual(cloned.view.getUint16(0), 0x1234);
    strictEqual(cloned.view.buffer.byteLength, 8);
    strictEqual(ab.byteLength, 0);
});

Deno.test('structuredClone: transfer list buffer detaches even when not in payload', () => {
    const ab = new ArrayBuffer(4);
    const cloned = structuredClone({ ok: true }, { transfer: [ab] });
    ok(cloned.ok);
    strictEqual(ab.byteLength, 0);
});

Deno.test('structuredClone: ArrayBuffer view is not transferable', () => {
    const ab = new ArrayBuffer(4);
    const view = new Uint8Array(ab);
    let threw = false;
    try { structuredClone({ view }, { transfer: [view as unknown as Transferable] }); } catch { threw = true; }
    ok(threw, 'typed array views must not be accepted as transfer entries');
    strictEqual(ab.byteLength, 4);
});

Deno.test('structuredClone: SharedArrayBuffer is cloneable but not transferable', () => {
    const sab = new SharedArrayBuffer(4);
    new Uint8Array(sab)[0] = 77;
    const cloned = structuredClone({ sab });
    ok(cloned.sab instanceof SharedArrayBuffer);
    strictEqual(new Uint8Array(cloned.sab)[0], 77);
    let threw = false;
    try { structuredClone({ sab }, { transfer: [sab as unknown as Transferable] }); } catch { threw = true; }
    ok(threw, 'SharedArrayBuffer must not be accepted as a transfer entry');
});

Deno.test('structuredClone: transfers buffers nested in Map and Set', () => {
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([3, 4, 5, 6]);
    const map = new Map([['buf', ab]]);
    const set = new Set([ab]);
    const cloned = structuredClone({ map, set }, { transfer: [ab] });
    const mapBuffer = cloned.map.get('buf') as ArrayBuffer;
    const [setBuffer] = cloned.set as Set<ArrayBuffer>;
    ok(mapBuffer instanceof ArrayBuffer);
    strictEqual(mapBuffer, setBuffer);
    strictEqual(new Uint8Array(mapBuffer)[2], 5);
    strictEqual(ab.byteLength, 0);
});

Deno.test('structuredClone: transfers ArrayBuffer used as Map key', () => {
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([6, 7, 8, 9]);
    const map = new Map([[ab, { tag: 'keyed' }]]);
    const cloned = structuredClone({ map, ref: ab }, { transfer: [ab] });
    const [key] = cloned.map.keys() as IterableIterator<ArrayBuffer>;
    ok(key instanceof ArrayBuffer);
    strictEqual(key, cloned.ref);
    strictEqual(new Uint8Array(key)[0], 6);
    strictEqual(ab.byteLength, 0);
});

Deno.test('structuredClone upstream: transfers MessagePort through self.structuredClone', async () => {
    const original = ['hello world'];
    const channel = new MessageChannel();
    const [arrayCloned, portTransferred] = self.structuredClone(
        [original, channel.port2] as [string[], MessagePort],
        { transfer: [channel.port2] },
    );

    ok(arrayCloned !== original);
    deepStrictEqual(arrayCloned, original);
    ok(portTransferred instanceof MessagePort);
    throws(() => channel.port2.postMessage('after-transfer'), { name: 'InvalidStateError' });

    const received = new Promise((resolve) => {
        portTransferred.onmessage = (event) => resolve(event.data);
    });
    channel.port1.postMessage('1');
    strictEqual(await received, '1');
    channel.port1.close();
    portTransferred.close();
});

Deno.test('structuredClone upstream: DataCloneError messages for invalid and detached transfer list entries', () => {
    const sab = new SharedArrayBuffer(1024);
    throws(() => {
        structuredClone(sab, { transfer: [sab as unknown as Transferable] });
    }, { name: 'DataCloneError', message: 'Value not transferable' });

    const detached = new ArrayBuffer(1);
    structuredClone(detached, { transfer: [detached] });
    throws(() => {
        structuredClone(detached, { transfer: [detached] });
    }, { name: 'DataCloneError', message: 'ArrayBuffer at index 0 is already detached' });

    const zeroLength = new ArrayBuffer(0);
    throws(() => {
        structuredClone([zeroLength, detached], { transfer: [zeroLength, detached] });
    }, { name: 'DataCloneError', message: 'ArrayBuffer at index 1 is already detached' });

    structuredClone(zeroLength, { transfer: [zeroLength] });
});

Deno.test('structuredClone: preserves circular references', () => {
    const value: { name: string; self?: unknown; list?: unknown[] } = { name: 'root' };
    value.self = value;
    value.list = [value];
    const cloned = structuredClone(value);
    strictEqual(cloned.name, 'root');
    strictEqual(cloned.self, cloned);
    strictEqual(cloned.list![0], cloned);
});

Deno.test('structuredClone: clones Error standard fields only', () => {
    const error = new TypeError('bad input');
    (error as any).code = 'ERR_TEST';
    (error as any).cause = { reason: 'nested' };
    const cloned = structuredClone(error);
    ok(cloned instanceof TypeError);
    strictEqual(cloned.name, 'TypeError');
    strictEqual(cloned.message, 'bad input');
    strictEqual((cloned as any).code, undefined);
    strictEqual((cloned as any).cause.reason, 'nested');
    ok((cloned as any).cause !== (error as any).cause);
    ok(cloned !== error);
});

Deno.test('structuredClone: unsupported objects throw DataCloneError', () => {
    for (const value of [new WeakMap(), new WeakSet(), Promise.resolve(1)]) {
        let threw = false;
        try { structuredClone(value); } catch (error) {
            threw = true;
            strictEqual((error as Error).name, 'DataCloneError');
        }
        ok(threw, `${Object.prototype.toString.call(value)} must not be cloneable`);
    }
});

Deno.test('structuredClone: duplicate transfer list throws before detach', () => {
    const ab = new ArrayBuffer(4);
    let threw = false;
    try { structuredClone({ ab }, { transfer: [ab, ab] }); } catch { threw = true; }
    ok(threw, 'duplicate transfer list entries must throw');
    strictEqual(ab.byteLength, 4);
});

Deno.test('structuredClone: invalid transfer list entry throws before detach', () => {
    const ab = new ArrayBuffer(4);
    let threw = false;
    try { structuredClone({ ab }, { transfer: [ab, {} as Transferable] }); } catch { threw = true; }
    ok(threw, 'invalid transfer list entries must throw');
    strictEqual(ab.byteLength, 4);
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
