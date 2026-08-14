/*
 * structuredClone tag-based dispatch: fidelity guards.
 *
 * WHY THIS FILE EXISTS
 * `cloneValue` used to identify a value's type by *calling* prototype accessors and
 * catching the TypeError -- five `valueOf` probes in `cloneBoxedPrimitive`, plus
 * `isSharedArrayBuffer` and `isArrayBufferView`. Seven caught exceptions per ordinary
 * object. In QuickJS a caught throw costs ~13-48us, which measured 0.44ms per object:
 * cloning an array of 2000 plain objects took ~1018ms against node's ~1ms.
 *
 * The fix routes on `Object.prototype.toString`, which reads internal slots. That is
 * ~19x cheaper, and it is also where a naive implementation silently breaks, because
 * the tag is NOT trustworthy on its own:
 *
 *   1. `Symbol.toStringTag` is user-settable. `{[Symbol.toStringTag]:'Map'}` reports
 *      `[object Map]` while being an ordinary object. Worse, node NEVER reads
 *      @@toStringTag at all -- measured: a spoofed tag *getter* records zero invocations
 *      and a *throwing* tag getter does not surface. So the guard has to be
 *      `Symbol.toStringTag in value` (a [[HasProperty]], which does not run getters),
 *      with `toString` called ONLY when that is false.
 *   2. Cross-realm objects fail `instanceof` but must still clone. They inherit
 *      @@toStringTag from their own realm's prototypes, so the gate routes them to the
 *      slot-based `engine.*` predicates.
 *   3. A view whose prototype chain has been severed from @@toStringTag reports
 *      `[object Object]` yet is still a real view. Measured: node clones it as a real
 *      Uint8Array. A pure tag test gets this wrong; `ArrayBuffer.isView` gets it right.
 *
 * WHAT IS ASSERTED, AND AGAINST WHAT
 * Every expectation below was measured against node v24.18.0 on the same machine and
 * matches it. The values are node's answers, not this implementation's.
 *
 * TWO ENTRY POINTS, DELIBERATELY
 * `globalThis.structuredClone` is installed by `cno/src/webapi/basic.ts`, which is
 * esbuild-bundled into cno.exe -- so it carries a BAKED copy of this module and does not
 * observe edits to the source until a rebuild. The direct import below loads
 * `cno/src/node/_internal/structured-clone.ts` from the working tree, so it exercises the
 * live source today. Both are checked: if they ever disagree, the binary is stale rather
 * than the logic being wrong, and `assertBothAgree` says so in the failure message.
 */
import { strictEqual, deepStrictEqual, ok, throws } from 'node:assert';
import { structuredCloneWithTransfer } from '../../cno/src/node/_internal/structured-clone.ts';

type CloneFn = <T>(value: T) => T;

/** The live working-tree source. */
const cloneSource: CloneFn = (value) => structuredCloneWithTransfer(value);
/** The public global (BAKED into cno.exe; refreshed only by a rebuild). */
const cloneGlobal: CloneFn = (value) => structuredClone(value);

const ENTRIES: ReadonlyArray<readonly [string, CloneFn]> = [
    ['source', cloneSource],
    ['global', cloneGlobal],
];

/**
 * Run `probe` through both entry points and require an identical result from each.
 * `probe` must return a JSON-comparable summary so a mismatch prints usefully.
 */
function assertBothAgree(what: string, probe: (clone: CloneFn) => unknown): void {
    const results = ENTRIES.map(([name, fn]) => {
        try {
            return [name, JSON.stringify(probe(fn))] as const;
        } catch (e) {
            return [name, `THREW ${(e as Error).name}: ${(e as Error).message}`] as const;
        }
    });
    const [[, first], [, second]] = results;
    strictEqual(
        second,
        first,
        `${what}: the baked global and the working-tree source disagree, which means the ` +
        `binary predates the source (rebuild) or the dispatch changed behaviour.\n` +
        results.map(([n, r]) => `  ${n}: ${r}`).join('\n'),
    );
}

const tagOf = (v: unknown): string => Object.prototype.toString.call(v);

// --- 1. @@toStringTag spoof: a plain object must NOT become a real builtin ----
// The whole risk of tag dispatch in one case. Node's answer: it stays an ordinary
// object, keeps its own properties, and gains no Map behaviour.

Deno.test('structuredClone: @@toStringTag spoof does not fabricate a Map', () => {
    for (const [name, clone] of ENTRIES) {
        const spoof = { [Symbol.toStringTag]: 'Map', real: 1 };
        const out = clone(spoof) as Record<string, unknown> & { get?: unknown };
        strictEqual(out instanceof Map, false, `${name}: must not become a real Map`);
        strictEqual(typeof out.get, 'undefined', `${name}: must not gain Map.get`);
        strictEqual(out.real, 1, `${name}: own data must survive`);
        // The spoofed tag does not even survive: it is a SYMBOL key, and structured clone
        // skips symbol keys. So the clone reports `[object Object]`. Node: identical.
        strictEqual(tagOf(out), '[object Object]', `${name}: the spoofed tag must not be copied`);
        strictEqual(
            Object.getOwnPropertySymbols(out).length,
            0,
            `${name}: no symbol keys may survive the clone`,
        );
    }
    assertBothAgree('spoof Map', (clone) => {
        const out = clone({ [Symbol.toStringTag]: 'Map', real: 1 }) as Record<string, unknown>;
        return { isMap: out instanceof Map, real: out.real, tag: tagOf(out) };
    });
});

