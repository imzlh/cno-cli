import { strictEqual, throws } from 'node:assert';
import { sliceAnsi, wrapAnsi } from '../../cno/src/bun/utils/text.ts';

const ESC = '\x1b';
const RED = `${ESC}[31m`;
const RED_OFF = `${ESC}[39m`;
const BOLD = `${ESC}[1m`;
const BOLD_OFF = `${ESC}[22m`;
const LINK = (uri: string) => `${ESC}]8;;${uri}\x07`;
const LINK_END = `${ESC}]8;;\x07`;

Deno.test('bun: sliceAnsi slices by columns', () => {
    strictEqual(sliceAnsi('hello', 1, 4), 'ell');
    strictEqual(sliceAnsi('hello'), 'hello');
    strictEqual(sliceAnsi('hello', 4, 1), '');
    strictEqual(sliceAnsi('hello', 10), '');
    strictEqual(sliceAnsi('hello', -3), 'llo');
    strictEqual(sliceAnsi('hello', 0, -1), 'hell');
    strictEqual(sliceAnsi('hello', -100, 2), 'he');
    strictEqual(sliceAnsi('hello', 1.9, 3.2), 'el');
    strictEqual(sliceAnsi('', 0, 5), '');
});

Deno.test('bun: sliceAnsi reopens and closes SGR styles at the edges', () => {
    strictEqual(sliceAnsi(`${RED}hello${RED_OFF}`, 1, 4), `${RED}ell${RED_OFF}`);
    strictEqual(sliceAnsi(`${RED}hello`, 1, 3), `${RED}el${RED_OFF}`);
    strictEqual(sliceAnsi(`a${RED}bc${RED_OFF}d`, 2, 3), `${RED}c${RED_OFF}`);
    strictEqual(sliceAnsi(`${BOLD}${RED}abc${ESC}[0m`, 1, 2), `${BOLD}${RED}b${BOLD_OFF}${RED_OFF}`);
});

Deno.test('bun: sliceAnsi keeps OSC 8 hyperlinks open only inside the slice', () => {
    const link = `${LINK('u')}link${LINK_END}`;
    strictEqual(sliceAnsi(link, 0, 2), `${LINK('u')}li${LINK_END}`);
    strictEqual(sliceAnsi(link, 2, 4), `${LINK('u')}nk${LINK_END}`);
    strictEqual(sliceAnsi(`${ESC}]8;;u${ESC}\\link${ESC}]8;;${ESC}\\`, 1, 3),
        `${ESC}]8;;u${ESC}\\in${ESC}]8;;${ESC}\\`);
    strictEqual(sliceAnsi(`\x9d8;;u\x9clink\x9d8;;\x9c`, 1, 3),
        `\x9d8;;u\x9cin\x9d8;;\x9c`);
});

Deno.test('bun: sliceAnsi counts wide characters and graphemes as cells', () => {
    strictEqual(sliceAnsi('\u5b89\u5b81\u54c8', 0, 4), '\u5b89\u5b81');
    strictEqual(sliceAnsi('\u5b89\u5b81\u54c8', 1, 4), '\u5b81');
    strictEqual(sliceAnsi('a\u{1F468}\u200d\u{1F469}\u200d\u{1F467}b', 1, 3), '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}');
    strictEqual(sliceAnsi('e\u0301x', 0, 1), 'e\u0301');
});

Deno.test('bun: sliceAnsi ellipsis truncates at either edge', () => {
    strictEqual(sliceAnsi('unicorn', 0, 4, '\u2026'), 'uni\u2026');
    strictEqual(sliceAnsi('unicorn', -4, undefined, '\u2026'), '\u2026orn');
    strictEqual(sliceAnsi('unicorn', 0, 7, '\u2026'), 'unicorn');
    strictEqual(sliceAnsi('unicorn', 0, 4, { ellipsis: '\u2026' }), 'uni\u2026');
    strictEqual(sliceAnsi(`${RED}unicorn${RED_OFF}`, 0, 4, '\u2026'), `${RED}uni\u2026${RED_OFF}`);
    strictEqual(sliceAnsi(`${LINK('u')}unicorn${LINK_END}`, 0, 4, '\u2026'), `${LINK('u')}uni${LINK_END}\u2026`);
});

