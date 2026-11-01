import { strictEqual, deepStrictEqual, throws, ok } from 'node:assert';
import { randomUUIDv5 } from '../../cno/src/bun/uuid/v5.ts';

const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const expected = '21f7f8de-8051-5b89-8680-0195ef798b6a';

Deno.test('bun: UUIDv5 RFC vector, inputs and encodings', () => {
    strictEqual(randomUUIDv5('www.widgets.com', namespace), expected);
    strictEqual(randomUUIDv5('www.widgets.com', namespace.toUpperCase(), 'hex'), expected);
    const ns = Uint8Array.from([0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]);
    const padded = new Uint8Array(20); padded.set(ns, 2);
    const name = new TextEncoder().encode('www.widgets.com');
    strictEqual(randomUUIDv5(name.buffer, new DataView(padded.buffer, 2, 16)), expected);
    strictEqual(randomUUIDv5(name, ns.buffer), expected);
    const output = randomUUIDv5(name, ns, 'buffer');
    strictEqual(output.length, 16);
    strictEqual(output[6] >> 4, 5);
    strictEqual(output[8] >> 6, 2);
    strictEqual(randomUUIDv5(name, ns, 'base64'), 'Iff43oBRW4mGgAGV73mLag==');
    strictEqual(randomUUIDv5(name, ns, 'base64url'), 'Iff43oBRW4mGgAGV73mLag');
    deepStrictEqual([...output], [...ns.map((_, i) => parseInt(expected.replace(/-/g, '').slice(i * 2, i * 2 + 2), 16))]);
    strictEqual(randomUUIDv5(name, ns, 'ascii'), output.toString('ascii'));
    ok(randomUUIDv5.name === 'randomUUIDv5' && randomUUIDv5.length === 3);
    strictEqual(Object.hasOwn(randomUUIDv5, 'prototype'), false);
    throws(() => new (randomUUIDv5 as any)('x', namespace), TypeError);
});

Deno.test('bun: UUIDv5 predefined namespaces are case insensitive', () => {
    const cases = [
        ['dns', '6ba7b810-9dad-11d1-80b4-00c04fd430c8', '21f7f8de-8051-5b89-8680-0195ef798b6a'],
        ['url', '6ba7b811-9dad-11d1-80b4-00c04fd430c8', '255af1f8-53b9-5cd9-a56b-010c24df82e0'],
        ['oid', '6ba7b812-9dad-11d1-80b4-00c04fd430c8', 'd9aa9182-d54e-59ca-ab63-e34cd374d360'],
        ['x500', '6ba7b814-9dad-11d1-80b4-00c04fd430c8', '6d762c22-e074-570e-a751-1f8c23a3bf97'],
    ];
    for (const [alias, uuid, result] of cases) {
        strictEqual(randomUUIDv5('www.widgets.com', alias), result);
        strictEqual(randomUUIDv5('www.widgets.com', alias.toUpperCase()), result);
        strictEqual(randomUUIDv5('www.widgets.com', uuid), result);
    }
    for (const invalid of ['x.500', ' dns', 'dns\n', 'constructor', '__proto__']) {
        throws(() => randomUUIDv5('', invalid), { name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE', message: 'Invalid UUID format for namespace' });
    }
});

Deno.test('bun: UUIDv5 validates types, encodings and namespace in Bun order', () => {
    const call = randomUUIDv5 as (...args: any[]) => any;
    throws(() => call(null, null, 'bad'), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'name must be a string, ArrayBuffer or ArrayBufferView' });
    throws(() => call('', null, 'bad'), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'namespace must be a string, ArrayBuffer or ArrayBufferView' });
    throws(() => call('', 'bad', 'bad'), { name: 'TypeError', code: 'ERR_UNKNOWN_ENCODING', message: 'Encoding must be one of base64, base64url, hex, or buffer' });
    throws(() => call('', 'bad'), { name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE', message: 'Invalid UUID format for namespace' });
    throws(() => call('', `${namespace}\n`), { code: 'ERR_INVALID_ARG_VALUE' });
    throws(() => call('', new Uint8Array(15)), { name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE', message: 'Namespace must be exactly 16 bytes' });
    strictEqual(call('www.widgets.com', namespace, null), expected);
    strictEqual(call('www.widgets.com', namespace, 'HEX'), expected);
    strictEqual(call(new String('www.widgets.com'), new String(namespace), new String('HEX')), expected);
    strictEqual(call('www.widgets.com', namespace, new String('base64')), 'Iff43oBRW4mGgAGV73mLag==');
    throws(() => call('', namespace, new String('invalid')), { code: 'ERR_UNKNOWN_ENCODING' });
    strictEqual(call('www.widgets.com', namespace, {}), expected);
    const shared = new SharedArrayBuffer(16);
    strictEqual(call('', shared), call('', new Uint8Array(16)));
    const order: string[] = [];
    const boxed = (value: string, label: string) => Object.assign(new String(value), { toString() { order.push(label); return value; } });
    call(boxed('x', 'name'), boxed(namespace, 'namespace'), boxed('hex', 'encoding'));
    deepStrictEqual(order, ['name', 'namespace', 'encoding']);
});