Deno.test('structuredClone: @@toStringTag spoof does not fabricate a boxed Number or a view', () => {
    for (const [name, clone] of ENTRIES) {
        const num = clone({ [Symbol.toStringTag]: 'Number', real: 2 }) as Record<string, unknown>;
        strictEqual(typeof num, 'object', `${name}: stays an object`);
        strictEqual(num.real, 2, `${name}: own data survives the Number spoof`);

        const view = clone({ [Symbol.toStringTag]: 'Uint8Array', real: 3 }) as Record<string, unknown>;
        strictEqual(view instanceof Uint8Array, false, `${name}: must not become a typed array`);
        strictEqual(view.real, 3, `${name}: own data survives the Uint8Array spoof`);

        const buf = clone({ [Symbol.toStringTag]: 'ArrayBuffer', real: 4 }) as Record<string, unknown>;
        strictEqual(buf instanceof ArrayBuffer, false, `${name}: must not become an ArrayBuffer`);
        strictEqual(buf.real, 4, `${name}: own data survives the ArrayBuffer spoof`);
    }
});

Deno.test('structuredClone: a REAL Map tagged as Object is still cloned as a Map', () => {
    // The spoof in the other direction. If dispatch trusted the tag, this Map would be
    // flattened to `{}` and its entries lost. Node keeps it a Map.
    for (const [name, clone] of ENTRIES) {
        const map = new Map<string, string>([['k', 'v']]);
        Object.defineProperty(map, Symbol.toStringTag, { value: 'Object', configurable: true });
        const out = clone(map);
        ok(out instanceof Map, `${name}: must remain a real Map`);
        strictEqual(out.size, 1, `${name}: entries must survive`);
        strictEqual(out.get('k'), 'v', `${name}: the entry must be intact`);
    }
});

Deno.test('structuredClone: a REAL Date tagged as Object keeps its time value', () => {
    for (const [name, clone] of ENTRIES) {
        const date = new Date(5000);
        Object.defineProperty(date, Symbol.toStringTag, { value: 'Object', configurable: true });
        const out = clone(date);
        ok(out instanceof Date, `${name}: must remain a real Date`);
        strictEqual(out.getTime(), 5000, `${name}: the time value must survive`);
    }
});

Deno.test('structuredClone: a @@toStringTag getter is never invoked, and never rethrown', () => {
    // Node reads @@toStringTag zero times (measured). The gate must be [[HasProperty]],
    // not a Get, or a side-effecting getter would fire and a throwing one would escape.
    for (const [name, clone] of ENTRIES) {
        let hits = 0;
        const counted: Record<string, unknown> = { real: 5 };
        Object.defineProperty(counted, Symbol.toStringTag, {
            get() { hits++; return 'Map'; },
            configurable: true,
        });
        const out = clone(counted) as Record<string, unknown>;
        strictEqual(hits, 0, `${name}: the @@toStringTag getter must not be invoked (node: 0)`);
        strictEqual(out.real, 5, `${name}: own data must survive`);

        const boom: Record<string, unknown> = { real: 6 };
        Object.defineProperty(boom, Symbol.toStringTag, {
            get() { throw new Error('tag getter must never run'); },
            configurable: true,
        });
        const survived = clone(boom) as Record<string, unknown>;
        strictEqual(survived.real, 6, `${name}: a throwing tag getter must not surface (node: no throw)`);
    }
});

// --- 2. boxed primitives -----------------------------------------------------
// The type the five-throw probe existed to find. Tag dispatch must still find them,
// including after prototype surgery, where only the internal slot identifies them.

Deno.test('structuredClone: boxed primitives keep their type and value', () => {
    for (const [name, clone] of ENTRIES) {
        const num = clone(new Number(42));
        strictEqual(tagOf(num), '[object Number]', `${name}: boxed Number tag`);
        strictEqual(num.valueOf(), 42, `${name}: boxed Number value`);
        strictEqual(typeof num, 'object', `${name}: must NOT be unboxed to a primitive`);

        const str = clone(new String('hi'));
        strictEqual(tagOf(str), '[object String]', `${name}: boxed String tag`);
        strictEqual(str.valueOf(), 'hi', `${name}: boxed String value`);
        strictEqual(str.length, 2, `${name}: boxed String length`);

        const bool = clone(new Boolean(true));
        strictEqual(tagOf(bool), '[object Boolean]', `${name}: boxed Boolean tag`);
        strictEqual(bool.valueOf(), true, `${name}: boxed Boolean value`);

        // BigInt and Symbol objects DO carry @@toStringTag, so they exercise the
        // preserved throw-probe path rather than the tag fast path.
        const big = clone(Object(7n));
        strictEqual(tagOf(big), '[object BigInt]', `${name}: boxed BigInt tag`);
        strictEqual(big.valueOf(), 7n, `${name}: boxed BigInt value`);
    }
});

