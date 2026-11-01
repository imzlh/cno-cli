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
});

Deno.test('bun: deepEquals byte windows and strict typed-array properties', () => {
    const bytes = new Uint8Array([9, 1, 2, 9]);
    strictEqual(deepEquals(bytes.subarray(1, 3), new Uint8Array([1, 2])), true);
    strictEqual(deepEquals(new DataView(bytes.buffer, 1, 2), new DataView(new Uint8Array([1, 2]).buffer)), true);
    const a = Object.assign(new Uint8Array([1]), { extra: 1 });
    const b = Object.assign(new Uint8Array([1]), { extra: 2 });
    strictEqual(deepEquals(a, b), true);
    strictEqual(deepEquals(a, b, true), false);
    if (typeof SharedArrayBuffer !== 'undefined') {
        const left = new SharedArrayBuffer(2), right = new SharedArrayBuffer(2);
        strictEqual(deepEquals(left, right), true);
        new Uint8Array(right)[1] = 1;
        strictEqual(deepEquals(left, right), false);
        strictEqual(deepEquals(left, new SharedArrayBuffer(3)), false);
        strictEqual(deepEquals(left, new ArrayBuffer(2)), false);
    }
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
