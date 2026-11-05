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

Deno.test('bun: color accepts numeric typed arrays using array channel rules', () => {
    deepStrictEqual(color(new Uint8Array([1, 2, 3]), '[rgba]'), [1, 2, 3, 255]);
    deepStrictEqual(color(new Uint8ClampedArray([1.5, 256, -5, 1]), '[rgba]'), [2, 255, 0, 1]);
    deepStrictEqual(color(new Float32Array([1.9, 256, -5, .5]), '[rgba]'), [1, 255, 0, 0]);
    deepStrictEqual(color(new Float64Array([1.9, 2.9, 3.9, 127.9]), '[rgba]'), [1, 2, 3, 127]);
    throws(() => color(new Uint8Array(2)), /Expected array length 3 or 4/);
    throws(() => color(new DataView(new ArrayBuffer(3))), /Expected r to be a integer/);
});

Deno.test('bun: color accepts StringLike objects without hiding their errors', () => {
    strictEqual(color({ toString() { return 'rgb(4 5 6 / .5)'; } }, 'hex'), '#040506');
    strictEqual(color(new String('red'), 'css'), 'red');

    let stringified = false;
    deepStrictEqual(color({
        r: 1,
        g: 2,
        b: 3,
        toString() {
            stringified = true;
            throw new Error('must not stringify RGB objects');
        },
    }, '[rgba]'), [1, 2, 3, 255]);
    strictEqual(stringified, false);

    const expected = new Error('StringLike failure');
    throws(() => color({ toString() { throw expected; } }), error => error === expected);
    throws(() => color({}), /Expected r to be a integer/);
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

Deno.test('bun: color ANSI256 aliases select fixed xterm cube and grayscale entries', () => {
    for (const format of ['ansi-256', 'ansi_256', 'ansi256']) {
        for (const [input, index] of [
            ['red', 196], ['black', 16], ['white', 231],
            ['#5f87af', 67], ['#080808', 232], ['#808080', 244], ['#eeeeee', 255],
        ] as const) {
            strictEqual(color(input, format), `\x1b[38;5;${index}m`, `${input}:${format}`);
        }
        strictEqual(color([95, 135, 175], format), '\x1b[38;5;67m');
        strictEqual(color({ r: 255, g: 0, b: 0 }, format), '\x1b[38;5;196m');
    }
});

Deno.test('bun: color ANSI256 ignores alpha without enabling unsupported terminal formats', () => {
    strictEqual(color('#ff000000', 'ansi-256'), '\x1b[38;5;196m');
    strictEqual(color('rgba(255, 0, 0, 0.5)', 'ansi-256'), '\x1b[38;5;196m');
    strictEqual(color('transparent', 'ansi-256'), '\x1b[38;5;16m');
    strictEqual(color('invalid-color', 'ansi-256'), null);
    for (const format of ['ansi-16', 'ansi_16', 'ansi']) {
        throws(() => color('red', format), /not implemented/);
    }
});

Deno.test('bun: color rejects missing channels and malformed alpha separators', () => {
    for (const input of [
        'rgb(1 2 / 3)', 'rgb(1 2 3 .5)', 'rgba(1 2 3 50%)',
        'rgb(1, 2, 3 / .5)', 'rgb(1 2 3 /)', 'rgb(1 2 3 / / .5)',
        'hsl(120 100% / 50%)', 'hsl(120 100% 50% .5)',
        'hsla(120 100% 50% 50%)', 'hsl(120, 100%, 50% / .5)',
    ]) {
        strictEqual(color(input), null, input);
    }
    strictEqual(color('rgb(1 2 3 / .5)', 'hex'), '#010203');
    strictEqual(color('hsl(120 100% 50% / 50%)', 'hex'), '#00ff00');
    strictEqual(color('rgba(1, 2, 3)', 'hex'), '#010203');
    strictEqual(color('hsla(120, 100%, 50%)', 'hex'), '#00ff00');
    strictEqual(color('rgb(1, 2, 3, .5)', 'hex'), '#010203');
    strictEqual(color('hsl(120, 100%, 50%, .5)', 'hex'), '#00ff00');
});

Deno.test('bun: color rejects nonfinite CSS components before clamping or hue conversion', () => {
    const overflowingHue = '9'.repeat(400);
    const finiteHueWithOverflowingUnit = `1${'0'.repeat(308)}turn`;
    for (const input of [
        'rgb(1e999 0 0)', 'rgb(0 -1e999 0)', 'rgb(1e999% 0 0)',
        'rgb(1 2 3 / 1e999)', 'rgba(1, 2, 3, -1e999)',
        'hsl(120 1e999% 50%)', 'hsl(120 100% 1e999%)',
        'hsl(120 100% 50% / 1e999)',
        `hsl(${overflowingHue} 100% 50%)`,
        `hsl(${finiteHueWithOverflowingUnit} 100% 50%)`,
    ]) {
        strictEqual(color(input), null, input);
    }
    strictEqual(color('rgb(300 -20 50)', 'hex'), '#ff0032');
});
