import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { runInNewContext } from 'node:vm';
import { JSON5 } from '../../cno/src/bun/utils/json5.ts';

Deno.test('bun: JSON5 methods match Bun call shape', () => {
    strictEqual(JSON5.parse.name, 'parse');
    strictEqual(JSON5.parse.length, 1);
    strictEqual(Object.hasOwn(JSON5.parse, 'prototype'), false);
    throws(() => Reflect.construct(JSON5.parse, ['1']), TypeError);
    strictEqual(JSON5.stringify.name, 'stringify');
    strictEqual(JSON5.stringify.length, 3);
    strictEqual(Object.hasOwn(JSON5.stringify, 'prototype'), false);
    throws(() => Reflect.construct(JSON5.stringify, [1]), TypeError);
});

Deno.test('bun: JSON5 parses JSON5 syntax and raw byte views', () => {
    const source = `/* comment */ {unquoted: 'hello\\\nworld', hex: -0x10, numbers: [+1, .5, 1., Infinity, -Infinity, NaN,], escaped: '\\x41\\u0042\\v', // comment
    nested: {true: null,},}`;
    const expected = { unquoted: 'helloworld', hex: -16, numbers: [1, .5, 1, Infinity, -Infinity, NaN], escaped: 'AB\v', nested: { true: null } };
    deepStrictEqual(JSON5.parse(source), expected);
    const bytes = new TextEncoder().encode(`xx${source}yy`);
    deepStrictEqual(JSON5.parse(bytes.subarray(2, -2)), expected);
    deepStrictEqual(JSON5.parse('{\\u0061: 1, __proto__: 2}'), JSON.parse('{"a":1,"__proto__":2}'));
    strictEqual(JSON5.parse(42), 42);
    strictEqual(JSON5.parse(true), true);
});

Deno.test('bun: JSON5 rejects invalid syntax and nullish input', () => {
    for (const source of ['', '01', '[1,,2]', '{x:}', '/*', '"\\8"', '1 garbage', "'line\nbreak'"]) {
        throws(() => JSON5.parse(source), SyntaxError, source);
    }
    throws(() => JSON5.parse(null), TypeError);
    throws(() => JSON5.parse(undefined), TypeError);
    throws(() => JSON5.parse(Symbol()), TypeError);
});

Deno.test('bun: JSON5.stringify uses JSON5 formatting and ignores toJSON', () => {
    const value = { foo: 'a', 'a-b': "x'y", numbers: [undefined, NaN, Infinity], missing: undefined };
    strictEqual(JSON5.stringify(value), "{foo:'a','a-b':'x\\'y',numbers:[null,NaN,Infinity]}");
    strictEqual(JSON5.stringify({ a: 1 }, null, 2), '{\n  a: 1,\n}');
    strictEqual(JSON5.stringify([1], null, 'abcdefghijk'), '[\nabcdefghij1,\n]');
    strictEqual(JSON5.stringify({ toJSON() { return 1; } }), '{}');
    strictEqual(JSON5.stringify('\0\v\x01\u2028'), "'\\0\\v\\x01\\u2028'");
    strictEqual(JSON5.stringify(undefined), undefined);
    throws(() => JSON5.stringify(1, () => 1), /does not support the replacer/);
    throws(() => JSON5.stringify(1n), /cannot serialize BigInt/);
    const circular: any = {}; circular.self = circular;
    throws(() => JSON5.stringify(circular), /circular structure to JSON5/);
});

Deno.test('bun: JSON5 handles object keys, byte offsets and control characters', () => {
    const object = JSON5.parse('{__proto__: {polluted: true}, constructor: 1, a: 1, a: 2}');
    strictEqual(Object.getPrototypeOf(object), Object.prototype);
    strictEqual(Object.prototype.hasOwnProperty.call(object, '__proto__'), true);
    strictEqual(({} as any).polluted, undefined);
    strictEqual(object.a, 2);
    const bytes = new TextEncoder().encode('x-0x10x');
    strictEqual(JSON5.parse(new DataView(bytes.buffer, 1, 5)), -16);
    if (typeof SharedArrayBuffer !== 'undefined') {
        const shared = new SharedArrayBuffer(2);
        new Uint8Array(shared).set([0x34, 0x32]);
        strictEqual(JSON5.parse(shared), 42);
    }
    strictEqual(JSON5.stringify('\x7f'), "'\\x7f'");
    strictEqual(JSON5.stringify({ '𝒜': 1, α: 2 }), "{'𝒜':1,α:2}");
    for (const source of ['0x', '1e+', '00', '{a:1,,}', '[,1]', '"\\u123"', '"\\01"']) {
        throws(() => JSON5.parse(source), SyntaxError, source);
    }
});

