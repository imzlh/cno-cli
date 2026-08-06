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

// --- 13. unescape does NOT decode + as space ------------------------------

// Verified against real Node v24.18.0: qsUnescape is decodeURIComponent with a
// Buffer fallback and never maps '+'. Only parse() rewrites '+' before decoding.
// The decodeSpaces flag applies solely on the fallback path, so it is invisible
// unless decodeURIComponent actually throws.
Deno.test('querystring: unescape leaves + alone but parse decodes it', () => {
    strictEqual(querystring.unescape('a+b'), 'a+b');
    strictEqual(querystring.unescape('a+b', true), 'a+b');
    strictEqual(querystring.unescape('a%20b'), 'a b');
    // decodeURIComponent throws here, so decodeSpaces reaches the fallback.
    strictEqual(querystring.unescape('a+b%zz'), 'a+b%zz');
    strictEqual(querystring.unescape('a+b%zz', true), 'a b%zz');
    // parse() does map '+', in both keys and values.
    deepStrictEqual(Object.entries(querystring.parse('a+b=c+d')), [['a b', 'c d']]);
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

Deno.test('querystring: escape percent-encodes spaces and reserved punctuation', () => {
    strictEqual(querystring.escape('hello world'), 'hello%20world');
    ok(querystring.escape('a=b&c').includes('%'));
    strictEqual(querystring.escape("~!'()*"), "~!'()*");
});

Deno.test('querystring: escape encodes emoji code points as UTF-8 percent sequences', () => {
    // Surrogate pairs must not be fed to encodeURIComponent one unit at a time.
    strictEqual(querystring.escape('😀'), '%F0%9F%98%80');
    strictEqual(querystring.escape('a😀b'), 'a%F0%9F%98%80b');
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

// --- regressions: measured against real Node v24.18.0 ----------------------

// Node's unescape fallback is unescapeBuffer(s).toString(): every UTF-16 code
// unit is truncated to one byte and joins the SAME byte stream as the
// percent-decoded bytes before a single UTF-8 decode. So a literal U+4E2D
// becomes the byte 0x2D ('-'), and a surrogate pair becomes 0x3D 0x00.
Deno.test('querystring: unescape byte-truncates literals on the fallback path', () => {
    strictEqual(querystring.unescape('%zz中'), '%zz-');
    strictEqual(querystring.unescape('中%zz'), '-%zz');
    strictEqual(querystring.unescape('%zz中A'), '%zz-A');
    strictEqual(querystring.unescape('%zz\u{1F600}'), '%zz=\u0000');
    strictEqual(querystring.unescape('%zzÿ'), '%zz\uFFFD');
    strictEqual(querystring.unescape('%zzĀ'), '%zz\u0000');
    // The truncated byte participates in the same UTF-8 decode: %E4 %B8 is an
    // incomplete sequence (one U+FFFD), then 0x2D from the literal.
    strictEqual(querystring.unescape('%E4%B8中'), '\uFFFD-');
    // No fallback when decodeURIComponent succeeds, so the literal survives.
    strictEqual(querystring.unescape('中'), '中');
});

// Node's parse only calls the decoder once it has seen a plausible %XX
// (keyEncoded/valEncoded). Decoding unconditionally is observably wrong: with no
// valid escape the literal is preserved, but one valid escape arms the gate and
// the fallback then truncates.
Deno.test('querystring: parse only decodes segments holding a valid escape', () => {
    deepStrictEqual(Object.entries(querystring.parse('k=a+中%zz')), [['k', 'a 中%zz']]);
    deepStrictEqual(Object.entries(querystring.parse('a+中%zz')), [['a 中%zz', '']]);
    // %41 arms the gate, decodeURIComponent then throws on %zz -> truncation.
    deepStrictEqual(Object.entries(querystring.parse('k=%41中%zz')), [['k', 'A-%zz']]);
    deepStrictEqual(Object.entries(querystring.parse('%41中%zz=v')), [['A-%zz', 'v']]);
    // Incomplete escapes never arm the gate.
    deepStrictEqual(Object.entries(querystring.parse('k=%4')), [['k', '%4']]);
    deepStrictEqual(Object.entries(querystring.parse('k=%G1')), [['k', '%G1']]);
});

// Node matches sep and eq in one pass, with the eq test in the ELSE branch of
// the sep match. A char that advances the sep prefix is therefore never tested
// as eq, which split()+indexOf() cannot reproduce.
Deno.test('querystring: parse gives separator matching priority over equals', () => {
    deepStrictEqual(Object.entries(querystring.parse('k%ad', 'ab', 'a')), [['k%ad', '']]);
    deepStrictEqual(Object.entries(querystring.parse('xay', 'ab', 'a')), [['xay', '']]);
    // On a failed sep-prefix advance, sepIdx resets and the SAME char is then
    // tested as eq (it is not re-tested as a fresh sep start), so the second 'a'
    // here becomes the separator between key and value.
    deepStrictEqual(Object.entries(querystring.parse('xaay', 'ab', 'a')), [['xa', 'y']]);
    // A self-overlapping separator also differs from String.split.
    deepStrictEqual(Object.entries(querystring.parse('aab=1', 'ab', '=')), [['aab', '1']]);
    // Trailing text after a completed separator becomes a fresh empty-valued key.
    deepStrictEqual(Object.entries(querystring.parse('k=vaba', 'ab', '=')), [['k', 'v'], ['a', '']]);
    deepStrictEqual(Object.entries(querystring.parse('k=va', 'ab', '=')), [['k', 'va']]);
});

// Node exports qsEscape/qsUnescape under the escape/unescape names because both
// are JS globals, and parse/stringify both declare four parameters.
Deno.test('querystring: function names and arities match Node', () => {
    strictEqual(querystring.escape.name, 'qsEscape');
    strictEqual(querystring.unescape.name, 'qsUnescape');
    strictEqual(querystring.parse.length, 4);
    strictEqual(querystring.stringify.length, 4);
    strictEqual(querystring.escape.length, 1);
    strictEqual(querystring.unescape.length, 2);
    strictEqual(querystring.decode, querystring.parse);
    strictEqual(querystring.encode, querystring.stringify);
});

Deno.test('querystring: unescapeBuffer truncates and honours decodeSpaces', () => {
    deepStrictEqual([...querystring.unescapeBuffer('a+b')], [0x61, 0x2b, 0x62]);
    deepStrictEqual([...querystring.unescapeBuffer('a+b', true)], [0x61, 0x20, 0x62]);
    deepStrictEqual([...querystring.unescapeBuffer('%E4%B8%AD')], [0xe4, 0xb8, 0xad]);
    // A malformed escape emits a literal '%' and rescans from the next char.
    deepStrictEqual([...querystring.unescapeBuffer('%4z')], [0x25, 0x34, 0x7a]);
    deepStrictEqual([...querystring.unescapeBuffer('%zz')], [0x25, 0x7a, 0x7a]);
    // A trailing '%' with fewer than two chars after it stays literal.
    deepStrictEqual([...querystring.unescapeBuffer('a%')], [0x61, 0x25]);
    deepStrictEqual([...querystring.unescapeBuffer('%2')], [0x25, 0x32]);
    // Literals above U+00FF are truncated to their low byte.
    deepStrictEqual([...querystring.unescapeBuffer('中')], [0x2d]);
});
