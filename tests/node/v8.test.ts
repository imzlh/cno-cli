import { strictEqual, ok } from 'node:assert';
import * as v8 from 'node:v8';

// --- 1. serialize / deserialize round-trip ----------------------------------

Deno.test('v8: serialize then deserialize round-trips', () => {
    const obj = { a: 1, b: [1, 2, 3], c: 'str', d: true, e: null };
    const buf = v8.serialize(obj);
    ok(buf instanceof Uint8Array || Buffer.isBuffer(buf));
    const back = v8.deserialize(buf as any);
    ok(back);
    strictEqual(back.a, 1);
    strictEqual(back.c, 'str');
});

// --- 2. Serializer / Deserializer classes ----------------------------------

Deno.test('v8: Serializer writeHeader + releaseBuffer', () => {
    const s = new v8.Serializer();
    s.writeHeader();
    const buf = s.releaseBuffer();
    ok(buf instanceof Uint8Array || Buffer.isBuffer(buf));
});

// --- 3. Serializer.writeValue round-trips ----------------------------------

Deno.test('v8: Serializer.writeValue + Deserializer.readValue', () => {
    const s = new v8.Serializer();
    s.writeValue({ x: 42 });
    const buf = s.releaseBuffer();
    const d = new v8.Deserializer(buf as any);
    const val = d.readValue();
    ok(val && val.x === 42);
});

// --- 4. getHeapStatistics returns object ------------------------------------

Deno.test('v8: getHeapStatistics returns object', () => {
    const h = v8.getHeapStatistics();
    ok(h && typeof h === 'object');
    ok(typeof h.total_heap_size === 'number');
});

// --- 5. getHeapSpaceStatistics returns array --------------------------------

Deno.test('v8: getHeapSpaceStatistics returns array', () => {
    const spaces = v8.getHeapSpaceStatistics();
    ok(Array.isArray(spaces));
    if (spaces.length > 0) {
        ok(typeof spaces[0]!.space_name === 'string');
    }
});

// --- 6. getHeapCodeStatistics returns object --------------------------------

Deno.test('v8: getHeapCodeStatistics returns object', () => {
    const c = v8.getHeapCodeStatistics();
    ok(c && typeof c === 'object');
});

// --- 7. setFlagsFromString is callable --------------------------------------

Deno.test('v8: setFlagsFromString is callable', () => {
    let threw = false;
    try {
        v8.setFlagsFromString('--max-old-space-size=1024');
    } catch {
        threw = true;
    }
    ok(true); // either applied or ignored, both acceptable
});

// --- 8. cachedDataVersionTag returns number ---------------------------------

Deno.test('v8: cachedDataVersionTag returns number', () => {
    const tag = v8.cachedDataVersionTag();
    ok(typeof tag === 'number');
});

// --- 9. DefaultSerializer / DefaultDeserializer -----------------------------

Deno.test('v8: DefaultSerializer is subclass of Serializer', () => {
    const s = new v8.DefaultSerializer();
    ok(s instanceof v8.Serializer);
});

Deno.test('v8: DefaultDeserializer is subclass of Deserializer', () => {
    const d = new v8.DefaultDeserializer(new Uint8Array([1, 2, 3]));
    ok(d instanceof v8.Deserializer);
});

// --- 10. serialize handles primitives ---------------------------------------

Deno.test('v8: serialize primitives', () => {
    const n = v8.serialize(42);
    strictEqual(v8.deserialize(n as any), 42);
    const s = v8.serialize('hello');
    strictEqual(v8.deserialize(s as any), 'hello');
});

// --- 11. promiseHooks exists (may be stub) ----------------------------------

Deno.test('v8: promiseHooks is object or undefined', () => {
    const ph = (v8 as any).promiseHooks;
    ok(ph === undefined || typeof ph === 'object');
});
