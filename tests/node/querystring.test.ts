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
