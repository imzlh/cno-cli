import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import * as querystring from 'node:querystring';

// --- 1. stringify basic ---------------------------------------------------

Deno.test('querystring: stringify basic object', () => {
    strictEqual(querystring.stringify({ a: '1', b: '2' }), 'a=1&b=2');
});

// --- 2. stringify with custom separator and equals ------------------------

Deno.test('querystring: stringify with custom sep and eq', () => {
    strictEqual(querystring.stringify({ a: '1', b: '2' }, ';', ':'), 'a:1;b:2');
});

// --- 3. stringify encodes special chars -----------------------------------

Deno.test('querystring: stringify percent-encodes spaces and reserved', () => {
    const s = querystring.stringify({ q: 'hello world' });
    ok(s.includes('hello') && !s.includes(' '), 'spaces must be encoded');
});

// --- 4. stringify arrays --------------------------------------------------

Deno.test('querystring: stringify array values', () => {
    const s = querystring.stringify({ a: ['1', '2'] });
    strictEqual(s, 'a=1&a=2');
});

// --- 5. stringify empty string value --------------------------------------

Deno.test('querystring: stringify empty value', () => {
    strictEqual(querystring.stringify({ a: '' }), 'a=');
});

// --- 6. parse basic -------------------------------------------------------

Deno.test('querystring: parse basic string', () => {
    const o = querystring.parse('a=1&b=2');
    strictEqual(o.a, '1');
    strictEqual(o.b, '2');
});

// --- 7. parse repeated keys into array ------------------------------------

Deno.test('querystring: parse repeated keys into array', () => {
    const o = querystring.parse('a=1&a=2');
    deepStrictEqual(o.a, ['1', '2']);
});

// --- 8. parse + decode round-trip -----------------------------------------

Deno.test('querystring: stringify then parse round-trips', () => {
    const obj = { q: 'hello world', n: '42' };
    const s = querystring.stringify(obj);
    const back = querystring.parse(s);
    strictEqual(back.q, 'hello world');
    strictEqual(back.n, '42');
});

// --- 9. parse empty value -------------------------------------------------

Deno.test('querystring: parse empty value', () => {
    const o = querystring.parse('a=&b=2');
    strictEqual(o.a, '');
    strictEqual(o.b, '2');
});

// --- 10. parse with custom sep and eq -------------------------------------

Deno.test('querystring: parse with custom sep and eq', () => {
    const o = querystring.parse('a:1;b:2', ';', ':');
    strictEqual(o.a, '1');
    strictEqual(o.b, '2');
});

// --- 11. parse maxKeys limits keys ----------------------------------------

Deno.test('querystring: parse maxKeys limits keys', () => {
    const o = querystring.parse('a=1&b=2&c=3', '&', '=', { maxKeys: 2 });
    ok('a' in o);
    ok('b' in o);
    ok(!('c' in o), 'c must be dropped after maxKeys');
});

// --- 12. escape / unescape ------------------------------------------------

Deno.test('querystring: escape/unescape round-trips', () => {
    const s = 'hello world & friends=you';
    const escaped = querystring.escape(s);
    ok(!escaped.includes(' '));
    strictEqual(querystring.unescape(escaped), s);
});

// --- 13. unescape decodes + as space --------------------------------------

Deno.test('querystring: unescape decodes + as space', () => {
    strictEqual(querystring.unescape('a+b'), 'a b');
});

// --- 14. stringify with encodeURIComponent option -------------------------

