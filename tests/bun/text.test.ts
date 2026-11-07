import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { sliceAnsi, stringWidth, stripANSI, wrapAnsi } from '../../cno/src/bun/utils/text.ts';

Deno.test('bun: ANSI text helpers have native function shapes', () => {
    for (const [fn, name, length] of [
        [stripANSI, 'stripANSI', 1],
        [stringWidth, 'stringWidth', 2],
        [sliceAnsi, 'sliceAnsi', 5],
        [wrapAnsi, 'wrapAnsi', 3],
    ] as const) {
        strictEqual(fn.name, name);
        strictEqual(fn.length, length);
        strictEqual(Object.hasOwn(fn, 'prototype'), false);
        throws(() => Reflect.construct(fn as never, []), TypeError);
    }
});

Deno.test('bun: ANSI slicing and wrapping snapshot arguments in native order', () => {
    const sliceLog: string[] = [];
    const primitive = (name: string, value: unknown) => ({
        [Symbol.toPrimitive](hint: string) {
            sliceLog.push(`${name}:${hint}`);
            return value;
        },
    });
    const sliceOptions = new Proxy({ ellipsis: '', ambiguousIsNarrow: true }, {
        get(target, property, receiver) {
            sliceLog.push(`get:${String(property)}`);
            return Reflect.get(target, property, receiver);
        },
    });
    strictEqual(sliceAnsi(
        primitive('input', 'abcd') as unknown as string,
        primitive('start', 1) as unknown as number,
        primitive('end', 3) as unknown as number,
        sliceOptions,
    ), 'bc');
    deepStrictEqual(sliceLog, [
        'input:string', 'start:number', 'end:number',
        'get:ellipsis', 'get:ambiguousIsNarrow',
    ]);

    const errorLog: string[] = [];
    const badStart = {
        [Symbol.toPrimitive](hint: string) {
            errorLog.push(`start:${hint}`);
            return Symbol('start');
        },
    };
    const unreadOptions = new Proxy({}, {
        get(_target, property) {
            errorLog.push(`get:${String(property)}`);
            throw new Error('options getter must not run');
        },
    });
    throws(() => sliceAnsi('abcd', badStart as unknown as number, 3, unreadOptions), TypeError);
    deepStrictEqual(errorLog, ['start:number']);

    const wrapLog: string[] = [];
    const columns = {
        [Symbol.toPrimitive](hint: string) {
            wrapLog.push(`columns:${hint}`);
            return 0;
        },
    };
    const wrapOptions = new Proxy({ hard: true, wordWrap: false, trim: false, ambiguousIsNarrow: true }, {
        get(target, property, receiver) {
            wrapLog.push(`get:${String(property)}`);
            return Reflect.get(target, property, receiver);
        },
    });
    strictEqual(wrapAnsi('abcd', columns as unknown as number, wrapOptions), 'abcd');
    deepStrictEqual(wrapLog, [
        'columns:number', 'get:hard', 'get:wordWrap', 'get:trim', 'get:ambiguousIsNarrow',
    ]);

    const functionLog: string[] = [];
    const functionOptions = () => {};
    Object.defineProperties(functionOptions, {
        ellipsis: { get: () => { functionLog.push('get:ellipsis'); return '!'; } },
        hard: { get: () => { functionLog.push('get:hard'); return true; } },
        wordWrap: { get: () => { functionLog.push('get:wordWrap'); return undefined; } },
        trim: { get: () => { functionLog.push('get:trim'); return undefined; } },
        ambiguousIsNarrow: { get: () => { functionLog.push('get:ambiguousIsNarrow'); return true; } },
    });
    strictEqual(sliceAnsi('abc', 0, 2, functionOptions as unknown as {}), 'a!');
    deepStrictEqual(functionLog, ['get:ellipsis', 'get:ambiguousIsNarrow']);
    functionLog.length = 0;
    strictEqual(wrapAnsi('abc', 2, functionOptions as unknown as {}), 'ab\nc');
    deepStrictEqual(functionLog, ['get:hard', 'get:wordWrap', 'get:trim', 'get:ambiguousIsNarrow']);
    strictEqual(sliceAnsi('abcd', 1, 3, null as unknown as {}), 'bc');
    strictEqual(sliceAnsi('abcd', 1, 3, Symbol('options') as unknown as {}), 'bc');
    strictEqual(wrapAnsi('abcd', 2, null as unknown as {}), 'abcd');
    strictEqual(wrapAnsi('abcd', 2, Symbol('options') as unknown as {}), 'abcd');

    strictEqual(stringWidth('', unreadOptions), 0);
    strictEqual(sliceAnsi('', Symbol('start') as unknown as number, Symbol('end') as unknown as number, unreadOptions), '');
    strictEqual(wrapAnsi('', Symbol('columns') as unknown as number, unreadOptions), '');
});

