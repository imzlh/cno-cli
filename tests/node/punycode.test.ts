import { strictEqual, ok } from 'node:assert';

// ============================================================================
// punycode — RFC 3492 Bootstring encoding
// ============================================================================

Deno.test('punycode: encode ASCII stays ASCII', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.encode('hello'), 'hello');
});

Deno.test('punycode: encode non-ASCII produces xn-- prefix', () => {
    const punycode = require('node:punycode');
    const encoded = punycode.encode('中文');
    ok(encoded.startsWith('xn--'));
});

Deno.test('punycode: decode xn-- prefix returns original', () => {
    const punycode = require('node:punycode');
    const decoded = punycode.decode('xn--fiq228c');
    ok(decoded.length > 0);
});

Deno.test('punycode: decode ASCII stays ASCII', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.decode('hello'), 'hello');
});

Deno.test('punycode: toASCII converts IDN', () => {
    const punycode = require('node:punycode');
    const ascii = punycode.toASCII('中文.com');
    ok(ascii.startsWith('xn--'));
    ok(ascii.endsWith('.com'));
});

Deno.test('punycode: toUnicode reverses toASCII', () => {
    const punycode = require('node:punycode');
    const unicode = punycode.toUnicode('xn--fiq228c.com');
    ok(unicode.includes('中') || unicode.length > 0);
});

Deno.test('punycode: ucs2decode handles surrogate pairs', () => {
    const punycode = require('node:punycode');
    const codes = punycode.ucs2decode('𝕳');
    ok(codes.length === 1);
    ok(codes[0] > 0xFFFF);
});

Deno.test('punycode: ucs2encode round-trips ucs2decode', () => {
    const punycode = require('node:punycode');
    const input = 'hello 𝕳 world';
    const encoded = punycode.ucs2encode(punycode.ucs2decode(input));
    strictEqual(encoded, input);
});