Deno.test('structuredClone: a boxed Number reprototyped to Object.prototype is still boxed', () => {
    // `Object.setPrototypeOf(new Number(11), Object.prototype)` removes every prototype
    // clue; only [[NumberData]] remains. Object.prototype.toString reads that slot, so
    // this is the case that proves the dispatch is slot-based and not prototype-based.
    // Node's answer: `[object Number]`, value 11.
    for (const [name, clone] of ENTRIES) {
        const boxed = new Number(11);
        Object.setPrototypeOf(boxed, Object.prototype);
        const out = clone(boxed);
        strictEqual(tagOf(out), '[object Number]', `${name}: must still be recognised as boxed`);
        strictEqual(Number.prototype.valueOf.call(out), 11, `${name}: value must survive`);
    }
});

Deno.test('structuredClone: a boxed Symbol still throws DataCloneError', () => {
    for (const [name, clone] of ENTRIES) {
        throws(
            () => clone(Object(Symbol('s'))),
            (e: Error & { code?: number }) => {
                strictEqual(e.name, 'DataCloneError', `${name}: error name`);
                strictEqual(e.code, 25, `${name}: DOMException code`);
                return true;
            },
            `${name}: a Symbol object must not become cloneable`,
        );
    }
});

// --- 3. Map with object keys -------------------------------------------------
// Map/Set/Error moved ahead of the boxed probe. That reorder is only sound because the
// internal slots are mutually exclusive; these cases pin the observable behaviour.

Deno.test('structuredClone: Map with object keys clones keys and values deeply', () => {
    for (const [name, clone] of ENTRIES) {
        const key = { id: 1 };
        const source = new Map<unknown, unknown>([[key, { v: 2 }], ['s', 3]]);
        const out = clone(source);

        ok(out instanceof Map, `${name}: must be a Map`);
        strictEqual(out.size, 2, `${name}: size`);
        strictEqual(out.get('s'), 3, `${name}: string key`);

        const clonedKey = [...out.keys()].find((k) => typeof k === 'object') as { id: number };
        ok(clonedKey, `${name}: the object key must be present`);
        ok(clonedKey !== key, `${name}: the object key must be a CLONE, not the original`);
        strictEqual(clonedKey.id, 1, `${name}: key contents`);
        deepStrictEqual(out.get(clonedKey), { v: 2 }, `${name}: the value must be keyed by the clone`);
    }
});

Deno.test('structuredClone: Map/Set preserve identity of a shared member', () => {
    // Sharing must be preserved through the reordered dispatch: one input object
    // appearing twice must be ONE output object.
    for (const [name, clone] of ENTRIES) {
        const shared = { s: 1 };
        const out = clone({ m: new Map([['a', shared]]), s: new Set([shared]), direct: shared });
        const viaMap = (out.m as Map<string, unknown>).get('a');
        const viaSet = [...(out.s as Set<unknown>)][0];
        strictEqual(viaMap, viaSet, `${name}: Map and Set members must be the same clone`);
        strictEqual(viaMap, out.direct, `${name}: and the same as the direct reference`);
        ok(viaMap !== shared, `${name}: but detached from the input`);
    }
});

Deno.test('structuredClone: a self-referential Map survives', () => {
    for (const [name, clone] of ENTRIES) {
        const map = new Map<string, unknown>();
        map.set('self', map);
        const out = clone(map);
        ok(out instanceof Map, `${name}: must be a Map`);
        strictEqual(out.get('self'), out, `${name}: the cycle must point at the clone`);
    }
});

// --- 4. non-zero byteOffset views -------------------------------------------
// `isArrayBufferView` now answers via ArrayBuffer.isView. A view carries an offset and
// a length into a buffer; getting the window wrong is silent data corruption, so the
// bytes are asserted and not merely the sizes.

Deno.test('structuredClone: TypedArray with a non-zero byteOffset keeps its window', () => {
    for (const [name, clone] of ENTRIES) {
        const buffer = new ArrayBuffer(16);
        const view = new Uint16Array(buffer, 4, 3);
        view[0] = 7;
        view[2] = 9;
        const out = clone(view);

        strictEqual(tagOf(out), '[object Uint16Array]', `${name}: constructor must be preserved`);
        strictEqual(out.byteOffset, 4, `${name}: byteOffset`);
        strictEqual(out.length, 3, `${name}: element length`);
        strictEqual(out.byteLength, 6, `${name}: byteLength`);
        strictEqual(out.buffer.byteLength, 16, `${name}: the whole backing buffer is cloned`);
        strictEqual(out[0], 7, `${name}: the window must address the right bytes`);
        strictEqual(out[2], 9, `${name}: and the last element too`);
    }
});

