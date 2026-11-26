import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { file, YAML } from 'bun';

Deno.test('bun: YAML parses block and flow syntax, scalar types and document streams', () => {
    const source = `%YAML 1.1
---
name: project
items: [true, null, 0123, -0x10, +0o12, .inf, .nan, yes, 1_000]
description: >-
  first line
  second line
literal: |
  one
  two
---
!!timestamp 2026-11-21
`;
    deepStrictEqual(YAML.parse(source), [{
        name: 'project',
        items: [true, null, 123, -16, 10, Infinity, NaN, 'yes', '1_000'],
        description: 'first line second line',
        literal: 'one\ntwo\n',
    }, '2026-11-21']);
    strictEqual(YAML.parse(''), null);
    deepStrictEqual(YAML.parse('---\n---\n'), [null, null]);
    strictEqual(YAML.parse(undefined), 'undefined');
    deepStrictEqual(YAML.parse({}), ['object Object']);
    deepStrictEqual(YAML.parse('[!!int 1.5, !!float 0x10, !!int "1", !!bool "true", !custom true]'), [1.5, 16, '1', 'true', 'true']);
    throws(() => YAML.parse(Symbol()), TypeError);
});

Deno.test('bun: YAML preserves alias identity, cycles, merges and safe duplicate keys', () => {
    const result = YAML.parse(`base: &base {a: 1, b: 2}
same: *base
merged: {<<: [*base, {a: 9, c: 3}], b: 4}
cycle: &cycle [*cycle]
a: 1
a: 2
__proto__: {polluted: true}
true: boolean key
null: null key
[1, 2]: collection key
`);
    strictEqual(result.base, result.same);
    strictEqual(result.cycle, result.cycle[0]);
    deepStrictEqual(result.merged, { b: 4, a: 1, c: 3 });
    strictEqual(result.a, 2);
    strictEqual(result['1,2'], 'collection key');
    strictEqual(result.null, 'null key');
    strictEqual(Object.getPrototypeOf(result), Object.prototype);
    strictEqual(Object.hasOwn(result, '__proto__'), true);
    strictEqual(({} as any).polluted, undefined);
    const reused = YAML.parse('a: &x {v: 1}\nb: &x {v: 2}\nc: *x');
    strictEqual(reused.b, reused.c);
    for (const source of ['a: [1,', 'a: [1,,2]', 'a: *missing', 'a:\n\tb: 2']) {
        throws(() => YAML.parse(source), SyntaxError);
    }
    throws(() => YAML.parse('a: &a\n  <<: *a\n  b: 1'), /Merge key cannot reference an enclosing node/);
});

