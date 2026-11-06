import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { color } from '../../cno/src/bun/utils/color.ts';

Deno.test('bun: color has Bun native function shape and validates input before format', () => {
    strictEqual(color.name, 'color');
    strictEqual(color.length, 2);
    strictEqual(Object.hasOwn(color, 'prototype'), false);
    throws(() => Reflect.construct(color, ['red']), TypeError);

    const events: string[] = [];
    const poisonedFormat = new String('hex');
    Object.defineProperty(poisonedFormat, Symbol.toPrimitive, {
        get() {
            events.push('format');
            throw new Error('format must not be coerced');
        },
    });
    throws(() => color(undefined, poisonedFormat), /Expected input/);
    deepStrictEqual(events, []);

    const input = new Proxy({}, {
        get() {
            events.push('input');
            throw new Error('input must not be inspected');
        },
    });
    throws(() => color(input, 'bad'), /format must be one of/);
    deepStrictEqual(events, []);
});

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
    const hiddenLength = new Uint8Array([4, 5, 6]);
    Object.defineProperty(hiddenLength, 'length', {
        get() { throw new Error('typed array length getter must not run'); },
    });
    deepStrictEqual(color(hiddenLength, '[rgba]'), [4, 5, 6, 255]);
    throws(() => color(new Uint8Array(2)), /Expected array length 3 or 4/);
    throws(() => color(new DataView(new ArrayBuffer(3))), /Expected r to be a integer/);
});

Deno.test('bun: color treats objects as RGB records without StringLike coercion', () => {
    const events: string[] = [];
    const input = {
        get r() { events.push('r'); return 1; },
        get g() { events.push('g'); return 2; },
        get b() { events.push('b'); return 3; },
        get a() { events.push('a'); return .5; },
        toString() {
            events.push('toString');
            throw new Error('must not stringify RGB objects');
        },
    };
    deepStrictEqual(color(input, '[rgba]'), [1, 2, 3, 127]);
    deepStrictEqual(events, ['r', 'g', 'b', 'a']);

    throws(() => color({ toString() { return 'red'; } }), /Expected r to be a integer/);
    throws(() => color(new String('red')), /Expected r to be a integer/);
    throws(() => color({}), /Expected r to be a integer/);
});

Deno.test('bun: color excludes Proxy arrays and only reads selected channels', () => {
    const proxyEvents: string[] = [];
    const proxy = new Proxy([1, 2, 3], {
        get(target, key, receiver) {
            proxyEvents.push(String(key));
            return Reflect.get(target, key, receiver);
        },
    });
    throws(() => color(proxy, '[rgba]'), /Expected r to be a integer/);
    deepStrictEqual(proxyEvents, ['r']);

    const alphaEvents: string[] = [];
    const rgb = [1, 2, 3];
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, 3, {
        configurable: true,
        get() {
            alphaEvents.push('3');
            throw new Error('length-three alpha must not be read');
        },
    });
    Object.setPrototypeOf(rgb, prototype);
    deepStrictEqual(color(rgb, '[rgba]'), [1, 2, 3, 255]);
    deepStrictEqual(alphaEvents, []);
});

Deno.test('bun: color checks formats and invalid inputs', () => {
    strictEqual(color(null), null);
    strictEqual(color(true), null);
    strictEqual(color('red', null), 'red');
    strictEqual(color('red', new String('hex')), '#ff0000');
    throws(() => color(undefined), TypeError);
    throws(() => color([], 'rgb'), /Expected array length 3 or 4/);
    throws(() => color({ r: '1', g: 2, b: 3 }), TypeError);
    throws(() => color('red', 1), TypeError);
    throws(() => color('red', new Proxy(new String('hex'), {})), TypeError);
    throws(() => color(Symbol('red')), /Cannot convert a symbol to a string/);
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
    // Lab output remains unimplemented; unknown formats are rejected outright.
    throws(() => color('red', 'lab'), /not implemented/);
    for (const format of ['ansi-4', 'ansi-8', 'ansi-32']) {
        throws(() => color('red', format), TypeError);
    }
});

Deno.test('bun: color ANSI16 approximates through the 256 palette', () => {
    for (const format of ['ansi-16', 'ansi_16']) {
        strictEqual(color('red', format), '\x1b[91m', format);
        strictEqual(color('black', format), '\x1b[30m', format);
        strictEqual(color('white', format), '\x1b[97m', format);
        strictEqual(color('teal', format), '\x1b[36m', format);
        strictEqual(color('#5f87af', format), '\x1b[90m', format);
        strictEqual(color([95, 135, 175], format), '\x1b[90m', format);
    }
    strictEqual(color('#ff000000', 'ansi-16'), '\x1b[91m');
    strictEqual(color('rgba(255, 0, 0, 0.5)', 'ansi-16'), '\x1b[91m');
    strictEqual(color('invalid-color', 'ansi-16'), null);
});

Deno.test('bun: color "ansi" defers to the stdout depth and is empty without color support', () => {
    // This file imports the pure color module directly, so the namespace's
    // stdout provider is absent and Bun's no-ANSI contract returns ''.
    strictEqual(color('red', 'ansi'), '');
    strictEqual(color('nonsense', 'ansi'), null);
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
