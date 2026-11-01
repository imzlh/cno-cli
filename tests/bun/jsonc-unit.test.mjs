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

test('JSONC accepts comments and trailing commas in nested containers', () => {
    assert.deepEqual(JSONC.parse(`// configuration\r\n{
        /* multiline\n comment */ "list": [1, /* next */ 2, // last\n],
        "nested": { "enabled": true, /* trailing */ },
    } // end`), { list: [1, 2], nested: { enabled: true } });
    assert.deepEqual(JSONC.parse('[/**/\n]'), []);
    assert.deepEqual(JSONC.parse('{/**/}'), {});
    assert.equal(JSONC.parse('/* start */ 42 // end'), 42);
    assert.deepEqual(JSONC.parse('[1,\r// comment\r]'), [1]);
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
        '[1,]\u00a0', '[1,]\u2028', '{} {}', '/* nested /* */ */ {}',
    ];
    for (const source of invalid) {
        assert.throws(() => JSONC.parse(source), SyntaxError, source);
    }
});