Deno.test('bun: stripANSI removes CSI, OSC hyperlinks, and keeps plain text', () => {
    strictEqual(stripANSI('\x1b[31mred\x1b[0m'), 'red');
    strictEqual(stripANSI('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'), 'link');
    strictEqual(stripANSI('\x1b]8;;u\x1b\\link\x1b]8;;\x1b\\'), 'link');
    strictEqual(stripANSI('\x9b31mx\x9b0m'), 'x');
    strictEqual(stripANSI('a\x1b'), 'a');
    strictEqual(stripANSI('a\x1b[31'), 'a');
    strictEqual(stripANSI('a\x1b]8;;unterminated'), 'a');
    strictEqual(stripANSI('plain café'), 'plain café');
    strictEqual(stripANSI(1 as unknown as string), '1');
    throws(() => stripANSI(Symbol('x') as unknown as string), TypeError);
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
    strictEqual(stringWidth('①', null as unknown as {}), 1);
    strictEqual(stringWidth('#️⃣'), 2);
    deepStrictEqual(stringWidth(''), 0);
    strictEqual(stringWidth(null as unknown as string), 4);
    throws(() => stringWidth(Symbol('x') as unknown as string), TypeError);
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
    strictEqual(stringWidth(true as unknown as string, opt), 4);
    throws(() => stringWidth(Symbol('x') as unknown as string, opt), TypeError);
});

Deno.test('bun: stringWidth widens bounded East Asian ambiguous symbols when requested', () => {
    const ambiguous = [
        '\u2010', '\u2013', '\u2016', '\u2020', '\u2022', '\u2030', '\u203b',
        '\u2103', '\u212b', '\u2160', '\u216b', '\u2200', '\u2211', '\u2260',
        '\u2261', '\u2605', '\u2606', '\u2663', '\u2665',
    ];
    for (const symbol of ambiguous) {
        strictEqual(stringWidth(symbol), 1);
        strictEqual(stringWidth(symbol, { ambiguousIsNarrow: false }), 2);
        strictEqual(stringWidth(symbol, { perCodePoint: true }), 1);
        strictEqual(stringWidth(symbol, { perCodePoint: true, ambiguousIsNarrow: false }), 2);
    }

    strictEqual(stringWidth('\u200f', { ambiguousIsNarrow: false }), 0);
    strictEqual(stringWidth('\u200f', { perCodePoint: true, ambiguousIsNarrow: false }), 0);
    const narrowNeighbors = [
        '\u2011', '\u2012', '\u2017', '\u201f', '\u2023', '\u202f', '\u2031',
        '\u203a', '\u203c', '\u2102', '\u2104', '\u212a', '\u212c', '\u215f',
        '\u216c', '\u21ff', '\u2201', '\u2210', '\u2212', '\u225f', '\u2262',
        '\u2604', '\u2607', '\u2662', '\u2666',
    ];
    for (const neighbor of narrowNeighbors) {
        strictEqual(stringWidth(neighbor, { ambiguousIsNarrow: false }), 1);
        strictEqual(stringWidth(neighbor, { perCodePoint: true, ambiguousIsNarrow: false }), 1);
    }
});