Deno.test('bun: JSON5 uses binary brands and intrinsic view windows', () => {
    const foreign = runInNewContext(`(() => {
        const buffer = new Uint8Array([120, 120, 52, 50, 121, 121]).buffer;
        return {
            buffer: new Uint8Array([52, 50]).buffer,
            typed: new Uint16Array(buffer, 2, 1),
            data: new DataView(buffer, 2, 2),
        };
    })()`);
    strictEqual(JSON5.parse(foreign.buffer), 42);
    strictEqual(JSON5.parse(foreign.typed), 42);
    strictEqual(JSON5.parse(foreign.data), 42);

    const backing = new Uint8Array([120, 52, 50, 121]);
    for (const view of [new Uint8Array(backing.buffer, 1, 2), new DataView(backing.buffer, 1, 2)]) {
        for (const key of ['buffer', 'byteOffset', 'byteLength']) {
            Object.defineProperty(view, key, {
                configurable: true,
                get() { throw new Error(`shadowed ${key} getter ran`); },
            });
        }
        strictEqual(JSON5.parse(view), 42);
    }

    const rawBuffers: ArrayBufferLike[] = [new ArrayBuffer(2)];
    if (typeof SharedArrayBuffer === 'function') rawBuffers.push(new SharedArrayBuffer(2));
    for (const raw of rawBuffers) {
        new Uint8Array(raw).set([52, 50]);
        Object.defineProperty(raw, 'byteLength', {
            configurable: true,
            get() { throw new Error('shadowed byteLength getter ran'); },
        });
        strictEqual(JSON5.parse(raw), 42);
    }

    if (typeof SharedArrayBuffer === 'function') {
        const shared = new SharedArrayBuffer(6);
        new Uint8Array(shared).set([120, 120, 52, 50, 121, 121]);
        strictEqual(JSON5.parse(new Uint16Array(shared, 2, 1)), 42);
        strictEqual(JSON5.parse(new DataView(shared, 2, 2)), 42);
    }
});

Deno.test('bun: JSON5 treats detached binary inputs as empty and rejects proxies and invalid UTF-8', () => {
    const arrayBuffer = new ArrayBuffer(2);
    const typedBuffer = new ArrayBuffer(2);
    const typed = new Uint8Array(typedBuffer);
    const dataBuffer = new ArrayBuffer(2);
    const data = new DataView(dataBuffer);
    structuredClone(arrayBuffer, { transfer: [arrayBuffer] });
    structuredClone(typedBuffer, { transfer: [typedBuffer] });
    structuredClone(dataBuffer, { transfer: [dataBuffer] });
    for (const input of [arrayBuffer, typed, data]) throws(() => JSON5.parse(input), SyntaxError);

    throws(() => JSON5.parse(new Proxy(new Uint8Array([52, 50]), {})), TypeError);
    for (const bytes of [
        new Uint8Array([0xff]),
        new Uint8Array([0xc0, 0xaf]),
        new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22]),
    ]) {
        throws(() => JSON5.parse(bytes), SyntaxError);
    }
});

Deno.test('bun: JSON5.stringify identifies boxed values without consulting toStringTag', () => {
    const value = { a: 1, get [Symbol.toStringTag]() { throw new Error('must not be read'); } };
    strictEqual(JSON5.stringify(value), '{a:1}');
    strictEqual(JSON5.stringify({ a: 1, [Symbol.toStringTag]: 'BigInt' }), '{a:1}');
    strictEqual(JSON5.stringify(Object.assign(new String('a'), { valueOf: () => 'b' })), "'a'");
    strictEqual(JSON5.stringify(Object.assign(new Boolean(false), { valueOf: () => true })), 'false');
    strictEqual(JSON5.stringify({ a: 1 }, null, Object.assign(new String('xy'), {
        valueOf() { throw new Error('must not be called'); },
    })), '{\nxya: 1,\n}');
    strictEqual(JSON5.stringify({ a: 1 }, null, Object.assign(new String('xy'), {
        toString() { return 'zz'; },
    })), '{\nzza: 1,\n}');
    strictEqual(JSON5.stringify({ a: 1 }, null, new Proxy(new String('xy'), {})), '{a:1}');
    strictEqual(JSON5.stringify(Object.create(Number.prototype)), '{}');
    throws(() => JSON5.stringify(Object(1n)), /cannot serialize BigInt/);
});