Deno.test('structuredClone: DataView with a non-zero byteOffset keeps its window', () => {
    for (const [name, clone] of ENTRIES) {
        const dv = new DataView(new ArrayBuffer(16), 4, 8);
        dv.setFloat64(0, 1.5);
        const out = clone(dv);
        strictEqual(tagOf(out), '[object DataView]', `${name}: must remain a DataView`);
        strictEqual(out.byteOffset, 4, `${name}: byteOffset`);
        strictEqual(out.byteLength, 8, `${name}: byteLength`);
        strictEqual(out.getFloat64(0), 1.5, `${name}: contents`);
        strictEqual(out.buffer.byteLength, 16, `${name}: backing buffer size`);
    }
});

Deno.test('structuredClone: two views over one buffer still share one buffer', () => {
    for (const [name, clone] of ENTRIES) {
        const buffer = new ArrayBuffer(8);
        const out = clone({ x: new Uint8Array(buffer, 0, 4), y: new Uint8Array(buffer, 4, 4) });
        strictEqual(out.x.buffer, out.y.buffer, `${name}: the buffer must be cloned ONCE`);
        strictEqual(out.x.buffer.byteLength, 8, `${name}: and kept whole`);
    }
});

Deno.test('structuredClone: a view reprototyped to Object.prototype is still a view', () => {
    // This is why ArrayBuffer.isView is used instead of the tag: severing the prototype
    // makes the value report `[object Object]` with no @@toStringTag, so a tag-only
    // dispatch would clone it to a plain object. Node clones it as a real Uint8Array.
    for (const [name, clone] of ENTRIES) {
        const view = new Uint8Array([1, 2]);
        Object.setPrototypeOf(view, Object.prototype);
        const out = clone(view);
        strictEqual(tagOf(out), '[object Uint8Array]', `${name}: must still clone as a view`);
        strictEqual(out.length, 2, `${name}: length`);
        strictEqual(out[0], 1, `${name}: contents`);
    }
});

// --- 5. throwing valueOf ----------------------------------------------------
// The old code CALLED valueOf on every object; the new code does not. Node does not
// either (measured: a non-enumerable valueOf records zero invocations), so removing the
// call moves cno toward node. These pin that, in both directions.

Deno.test('structuredClone: a non-enumerable throwing valueOf does not break the clone', () => {
    for (const [name, clone] of ENTRIES) {
        const value: Record<string, unknown> = { real: 10 };
        Object.defineProperty(value, 'valueOf', {
            value() { throw new Error('valueOf must not be called'); },
            enumerable: false,
            configurable: true,
        });
        const out = clone(value) as Record<string, unknown>;
        strictEqual(out.real, 10, `${name}: the clone must succeed (node: succeeds)`);
        deepStrictEqual(Object.keys(out), ['real'], `${name}: non-enumerable valueOf is not copied`);
    }
});

Deno.test('structuredClone: valueOf is never invoked', () => {
    for (const [name, clone] of ENTRIES) {
        let hits = 0;
        const value: Record<string, unknown> = { real: 11 };
        Object.defineProperty(value, 'valueOf', {
            value() { hits++; return 77; },
            enumerable: false,
            configurable: true,
        });
        const out = clone(value) as Record<string, unknown>;
        strictEqual(hits, 0, `${name}: valueOf must not be invoked (node: 0 invocations)`);
        strictEqual(out.real, 11, `${name}: own data survives`);
        strictEqual(tagOf(out), '[object Object]', `${name}: stays an ordinary object`);
    }
});

Deno.test('structuredClone: a prototype-side throwing valueOf does not break the clone', () => {
    for (const [name, clone] of ENTRIES) {
        const proto = { valueOf() { throw new Error('proto valueOf must not be called'); } };
        const value = Object.create(proto) as Record<string, unknown>;
        value.real = 12;
        const out = clone(value) as Record<string, unknown>;
        strictEqual(out.real, 12, `${name}: the clone must succeed`);
        deepStrictEqual(Object.keys(out), ['real'], `${name}: only own enumerable keys are copied`);
    }
});

Deno.test('structuredClone: an own ENUMERABLE valueOf still throws, because it is a function', () => {
    // Not a valueOf rule: cloning any function throws, and this one is an own enumerable
    // property. Node throws DataCloneError code 25 here. Pinned so the previous three
    // cases cannot be misread as "functions became cloneable".
    for (const [name, clone] of ENTRIES) {
        throws(
            () => clone({ real: 9, valueOf: () => 123 }),
            (e: Error & { code?: number }) => {
                strictEqual(e.name, 'DataCloneError', `${name}: error name`);
                strictEqual(e.code, 25, `${name}: DOMException code`);
                return true;
            },
            `${name}: an own enumerable function property must still throw`,
        );
    }
});

