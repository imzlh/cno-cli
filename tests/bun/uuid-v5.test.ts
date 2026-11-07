import { strictEqual, deepStrictEqual, throws, ok } from 'node:assert';
import { runInNewContext } from 'node:vm';
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
    strictEqual(output.byteOffset, 0);
    strictEqual(output.buffer.byteLength, 16);
    strictEqual(output[6] >> 4, 5);
    strictEqual(output[8] >> 6, 2);
    strictEqual(randomUUIDv5(name, ns, 'base64'), 'Iff43oBRW4mGgAGV73mLag==');
    strictEqual(randomUUIDv5(name, ns, 'base64url'), 'Iff43oBRW4mGgAGV73mLag');
    deepStrictEqual([...output], [...ns.map((_, i) => parseInt(expected.replace(/-/g, '').slice(i * 2, i * 2 + 2), 16))]);
    strictEqual(randomUUIDv5(name, ns, 'ascii'), output.toString('ascii'));
    strictEqual(randomUUIDv5('x', namespace, 'ucs2'), '\ub105\u016a\uc646\udd56\u6ebd\udfc6\ua1b4\u7a42');
    strictEqual(randomUUIDv5('x', namespace, 'ucs-2'), randomUUIDv5('x', namespace, 'ucs2'));
    strictEqual(randomUUIDv5('x', namespace, 'utf16le'), randomUUIDv5('x', namespace, 'ucs2'));
    ok(randomUUIDv5.name === 'randomUUIDv5' && randomUUIDv5.length === 3);
    strictEqual(Object.hasOwn(randomUUIDv5, 'prototype'), false);
    throws(() => new (randomUUIDv5 as any)('x', namespace), TypeError);
});

Deno.test('bun: UUIDv5 preserves view windows and accepts cross-realm binary values', () => {
    const foreign = runInNewContext(`(() => {
        const name = new Uint8Array(19);
        name.set([119, 119, 119, 46, 119, 105, 100, 103, 101, 116, 115, 46, 99, 111, 109], 2);
        const namespace = new Uint8Array(20);
        namespace.set([107, 167, 184, 16, 157, 173, 17, 209, 128, 180, 0, 192, 79, 212, 48, 200], 2);
        return {
            name: new DataView(name.buffer, 2, 15),
            namespace: namespace.subarray(2, 18),
            namespaceBuffer: namespace.buffer.slice(2, 18),
            alias: new String('DNS'),
        };
    })()`);
    strictEqual(randomUUIDv5(foreign.name, foreign.namespace), expected);
    strictEqual(randomUUIDv5('www.widgets.com', foreign.namespaceBuffer), expected);
    strictEqual(randomUUIDv5('www.widgets.com', foreign.alias), expected);

    const paddedName = new Uint8Array(19);
    paddedName.set(new TextEncoder().encode('www.widgets.com'), 2);
    const paddedNamespace = new Uint8Array(20);
    paddedNamespace.set(Uint8Array.from(namespace.replaceAll('-', '').match(/../g)!, value => parseInt(value, 16)), 2);
    strictEqual(randomUUIDv5(new DataView(paddedName.buffer, 2, 15), new DataView(paddedNamespace.buffer, 2, 16)), expected);
});

Deno.test('bun: UUIDv5 reads binary brands and windows from internal slots', () => {
    const ns = Uint8Array.from(namespace.replaceAll('-', '').match(/../g)!, value => parseInt(value, 16));
    const name = new TextEncoder().encode('www.widgets.com');
    const shadow = <T extends ArrayBuffer | ArrayBufferView>(value: T): T => {
        for (const key of ['buffer', 'byteOffset', 'byteLength']) {
            Object.defineProperty(value, key, { configurable: true, get() { throw new Error(`read ${key}`); } });
        }
        return value;
    };

    strictEqual(randomUUIDv5(shadow(name.slice()), ns), expected);
    strictEqual(randomUUIDv5(shadow(new DataView(name.slice().buffer)), ns), expected);
    strictEqual(randomUUIDv5(name, shadow(ns.slice())), expected);
    strictEqual(randomUUIDv5(name, shadow(new DataView(ns.slice().buffer))), expected);
    strictEqual(randomUUIDv5(shadow(name.slice().buffer), ns), expected);
    strictEqual(randomUUIDv5(name, shadow(ns.slice().buffer)), expected);

    const call = randomUUIDv5 as (...args: any[]) => any;
    throws(() => call(new Proxy(name, {}), ns), { code: 'ERR_INVALID_ARG_TYPE' });
    throws(() => call(new Proxy(name.buffer, {}), ns), { code: 'ERR_INVALID_ARG_TYPE' });
    throws(() => call(name, new Proxy(ns, {})), { code: 'ERR_INVALID_ARG_TYPE' });
    throws(() => call(name, new Proxy(ns.buffer, {})), { code: 'ERR_INVALID_ARG_TYPE' });

    const isView = ArrayBuffer.isView;
    try {
        ArrayBuffer.isView = (() => { throw new Error('ArrayBuffer.isView called'); }) as typeof ArrayBuffer.isView;
        strictEqual(randomUUIDv5(name, ns), expected);
        throws(() => call({}, ns), { code: 'ERR_INVALID_ARG_TYPE' });
        throws(() => call(name, {}), { code: 'ERR_INVALID_ARG_TYPE' });
    } finally {
        ArrayBuffer.isView = isView;
    }
});

Deno.test('bun: UUIDv5 treats detached and out-of-bounds views as empty windows', () => {
    const ns = Uint8Array.from(namespace.replaceAll('-', '').match(/../g)!, value => parseInt(value, 16));
    const emptyName = randomUUIDv5('', ns);
    const call = randomUUIDv5 as (...args: any[]) => any;
    const detached = (kind: 'buffer' | 'typed' | 'view') => {
        const buffer = new ArrayBuffer(16);
        const value = kind === 'buffer' ? buffer : kind === 'typed' ? new Uint8Array(buffer) : new DataView(buffer);
        structuredClone(buffer, { transfer: [buffer] });
        return value;
    };

    for (const kind of ['buffer', 'typed', 'view'] as const) {
        strictEqual(call(detached(kind), ns), emptyName);
        throws(() => call('', detached(kind)), { code: 'ERR_INVALID_ARG_VALUE', message: 'Namespace must be exactly 16 bytes' });
    }

    if (typeof ArrayBuffer.prototype.resize !== 'function') return;
    const outOfBounds = (kind: 'typed' | 'view') => {
        const buffer = new ArrayBuffer(32, { maxByteLength: 64 });
        const value = kind === 'typed' ? new Uint8Array(buffer, 16, 16) : new DataView(buffer, 16, 16);
        buffer.resize(8);
        return value;
    };
    for (const kind of ['typed', 'view'] as const) {
        strictEqual(call(outOfBounds(kind), ns), emptyName);
        throws(() => call('', outOfBounds(kind)), { code: 'ERR_INVALID_ARG_VALUE', message: 'Namespace must be exactly 16 bytes' });
    }
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