Deno.test('bun: sliceAnsi options and positional ambiguousIsNarrow', () => {
    // U+00E9 is narrow; U+00B1 (plus-minus) is ambiguous and wide when ambiguousIsNarrow is false.
    strictEqual(sliceAnsi('\u00b1\u00b1x', 0, 2), '\u00b1\u00b1');
    strictEqual(sliceAnsi('\u00b1\u00b1x', 0, 2, false), '\u00b1');
    strictEqual(sliceAnsi('\u00b1\u00b1x', 0, 2, { ambiguousIsNarrow: false }), '\u00b1');
    strictEqual(sliceAnsi('\u00b1\u00b1x', 0, 2, { ambiguousIsNarrow: null as unknown as boolean }), '\u00b1');
    strictEqual(sliceAnsi('unicorn', 0, 4, '\u2026', false), 'uni\u2026');
    strictEqual(sliceAnsi(123 as unknown as string, 0, 2), '12');
    strictEqual(sliceAnsi('hello', '1' as unknown as number, '4' as unknown as number), 'ell');
    throws(() => sliceAnsi(Symbol('x') as unknown as string, 0, 1), TypeError);
});

Deno.test('bun: wrapAnsi wraps at word boundaries', () => {
    strictEqual(wrapAnsi('hello world', 5), 'hello\nworld');
    strictEqual(wrapAnsi('The quick brown fox jumps over the lazy dog', 20),
        'The quick brown fox\njumps over the lazy\ndog');
    strictEqual(wrapAnsi('a\nb', 5), 'a\nb');
    strictEqual(wrapAnsi('a b', 2, null as unknown as {}), 'a\nb');
    strictEqual(wrapAnsi('', 5), '');
});

Deno.test('bun: wrapAnsi re-opens SGR styles on each row', () => {
    strictEqual(wrapAnsi(`${RED}hello world${ESC}[0m`, 5),
        `${RED}hello${RED_OFF}\n${RED}world${ESC}[0m`);
    strictEqual(wrapAnsi(`${RED}abc`, 1, { hard: true }),
        `${RED}a${RED_OFF}\n${RED}b${RED_OFF}\n${RED}c`);
    strictEqual(wrapAnsi(`${RED}a\nb`, 5), `${RED}a\nb`);
});

Deno.test('bun: wrapAnsi hard option breaks long words', () => {
    strictEqual(wrapAnsi('abcdefghij', 3, { hard: true }), 'abc\ndef\nghi\nj');
    strictEqual(wrapAnsi('abcdefghij', 3), 'abcdefghij');
});

Deno.test('bun: wrapAnsi wordWrap false breaks at exact width', () => {
    strictEqual(wrapAnsi('hello world', 4, { wordWrap: false }), 'hell\no wo\nrld');
});

Deno.test('bun: wrapAnsi trim option controls edge whitespace', () => {
    strictEqual(wrapAnsi('a   b', 3), 'a\nb');
    strictEqual(wrapAnsi('a   b', 3, { trim: false }), 'a  \nb');
});

Deno.test('bun: wrapAnsi counts wide characters', () => {
    strictEqual(wrapAnsi("\u4e2d\u6587\u5b57\u7b26", 4, { hard: true }), '\u4e2d\u6587\n\u5b57\u7b26');
    strictEqual(wrapAnsi("\u4e2d\u6587", 3, { hard: true }), "\u4e2d\n\u6587");
    strictEqual(wrapAnsi('\u00b1\u00b1', 2, { hard: true, ambiguousIsNarrow: null as unknown as boolean }),
        '\u00b1\n\u00b1');
});

Deno.test('bun: wrapAnsi keeps hyperlinks valid on every row', () => {
    strictEqual(wrapAnsi(`${LINK('u')}hello world${LINK_END}`, 5),
        `${LINK('u')}hello${LINK_END}\n${LINK('u')}world${LINK_END}`);
    strictEqual(wrapAnsi(`${ESC}]8;;u${ESC}\\abc${ESC}]8;;${ESC}\\`, 1, { hard: true }),
        `${ESC}]8;;u${ESC}\\a${LINK_END}\n${LINK('u')}b${LINK_END}\n${LINK('u')}c${ESC}]8;;${ESC}\\`);
    strictEqual(wrapAnsi(`${LINK('u')}abc`, 1, { hard: true }),
        `${LINK('u')}a${LINK_END}\n${LINK('u')}b${LINK_END}\n${LINK('u')}c`);
});

Deno.test('bun: wrapAnsi coerces inputs and ignores unusable widths', () => {
    strictEqual(wrapAnsi(123 as unknown as string, 2, { hard: true }), '12\n3');
    strictEqual(wrapAnsi('abcd', '2' as unknown as number, { hard: true }), 'ab\ncd');
    strictEqual(wrapAnsi('abc', Number.NaN, { hard: true }), 'abc');
    strictEqual(wrapAnsi('abc', 0, { hard: true }), 'abc');
    strictEqual(wrapAnsi('abc', Number.POSITIVE_INFINITY, { hard: true }), 'abc');
    throws(() => wrapAnsi(Symbol('x') as unknown as string, 2), TypeError);
    throws(() => wrapAnsi('x', Symbol('x') as unknown as number), TypeError);
});