// --- 6. the fast path must not swallow the uncloneable ----------------------
// The dispatch skips several probes for ordinary objects. Everything that must still
// throw, must still throw -- including cno's Request/Response/stream classes, which
// carry no @@toStringTag and so cannot be excluded by the tag at all.

Deno.test('structuredClone: uncloneable values still throw DataCloneError', () => {
    const uncloneable: ReadonlyArray<readonly [string, () => unknown]> = [
        ['function', () => function f() {}],
        ['nested function', () => ({ ok: 1, bad: () => {} })],
        ['Promise', () => Promise.resolve(1)],
        ['WeakMap', () => new WeakMap()],
        ['WeakSet', () => new WeakSet()],
        ['WeakRef', () => new WeakRef({})],
        ['Proxy', () => new Proxy({ a: 1 }, {})],
    ];
    for (const [name, clone] of ENTRIES) {
        for (const [label, make] of uncloneable) {
            throws(
                () => clone(make()),
                (e: Error & { code?: number }) => {
                    strictEqual(e.name, 'DataCloneError', `${name}/${label}: error name`);
                    strictEqual(e.code, 25, `${name}/${label}: DOMException code`);
                    return true;
                },
                `${name}: ${label} must still throw DataCloneError`,
            );
        }
    }
});

Deno.test('structuredClone: a Proxy in the prototype chain cannot run has traps', () => {
    let hits = 0;
    const proxyPrototype = new Proxy({}, {
        has() {
            hits++;
            throw new Error('prototype has trap must not run');
        },
    });
    const source = Object.create(proxyPrototype) as { value: number };
    source.value = 7;
    const clone = cloneSource(source) as { value: number };
    strictEqual(clone.value, 7);
    strictEqual(hits, 0);
});

Deno.test('structuredClone: platform objects with internal slots still throw', () => {
    // Request/Response/ReadableStream/WritableStream/TransformStream carry NO
    // @@toStringTag in cno and report `[object Object]`, so a tag-gated rejection would
    // silently clone them to a hollow `{}`. This is the case that forced
    // throwIfNonSerializable to keep running for every value.
    const cases: ReadonlyArray<readonly [string, () => unknown]> = [
        ['URL', () => new URL('https://e.x/p?q=1')],
        ['URLSearchParams', () => new URLSearchParams()],
        ['Headers', () => new Headers()],
        ['Request', () => new Request('https://e.x/')],
        ['Response', () => new Response('body')],
        ['ReadableStream', () => new ReadableStream()],
        ['WritableStream', () => new WritableStream()],
        ['TransformStream', () => new TransformStream()],
    ];
    for (const [name, clone] of ENTRIES) {
        for (const [label, make] of cases) {
            let instance: unknown;
            try {
                instance = make();
            } catch {
                continue; // constructor unavailable in this build; not this test's subject
            }
            throws(
                () => clone(instance),
                (e: Error & { code?: number }) => {
                    strictEqual(e.name, 'DataCloneError', `${name}/${label}: error name`);
                    strictEqual(e.code, 25, `${name}/${label}: code`);
                    return true;
                },
                `${name}: ${label} must still be rejected`,
            );
        }
    }
});

Deno.test('structuredClone: a subclass of a rejected platform class is still rejected', () => {
    // The prototype gate in throwIfNonSerializable short-circuits only when the
    // immediate prototype is Object.prototype/Array.prototype/null. A subclass has
    // neither, so the full instanceof loop must still run for it.
    class MyUrl extends URL {}
    for (const [name, clone] of ENTRIES) {
        throws(
            () => clone(new MyUrl('https://e.x/')),
            (e: Error & { code?: number }) => {
                strictEqual(e.name, 'DataCloneError', `${name}: subclass must be rejected too`);
                return true;
            },
        );
    }
});

// --- 7. cross-realm ---------------------------------------------------------
// Hazard 2: these fail `instanceof` yet must clone. They inherit @@toStringTag from
// their own realm, so the gate sends them to the slot-based predicates.

