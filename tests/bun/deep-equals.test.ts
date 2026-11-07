import { strictEqual } from 'node:assert';
import { deepEquals } from '../../cno/src/bun/utils/deep-equals.ts';

Deno.test('bun: deepEquals primitive and object semantics', () => {
    strictEqual(deepEquals(NaN, NaN), true);
    strictEqual(deepEquals(0, -0), false);
    strictEqual(deepEquals(1, '1'), false);
    strictEqual(deepEquals({ x: undefined }, {}), true);
    strictEqual(deepEquals({ x: undefined }, {}, true), false);
    class A { x = 1; }
    class B { x = 1; }
    strictEqual(deepEquals(new A(), new B()), true);
    strictEqual(deepEquals(new A(), new B(), true), false);
    const symbol = Symbol();
    strictEqual(deepEquals({ [symbol]: 1 }, { [symbol]: 2 }), false);
    strictEqual(deepEquals(Array(1), [undefined]), true);
    strictEqual(deepEquals(Array(1), [undefined], true), false);
    // Bun only enables strict mode for the literal boolean true.
    strictEqual(deepEquals(new A(), new B(), 1 as unknown as boolean), true);
    strictEqual(deepEquals(new A(), new B(), 'true' as unknown as boolean), true);
});

Deno.test('bun: deepEquals collections, views, cycles and builtins', () => {
    strictEqual(deepEquals(new Set([{ x: 1 }]), new Set([{ x: 1 }])), true);
    strictEqual(deepEquals(new Map([[{ x: 1 }, 2]]), new Map([[{ x: 1 }, 2]])), true);
    strictEqual(deepEquals(new Uint8Array([1]), new Int8Array([1])), false);
    strictEqual(deepEquals(new Float64Array([-0]), new Float64Array([0])), true);
    strictEqual(deepEquals(new Float64Array([-0]), new Float64Array([0]), true), false);
    strictEqual(deepEquals(new Float64Array([NaN]), new Float64Array([NaN])), false);
    strictEqual(deepEquals(new Float64Array([NaN]), new Float64Array([NaN]), true), true);
    const a: { self?: unknown } = {}, b: { self?: unknown } = {};
    a.self = a; b.self = b;
    strictEqual(deepEquals(a, b), true);
    strictEqual(deepEquals(a, { self: { self: a } }), false);
    strictEqual(deepEquals(new Error('a'), new Error('b')), false);
    strictEqual(deepEquals(new URL('https://a/'), new URL('https://b/')), false);
    strictEqual(deepEquals(new Date(NaN), new Date(NaN)), false);
});

Deno.test('bun: deepEquals own properties and strict prototypes', () => {
    const inherited = Object.create({ get x() { throw new Error('must not read inherited x'); } });
    strictEqual(deepEquals({ x: undefined }, inherited), true);
    strictEqual(deepEquals(inherited, { x: undefined }), true);
    strictEqual(deepEquals({ x: undefined }, inherited, true), false);
    strictEqual(deepEquals({ x: 1 }, Object.create({ x: 1 })), false);
    strictEqual(deepEquals(Object.create(null), {}, true), true);
    class A {}
    strictEqual(deepEquals(Object.create(null), new A(), true), false);
    strictEqual(deepEquals(new A(), Object.create(null), true), false);
    strictEqual(deepEquals(Object.defineProperty({}, 'hidden', { value: 1 }), {}), true);
    strictEqual(deepEquals(Object(1n), Object(2n)), false);
    strictEqual(deepEquals(Object(1n), Object(1n)), true);
    const symbol = Symbol('same');
    strictEqual(deepEquals(Object(symbol), Object(symbol)), true);
    strictEqual(deepEquals(Object(symbol), Object(Symbol('same'))), false);
    strictEqual(deepEquals(Object.create({ x: 1 }), Object.create({ x: 2 }), true), true);
    class Same {}
    strictEqual(deepEquals(Object.create({ constructor: Same }), Object.create({ constructor: Same }), true), true);
    strictEqual(deepEquals(Object.create({ constructor: class A {} }), Object.create({ constructor: class B {} }), true), false);
    strictEqual(deepEquals(
        Object.create(Object.create({ constructor: class A {} })),
        Object.create(Object.create({ constructor: class B {} })),
        true,
    ), false);
});

