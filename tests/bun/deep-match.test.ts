import { strictEqual } from 'node:assert';
import { deepMatch } from '../../cno/src/bun/utils/deep-match.ts';

Deno.test('bun: deepMatch accepts partial objects and ignores extra keys', () => {
    strictEqual(deepMatch({ a: 1 }, { a: 1, b: 2 }), true);
    strictEqual(deepMatch({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 }), true);
    strictEqual(deepMatch({ a: 1 }, { a: 2 }), false);
    strictEqual(deepMatch({ a: 1 }, {}), false);
    strictEqual(deepMatch({ a: 1 }, Object.create(null)), false);
    strictEqual(deepMatch({}, 1), false);
    strictEqual(deepMatch(null, undefined), false);
});

Deno.test('bun: deepMatch requires exact array length and order', () => {
    strictEqual(deepMatch([1, { a: 1 }], [1, { a: 1, b: 2 }]), true);
    strictEqual(deepMatch([1], [1, 2]), false);
    strictEqual(deepMatch([1, 2], [2, 1]), false);
    strictEqual(deepMatch([], {}), false);
});

Deno.test('bun: deepMatch compares built-ins and primitives by deepEquals', () => {
    strictEqual(deepMatch({ d: new Date(1) }, { d: new Date(1) }), true);
    strictEqual(deepMatch({ d: new Date(1) }, { d: new Date(2) }), false);
    strictEqual(deepMatch({ m: new Map([[1, 2]]) }, { m: new Map([[1, 3]]) }), false);
    strictEqual(deepMatch({ u: new Uint8Array([1]) }, { u: new Uint8Array([1, 2]) }), false);
    strictEqual(deepMatch(NaN, NaN), true);
    strictEqual(deepMatch(0, -0), false);
});

Deno.test('bun: deepMatch handles cycles without recursing forever', () => {
    const a: { self?: unknown; x: number } = { x: 1 };
    const b: { self?: unknown; x: number; y: number } = { x: 1, y: 2 };
    a.self = a;
    b.self = b;
    strictEqual(deepMatch(a, b), true);
});

Deno.test('bun: deepMatch requires the same prototype for class-instance subsets', () => {
    class A { x = 1; }
    class B { x = 1; y = 2; }
    strictEqual(deepMatch(new A(), new A()), true);
    strictEqual(deepMatch(new A(), new B()), false);
    strictEqual(deepMatch({ x: 1 }, new A()), true);
});