Deno.test('structuredClone: cross-realm values clone by internal slot, not by instanceof', async () => {
    const vm = await import('node:vm');
    const build = (expr: string): unknown => vm.runInNewContext(`(${expr})`);

    for (const [name, clone] of ENTRIES) {
        const plain = clone(build('({a:1})')) as { a: number };
        strictEqual(plain.a, 1, `${name}: cross-realm plain object`);

        const date = clone(build('new Date(777000)')) as Date;
        ok(date instanceof Date, `${name}: cross-realm Date must clone into THIS realm`);
        strictEqual(date.getTime(), 777000, `${name}: cross-realm Date value`);

        const map = clone(build('new Map([["k","v"]])')) as Map<string, string>;
        ok(map instanceof Map, `${name}: cross-realm Map`);
        strictEqual(map.get('k'), 'v', `${name}: cross-realm Map entry`);

        const set = clone(build('new Set([3])')) as Set<number>;
        ok(set instanceof Set, `${name}: cross-realm Set`);
        strictEqual(set.size, 1, `${name}: cross-realm Set size`);

        const boxed = clone(build('new Number(21)'));
        strictEqual(tagOf(boxed), '[object Number]', `${name}: cross-realm boxed Number`);
        strictEqual(Number.prototype.valueOf.call(boxed), 21, `${name}: cross-realm boxed value`);

        const err = clone(build('new TypeError("cr err")')) as Error;
        strictEqual(err.name, 'TypeError', `${name}: cross-realm Error name`);
        strictEqual(err.message, 'cr err', `${name}: cross-realm Error message`);

        const view = clone(build('new Uint8Array([9,8])')) as Uint8Array;
        strictEqual(tagOf(view), '[object Uint8Array]', `${name}: cross-realm typed array`);
        strictEqual(view[0], 9, `${name}: cross-realm typed array contents`);

        const dv = clone(build('new DataView(new ArrayBuffer(8), 2, 4)')) as DataView;
        strictEqual(tagOf(dv), '[object DataView]', `${name}: cross-realm DataView`);
        strictEqual(dv.byteOffset, 2, `${name}: cross-realm DataView offset`);
        strictEqual(dv.byteLength, 4, `${name}: cross-realm DataView length`);
    }
});

// --- 8. the ordinary-object fast path itself --------------------------------
// The path that got fast still has to obey every structured-clone rule.

Deno.test('structuredClone: the ordinary-object fast path preserves clone semantics', () => {
    for (const [name, clone] of ENTRIES) {
        // getters are INVOKED and materialised as data properties
        let calls = 0;
        const withGetter = clone({ get g() { calls++; return 5; } }) as Record<string, unknown>;
        strictEqual(calls, 1, `${name}: the getter must be invoked exactly once`);
        strictEqual(withGetter.g, 5, `${name}: the value must be materialised`);
        const descriptor = Object.getOwnPropertyDescriptor(withGetter, 'g');
        ok(descriptor && !descriptor.get, `${name}: the accessor must NOT be copied as an accessor`);
        strictEqual(descriptor!.writable, true, `${name}: and must be a writable data property`);

        // non-enumerable properties are skipped
        const hidden: Record<string, unknown> = {};
        Object.defineProperty(hidden, 'hidden', { value: 1, enumerable: false });
        hidden.shown = 2;
        const afterHidden = clone(hidden) as Record<string, unknown>;
        deepStrictEqual(Object.keys(afterHidden), ['shown'], `${name}: only enumerable keys`);
        strictEqual('hidden' in afterHidden, false, `${name}: the hidden key must be absent`);

        // symbol keys are skipped
        const symbolKeyed = clone({ [Symbol('k')]: 1, n: 2 }) as Record<string, unknown>;
        deepStrictEqual(Object.keys(symbolKeyed), ['n'], `${name}: string keys only`);
        strictEqual(Object.getOwnPropertySymbols(symbolKeyed).length, 0, `${name}: no symbol keys`);

        // A null-prototype source clones to an ORDINARY object: structured clone builds a
        // fresh `{}` and copies own enumerable string keys. Measured in node: the clone's
        // prototype is Object.prototype, not null. (The prototype is not part of the
        // serialization, so this is expected, not a loss.)
        const nullProto = Object.create(null) as Record<string, unknown>;
        nullProto.a = 1;
        const afterNull = clone(nullProto) as Record<string, unknown>;
        strictEqual(
            Object.getPrototypeOf(afterNull),
            Object.prototype,
            `${name}: a null-prototype source clones to an ordinary object, as in node`,
        );
        strictEqual(afterNull.a, 1, `${name}: contents preserved`);

        // cycles and shared references
        const shared = { s: 1 };
        const graph = clone({ a: shared, b: shared }) as Record<string, unknown>;
        strictEqual(graph.a, graph.b, `${name}: a shared reference must stay ONE object`);
        ok(graph.a !== shared, `${name}: and be detached from the input`);

        const cyclic: Record<string, unknown> = { n: 1 };
        cyclic.self = cyclic;
        const afterCycle = clone(cyclic) as Record<string, unknown>;
        strictEqual(afterCycle.self, afterCycle, `${name}: the cycle must close on the clone`);

        // arrays keep holes, extra props and array-ness
        const sparse: number[] & { extra?: string } = [1];
        sparse[3] = 4;
        sparse.extra = 'e';
        const afterSparse = clone(sparse) as number[] & { extra?: string };
        ok(Array.isArray(afterSparse), `${name}: must remain an Array`);
        strictEqual(afterSparse.length, 4, `${name}: length preserved`);
        strictEqual(1 in afterSparse, false, `${name}: holes preserved`);
        strictEqual(afterSparse.extra, 'e', `${name}: extra properties preserved`);

        // an own __proto__ key must not pollute
        const polluting = JSON.parse('{"__proto__": {"polluted": true}}');
        const afterProto = clone(polluting) as Record<string, unknown>;
        ok(
            Object.prototype.hasOwnProperty.call(afterProto, '__proto__'),
            `${name}: __proto__ must stay an OWN property`,
        );
        strictEqual(
            (Object.prototype as Record<string, unknown>).polluted,
            undefined,
            `${name}: Object.prototype must not be polluted`,
        );
        strictEqual(Object.getPrototypeOf(afterProto), Object.prototype, `${name}: prototype intact`);
    }
});