Deno.test('bun: deepEquals byte windows and strict typed-array properties', () => {
    const bytes = new Uint8Array([9, 1, 2, 9]);
    strictEqual(deepEquals(bytes.subarray(1, 3), new Uint8Array([1, 2])), true);
    strictEqual(deepEquals(new DataView(bytes.buffer, 1, 2), new DataView(new Uint8Array([1, 2]).buffer)), true);
    const a = Object.assign(new Uint8Array([1]), { extra: 1 });
    const b = Object.assign(new Uint8Array([1]), { extra: 2 });
    strictEqual(deepEquals(a, b), true);
    strictEqual(deepEquals(a, b, true), false);
    class Bytes extends Uint8Array {}
    strictEqual(deepEquals(new Bytes([1]), new Uint8Array([1])), true);
    strictEqual(deepEquals(new Bytes([1]), new Uint8Array([1]), true), true);
    const leftView = Object.assign(new DataView(new Uint8Array([1]).buffer), { extra: 1 });
    const rightView = Object.assign(new DataView(new Uint8Array([1]).buffer), { extra: 2 });
    strictEqual(deepEquals(leftView, rightView), false);
    if (typeof SharedArrayBuffer !== 'undefined') {
        const left = new SharedArrayBuffer(2), right = new SharedArrayBuffer(2);
        strictEqual(deepEquals(left, right), true);
        new Uint8Array(right)[1] = 1;
        strictEqual(deepEquals(left, right), false);
        strictEqual(deepEquals(left, new SharedArrayBuffer(3)), false);
        strictEqual(deepEquals(left, new ArrayBuffer(2)), false);
    }
});

Deno.test('bun: deepEquals isolates view branding from ArrayBuffer.isView replacement', () => {
    const original = Object.getOwnPropertyDescriptor(ArrayBuffer, 'isView')!;
    const actual: boolean[] = [];
    try {
        for (const replacement of [
            () => false,
            () => { throw new Error('must not call replaced ArrayBuffer.isView'); },
        ]) {
            Object.defineProperty(ArrayBuffer, 'isView', { ...original, value: replacement });
            for (const strict of [false, true]) {
                actual.push(
                    deepEquals(new Uint8Array([1]), new Uint8Array([1]), strict),
                    deepEquals(new Uint8Array([1]), new Uint8Array([2]), strict),
                    deepEquals(new Uint8Array([1]), new Int8Array([1]), strict),
                    deepEquals(
                        new DataView(new Uint8Array([1]).buffer),
                        new DataView(new Uint8Array([2]).buffer),
                        strict,
                    ),
                );
            }
        }
    } finally {
        Object.defineProperty(ArrayBuffer, 'isView', original);
    }
    const expected = [true, false, false, true, true, false, false, true];
    strictEqual(actual.length, expected.length * 2);
    for (let i = 0; i < actual.length; i++) strictEqual(actual[i], expected[i % expected.length]);
});

Deno.test('bun: deepEquals array symbols and ignored string extras', () => {
    const symbol = Symbol('item');
    strictEqual(deepEquals(
        Object.assign([1], { extra: 1, [symbol]: 1 }),
        Object.assign([1], { extra: 2, [symbol]: 2 }),
    ), false);
    strictEqual(deepEquals(
        Object.assign([1], { extra: 1, [symbol]: undefined }),
        Object.assign([1], { extra: 2 }),
    ), true);
    strictEqual(deepEquals(
        Object.assign([1], { [symbol]: undefined }),
        [1],
        true,
    ), false);
});

