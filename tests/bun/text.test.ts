import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { stringWidth, stripANSI } from '../../cno/src/bun/utils/text.ts';

Deno.test('bun: stripANSI removes CSI, OSC hyperlinks, and keeps plain text', () => {
    strictEqual(stripANSI('\x1b[31mred\x1b[0m'), 'red');
    strictEqual(stripANSI('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'), 'link');
    strictEqual(stripANSI('\x1b]8;;u\x1b\\link\x1b]8;;\x1b\\'), 'link');
    strictEqual(stripANSI('\x9b31mx\x9b0m'), 'x');
    strictEqual(stripANSI('a\x1b'), 'a\x1b');
    strictEqual(stripANSI('\x1b]8;;unterminated'), '\x1b]8;;unterminated');
    strictEqual(stripANSI('plain café'), 'plain café');
    throws(() => stripANSI(1 as unknown as string), TypeError);
});

Deno.test('bun: stringWidth counts terminal cells', () => {
    strictEqual(stringWidth('abc'), 3);
    strictEqual(stringWidth('\x1b[31mabc\x1b[0m'), 3);
    strictEqual(stringWidth('\x1b[31mabc\x1b[0m', { countAnsiEscapeCodes: true }), 10);
    strictEqual(stringWidth('中文'), 4);
    strictEqual(stringWidth('e\u0301'), 1);
    strictEqual(stringWidth('👍🏽'), 2);
    strictEqual(stringWidth('👨‍👩‍👧'), 2);
    strictEqual(stringWidth('🇺🇸🇫🇷'), 4);
    strictEqual(stringWidth('a\u200bb'), 2);
    strictEqual(stringWidth('a\x07b'), 2);
    strictEqual(stringWidth('①'), 1);
    strictEqual(stringWidth('①', { ambiguousIsNarrow: false }), 2);
    strictEqual(stringWidth('#️⃣'), 2);
    deepStrictEqual(stringWidth(''), 0);
    throws(() => stringWidth(1 as unknown as string), TypeError);
});

Deno.test('bun: stringWidth groups grapheme clusters by default', () => {
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}';
    strictEqual(stringWidth(family), 2);
    strictEqual(stringWidth('a' + family + 'b'), 4);
    strictEqual(stringWidth('\u{1F1FA}\u{1F1F8}\u{1F1EB}'), 4);
    strictEqual(stringWidth('a\u{1F1FA}\u{1F1F8}'), 3);
    strictEqual(stringWidth('\u{1F44D}\u{1F3FD}'), 2);
    strictEqual(stringWidth('\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'), 2);
    strictEqual(stringWidth('\u263A\uFE0F'), 2);
    strictEqual(stringWidth('\u{1F1FA}\u200b\u{1F1F8}'), 4);
});

Deno.test('bun: stringWidth perCodePoint measures each code point', () => {
    const opt = { perCodePoint: true };
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}';
    strictEqual(stringWidth(family, opt), 8);
    strictEqual(stringWidth('a' + family + 'b', opt), 10);
    strictEqual(stringWidth('\u{1F1FA}\u{1F1F8}', opt), 4);
    strictEqual(stringWidth('\u{1F44D}\u{1F3FD}', opt), 4);
    strictEqual(stringWidth('e\u0301', opt), 1);
    strictEqual(stringWidth('\u4e2d\u6587', opt), 4);
    strictEqual(stringWidth('\u2460', opt), 1);
    strictEqual(stringWidth('\u2460', { ...opt, ambiguousIsNarrow: false }), 2);
    strictEqual(stringWidth('\x1b[31mabc\x1b[0m', { ...opt, countAnsiEscapeCodes: true }), 10);
    strictEqual(stringWidth('\x1b[31mabc\x1b[0m', opt), 3);
    strictEqual(stringWidth('', opt), 0);
    throws(() => stringWidth(1 as unknown as string, opt), TypeError);
});