Deno.test('structuredClone: Errors keep name, message, cause and stack', () => {
    for (const [name, clone] of ENTRIES) {
        const withCause = clone(new Error('outer', { cause: { deep: 1 } }));
        strictEqual(withCause.name, 'Error', `${name}: name`);
        strictEqual(withCause.message, 'outer', `${name}: message`);
        deepStrictEqual(withCause.cause, { deep: 1 }, `${name}: cause is cloned`);
        strictEqual(
            Object.keys(withCause).includes('cause'),
            false,
            `${name}: cause must be non-enumerable, as in node`,
        );

        const typed = clone(new TypeError('boom'));
        strictEqual(typed.name, 'TypeError', `${name}: subclass name preserved`);
        strictEqual(typed.message, 'boom', `${name}: subclass message preserved`);
        ok(typed instanceof Error, `${name}: must be a real Error`);
        strictEqual(typeof typed.stack, 'string', `${name}: stack must be a string`);
    }
});

Deno.test('structuredClone: RegExp keeps source and flags, and resets lastIndex', () => {
    for (const [name, clone] of ENTRIES) {
        const re = /ab(c)/gimsuy;
        re.lastIndex = 2;
        const out = clone(re);
        strictEqual(out.source, 'ab(c)', `${name}: source`);
        strictEqual(out.flags, 'gimsuy', `${name}: flags`);
        strictEqual(out.lastIndex, 0, `${name}: lastIndex resets, as in node`);
    }
});

// --- 10. the tag must not be trusted beyond its slot-derived meaning ---------
// `Object.prototype.toString` derives only SOME tags from an internal slot (Array,
// Function, Error, Boolean, Number, String, Date, RegExp, Arguments). Map, Set,
// ArrayBuffer, SharedArrayBuffer, DataView, TypedArray, Promise and the Weak* types are
// named by @@toStringTag on their PROTOTYPE instead. Delete that and a real one reports
// `[object Object]`, so any dispatch that used the tag to rule them out would mistake it
// for an ordinary object.
//
// An earlier revision of this fix did exactly that and measurably diverged from node: a
// SharedArrayBuffer cloned to a hollow object with `byteLength === undefined` -- the
// payload silently gone -- and a Promise and a WeakMap cloned instead of throwing. Node
// reads internal slots throughout and is immune to all of it. These cases pin that.

/** Delete a prototype's @@toStringTag for the duration of `body`, then restore it. */
function withoutToStringTag(proto: object, body: () => void): void {
    const descriptor = Object.getOwnPropertyDescriptor(proto, Symbol.toStringTag);
    try {
        delete (proto as Record<symbol, unknown>)[Symbol.toStringTag];
        body();
    } finally {
        if (descriptor) Object.defineProperty(proto, Symbol.toStringTag, descriptor);
    }
}

Deno.test('structuredClone: a SharedArrayBuffer survives even with its prototype tag deleted', () => {
    if (typeof SharedArrayBuffer !== 'function') return; // not built with SAB support
    for (const [name, clone] of ENTRIES) {
        withoutToStringTag(SharedArrayBuffer.prototype, () => {
            const sab = new SharedArrayBuffer(8);
            new Uint8Array(sab)[0] = 9;
            // Precondition: the tag really is gone, so the value now LOOKS ordinary.
            strictEqual(tagOf(sab), '[object Object]', `${name}: precondition, tag is deleted`);

            const out = clone(sab) as SharedArrayBuffer;
            strictEqual(
                out.byteLength,
                8,
                `${name}: the payload must survive. byteLength === undefined here means the ` +
                `SharedArrayBuffer was mistaken for a plain object and its bytes were dropped.`,
            );
            strictEqual(new Uint8Array(out)[0], 9, `${name}: contents must survive`);
        });
    }
});

Deno.test('structuredClone: Promise and WeakMap still throw with their prototype tags deleted', () => {
    for (const [name, clone] of ENTRIES) {
        withoutToStringTag(Promise.prototype, () => {
            const promise = Promise.resolve(1);
            strictEqual(tagOf(promise), '[object Object]', `${name}: precondition, Promise tag deleted`);
            throws(
                () => clone(promise),
                (e: Error) => {
                    strictEqual(e.name, 'DataCloneError', `${name}: Promise must still be rejected`);
                    return true;
                },
            );
        });
        withoutToStringTag(WeakMap.prototype, () => {
            const weak = new WeakMap();
            strictEqual(tagOf(weak), '[object Object]', `${name}: precondition, WeakMap tag deleted`);
            throws(
                () => clone(weak),
                (e: Error) => {
                    strictEqual(e.name, 'DataCloneError', `${name}: WeakMap must still be rejected`);
                    return true;
                },
            );
        });
    }
});

