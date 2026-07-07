import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';
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
    ok(typeof c.code_and_metadata_size === 'number');
    ok(typeof c.bytecode_and_metadata_size === 'number');
});

// --- 7. setFlagsFromString is callable --------------------------------------

Deno.test('v8: setFlagsFromString is callable', () => {
    strictEqual(v8.setFlagsFromString('--max-old-space-size=1024'), undefined);
});

// --- 8. cachedDataVersionTag returns number ---------------------------------

Deno.test('v8: cachedDataVersionTag returns number', () => {
    const tag = v8.cachedDataVersionTag();
    ok(typeof tag === 'number');
    ok(tag > 0);
});

Deno.test('v8: startupSnapshot accepts callbacks and reports non-building runtime', () => {
    strictEqual(v8.startupSnapshot.isBuildingSnapshot(), false);
    strictEqual(v8.startupSnapshot.addSerializeCallback(() => {}, { phase: 'serialize' }), undefined);
    strictEqual(v8.startupSnapshot.addDeserializeCallback(() => {}, { phase: 'deserialize' }), undefined);
    strictEqual(v8.startupSnapshot.setDeserializeMainFunction(() => {}, { phase: 'main' }), undefined);
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

Deno.test('v8: serialize preserves cycles, Map, Set, and BigInt', () => {
    const input: {
        map: Map<string, number>;
        set: Set<number>;
        big: bigint;
        self?: unknown;
    } = {
        map: new Map([['a', 1]]),
        set: new Set([2, 3]),
        big: 123n,
    };
    input.self = input;
    const output = v8.deserialize(v8.serialize(input as any) as any) as typeof input;
    strictEqual(output.self, output);
    ok(output.map instanceof Map);
    strictEqual(output.map.get('a'), 1);
    ok(output.set instanceof Set);
    ok(output.set.has(3));
    strictEqual(output.big, 123n);
});

Deno.test('v8: Deserializer.readHeader pairs with Serializer.writeHeader', () => {
    const serializer = new v8.Serializer();
    serializer.writeHeader();
    serializer.writeValue({ x: 1 });
    const deserializer = new v8.Deserializer(serializer.releaseBuffer() as any);
    deserializer.readHeader();
    strictEqual(deserializer.getWireFormatVersion(), 1);
    deepStrictEqual(deserializer.readValue(), { x: 1 });
});

Deno.test('v8: Deserializer wire format version requires a header first', () => {
    const serializer = new v8.Serializer();
    serializer.writeHeader();
    const deserializer = new v8.Deserializer(serializer.releaseBuffer() as any);
    throws(() => deserializer.getWireFormatVersion(), Error);
    strictEqual(deserializer.readHeader(), true);
    strictEqual(deserializer.getWireFormatVersion(), 1);
});

Deno.test('v8: serialize of function throws clone error', () => {
    let err: Error | null = null;
    try {
        v8.serialize(() => {});
    } catch (error) {
        err = error as Error;
    }
    ok(err instanceof Error);
    ok(/could not be cloned/i.test(err.message));
});

Deno.test('v8: serialize and deserialize preserve typed arrays', () => {
    const input = new Uint16Array([1, 2, 3]);
    const output = v8.deserialize(v8.serialize(input) as any);
    ok(output instanceof Uint16Array);
    strictEqual(output.length, 3);
    strictEqual(output[1], 2);
});

Deno.test('v8: getHeapSpaceStatistics entries expose numeric size fields', () => {
    const spaces = v8.getHeapSpaceStatistics();
    if (spaces.length === 0) return;
    const first = spaces[0]!;
    ok(typeof first.space_name === 'string');
    ok(typeof first.space_size === 'number');
    ok(typeof first.space_used_size === 'number');
    ok(typeof first.space_available_size === 'number');
});

Deno.test('v8: Serializer releaseBuffer can be called repeatedly', () => {
    const serializer = new v8.Serializer();
    serializer.writeHeader();
    ok(serializer.releaseBuffer().byteLength > 0);
    strictEqual(serializer.releaseBuffer().byteLength, 0);
    serializer.writeHeader();
    ok(serializer.releaseBuffer().byteLength > 0);
});

Deno.test('v8: Serializer and Deserializer raw numeric methods round-trip', () => {
    const serializer = new v8.Serializer();
    serializer.writeUint32(0x78563412);
    serializer.writeUint64(0x11223344, 0x55667788);
    serializer.writeDouble(1.5);
    serializer.writeRawBytes(Buffer.from([1, 2, 3]));

    const deserializer = new v8.Deserializer(serializer.releaseBuffer() as any);
    strictEqual(deserializer.readUint32(), 0x78563412);
    deepStrictEqual(deserializer.readUint64(), [0x11223344, 0x55667788]);
    strictEqual(deserializer.readDouble(), 1.5);
    deepStrictEqual([...deserializer.readRawBytes(3)], [1, 2, 3]);
});

Deno.test('v8: Serializer and Deserializer reject non-view raw buffers', () => {
    throws(() => new v8.Deserializer('abc' as unknown as Uint8Array), TypeError);
    throws(() => new v8.Deserializer({} as unknown as Uint8Array), TypeError);
    throws(() => new v8.Deserializer(new ArrayBuffer(8) as unknown as Uint8Array), TypeError);

    const serializer = new v8.Serializer();
    throws(() => serializer.writeRawBytes('abc' as unknown as Uint8Array), TypeError);
    throws(() => serializer.writeRawBytes({} as unknown as Uint8Array), TypeError);
    throws(() => serializer.writeRawBytes(new ArrayBuffer(8) as unknown as Uint8Array), TypeError);
});

Deno.test('v8: Deserializer.readRawBytes validates length and reads remaining bytes', () => {
    const serializer = new v8.Serializer();
    serializer.writeRawBytes(Buffer.from([1, 2, 3]));

    const deserializer = new v8.Deserializer(serializer.releaseBuffer() as any);
    throws(() => deserializer.readRawBytes(-1), Error);
    throws(() => deserializer.readRawBytes(Infinity), Error);
    deepStrictEqual([...deserializer.readRawBytes(undefined as unknown as number)], [1, 2, 3]);
});

Deno.test('v8: invalid serialized data throws while reading header', () => {
    throws(() => v8.deserialize(Buffer.from([1, 2, 3]) as any), Error);
});

Deno.test('v8: setFlagsFromString changes cachedDataVersionTag', () => {
    v8.setFlagsFromString('');
    const before = v8.cachedDataVersionTag();
    v8.setFlagsFromString('--allow_natives_syntax');
    const after = v8.cachedDataVersionTag();
    ok(after !== before);
    v8.setFlagsFromString('');
});
