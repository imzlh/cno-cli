import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { runInNewContext } from 'node:vm';
import { inspect, inspectCustom } from '../../cno/src/bun/inspect.ts';

Deno.test('bun: inspect formats primitives', () => {
    strictEqual(inspect('a\'b\n'), '"a\'b\\n"');
    strictEqual(inspect(1), '1');
    strictEqual(inspect(-0), '-0');
    strictEqual(inspect(10n), '10n');
    strictEqual(inspect(null), 'null');
    strictEqual(inspect(undefined), 'undefined');
    strictEqual(inspect(true), 'true');
});

Deno.test('bun: inspect formats arrays and plain objects', () => {
    strictEqual(inspect([]), '[]');
    strictEqual(inspect([1, 'x', null]), '[ 1, "x", null ]');
    strictEqual(inspect({}), '{}');
    strictEqual(inspect({ a: 1, 'b-c': [2] }), '{ a: 1, "b-c": [ 2 ] }');
    strictEqual(inspect({ a: { b: { c: { d: 1 } } } }), '{ a: { b: { c: { d: 1 } } } }');
});

Deno.test('bun: inspect marks cycles', () => {
    const value: Record<string, unknown> = { name: 'loop' };
    value.self = value;
    strictEqual(inspect(value), '{ name: "loop", self: [Circular] }');
});

Deno.test('bun: inspect honors depth option', () => {
    const value = { a: { b: { c: { d: 1 } } } };
    strictEqual(inspect(value, { depth: 0 }), '{ a: [Object ...] }');
    strictEqual(inspect(value, { depth: null }), '{ a: { b: { c: { d: 1 } } } }');
    strictEqual(inspect(value, { depth: 'x' as unknown as number }), '{ a: { b: { c: { d: 1 } } } }');
    strictEqual(inspect(value, null as unknown as object), '{ a: { b: { c: { d: 1 } } } }');
    const invalid = (depth: number, message: RegExp) => throws(
        () => inspect(value, { depth }),
        (error: Error & { code?: string }) => error.code === 'ERR_INVALID_ARG_TYPE' && message.test(error.message),
    );
    invalid(-1, /greater than or equal to 0/);
    invalid(0.5, /integer/);
    invalid(NaN, /integer/);
    strictEqual(inspect(value, 1 as never), '{ a: { b: [Object ...] } }');
    strictEqual(inspect(value, -Infinity as never), '{ a: { b: { c: { d: 1 } } } }');
});

Deno.test('bun: inspect calls the nodejs.util.inspect.custom hook', () => {
    const value = {
        [inspectCustom](depth: number, options: { depth: number }) {
            return `Custom(${depth},${options.depth})`;
        },
    };
    strictEqual(inspect(value), 'Custom(8,8)');
    strictEqual(inspect({ nested: value }), '{ nested: Custom(7,8) }');
});

Deno.test('bun: inspect formats functions and symbol keys', () => {
    function named() {}
    strictEqual(inspect(named), '[Function: named]');
    strictEqual(inspect({ [Symbol.for('k')]: 1 }), '{ [Symbol(k)]: 1 }');
});

Deno.test('bun: inspect formats common builtins and sparse arrays', () => {
    strictEqual(inspect(new Date('2020-01-02T03:04:05.000Z')), '2020-01-02T03:04:05.000Z');
    strictEqual(inspect(new Date(NaN)), 'Invalid Date');
    strictEqual(inspect(/a+b/gi), '/a+b/gi');
    strictEqual(inspect(new Map([['x', 1]])), 'Map(1) { "x": 1 }');
    strictEqual(inspect(new Set([1, 'x'])), 'Set(2) { 1, "x" }');
    strictEqual(inspect(new Uint8Array([1, 2, 255])), 'Uint8Array(3) [ 1, 2, 255 ]');
    strictEqual(inspect(new DataView(new Uint8Array([1, 2]).buffer)), 'DataView(2) [ 1, 2 ]');
    strictEqual(inspect(new Uint8Array([1, 2]).buffer), 'ArrayBuffer(2) [ 1, 2 ]');

    const sparse = new Array(3);
    sparse[1] = 1;
    (sparse as unknown as Record<string, unknown>).x = 2;
    strictEqual(inspect(sparse), '[ empty item, 1, empty item, x: 2 ]');
});

Deno.test('bun: inspect custom hook receives Bun-compatible options', () => {
    let received: unknown[] = [];
    const value = {
        [inspectCustom](...args: unknown[]) {
            received = args;
            return this;
        },
        a: 1,
    };
    strictEqual(inspect(value), '{ a: 1, [Symbol(nodejs.util.inspect.custom)]: [Function: [nodejs.util.inspect.custom]] }');
    strictEqual(received[0], 8);
    deepStrictEqual(Object.keys(received[1] as object), ['stylize', 'depth', 'colors']);
    strictEqual((received[1] as { depth: number }).depth, 8);
    strictEqual((received[1] as { colors: boolean }).colors, false);
    strictEqual(typeof (received[1] as { stylize: unknown }).stylize, 'function');
    strictEqual(received[2], inspect);
});

Deno.test('bun: inspect bounds recursive custom hook results and propagates errors', () => {
    const recursive = {
        [inspectCustom]() {
            return { recursive };
        },
    };
    strictEqual(inspect(recursive),
        '{ recursive: { recursive: { recursive: { recursive: { recursive: { recursive: { recursive: { recursive: { recursive: [Object ...] } } } } } } } } }');
    throws(() => inspect({ [inspectCustom]() { throw new RangeError('hook-failed'); } }), /hook-failed/);
});

Deno.test('bun: inspect recognizes common cross-realm builtins', () => {
    const values = runInNewContext(`[
        new Date('2020-01-02T03:04:05.000Z'),
        new Map([['x', 1]]),
        new Set([1]),
        new Uint8Array([1, 2]),
    ]`) as unknown[];
    strictEqual(values.map(value => inspect(value)).join('\n'), [
        '2020-01-02T03:04:05.000Z',
        'Map(1) { "x": 1 }',
        'Set(1) { 1 }',
        'Uint8Array(2) [ 1, 2 ]',
    ].join('\n'));
});

Deno.test('bun: inspect does not dispatch spoofed builtin tags', () => {
    for (const tag of ['Date', 'RegExp', 'Map', 'Set', 'ArrayBuffer']) {
        strictEqual(inspect({ [Symbol.toStringTag]: tag, a: 1 }),
            `{ a: 1, [Symbol(Symbol.toStringTag)]: "${tag}" }`);
    }
});
