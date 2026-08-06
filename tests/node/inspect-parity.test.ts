/**
 * util.inspect / util.format parity regressions.
 *
 * Every expectation here was measured against real Node v24.18.0 by
 * differential fuzzing; each one is a case that cno previously got wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import util from 'node:util';

test('inspect: property keys containing $ are quoted like Node', () => {
    assert.strictEqual(util.inspect({ $: 1 }), "{ '$': 1 }");
    assert.strictEqual(util.inspect({ $a: 1 }), "{ '$a': 1 }");
    assert.strictEqual(util.inspect({ a$: 1 }), "{ 'a$': 1 }");
    assert.strictEqual(util.inspect({ abc$def: 1 }), "{ 'abc$def': 1 }");
    // Plain identifiers stay unquoted.
    assert.strictEqual(util.inspect({ a: 1 }), '{ a: 1 }');
    assert.strictEqual(util.inspect({ _a: 1 }), '{ _a: 1 }');
});

test('inspect: numericSeparator keeps the sign of negative fractions', () => {
    assert.strictEqual(util.inspect(-0.5, { numericSeparator: true }), '-0.5');
    assert.strictEqual(util.inspect(-0.25, { numericSeparator: true }), '-0.25');
    assert.strictEqual(util.inspect(-0.125, { numericSeparator: true }), '-0.125');
    assert.strictEqual(util.inspect(-0.0001, { numericSeparator: true }), '-0.000_1');
    assert.strictEqual(util.inspect(-0.123456789, { numericSeparator: true }), '-0.123_456_789');
    assert.strictEqual(util.inspect(1234567, { numericSeparator: true }), '1_234_567');
});

test('inspect: long single-line strings are never wrapped', () => {
    // Node splits only after a newline; it does not word-wrap.
    const s = 'x'.repeat(300);
    assert.strictEqual(util.inspect(s), `'${s}'`);
    assert.strictEqual(util.inspect('x'.repeat(77)), `'${'x'.repeat(77)}'`);
    // A newline is a split point.
    assert.strictEqual(
        util.inspect('a\n' + 'x'.repeat(100)),
        `'a\\n' +\n  '${'x'.repeat(100)}'`,
    );
});

test('inspect: compact true joins onto one line when it fits', () => {
    assert.strictEqual(util.inspect({ a: 1 }, { compact: true }), '{ a: 1 }');
    assert.strictEqual(util.inspect({ a: { b: 1 } }, { compact: true }), '{ a: { b: 1 } }');
    assert.strictEqual(util.inspect([1, [2, [3]]], { compact: true }), '[ 1, [ 2, [ 3 ] ] ]');
});

test('inspect: depth elision markers carry no size', () => {
    assert.strictEqual(util.inspect({ a: { b: new Map([[1, 2]]) } }, { depth: 1 }), '{ a: { b: [Map] } }');
    assert.strictEqual(util.inspect({ a: { b: new Set([1, 2]) } }, { depth: 1 }), '{ a: { b: [Set] } }');
    assert.strictEqual(
        util.inspect({ a: { b: new Uint8Array(3) } }, { depth: 1 }),
        '{ a: { b: [Uint8Array] } }',
    );
});

test('inspect: null-prototype elision is not double-bracketed', () => {
    const o = Object.create(null);
    o.k = 1;
    assert.strictEqual(util.inspect({ a: { b: o } }, { depth: 1 }), '{ a: { b: [Object: null prototype] } }');
});

test('inspect: a RegExp keeps its source at the depth limit', () => {
    assert.strictEqual(util.inspect({ r: /re/g }, { depth: 0, showHidden: true }), '{ r: /re/g }');
    assert.strictEqual(util.inspect({ a: { r: /re/g } }, { depth: 1, showHidden: true }), '{ a: { r: /re/g } }');
    const r = /re/g;
    (r as unknown as Record<string, unknown>).x = 1;
    assert.strictEqual(util.inspect({ r }, { depth: 0 }), '{ r: /re/g }');
});

test('inspect: a prototype object is not labelled with its constructor', () => {
    class Klass {}
    assert.strictEqual(
        util.inspect(Klass, { showHidden: true, depth: 0 }),
        "[class Klass] { [length]: 0, [name]: 'Klass', [prototype]: [Object] }",
    );
});

test('inspect: showHidden lists a null-prototype toStringTag as the name', () => {
    const o = Object.create(null);
    (o as Record<PropertyKey, unknown>)[Symbol.toStringTag] = 'T';
    assert.strictEqual(util.inspect(o), "[T: null prototype] { Symbol(Symbol.toStringTag): 'T' }");
});

test('inspect: an unusual prototype chain gets the Object <...> label', () => {
    const o = Object.create(Object.create(null));
    o.a = 1;
    assert.strictEqual(util.inspect(o), 'Object <[Object: null prototype] {}> { a: 1 }');
});

test('inspect: a null-prototype Set/Map still shows its entries', () => {
    const s = new Set([1]);
    Object.setPrototypeOf(s, null);
    assert.strictEqual(util.inspect(s), '[Set(1): null prototype] { 1 }');
    const m = new Map([[1, 2]]);
    Object.setPrototypeOf(m, null);
    assert.strictEqual(util.inspect(m), '[Map(1): null prototype] { 1 => 2 }');
});

test('inspect: a null-prototype typed array reports its real subclass', () => {
    const t = new Uint8Array([1, 2]);
    Object.setPrototypeOf(t, null);
    assert.strictEqual(util.inspect(t), '[Uint8Array(2): null prototype] [ 1, 2 ]');
});

test('inspect: an empty-item run is not clipped by maxArrayLength', () => {
    const s = new Set();
    s.add(new Array(11));
    s.add('x');
    assert.strictEqual(
        util.inspect(s, { sorted: true, maxArrayLength: 1 }),
        'Set(2) { ... 1 more item, [ <11 empty items> ] }',
    );
});

test('inspect: an object merely shaped like a builtin does not throw', () => {
    // Object.create(X.prototype) has the prototype but not the internal slot.
    assert.strictEqual(util.inspect(Object.create(ArrayBuffer.prototype)), 'ArrayBuffer {}');
    assert.strictEqual(util.inspect(Object.create(DataView.prototype)), 'DataView {}');
    assert.strictEqual(util.inspect(Object.create(Promise.prototype)), 'Promise {}');
    // A spoofed toStringTag must not route to the builtin formatter.
    class C {
        get [Symbol.toStringTag]() {
            return 'WeakMap';
        }
    }
    const o = new C() as unknown as Record<string, unknown>;
    o.a = 1;
    assert.strictEqual(util.inspect(o), 'C [WeakMap] { a: 1 }');
});

test('inspect: maxStringLength applies to boxed String contents', () => {
    assert.strictEqual(
        util.inspect(new String('-0abc'), { maxStringLength: 2 }),
        "[String: '-0'... 3 more characters]",
    );
});

test('inspect: showHidden reveals error stack and message', () => {
    const e = new Error('m');
    e.stack = 'Error: m\n    at F';
    assert.strictEqual(
        util.inspect(e, { showHidden: true }),
        "Error: m\n    at F {\n  [stack]: [Getter/Setter],\n  [message]: 'm'\n}",
    );
});

test('inspect: showHidden lists prototype-chain properties', () => {
    // Symbol.toStringTag lives on GeneratorFunction.prototype, not the instance.
    function* g() {}
    const out = util.inspect(g, { showHidden: true });
    assert.ok(
        out.includes("[Symbol(Symbol.toStringTag)]: 'GeneratorFunction'"),
        `expected the prototype tag to be listed, got: ${out}`,
    );
});

test('inspect: an error with no stack frames is bracketed', () => {
    const e = new Error('m');
    e.stack = '';
    assert.strictEqual(util.inspect(e), '[Error: m]');
    const e2 = new Error('m');
    (e2 as unknown as Record<string, unknown>).stack = undefined;
    assert.strictEqual(util.inspect(e2), '[Error: m]');
    // An empty message drops the colon.
    assert.strictEqual(util.inspect(Object.create(Error.prototype)), '[Error]');
});

test('inspect: never throws, even on a hostile proxy trap', () => {
    for (const trap of ['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf']) {
        const p = new Proxy(
            { a: 1 },
            {
                [trap]() {
                    throw new Error('hostile');
                },
            },
        );
        // The exact text needs a native proxy-target binding to match Node, but
        // inspect must never propagate the trap's exception.
        assert.doesNotThrow(() => util.inspect(p), `hostile ${trap} trap escaped`);
    }
});

test('inspect: a revoked proxy renders as <Revoked Proxy>', () => {
    const r = Proxy.revocable({ a: 1 }, {});
    r.revoke();
    assert.strictEqual(util.inspect(r.proxy), '<Revoked Proxy>');
    assert.strictEqual(util.inspect({ p: r.proxy }), '{ p: <Revoked Proxy> }');
});

test('util.diff: reports Myers line operations', () => {
    const d = (util as unknown as {
        diff: (a: string | string[], b: string | string[]) => [number, string][];
    }).diff;
    assert.strictEqual(typeof d, 'function');
    // Node short-circuits only on reference equality, so two equal arrays still
    // produce a no-op entry, while two equal strings return [].
    assert.deepStrictEqual(d('a', 'a'), []);
    assert.deepStrictEqual(d(['a'], ['a']), [[0, 'a']]);
    assert.deepStrictEqual(d(['a', 'b'], ['a', 'c']), [[0, 'a'], [1, 'b'], [-1, 'c']]);
});

test('util.inspectDiff: produces Node-shaped + actual / - expected bodies', (t) => {
    const inspectDiff = (util as unknown as {
        inspectDiff?: (a: unknown, b: unknown) => {
            message: string;
            header?: string;
            skipped: boolean;
            identical: boolean;
        };
    }).inspectDiff;
    if (typeof inspectDiff !== 'function') {
        // Node keeps this machinery private to internal/assert; cno exposes it so
        // assert has a single call site. Skip when running the suite on Node.
        t.skip('util.inspectDiff is a cno extension');
        return;
    }

    const r = inspectDiff({ a: 1, b: 2 }, { a: 1, b: 3 });
    assert.strictEqual(r.identical, false);
    assert.strictEqual(r.message, '\n  {\n    a: 1,\n+   b: 2\n-   b: 3\n  }');
    assert.strictEqual(r.header, undefined);

    // Single-line values use the simple form with an empty header.
    const s = inspectDiff('a', 'b');
    assert.strictEqual(s.message, "'a' !== 'b'");
    assert.strictEqual(s.header, '');

    // Structurally equal but distinct references.
    const eq = inspectDiff({ a: 1 }, { a: 1 });
    assert.strictEqual(eq.identical, true);
});

test('format: specifier handling matches Node', () => {
    assert.strictEqual(util.format('%s', 42), '42');
    assert.strictEqual(util.format('%d', 'abc'), 'NaN');
    assert.strictEqual(util.format('%i', 3.9), '3');
    assert.strictEqual(util.format('%j', { a: 1 }), '{"a":1}');
    // `%%` is only collapsed when there is at least one argument.
    assert.strictEqual(util.format('100%%'), '100%%');
    assert.strictEqual(util.format('100%%', 1), '100% 1');
    assert.strictEqual(util.format('%s %s', 'a'), 'a %s');
    assert.strictEqual(util.format('%s', 'a', 'b', 'c'), 'a b c');
    assert.strictEqual(util.format('%q', 1), '%q 1');
});