Deno.test('bun: deepEquals unordered collections and recursive mismatch', () => {
    strictEqual(deepEquals(new Set([{ x: 1 }, { x: 2 }]), new Set([{ x: 2 }, { x: 1 }])), true);
    strictEqual(deepEquals(new Set([{ x: 1 }, { x: 3 }]), new Set([{ x: 1 }, { x: 2 }])), false);
    strictEqual(deepEquals(new Map([[{ x: 1 }, 2]]), new Map([[{ x: 1 }, 3]])), false);
    const a = new Map(), b = new Map();
    a.set(a, new Set([a]));
    b.set(b, new Set([b]));
    strictEqual(deepEquals(a, b), true);
    b.set('extra', 1);
    strictEqual(deepEquals(a, b), false);
    const value = { x: 1 };
    strictEqual(deepEquals([value, value], [{ x: 1 }, { x: 1 }]), true);
});

Deno.test('bun: deepEquals uses internal brands without observing toStringTag', () => {
    const tagged = (value: number) => Object.defineProperty({ value }, Symbol.toStringTag, {
        get() { throw new Error('must not read Symbol.toStringTag'); },
    });
    strictEqual(deepEquals(tagged(1), tagged(1)), true);
    strictEqual(deepEquals(tagged(1), tagged(2)), false);
    strictEqual(deepEquals(new Date(0), { [Symbol.toStringTag]: 'Date' }), false);
    strictEqual(deepEquals(new Map(), { [Symbol.toStringTag]: 'Map' }), false);
});

Deno.test('bun: deepEquals keeps Date branding after prototype replacement', () => {
    const date = Object.setPrototypeOf(new Date(1), null);
    strictEqual(deepEquals(date, new Date(1)), true);
    strictEqual(deepEquals(date, new Date(2)), false);
    strictEqual(deepEquals(date, new Date(1), true), true);
    strictEqual(deepEquals(Object.create(Date.prototype), new Date(1)), false);
});

Deno.test('bun: deepEquals keeps collection branding after prototype replacement', () => {
    const map = Object.setPrototypeOf(new Map([['key', 1]]), null);
    strictEqual(deepEquals(map, new Map([['key', 1]])), true);
    strictEqual(deepEquals(map, new Map([['key', 2]])), false);
    strictEqual(deepEquals(map, new Map([['key', 1]]), true), true);

    const set = Object.setPrototypeOf(new Set([1]), null);
    strictEqual(deepEquals(set, new Set([1])), true);
    strictEqual(deepEquals(set, new Set([2])), false);
    strictEqual(deepEquals(set, new Set([1]), true), true);

    const mapWithSetPrototype = Object.setPrototypeOf(new Map([['key', 1]]), Set.prototype);
    const setWithMapPrototype = Object.setPrototypeOf(new Set([1]), Map.prototype);
    strictEqual(deepEquals(mapWithSetPrototype, new Map([['key', 1]])), true);
    strictEqual(deepEquals(setWithMapPrototype, new Set([1])), true);

    const replaced = { constructor: class Replacement {} };
    strictEqual(deepEquals(Object.setPrototypeOf(new Map([['key', 1]]), replaced), new Map([['key', 1]])), true);
    strictEqual(deepEquals(Object.setPrototypeOf(new Set([1]), replaced), new Set([1])), true);

    strictEqual(deepEquals(Object.create(Map.prototype), new Map()), false);
    strictEqual(deepEquals(Object.create(Set.prototype), new Set()), false);
    strictEqual(deepEquals(new Proxy(new Map(), {}), new Map()), false);
    strictEqual(deepEquals(new Proxy(new Set(), {}), new Set()), false);
});

Deno.test('bun: deepEquals function values are identity-only', () => {
    const left = function named(value: unknown) { return value; };
    const right = function named(value: unknown) { return value; };
    strictEqual(deepEquals(left, left), true);
    strictEqual(deepEquals(left, right), false);
    strictEqual(deepEquals({ fn: left }, { fn: right }), false);
});
