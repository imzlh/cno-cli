import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { color } from '../../cno/src/bun/utils/color.ts';

Deno.test('bun: color parses common CSS color syntax and canonicalizes output', () => {
    for (const [input, css, hex] of [
        ['red', 'red', '#ff0000'], ['  #ABC  ', '#abc', '#aabbcc'],
        ['transparent', '#0000', '#000000'], ['rebeccapurple', '#639', '#663399'],
        ['rgb(255, 0, 0)', 'red', '#ff0000'], ['rgb(1 2 3 / 50%)', '#01020380', '#010203'],
        ['rgba(1,2,3,.5)', '#01020380', '#010203'], ['hsl(120,100%,50%)', '#0f0', '#00ff00'],
    ]) {
        strictEqual(color(input), css);
        strictEqual(color(input, 'hex'), hex);
    }
    strictEqual(color('RED'), null);
    strictEqual(color('nonsense'), null);
    strictEqual(color('constructor'), null);
});

Deno.test('bun: color supports numeric, array and object representations', () => {
    deepStrictEqual(color(0x12345678, '[rgba]'), [0x34, 0x56, 0x78, 0x12]);
    deepStrictEqual(color(-1, '[rgb]'), [255, 255, 255]);
    deepStrictEqual(color([1.5, 256, -5, .5], '[rgba]'), [1, 255, 0, 0]);
    deepStrictEqual(color({ r: 1, g: 2, b: 3, a: .5 }, '[rgba]'), [1, 2, 3, 127]);
    deepStrictEqual(color('#12345678', '{rgba}'), { r: 18, g: 52, b: 86, a: Math.fround(120 / 255) });
    strictEqual(color('#12345678', 'number'), 0x123456);
    strictEqual(color('#123456', 'HEX'), '#123456');
    strictEqual(color('#ff000080', 'rgba'), 'rgba(255, 0, 0, 0.5019608)');
    strictEqual(color('red', 'ansi-16m'), '\x1b[38;2;255;0;0m');
});

Deno.test('bun: color checks formats and invalid inputs', () => {
    strictEqual(color(null), null);
    strictEqual(color(true), null);
    strictEqual(color('red', null), 'red');
    throws(() => color(undefined), TypeError);
    throws(() => color([], 'rgb'), /Expected array length 3 or 4/);
    throws(() => color({ r: '1', g: 2, b: 3 }), TypeError);
    throws(() => color('red', 1), TypeError);
    throws(() => color(null, 'bad'), TypeError);
});