Deno.test('bun: YAML decodes binary windows and memory blobs synchronously', () => {
    const source = 'name: café\nvalue: 42';
    const bytes = new TextEncoder().encode(`xx${source}yy`);
    const expected = { name: 'café', value: 42 };
    for (const input of [
        bytes.subarray(2, -2), new DataView(bytes.buffer, 2, bytes.length - 4),
        new Blob([source]), new File([source], 'input.yaml'), new Blob([bytes]).slice(2, -2),
    ]) deepStrictEqual(YAML.parse(input), expected);
    strictEqual(YAML.parse(new Uint8Array([0xff, 0x61])), '�a');
    if (typeof SharedArrayBuffer === 'function') {
        const shared = new SharedArrayBuffer(bytes.length);
        new Uint8Array(shared).set(bytes);
        deepStrictEqual(YAML.parse(new DataView(shared, 2, bytes.length - 4)), expected);
    }
    const shadowed = new DataView(bytes.buffer, 2, bytes.length - 4);
    for (const key of ['buffer', 'byteOffset', 'byteLength']) {
        Object.defineProperty(shadowed, key, { get() { throw new Error('shadow getter ran'); } });
    }
    deepStrictEqual(YAML.parse(shadowed), expected);
    const detached = new ArrayBuffer(2);
    const view = new DataView(detached);
    structuredClone(detached, { transfer: [detached] });
    strictEqual(YAML.parse(detached), null);
    strictEqual(YAML.parse(view), null);
    throws(() => YAML.parse(file('not-read-by-YAML')), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
});

Deno.test('bun: YAML emits Bun flow and block layouts with YAML quoting', () => {
    const value = { a: 1, b: [1, 2], c: 'true' };
    strictEqual(YAML.stringify(value), '{a: 1,b: [1,2],c: "true"}');
    strictEqual(YAML.stringify(value, null, 2), 'a: 1\nb:\n  - 1\n  - 2\nc: "true"');
    strictEqual(YAML.stringify(value, null, 'xy'), 'a: 1\nb:\nxy- 1\nxy- 2\nc: "true"');
    strictEqual(YAML.stringify([{ a: [1, 2] }], null, 'xy'), '- a:\nxy  - 1\nxy  - 2');
    strictEqual(YAML.stringify({ a: [{ x: 1, y: [2, 3] }] }, null, 2), 'a:\n  - x: 1\n    "y":\n      - 2\n      - 3');
    for (const text of ['yes', 'y', 'on', '0123', 'true', '1e2', 'a#b', 'x,y', 'a[b]', '-x', '<<', '']) {
        strictEqual(YAML.stringify(text), JSON.stringify(text));
    }
    strictEqual(YAML.stringify('...'), '"..."');
    strictEqual(YAML.parse(YAML.stringify('...')), '...');
    const literalMergeKey = { '<<': { x: 1 } };
    deepStrictEqual(YAML.parse(YAML.stringify(literalMergeKey)), literalMergeKey);
    strictEqual(YAML.stringify('a\0\x07\x1b\x7f\u0085\u00a0\u2028\u2029'), '"a\\0\\a\\e\\x7f\\N\\_\\L\\P"');
    strictEqual(YAML.stringify(NaN), '.nan');
    strictEqual(YAML.stringify(-Infinity), '-.inf');
    strictEqual(YAML.stringify(-0), '-0');
    strictEqual(YAML.stringify(undefined), undefined);
    strictEqual(YAML.stringify([undefined, 1, () => 1, Symbol(), null]), '[1,null]');
    strictEqual(YAML.stringify({ toJSON() { throw new Error('must not run'); }, a: 1 }), '{a: 1}');
    strictEqual(YAML.stringify(new Map([['a', 1]])), '{}');
    strictEqual(YAML.stringify(new Number(3)), '3');
    const array = [1, 2];
    Object.defineProperty(array, Symbol.iterator, { get() { throw new Error('iterator must not run'); } });
    strictEqual(YAML.stringify(array), '[1,2]');
    throws(() => YAML.stringify(1n), /cannot serialize BigInt/);
    throws(() => YAML.stringify(value, []), /does not support the replacer/);
});

Deno.test('bun: YAML serializes shared graphs and circular structures using anchors', () => {
    const shared = { x: 1 };
    const graph = { a: shared, b: shared };
    strictEqual(YAML.stringify(graph), '{a: &a {x: 1},b: *a}');
    strictEqual(YAML.stringify(graph, null, 2), 'a:\n  &a\n  x: 1\nb:\n  *a');
    strictEqual(YAML.stringify([shared, shared]), '[&item0 {x: 1},*item0]');
    const circular: any = { x: 1 };
    circular.self = circular;
    strictEqual(YAML.stringify(circular), '&root {x: 1,self: *root}');
    strictEqual(YAML.stringify(circular, null, 2), '&root\nx: 1\nself:\n  *root');
    strictEqual(YAML.stringify([{}, []], null, 1), '- {}\n- []');
    const empty = {};
    strictEqual(YAML.stringify({ a: empty, b: empty }, null, 2), 'a:\n  &a\n  {}\nb:\n  *a');
    const nested = { a: { b: { c: 1 } }, d: [1, [2, [3]], { x: { z: 4 } }] };
    for (const gap of [1, 2, 3, 10]) {
        deepStrictEqual(YAML.parse(YAML.stringify(nested, null, gap)), nested);
    }
    let reads = 0;
    const changing = { get value() { reads++; return { self: this }; } };
    strictEqual(YAML.stringify(changing), '&root {value: {self: *root}}');
    strictEqual(reads, 2);
    for (const space of [undefined, 2]) {
        const parsed = YAML.parse(YAML.stringify(circular, null, space));
        strictEqual(parsed, parsed.self);
    }
});
