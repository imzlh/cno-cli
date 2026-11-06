import { deepStrictEqual, doesNotThrow, strictEqual, throws } from 'node:assert';
import { runInNewContext } from 'node:vm';
import { JSONL, parseJSONL, parseJSONLChunk } from '../../cno/src/bun/utils/jsonl.ts';

const enc = (text: string) => new TextEncoder().encode(text);

Deno.test('bun: JSONL.parse returns each top-level value from LF, CRLF, and blank-line input', () => {
    deepStrictEqual(JSONL.parse('{"a":1}\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
    deepStrictEqual(JSONL.parse('{"a":1}\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
    deepStrictEqual(JSONL.parse('{"a":1}\r\n{"b":2}\r\n'), [{ a: 1 }, { b: 2 }]);
    deepStrictEqual(JSONL.parse('\n\n{"a":1}\n\n\n{"b":2}\n\n'), [{ a: 1 }, { b: 2 }]);
    deepStrictEqual(JSONL.parse('1\n"x"\nnull\ntrue\n'), [1, 'x', null, true]);
    deepStrictEqual(JSONL.parse(''), []);
});

Deno.test('bun: JSONL.parse accepts byte input and treats views as raw bytes', () => {
    deepStrictEqual(JSONL.parse(enc('{"a":1}\n{"b":2}\n')), [{ a: 1 }, { b: 2 }]);
    deepStrictEqual(JSONL.parse(new Uint8Array(0)), []);
    deepStrictEqual(JSONL.parse(Buffer.from('[1]\n{"x":2}\n')), [[1], { x: 2 }]);
    const window = new Uint8Array(enc('zz[1]\n').buffer, 2, 4);
    deepStrictEqual(JSONL.parse(window), [[1]]);
    deepStrictEqual(JSONL.parse(new Uint16Array(enc('zz[2]\n').buffer, 2, 2)), [[2]]);
});

Deno.test('bun: JSONL uses typed-array brands across realms and ignores shadowed view metadata', () => {
    const foreign = runInNewContext(`(() => {
        const bytes = new Uint8Array([120, 120, 91, 51, 93, 10, 121, 121]);
        return {
            bytes: bytes.subarray(2, 6),
            words: new Uint16Array(bytes.buffer, 2, 2),
            data: new DataView(bytes.buffer, 2, 4),
            buffer: new Uint8Array([91, 51, 93, 10]).buffer,
        };
    })()`);
    deepStrictEqual(JSONL.parse(foreign.bytes), [[3]]);
    deepStrictEqual(JSONL.parse(foreign.words), [[3]]);
    strictEqual(parseJSONLChunk(foreign.data).error instanceof SyntaxError, true);
    strictEqual(parseJSONLChunk(foreign.buffer).error instanceof SyntaxError, true);

    const bytes = enc('[4]\n');
    for (const key of ['buffer', 'byteOffset', 'byteLength']) {
        Object.defineProperty(bytes, key, {
            configurable: true,
            get() { throw new Error(`shadowed ${key} getter ran`); },
        });
    }
    deepStrictEqual(JSONL.parse(bytes), [[4]]);
});

Deno.test('bun: JSONL accepts SharedArrayBuffer-backed typed-array windows only', () => {
    if (typeof SharedArrayBuffer !== 'function') return;
    const shared = new SharedArrayBuffer(8);
    new Uint8Array(shared).set(enc('xx[5]\nyy'));
    deepStrictEqual(JSONL.parse(new Uint8Array(shared, 2, 4)), [[5]]);
    deepStrictEqual(JSONL.parse(new Uint16Array(shared, 2, 2)), [[5]]);
    strictEqual(parseJSONLChunk(shared).error instanceof SyntaxError, true);
    strictEqual(parseJSONLChunk(new DataView(shared, 2, 4)).error instanceof SyntaxError, true);

    const foreign = runInNewContext(`(() => {
        const buffer = new SharedArrayBuffer(8);
        new Uint8Array(buffer).set([120, 120, 91, 54, 93, 10, 121, 121]);
        return { buffer, bytes: new Uint8Array(buffer, 2, 4) };
    })()`);
    deepStrictEqual(JSONL.parse(foreign.bytes), [[6]]);
    strictEqual(parseJSONLChunk(foreign.buffer).error instanceof SyntaxError, true);
});

Deno.test('bun: JSONL.parse coerces non-string inputs and rejects null, undefined, DataView, and ArrayBuffer', () => {
    deepStrictEqual(JSONL.parse(42 as never), [42]);
    deepStrictEqual(JSONL.parse(true as never), [true]);
    deepStrictEqual(JSONL.parse(NaN as never), []);
    deepStrictEqual(JSONL.parse({ toString: () => '[2]\n' } as never), [[2]]);
    throws(() => JSONL.parse(null as never), TypeError);
    throws(() => JSONL.parse(undefined as never), TypeError);
    throws(() => JSONL.parse(Symbol('x') as never), TypeError);
    throws(() => JSONL.parse(new DataView(enc('[1]\n').buffer)), SyntaxError);
    throws(() => JSONL.parse(enc('[1]\n').buffer), SyntaxError);
});

Deno.test('bun: JSONL.parse keeps values before an error and throws when none precede it', () => {
    deepStrictEqual(JSONL.parse('{"a":1}\n{bad}\n'), [{ a: 1 }]);
    deepStrictEqual(JSONL.parse('1\n2\nx\n3\n'), [1, 2]);
    deepStrictEqual(JSONL.parse(enc('1\n{x}\n')), [1]);
    throws(() => JSONL.parse('{bad}\n'), SyntaxError);
    throws(() => JSONL.parse('1.\n'), SyntaxError);
    throws(() => JSONL.parse('[1 2]\n'), SyntaxError);
});

Deno.test('bun: JSONL.parse ignores an incomplete trailing value', () => {
    deepStrictEqual(JSONL.parse('{"a":1}\n{"b":'), [{ a: 1 }]);
    deepStrictEqual(JSONL.parse('[1,'), []);
    deepStrictEqual(JSONL.parse('1.'), []);
    deepStrictEqual(JSONL.parse('1e'), [1]);
});

Deno.test('bun: JSONL.parseChunk reports read and done for complete input', () => {
    deepStrictEqual(parseJSONLChunk('{"a":1}\n{"b":2}\n'), { values: [{ a: 1 }, { b: 2 }], read: 15, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1\n2'), { values: [1, 2], read: 3, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('  \n  '), { values: [], read: 0, done: true, error: null });
    deepStrictEqual(parseJSONLChunk(''), { values: [], read: 0, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1 \t '), { values: [1], read: 1, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('{"a":1}  '), { values: [{ a: 1 }], read: 7, done: true, error: null });
});

Deno.test('bun: JSONL.parseChunk leaves unfinished data unread for the next chunk', () => {
    deepStrictEqual(parseJSONLChunk('{"a":1}\n{"b":'), { values: [{ a: 1 }], read: 7, done: false, error: null });
    deepStrictEqual(parseJSONLChunk('[1]\n[2'), { values: [[1]], read: 3, done: false, error: null });
    deepStrictEqual(parseJSONLChunk('1\n{"a"'), { values: [1], read: 1, done: false, error: null });
    deepStrictEqual(parseJSONLChunk('1\n   '), { values: [1], read: 1, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('[1,2]\n[3'), { values: [[1, 2]], read: 5, done: false, error: null });
    deepStrictEqual(parseJSONLChunk('12'), { values: [12], read: 2, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('true'), { values: [true], read: 4, done: true, error: null });
});

Deno.test('bun: JSONL.parseChunk reports an error without throwing', () => {
    const bad = parseJSONLChunk('{"a":1}\n{bad}\n');
    deepStrictEqual(bad.values, [{ a: 1 }]);
    strictEqual(bad.read, 7);
    strictEqual(bad.done, false);
    strictEqual(bad.error instanceof SyntaxError, true);
    strictEqual(bad.error?.message, 'Failed to parse JSONL');

    const none = parseJSONLChunk('{bad}\n{"a":1}\n');
    deepStrictEqual(none.values, []);
    strictEqual(none.read, 0);
    strictEqual(none.error instanceof SyntaxError, true);

    strictEqual(parseJSONLChunk('"中"\n@').error instanceof SyntaxError, true);
    strictEqual(parseJSONLChunk('1x\n').read, 1);
    strictEqual(parseJSONLChunk('"ab"x').read, 4);
});

Deno.test('bun: JSONL.parseChunk start and end select a window and keep offsets absolute', () => {
    deepStrictEqual(parseJSONLChunk('xx{"a":1}\n{"b":2}\n', 2, 10), { values: [{ a: 1 }], read: 9, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1\n2\n', 1), { values: [2], read: 3, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1\n2\n', 2, 2), { values: [], read: 2, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1\n2\n', 3, 1), { values: [], read: 1, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1\n2\n', 99), { values: [], read: 4, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1\n2\n', 0, 99), { values: [1, 2], read: 3, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1\n2\n', 0, 0), { values: [], read: 0, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1\n2\n', 1.9), { values: [2], read: 3, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1\n2\n', 0, -1), { values: [1, 2], read: 3, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1\n2\n', 0, NaN), { values: [1, 2], read: 3, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1\n2\n', 0, 2.5), { values: [1], read: 1, done: true, error: null });
    strictEqual(Object.is(parseJSONLChunk('1\n2\n', 0, -0).read, -0), false);
});

Deno.test('bun: JSONL.parseChunk applies only primitive numeric offsets without coercion', () => {
    const source = '0\n1\n2\n';
    let coercions = 0;
    const offset = {
        valueOf() { coercions++; return 2; },
        [Symbol.toPrimitive]() { coercions++; return 2; },
    };

    for (const start of [undefined, null, false, true, '2', 2n, Symbol('offset'), offset, new Number(2)]) {
        deepStrictEqual(parseJSONLChunk(source, start as never).values, [0, 1, 2]);
    }
    for (const end of [null, false, true, '4', 4n, Symbol('offset'), offset, new Number(4)]) {
        deepStrictEqual(parseJSONLChunk(source, 0, end as never).values, [0, 1, 2]);
    }
    strictEqual(coercions, 0);
    deepStrictEqual(parseJSONLChunk(source, 2.9).values, [1, 2]);
    deepStrictEqual(parseJSONLChunk(source, 0, 4.9).values, [0, 1]);
    deepStrictEqual(parseJSONLChunk(source, Infinity), { values: [], read: 6, done: true, error: null });
    deepStrictEqual(parseJSONLChunk(source, 6, 2), { values: [], read: 2, done: true, error: null });
});

Deno.test('bun: JSONL.parseChunk reads byte input with byte offsets', () => {
    deepStrictEqual(parseJSONLChunk(enc('{"a":1}\n{"b":2}\n')), { values: [{ a: 1 }, { b: 2 }], read: 15, done: true, error: null });
    deepStrictEqual(parseJSONLChunk(enc('{"a":1}\n{"b":2}\n'), 8, 16), { values: [{ b: 2 }], read: 15, done: true, error: null });
    deepStrictEqual(parseJSONLChunk(enc('12\n34\n'), 1), { values: [2, 34], read: 5, done: true, error: null });
    deepStrictEqual(parseJSONLChunk(enc('1\n2\n'), 2), { values: [2], read: 3, done: true, error: null });
    deepStrictEqual(parseJSONLChunk(enc('1\n2\n'), 99), { values: [], read: 4, done: true, error: null });
    deepStrictEqual(parseJSONLChunk(new Uint8Array(0)), { values: [], read: 0, done: true, error: null });
    const view = new Uint8Array(enc('zz[1]\n').buffer, 2);
    deepStrictEqual(parseJSONLChunk(view), { values: [[1]], read: 3, done: true, error: null });
    const buffer = Buffer.from('zz[1]\n');
    deepStrictEqual(parseJSONLChunk(buffer.subarray(2)), { values: [[1]], read: 3, done: true, error: null });
});

Deno.test('bun: JSONL.parseChunk rejects DataView and ArrayBuffer through the error field', () => {
    for (const input of [new DataView(enc('[1]\n').buffer), enc('[1]\n').buffer]) {
        const result = parseJSONLChunk(input);
        deepStrictEqual(result.values, []);
        strictEqual(result.read, 0);
        strictEqual(result.error instanceof SyntaxError, true);
    }
    throws(() => parseJSONLChunk(null as never), TypeError);
    throws(() => parseJSONLChunk(undefined as never), TypeError);
});

Deno.test('bun: JSONL keeps detached DataView rejection separate from detached typed arrays', () => {
    const dataBuffer = enc('[1]\n').buffer;
    const dataView = new DataView(dataBuffer);
    structuredClone(dataBuffer, { transfer: [dataBuffer] });
    throws(() => JSONL.parse(dataView), SyntaxError);
    strictEqual(parseJSONLChunk(dataView).error instanceof SyntaxError, true);

    const typedBuffer = enc('[1]\n').buffer;
    const typedView = new Uint8Array(typedBuffer);
    structuredClone(typedBuffer, { transfer: [typedBuffer] });
    throws(() => JSONL.parse(typedView), TypeError);
    throws(() => parseJSONLChunk(typedView), TypeError);
});

Deno.test('bun: JSONL.parseChunk applies a UTF-8 byte order mark only at the start of byte input', () => {
    deepStrictEqual(parseJSONLChunk(new Uint8Array([0xef, 0xbb, 0xbf, 0x31, 0x0a])), { values: [1], read: 4, done: true, error: null });
    deepStrictEqual(parseJSONLChunk(new Uint8Array([0xef, 0xbb, 0xbf])), { values: [], read: 3, done: true, error: null });
    deepStrictEqual(parseJSONLChunk(new Uint8Array([0xef, 0xbb, 0xbf, 0x31, 0x0a]), 3), { values: [1], read: 4, done: true, error: null });
    strictEqual(parseJSONLChunk(new Uint8Array([0x31, 0x0a, 0xef, 0xbb, 0xbf, 0x32, 0x0a])).error instanceof SyntaxError, true);
    strictEqual(parseJSONLChunk('\uFEFF1\n').error instanceof SyntaxError, true);
});

Deno.test('bun: JSONL decodes UTF-8 multibyte text and replaces invalid sequences', () => {
    deepStrictEqual(parseJSONLChunk(enc('{"中":"😀"}\n')).values, [{ 中: '😀' }]);
    deepStrictEqual(parseJSONLChunk(enc('"😀"\n"x"')).values, ['😀', 'x']);
    deepStrictEqual(parseJSONLChunk(enc('"中"\n"中"\n{x}\n')).read, 11);
    deepStrictEqual(parseJSONLChunk(new Uint8Array([0x22, 0xff, 0x22, 0x0a])).values, ['\uFFFD']);
    deepStrictEqual(parseJSONLChunk(new Uint8Array([0x22, 0xe4, 0xb8])), { values: [], read: 0, done: false, error: null });
    deepStrictEqual(parseJSONLChunk(new Uint8Array([0x22, 0xe4, 0xb8, 0x0a])).error instanceof SyntaxError, true);
    deepStrictEqual(parseJSONLChunk(new Uint8Array([0x80, 0x0a])).error instanceof SyntaxError, true);
    deepStrictEqual(parseJSONLChunk('"中"\n"中"\n{x}\n').read, 7);
});

Deno.test('bun: JSONL replacement decoding preserves malformed UTF-8 behavior', () => {
    deepStrictEqual(parseJSONLChunk(new Uint8Array([0x22, 0xff, 0x61, 0x22, 0x0a])).values, ['\uFFFDa']);
    deepStrictEqual(parseJSONLChunk(new Uint8Array([0x22, 0xc0, 0xaf, 0x22, 0x0a])).values, ['\uFFFD\uFFFD']);
    deepStrictEqual(parseJSONLChunk(new Uint8Array([0x22, 0xe2, 0x28, 0xa1, 0x22, 0x0a])).values, ['\uFFFD(\uFFFD']);
    deepStrictEqual(parseJSONLChunk(new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22, 0x0a])).values, ['\uFFFD\uFFFD\uFFFD']);
});

Deno.test('bun: JSONL accepts CR as whitespace but not as a line separator', () => {
    deepStrictEqual(parseJSONLChunk('1\r'), { values: [1], read: 1, done: true, error: null });
    deepStrictEqual(parseJSONLChunk('1 \r\n 2\n').values, [1, 2]);
    deepStrictEqual(parseJSONLChunk('[1\r]').values, [[1]]);
    strictEqual(parseJSONLChunk('1\rx').error instanceof SyntaxError, true);
    strictEqual(parseJSONLChunk('1\r2\r').error instanceof SyntaxError, true);
});

Deno.test('bun: JSONL requires one value per line and rejects trailing content after a value', () => {
    deepStrictEqual(parseJSONLChunk('1 2\n3\n'), { values: [1], read: 1, done: false, error: new SyntaxError('Failed to parse JSONL') });
    deepStrictEqual(parseJSONLChunk('[1][2]\n').values, [[1]]);
    strictEqual(parseJSONLChunk('[1][2]\n').error instanceof SyntaxError, true);
    strictEqual(parseJSONLChunk('[1]]\n').read, 3);
    strictEqual(parseJSONLChunk('{}{}\n').read, 2);
    strictEqual(parseJSONLChunk('"a" x\n').read, 3);
    strictEqual(parseJSONLChunk('"a"x').read, 3);
    strictEqual(parseJSONLChunk('1 [2]\n').read, 1);
});

Deno.test('bun: JSONL number grammar matches JSON, with partial top-level commits', () => {
    deepStrictEqual(parseJSONLChunk('-0\n').values, [-0]);
    deepStrictEqual(parseJSONLChunk('1E2\n').values, [100]);
    deepStrictEqual(parseJSONLChunk('0.0e0\n').values, [0]);
    deepStrictEqual(parseJSONLChunk('1e308\n').values, [1e308]);
    deepStrictEqual(parseJSONLChunk('1e400\n').values, [Infinity]);
    deepStrictEqual(parseJSONLChunk('12345678901234567890123\n').values, [1.2345678901234568e22]);
    deepStrictEqual(parseJSONLChunk('1e\n'), { values: [1], read: 1, done: false, error: new SyntaxError('Failed to parse JSONL') });
    deepStrictEqual(parseJSONLChunk('1e+'), { values: [1], read: 1, done: false, error: new SyntaxError('Failed to parse JSONL') });
    deepStrictEqual(parseJSONLChunk('1.5.\n'), { values: [1.5], read: 3, done: false, error: new SyntaxError('Failed to parse JSONL') });
    deepStrictEqual(parseJSONLChunk('0x1\n').values, [0]);
    for (const source of ['.5\n', '+1\n', 'NaN\n', 'Infinity\n', '01\n', '[01]\n', '1.\n', '1.e5\n', '[1.]\n', '[1e]\n']) {
        strictEqual(parseJSONLChunk(source).error instanceof SyntaxError, true, source);
    }
});

Deno.test('bun: JSONL string escapes follow JSON', () => {
    deepStrictEqual(parseJSONL('"\\n\\t\\/\\u0041"\n'), ['\n\t/A']);
    deepStrictEqual(parseJSONL('"\\uD83D\\uDE00"\n'), ['😀']);
    deepStrictEqual(parseJSONL('"\\ud800"\n'), ['\ud800']);
    deepStrictEqual(parseJSONL('"\ud800"\n'), ['\ud800']);
    deepStrictEqual(parseJSONL('"\\u00aF"\n'), ['\u00af']);
    strictEqual(parseJSONLChunk('"\\x"\n').error instanceof SyntaxError, true);
    strictEqual(parseJSONLChunk('"\\u12"\n').error instanceof SyntaxError, true);
    strictEqual(parseJSONLChunk('"\n"\n').error instanceof SyntaxError, true);
    strictEqual(parseJSONLChunk('"\\u12').error instanceof SyntaxError, true);
});

Deno.test('bun: JSONL literal and nested incomplete values stay pending until the closing byte', () => {
    deepStrictEqual(parseJSONLChunk('tr'), { values: [], read: 0, done: false, error: null });
    deepStrictEqual(parseJSONLChunk('nul'), { values: [], read: 0, done: false, error: null });
    strictEqual(parseJSONLChunk('[tru]\n').error instanceof SyntaxError, true);
    strictEqual(parseJSONLChunk('truex\n').read, 4);
    deepStrictEqual(parseJSONLChunk('[1,null'), { values: [], read: 0, done: false, error: null });
    deepStrictEqual(parseJSONLChunk('{"a":1,'), { values: [], read: 0, done: false, error: null });
    deepStrictEqual(parseJSONLChunk('[1,]'), { values: [], read: 0, done: false, error: null });
    strictEqual(parseJSONLChunk('[1,]\n').error instanceof SyntaxError, true);
    strictEqual(parseJSONLChunk('{"a":1,}\n').error instanceof SyntaxError, true);
    strictEqual(parseJSONLChunk('[1,x,]').error instanceof SyntaxError, true);
});

Deno.test('bun: JSONL classifies number-shaped tokens at nested EOF boundaries', () => {
    for (const source of ['{1.', '{-1', '[1 2.', '{"a":1 2.']) {
        deepStrictEqual(parseJSONLChunk(source), { values: [], read: 0, done: false, error: null }, source);
        deepStrictEqual(parseJSONLChunk(enc(source)), { values: [], read: 0, done: false, error: null }, source);
    }
    for (const source of ['{01', '{1e', '{truex', '{nullx', '[1 2e', '{"a":1 2e', '[1e+']) {
        strictEqual(parseJSONLChunk(source).error instanceof SyntaxError, true, source);
        strictEqual(parseJSONLChunk(enc(source)).error instanceof SyntaxError, true, source);
    }
});

Deno.test('bun: JSONL single-byte EOF classification matches the oracle', () => {
    // Punctuation that stays pending at end of input, then errors once a newline follows.
    for (const ch of [',', ':', ';', '=', '(', ')', '.', '-', '[', '{', ']', '}', '"', '$', '_']) {
        strictEqual(parseJSONLChunk(ch).done, false, ch);
        strictEqual(parseJSONLChunk(ch).error, null, ch);
    }
    for (const ch of ['<', '>', '?', '@', '\\', '^', '`', '|', '~', '!', '#', '%', '&', "'", '*', '+', '/']) {
        strictEqual(parseJSONLChunk(ch).error instanceof SyntaxError, true, ch);
    }
});

Deno.test('bun: JSONL parse and parseChunk are exported from the same module as JSONL', () => {
    strictEqual(JSONL.parse, parseJSONL);
    strictEqual(JSONL.parseChunk, parseJSONLChunk);
});

Deno.test('bun: JSONL public object and functions match the native API shape', () => {
    deepStrictEqual(Reflect.ownKeys(JSONL), ['parse', 'parseChunk', Symbol.toStringTag]);
    strictEqual(Object.prototype.toString.call(JSONL), '[object JSONL]');
    strictEqual(JSONL.parse.name, 'parse');
    strictEqual(JSONL.parse.length, 1);
    strictEqual(JSONL.parseChunk.name, 'parseChunk');
    strictEqual(JSONL.parseChunk.length, 1);
    strictEqual(Object.hasOwn(JSONL.parse, 'prototype'), false);
    strictEqual(Object.hasOwn(JSONL.parseChunk, 'prototype'), false);
    strictEqual(Object.getOwnPropertyDescriptor(JSONL, 'parse')?.configurable, false);
    strictEqual(Object.getOwnPropertyDescriptor(JSONL, 'parseChunk')?.configurable, false);
    doesNotThrow(() => JSONL.parse.call(null, '1\n'));
    throws(() => Reflect.construct(JSONL.parse as never, ['1\n']), TypeError);
    throws(() => Reflect.construct(JSONL.parseChunk as never, ['1\n']), TypeError);
});