Deno.test('structuredClone: Map and TypedArray survive with their prototype tags deleted', () => {
    for (const [name, clone] of ENTRIES) {
        withoutToStringTag(Map.prototype, () => {
            const map = new Map([['k', 'v']]);
            strictEqual(tagOf(map), '[object Object]', `${name}: precondition, Map tag deleted`);
            const out = clone(map);
            ok(out instanceof Map, `${name}: must still clone as a Map`);
            strictEqual(out.get('k'), 'v', `${name}: entries must survive`);
        });
        // Typed arrays share one tag, on %TypedArray%.prototype.
        withoutToStringTag(Object.getPrototypeOf(Uint8Array.prototype) as object, () => {
            const view = new Uint8Array([1, 2]);
            strictEqual(tagOf(view), '[object Object]', `${name}: precondition, TypedArray tag deleted`);
            const out = clone(view);
            strictEqual(out.length, 2, `${name}: length must survive`);
            strictEqual(out[0], 1, `${name}: contents must survive`);
        });
    }
});

Deno.test('structuredClone: boxed BigInt and Symbol survive their prototype tags being deleted', () => {
    // The ONLY remaining place the tag is trusted is "a `[object Object]` tag proves this is
    // not a boxed primitive". A BigInt or Symbol object with its prototype tag deleted
    // reports `[object Object]` and would falsify exactly that. Measured node behaviour: the
    // BigInt keeps its value, and the Symbol object still throws. A load-time-only integrity
    // check does NOT catch this -- the deletion happens after import -- which is why the
    // check is per-call.
    for (const [name, clone] of ENTRIES) {
        withoutToStringTag(BigInt.prototype, () => {
            const boxed = Object(7n);
            strictEqual(tagOf(boxed), '[object Object]', `${name}: precondition, BigInt tag deleted`);
            const out = clone(boxed);
            let value: bigint | string;
            try {
                value = BigInt.prototype.valueOf.call(out);
            } catch {
                value = 'NO-SLOT';
            }
            strictEqual(
                value,
                7n,
                `${name}: the BigInt value must survive. 'NO-SLOT' means the boxed BigInt was ` +
                `mistaken for a plain object because its tag was trusted.`,
            );
        });
        withoutToStringTag(Symbol.prototype, () => {
            const boxed = Object(Symbol('x'));
            strictEqual(tagOf(boxed), '[object Object]', `${name}: precondition, Symbol tag deleted`);
            throws(
                () => clone(boxed),
                (e: Error) => {
                    strictEqual(e.name, 'DataCloneError', `${name}: a Symbol object must still throw`);
                    return true;
                },
            );
        });
    }
});

// --- 11. performance guard ---------------------------------------------------
// A deliberately GENEROUS ceiling. The regression this file exists for was ~1040ms for
// 2000 plain objects (7 caught exceptions each); the fix measures ~348ms and node ~1ms.
// The threshold is 2500ms -- above any plausible slow run of the fixed code, below the
// broken cost -- because a tight perf assertion on a shared Windows box goes flaky, gets
// deleted, and then the regression returns silently. This is a tripwire for a wholesale
// return to exception-based dispatch, not a benchmark. It will NOT catch a partial
// regression; the fidelity cases above are what protect behaviour.

Deno.test('structuredClone: 2000 plain objects stay far away from the exception-probe cost', () => {
    const input: Array<{ x: number }> = [];
    for (let i = 0; i < 2000; i++) input.push({ x: i });

    structuredCloneWithTransfer(input); // warm

    const started = Date.now();
    const ITERATIONS = 3;
    for (let i = 0; i < ITERATIONS; i++) structuredCloneWithTransfer(input);
    const perIteration = (Date.now() - started) / ITERATIONS;

    ok(
        perIteration < 2500,
        `cloning 2000 plain objects took ${perIteration.toFixed(0)}ms per iteration ` +
        `(${ITERATIONS} iterations). The pre-fix implementation measured ~1040ms and the ` +
        `fixed one ~348ms, so a value near or above 1000ms suggests throw-based type ` +
        `probing is back on the ordinary-object path in cloneValue.`,
    );

    // Correctness under the same load: a fast clone that drops data is not a pass.
    const out = structuredCloneWithTransfer(input);
    strictEqual(out.length, 2000, 'every element must be cloned');
    strictEqual(out[0].x, 0, 'first element');
    strictEqual(out[1999].x, 1999, 'last element');
    ok(out[0] !== input[0], 'elements must be clones, not the originals');
});