Deno.test('querystring: stringify with custom encodeURIComponent', () => {
    const s = querystring.stringify({ q: 'a/b' }, '&', '=', {
        encodeURIComponent: (x) => x.replace(/\//g, '%2F'),
    });
    ok(s.includes('%2F'));
});

// --- 15. parse with decodeURIComponent option -----------------------------

Deno.test('querystring: parse with custom decodeURIComponent', () => {
    const o = querystring.parse('q=a%2Fb', '&', '=', {
        decodeURIComponent: (x) => x.replace(/%2F/g, '/'),
    });
    strictEqual(o.q, 'a/b');
});

// --- 16. parse keeps bare keys and skips empty segments --------------------

Deno.test('querystring: parse treats bare keys as empty strings', () => {
    const o = querystring.parse('a&b=');
    strictEqual(o.a, '');
    strictEqual(o.b, '');
});

Deno.test('querystring: parse ignores empty segments between separators', () => {
    const o = querystring.parse('a=1&&b=2&c');
    strictEqual(o.a, '1');
    strictEqual(o.b, '2');
    strictEqual(o.c, '');
    ok(!('' in o), 'empty separator segment must not create an empty key');
});

Deno.test('querystring: parse maxKeys 0 means unlimited', () => {
    const o = querystring.parse('a=1&b=2&c=3', '&', '=', { maxKeys: 0 });
    strictEqual(o.a, '1');
    strictEqual(o.b, '2');
    strictEqual(o.c, '3');
});

// --- 19. stringify coerces primitives and empties nullish values ----------

Deno.test('querystring: stringify coerces numbers and booleans', () => {
    strictEqual(querystring.stringify({ n: 1, t: true, f: false }), 'n=1&t=true&f=false');
});

Deno.test('querystring: stringify serializes null and undefined as empty values', () => {
    strictEqual(querystring.stringify({ a: undefined, b: null, c: '' }), 'a=&b=&c=');
});

Deno.test('querystring: stringify serializes nullish array entries as empty values', () => {
    strictEqual(querystring.stringify({ a: [1, null, undefined, ''] }), 'a=1&a=&a=&a=');
});

Deno.test('querystring: stringify serializes non-finite numbers as empty values', () => {
    strictEqual(querystring.stringify({ a: NaN, b: Infinity, c: -Infinity }), 'a=&b=&c=');
});

Deno.test('querystring: stringify non-objects as empty string', () => {
    strictEqual(querystring.stringify(null as unknown as Record<string, unknown>), '');
    strictEqual(querystring.stringify(undefined as unknown as Record<string, unknown>), '');
    strictEqual(querystring.stringify('abc' as unknown as Record<string, unknown>), '');
});

Deno.test('querystring: stringify falsy separators use defaults', () => {
    strictEqual(
        querystring.stringify({ a: 1, b: 2 }, '' as unknown as string, '' as unknown as string),
        'a=1&b=2',
    );
});

// --- 23. escape keeps extra RFC 2396 punctuation unescaped -----------------

Deno.test('querystring: escape leaves !\'()* unescaped like Node', () => {
    strictEqual(querystring.escape("!'()*"), "!'()*");
});

Deno.test('querystring: parse preserves empty key before equals sign', () => {
    const o = querystring.parse('=x');
    strictEqual(o[''], 'x');
});

Deno.test('querystring: parse decodes plus signs in keys and values', () => {
    const o = querystring.parse('a+b=c+d');
    strictEqual(o['a b'], 'c d');
});

Deno.test('querystring: parse passes plus signs as percent spaces to custom decoder', () => {
    const calls: string[] = [];
    const o = querystring.parse('a+b=c+d', '&', '=', {
        decodeURIComponent: (value) => {
            calls.push(value);
            return `decoded:${value}`;
        },
    });

    strictEqual(o['decoded:a%20b'], 'decoded:c%20d');
    deepStrictEqual(calls, ['a%20b', 'c%20d']);
});

Deno.test('querystring: parse tolerates malformed percent escapes', () => {
    const o = querystring.parse('a=%E0%A4%A');
    strictEqual(o.a, '\uFFFD%A');
});

Deno.test('querystring: parse falls back when a custom decoder throws', () => {
    const o = querystring.parse('a=%E0%A4%A&b=ok', '&', '=', {
        decodeURIComponent: () => {
            throw new Error('bad decoder');
        },
    });

    strictEqual(o.a, '\uFFFD%A');
    strictEqual(o.b, 'ok');
});

Deno.test('querystring: unescape tolerates malformed percent escapes', () => {
    strictEqual(querystring.unescape('%E0%A4%A'), '\uFFFD%A');
});

Deno.test('querystring: parse returns null-prototype object', () => {
    strictEqual(Object.getPrototypeOf(querystring.parse('a=1')), null);
});

Deno.test('querystring: parse non-strings as empty null-prototype object', () => {
    const parsed = querystring.parse(123 as unknown as string);
    strictEqual(Object.getPrototypeOf(parsed), null);
    strictEqual(Object.keys(parsed).length, 0);
});

Deno.test('querystring: parse falsy separators use defaults', () => {
    const parsed = querystring.parse(
        'a=1&b=2',
        '' as unknown as string,
        '' as unknown as string,
    );
    strictEqual(parsed.a, '1');
    strictEqual(parsed.b, '2');
});
