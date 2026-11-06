import { strictEqual, throws } from 'node:assert';
import { deepMatch } from '../../cno/src/bun/utils/deep-match.ts';

Deno.test('bun: deepMatch accepts partial objects and ignores extra keys', () => {
    strictEqual(deepMatch({ a: 1 }, { a: 1, b: 2 }), true);
    strictEqual(deepMatch({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 }), true);
    strictEqual(deepMatch({ a: 1 }, { a: 2 }), false);
    strictEqual(deepMatch({ a: 1 }, {}), false);
    strictEqual(deepMatch({ a: 1 }, Object.create(null)), false);
    throws(() => deepMatch({}, 1), { name: 'TypeError', message: 'Expected 2 objects to match' });
    throws(() => deepMatch(null, undefined), { name: 'TypeError', message: 'Expected 2 objects to match' });
});

Deno.test('bun: deepMatch requires exact array length and order', () => {
    strictEqual(deepMatch([1, { a: 1 }], [1, { a: 1, b: 2 }]), true);
    strictEqual(deepMatch([1], [1, 2]), false);
    strictEqual(deepMatch([1, 2], [2, 1]), false);
    strictEqual(deepMatch([], {}), false);
});

Deno.test('bun: deepMatch compares nested primitives but ignores builtin internal slots', () => {
    strictEqual(deepMatch({ d: new Date(1) }, { d: new Date(1) }), true);
    strictEqual(deepMatch({ d: new Date(1) }, { d: new Date(2) }), true);
    strictEqual(deepMatch({ m: new Map([[1, 2]]) }, { m: new Map([[1, 3]]) }), true);
    strictEqual(deepMatch({ u: new Uint8Array([1]) }, { u: new Uint8Array([1, 2]) }), true);
    strictEqual(deepMatch({ u: new Uint8Array([1]) }, { u: new Uint8Array([2]) }), false);
    strictEqual(deepMatch({ n: NaN }, { n: NaN }), true);
    strictEqual(deepMatch({ n: 0 }, { n: -0 }), false);
    throws(() => deepMatch(NaN, NaN), TypeError);
});

Deno.test('bun: deepMatch handles cycles without recursing forever', () => {
    const a: { self?: unknown; x: number } = { x: 1 };
    const b: { self?: unknown; x: number; y: number } = { x: 1, y: 2 };
    a.self = a;
    b.self = b;
    strictEqual(deepMatch(a, b), true);
});

Deno.test('bun: deepMatch ignores prototypes and compares inherited enumerable properties', () => {
    class A { x = 1; }
    class B { x = 1; y = 2; }
    strictEqual(deepMatch(new A(), new A()), true);
    strictEqual(deepMatch(new A(), new B()), true);
    strictEqual(deepMatch({ x: 1 }, new A()), true);

    const inherited = Object.create({ inherited: 1 }) as { inherited: number; own?: number };
    inherited.own = 2;
    strictEqual(deepMatch(inherited, { inherited: 1, own: 2, extra: 3 }), true);
    strictEqual(deepMatch(inherited, { own: 2 }), false);

    const symbol = Symbol('inherited');
    const withSymbol = Object.create({ [symbol]: 1 });
    strictEqual(deepMatch(withSymbol, { [symbol]: 1 }), true);
    Object.defineProperty(withSymbol, symbol, { value: 2, enumerable: false });
    strictEqual(deepMatch(withSymbol, { [symbol]: 1 }), false);
});

Deno.test('bun: deepMatch preserves array shape and enumerable expandos', () => {
    strictEqual(deepMatch(Object('a'), Object('ab')), true);
    strictEqual(deepMatch(Object('ab'), Object('a')), false);
    strictEqual(deepMatch(Object(1), Object(2)), true);

    const subset = Object.assign(new Date(1), { meta: { x: 1 } });
    const value = Object.assign(new Date(2), { meta: { x: 1, y: 2 } });
    strictEqual(deepMatch(subset, value), true);
    value.meta.x = 2;
    strictEqual(deepMatch(subset, value), false);
});
