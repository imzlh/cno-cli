import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSONC, parseJSONC } from '../../cno/src/bun/utils/jsonc.ts';

test('JSONC parses standard JSON values using JSON semantics', () => {
    for (const source of ['null', 'true', 'false', '-1.25e+3', '"text"', '[]', '{}']) {
        assert.deepEqual(JSONC.parse(source), JSON.parse(source));
    }
    assert.equal(JSONC.parse, parseJSONC);
    const result = JSONC.parse('{"__proto__":{"polluted":true},"duplicate":1,"duplicate":2}');
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.hasOwn(result, '__proto__'), true);
    assert.equal(result.duplicate, 2);
    assert.equal(Object.prototype.polluted, undefined);
});

test('JSONC.parse has the Bun function shape and descriptor', () => {
    assert.equal(JSONC.parse, parseJSONC);
    assert.equal(parseJSONC.name, 'parse');
    assert.equal(parseJSONC.length, 1);
    assert.equal(Object.hasOwn(parseJSONC, 'prototype'), false);
    assert.deepEqual(Object.getOwnPropertyDescriptor(JSONC, 'parse'), {
        value: parseJSONC,
        writable: true,
        enumerable: true,
        configurable: true,
    });
    assert.throws(() => Reflect.construct(parseJSONC, ['1']), TypeError);
    assert.equal(parseJSONC.call({ ignored: true }, '1'), 1);
});

test('JSONC.parse follows Bun ToString coercion without decoding binary views', () => {
    for (const [input, expected] of [
        [true, true], [12.5, 12.5], [1n, 1], [[1], 1],
        [new String('[1,]'), [1]], [new Uint8Array([49]), 49], [new Uint16Array([12345]), 12345],
    ]) {
        assert.deepEqual(JSONC.parse(input), expected);
    }

    const hints = [];
    assert.equal(JSONC.parse({ [Symbol.toPrimitive](hint) { hints.push(hint); return '2'; } }), 2);
    assert.deepEqual(hints, ['string']);
    assert.deepEqual(JSONC.parse(Buffer.from('[1,]')), [1]);

    for (const input of [new Uint8Array([91, 49, 93]), new DataView(new ArrayBuffer(1)), new ArrayBuffer(1)]) {
        assert.throws(() => JSONC.parse(input), SyntaxError);
    }
    for (const input of [undefined, null]) {
        assert.throws(() => JSONC.parse(input), { name: 'TypeError', message: 'input must be a string' });
    }
    assert.throws(() => JSONC.parse(), { name: 'TypeError', message: 'input must be a string' });
    assert.throws(() => JSONC.parse(Symbol('input')), TypeError);
    assert.throws(() => JSONC.parse({ toString() { throw new RangeError('coerce'); } }), {
        name: 'RangeError', message: 'coerce',
    });
});

test('JSONC accepts comments and trailing commas in nested containers', () => {
    assert.deepEqual(JSONC.parse(`// configuration\r\n{
        /* multiline\n comment */ "list": [1, /* next */ 2, // last\n],
        "nested": { "enabled": true, /* trailing */ },
    } // end`), { list: [1, 2], nested: { enabled: true } });
    assert.deepEqual(JSONC.parse('[/**/\n]'), []);
    assert.deepEqual(JSONC.parse('{/**/}'), {});
    assert.equal(JSONC.parse('/* start */ 42 // end'), 42);
    assert.deepEqual(JSONC.parse('[1,\r// comment\r]'), [1]);
    assert.deepEqual(JSONC.parse('[1// line separator\u2028,2// paragraph separator\u2029,]'), [1, 2]);
    assert.deepEqual(JSONC.parse('\ufeff[1,/* before close */]'), [1]);
});

test('JSONC accepts Bun ECMAScript whitespace outside strings', () => {
    const whitespace = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006'
        + '\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
    assert.deepEqual(JSONC.parse(`${whitespace}[${whitespace}1${whitespace},${whitespace}]${whitespace}`), [1]);

    const stringValue = `before${whitespace}after`;
    assert.equal(JSONC.parse(JSON.stringify(stringValue)), stringValue);
    assert.throws(() => JSONC.parse('[1// vertical whitespace does not end the comment\v\f,2]'), SyntaxError);
});

test('JSONC preserves comment markers, delimiters, and escaped quotes inside strings', () => {
    const value = ['https://example.test/a/*b*/', '\\"//not a comment', '\\\\', ',}', ',]', '/*', '*/'];
    assert.deepEqual(JSONC.parse(`/* before */ ${JSON.stringify(value)} // after`), value);
    assert.deepEqual(JSONC.parse('{"escaped\\\"/*key*/":"value,]",}'), { 'escaped"/*key*/': 'value,]' });
});

test('JSONC rejects malformed JSON and does not broaden into JSON5', () => {
    const invalid = [
        '', '// comment only', '/* unterminated', '{} /* unterminated',
        '[,]', '{,}', '[1,,]', '{"x":1,,}', '[1,/* gap */,]',
        '[1 2]', '[1/* gap */2]', 'tr/* gap */ue', '1/* gap */2',
        '{"x":,}', '{"x",}', '{"x":true, "y":}',
        '{unquoted:1}', "{'single':1}", '[undefined]', '[NaN]', '[Infinity]',
        '[0x10]', '[+1]', '[01]', '"unterminated', '"raw\nnewline"',
        '[1,]\u0085', '[1,]\u180e', '[1,]\u2060', '\u00851', '\u180e1',
        '{} {}', '1/* comment */2', '/* nested /* */ */ {}',
    ];
    for (const source of invalid) {
        assert.throws(() => JSONC.parse(source), error => {
            assert.equal(error?.constructor, SyntaxError, source);
            assert.match(error.message, /^JSONC Parse error:/, source);
            return true;
        });
    }
    assert.throws(() => JSONC.parse('/* unterminated'), {
        name: 'SyntaxError',
        message: 'JSONC Parse error: Expected "*/" to terminate multi-line comment',
    });
});
