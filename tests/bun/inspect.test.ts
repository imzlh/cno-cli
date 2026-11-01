import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { inspect as nodeInspect } from 'node:util';
import { inspect, inspectCustom } from '../../cno/src/bun/inspect.ts';

Deno.test('bun: inspect formats primitives', () => {
    strictEqual(inspect('a\'b\n'), "'a\\'b\\n'");
    strictEqual(inspect(1), '1');
    strictEqual(inspect(-0), '-0');
    strictEqual(inspect(10n), '10n');
    strictEqual(inspect(null), 'null');
    strictEqual(inspect(undefined), 'undefined');
    strictEqual(inspect(true), 'true');
});

Deno.test('bun: inspect formats arrays and plain objects like util.inspect', () => {
    const samples: unknown[] = [
        [],
        [1, 'x', null],
        {},
        { a: 1, 'b-c': [2] },
        { a: { b: { c: { d: 1 } } } },
    ];
    for (const sample of samples) strictEqual(inspect(sample), nodeInspect(sample, { colors: false, compact: true, breakLength: Infinity }));
});

Deno.test('bun: inspect marks cycles', () => {
    const value: Record<string, unknown> = { name: 'loop' };
    value.self = value;
    strictEqual(inspect(value), "<ref *1> { name: 'loop', self: [Circular *1] }");
});

Deno.test('bun: inspect honors depth option', () => {
    const value = { a: { b: { c: { d: 1 } } } };
    strictEqual(inspect(value, { depth: 0 }), '{ a: [Object] }');
    strictEqual(inspect(value, { depth: null }), '{ a: { b: { c: { d: 1 } } } }');
    throws(() => inspect(value, { depth: 'x' as unknown as number }), TypeError);
});

Deno.test('bun: inspect calls the nodejs.util.inspect.custom hook', () => {
    const value = {
        [inspectCustom](depth: number, options: { depth: number }) {
            return `Custom(${depth},${options.depth})`;
        },
    };
    strictEqual(inspect(value), 'Custom(2,2)');
    strictEqual(inspect({ nested: value }), '{ nested: Custom(1,2) }');
});

Deno.test('bun: inspect formats functions and symbol keys', () => {
    function named() {}
    strictEqual(inspect(named), '[Function: named]');
    strictEqual(inspect({ [Symbol.for('k')]: 1 }), '{ [Symbol(k)]: 1 }');
});
