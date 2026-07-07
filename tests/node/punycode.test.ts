import { deepStrictEqual, strictEqual, ok } from 'node:assert';

// ============================================================================
// punycode — RFC 3492 Bootstring encoding
// ============================================================================

Deno.test('punycode: encode ASCII appends delimiter per Node behavior', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.encode('hello'), 'hello-');
});

Deno.test('punycode: encode non-ASCII returns punycode payload without xn-- prefix', () => {
    const punycode = require('node:punycode');
    const encoded = punycode.encode('中文');
    strictEqual(encoded, 'fiq228c');
});

Deno.test('punycode: decode payload returns original unicode string', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.decode('fiq228c'), '中文');
});

Deno.test('punycode: decode reverses encode for ASCII payload', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.decode('hello-'), 'hello');
});

Deno.test('punycode: toASCII converts IDN', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.toASCII('中文.com'), 'xn--fiq228c.com');
});

Deno.test('punycode: toUnicode reverses toASCII', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.toUnicode('xn--fiq228c.com'), '中文.com');
});

Deno.test('punycode: ucs2.decode handles surrogate pairs', () => {
    const punycode = require('node:punycode');
    const codes = punycode.ucs2.decode('𝕳');
    ok(codes.length === 1);
    ok(codes[0] > 0xFFFF);
});

Deno.test('punycode: ucs2.encode round-trips ucs2.decode', () => {
    const punycode = require('node:punycode');
    const input = 'hello 𝕳 world';
    const encoded = punycode.ucs2.encode(punycode.ucs2.decode(input));
    strictEqual(encoded, input);
});

Deno.test('punycode: version is string', () => {
    const punycode = require('node:punycode');
    ok(typeof punycode.version === 'string');
});

Deno.test('punycode: encode empty string stays empty', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.encode(''), '');
});

Deno.test('punycode: decode is case-insensitive for ASCII payload letters', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.decode('FIQ228C'), '中文');
});

Deno.test('punycode: encode/decode round-trip astral code points', () => {
    const punycode = require('node:punycode');
    const input = 'hello 😀 world';
    strictEqual(punycode.decode(punycode.encode(input)), input);
});

Deno.test('punycode: toASCII only encodes the unicode label in a mixed domain', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.toASCII('www.中文.com'), 'www.xn--fiq228c.com');
});

Deno.test('punycode: toASCII preserves local-part before @', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.toASCII('user@中文.com'), 'user@xn--fiq228c.com');
});

Deno.test('punycode: toASCII normalizes unicode dot separators', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.toASCII('中文。com'), 'xn--fiq228c.com');
});

Deno.test('punycode: toUnicode leaves uppercase XN-- prefix untouched', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.toUnicode('XN--FIQ228C.COM'), 'XN--FIQ228C.COM');
});

Deno.test('punycode: toUnicode leaves plain ASCII domains unchanged', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.toUnicode('example.com'), 'example.com');
});

Deno.test('punycode: toASCII encodes accented latin labels', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.toASCII('mañana.com'), 'xn--maana-pta.com');
});

Deno.test('punycode: toUnicode decodes punycoded latin labels', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.toUnicode('xn--maana-pta.com'), 'mañana.com');
});

Deno.test('punycode: toASCII leaves punycoded labels unchanged', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.toASCII('xn--maana-pta.com'), 'xn--maana-pta.com');
});

Deno.test('punycode: decode empty string stays empty', () => {
    const punycode = require('node:punycode');
    strictEqual(punycode.decode(''), '');
});

Deno.test('punycode upstream: replacement character labels round-trip through ASCII', () => {
    const punycode = require('node:punycode');
    const input = '个\uFFFD\uFFFD.hk';
    strictEqual(punycode.toASCII(input), 'xn--ciq6844ba.hk');
    strictEqual(punycode.toUnicode('xn--ciq6844ba.hk'), input);
});

Deno.test('punycode: ucs2.decode preserves unpaired surrogates as code units', () => {
    const punycode = require('node:punycode');
    deepStrictEqual(punycode.ucs2.decode(`a${String.fromCharCode(0xD83D)}`), [0x61, 0xD83D]);
});
