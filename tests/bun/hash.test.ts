import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { runInNewContext } from 'node:vm';
import hash from '../../cno/src/bun/hash/index.ts';

const hashNames = [
    'hash', 'wyhash', 'adler32', 'crc32', 'cityHash32', 'cityHash64',
    'xxHash32', 'xxHash64', 'murmur32v2', 'murmur32v3', 'murmur64v2',
] as const;

function hashFunction(name: typeof hashNames[number]): (data: unknown, seed?: unknown) => number | bigint {
    return name === 'hash'
        ? hash as unknown as (data: unknown, seed?: unknown) => bigint
        : (hash as unknown as Record<string, (data: unknown, seed?: unknown) => number | bigint>)[name];
}

// Generated independently with Bun 1.3.14; lengths cover short and block paths.
const vectors: Record<string, Array<[number, string, string]>> = {
    wyhash: [
        [0, "290873116282709081", "10554359555411758265"],
        [3, "12707251810896041482", "6097723703734350923"],
        [16, "9596187337276730530", "6972767446960149408"],
        [33, "8538603489192548107", "7549469471308311002"],
        [65, "4125511417004266586", "15371238021740542828"],
        [129, "2086020914004188382", "9074355679644290454"],
    ],
    adler32: [
        [0, "1", "1"],
        [3, "60228080", "60228080"],
        [16, "1230506073", "1230506073"],
        [33, "747639249", "747639249"],
        [65, "1757225249", "1757225249"],
        [129, "3127984577", "3127984577"],
    ],
    crc32: [
        [0, "0", "123456"],
        [3, "3065356688", "3714092456"],
        [16, "4184229313", "3995620996"],
        [33, "828002398", "1940563694"],
        [65, "3544425069", "3357613709"],
        [129, "2177074179", "2653856460"],
    ],
    cityHash32: [
        [0, "3696677242", "3696677242"],
        [3, "1557246270", "1557246270"],
        [16, "1511054377", "1511054377"],
        [33, "113723733", "113723733"],
        [65, "345145526", "345145526"],
        [129, "2843734516", "2843734516"],
    ],
    cityHash64: [
        [0, "0", "2622991264075586404"],
        [3, "16976495270931353165", "9594744038749531271"],
        [16, "9085395217545622528", "993043783568017643"],
        [33, "11394003346765960225", "3413744487982254882"],
        [65, "10081490080855457882", "4435974627007354107"],
        [129, "9816740276566165357", "7196584604246853622"],
    ],
    xxHash32: [
        [0, "46947589", "2249533708"],
        [3, "1047081942", "3375397817"],
        [16, "414211937", "3880780367"],
        [33, "1359941874", "1629377369"],
        [65, "285001732", "2213608876"],
        [129, "1620029072", "678716520"],
    ],
    xxHash64: [
        [0, "17241709254077376921", "17586581551997997898"],
        [3, "9568752790060189458", "4286445199872952057"],
        [16, "11555270759556775899", "4259216097195603204"],
        [33, "12250113901613710945", "8326970242894357057"],
        [65, "6991706220707514124", "6119308130017849179"],
        [129, "10494544716208942210", "41805090847122910"],
    ],
    murmur32v2: [
        [0, "0", "2408612312"],
        [3, "3716362986", "1860291060"],
        [16, "3731294972", "1479093862"],
        [33, "761481976", "2769377141"],
        [65, "3874849173", "408790814"],
        [129, "4149824758", "819932294"],
    ],
    murmur32v3: [
        [0, "0", "2524076747"],
        [3, "1782009257", "802422650"],
        [16, "3524684315", "219403819"],
        [33, "1567523854", "2793068641"],
        [65, "2242147030", "3247355004"],
        [129, "712747270", "608910373"],
    ],
    murmur64v2: [
        [0, "0", "12442697794056467994"],
        [3, "8168666686736940631", "6230645971550477498"],
        [16, "17036926767778633713", "12529044061747819847"],
        [33, "7550158365771679695", "8888551547903656390"],
        [65, "18069011209404581744", "2281336119240230585"],
        [129, "2085529410406000967", "9638922630744481846"],
    ],
};

Deno.test('bun: hash algorithms match seeded and unseeded vectors', () => {
    for (const [name, cases] of Object.entries(vectors)) {
        const fn = (hash as unknown as Record<string, (data: Uint8Array, seed?: number) => number | bigint>)[name];
        for (const [length, expected, seeded] of cases) {
            const storage = Uint8Array.from({ length: length + 5 }, (_, i) => ((i - 3) * 37 + 128) & 255);
            const view = storage.subarray(3, 3 + length);
            strictEqual(String(fn(view)), expected, `${name} length ${length}`);
            strictEqual(String(fn(view, 123456)), seeded, `${name} length ${length} seeded`);
        }
    }
});

Deno.test('bun: hash input and seed coercion', () => {
    const fn = hash.xxHash64 as unknown as (data: unknown, seed?: unknown) => bigint;
    for (const name of hashNames) {
        const hashFn = hashFunction(name);
        strictEqual(hashFn.length, 1, `${name}.length`);
        const invalidInput = {
            name: 'TypeError',
            code: 'ERR_INVALID_ARG_TYPE',
            message: 'data must be a string, ArrayBuffer, ArrayBufferView or Blob',
        };
        throws(() => hashFn(null), invalidInput);
        throws(() => hashFn(undefined), invalidInput);
    }
    let invalidError: unknown;
    try {
        hash(null as never);
    } catch (error) {
        invalidError = error;
    }
    strictEqual(invalidError instanceof TypeError, true);
    const codedError = invalidError as TypeError & { code: string };
    strictEqual(codedError.code, 'ERR_INVALID_ARG_TYPE');
    strictEqual(Object.hasOwn(codedError, 'code'), false);
    strictEqual(Object.prototype.propertyIsEnumerable.call(codedError, 'code'), false);
    strictEqual(String(codedError),
        'TypeError [ERR_INVALID_ARG_TYPE]: data must be a string, ArrayBuffer, ArrayBufferView or Blob');
    deepStrictEqual(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(codedError), 'code'), {
        configurable: true,
        enumerable: true,
        value: 'ERR_INVALID_ARG_TYPE',
        writable: true,
    });
    strictEqual(fn(123), fn('123'));
    strictEqual(fn({ toString: () => 'abc' }), fn('abc'));
    throws(() => fn(Symbol('x')), TypeError);
    strictEqual(fn('abc', 1.5), fn('abc', 1n));
    strictEqual(fn('abc', -1.5), fn('abc', -1n));
    strictEqual(fn('abc', 2 ** 53), fn('abc', 2n ** 53n));
    strictEqual(fn('abc', Infinity), fn('abc', (1n << 64n) - 1n));
    strictEqual(fn('abc', -Infinity), fn('abc'));
    strictEqual(fn('abc', -1n), fn('abc', 0xffff_ffff_ffff_ffffn));
    strictEqual(fn('abc', (1n << 64n) + 1n), fn('abc', 1n));
    const fn32 = hash.xxHash32 as unknown as (data: unknown, seed?: unknown) => number;
    strictEqual(fn32('abc', 2 ** 40 + 3.9), fn32('abc', 3n));
    strictEqual(fn32('abc', -1.5), fn32('abc', -1n));
    strictEqual(fn32('abc', Infinity), fn32('abc', (1n << 32n) - 1n));
    strictEqual(fn32('abc', (1n << 32n) + 1n), fn32('abc', 1n));
    const backing = new Uint8Array([1, 2, 3, 4, 5]);
    strictEqual(fn(new DataView(backing.buffer, 1, 3)), fn(new Uint8Array([2, 3, 4])));
    strictEqual(fn('\ud800'), fn('\ufffd'));
    strictEqual(fn({ toString: () => 'a\ud800b' }), fn('a\ufffdb'));
});

Deno.test('bun: hash recognizes cross-realm buffers and preserves view windows', () => {
    const fn = hash.xxHash64 as unknown as (data: unknown) => bigint;
    const foreign = runInNewContext(`(() => {
        const buffer = new ArrayBuffer(8);
        new Uint8Array(buffer).set([10, 11, 12, 23, 34, 15, 16, 17]);
        const result = {
            buffer,
            typed: new Uint16Array(buffer, 2, 2),
            data: new DataView(buffer, 2, 3),
        };
        if (typeof SharedArrayBuffer === 'function') {
            const shared = new SharedArrayBuffer(5);
            new Uint8Array(shared).set([90, 12, 23, 34, 91]);
            result.shared = shared;
            result.sharedView = new Uint8Array(shared, 1, 3);
        }
        return result;
    })()`);

    strictEqual(fn(foreign.buffer), fn(new Uint8Array([10, 11, 12, 23, 34, 15, 16, 17])));
    strictEqual(fn(foreign.typed), fn(new Uint8Array([12, 23, 34, 15])));
    strictEqual(fn(foreign.data), fn(new Uint8Array([12, 23, 34])));
    if (foreign.shared) {
        strictEqual(fn(foreign.shared), fn(new Uint8Array([90, 12, 23, 34, 91])));
        strictEqual(fn(foreign.sharedView), fn(new Uint8Array([12, 23, 34])));
    }
});

Deno.test('bun: hash ignores shadowed view metadata and treats detached inputs as empty', () => {
    const fn = hash.xxHash64 as unknown as (data: unknown) => bigint;
    const expected = fn(new Uint8Array([12, 23, 34]));
    const buffer = new Uint8Array([90, 12, 23, 34, 91]).buffer;
    for (const view of [new Uint8Array(buffer, 1, 3), new DataView(buffer, 1, 3)]) {
        for (const key of ['buffer', 'byteOffset', 'byteLength']) {
            Object.defineProperty(view, key, {
                configurable: true,
                get() { throw new Error(`shadowed ${key} getter ran`); },
            });
        }
        strictEqual(fn(view), expected);
    }

    for (const raw of [new ArrayBuffer(3), new SharedArrayBuffer(3)]) {
        new Uint8Array(raw).set([12, 23, 34]);
        Object.defineProperty(raw, 'byteLength', {
            configurable: true,
            get() { throw new Error('shadowed byteLength getter ran'); },
        });
        strictEqual(fn(raw), expected);
    }

    const detachedBuffer = new ArrayBuffer(4);
    const detachedTyped = new Uint8Array(detachedBuffer);
    const dataBuffer = new ArrayBuffer(4);
    const detachedData = new DataView(dataBuffer);
    structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
    structuredClone(dataBuffer, { transfer: [dataBuffer] });
    const empty = fn(new Uint8Array());
    strictEqual(fn(detachedBuffer), empty);
    strictEqual(fn(detachedTyped), empty);
    strictEqual(fn(detachedData), empty);
});

Deno.test('bun: hash coerces input before ignoring non-numeric seeds', () => {
    for (const name of hashNames.filter((name) => name !== 'adler32' && name !== 'cityHash32')) {
        const events: string[] = [];
        const data = {
            [Symbol.toPrimitive](hint: string) {
                events.push(`data:${hint}`);
                return 'abc';
            },
        };
        const seed = {
            get [Symbol.toPrimitive]() {
                events.push('seed:get');
                throw new Error('seed coercion ran');
            },
            valueOf() {
                events.push('seed:valueOf');
                throw new Error('seed coercion ran');
            },
        };
        const fn = hashFunction(name);
        strictEqual(fn(data, seed), fn('abc'), name);
        deepStrictEqual(events, ['data:string'], name);
    }
});

Deno.test('bun: hash functions expose Bun metadata and are not constructors', () => {
    for (const name of hashNames) {
        const fn = hashFunction(name);
        strictEqual(fn.name, name);
        strictEqual(fn.length, 1);
        strictEqual(Object.hasOwn(fn, 'prototype'), false, `${name}.prototype`);
        deepStrictEqual(Object.getOwnPropertyDescriptor(fn, 'name'), {
            configurable: true,
            enumerable: false,
            value: name,
            writable: false,
        });
        deepStrictEqual(Object.getOwnPropertyDescriptor(fn, 'length'), {
            configurable: true,
            enumerable: false,
            value: 1,
            writable: false,
        });
        throws(() => Reflect.construct(fn, ['abc']), TypeError, name);
    }

    for (const name of hashNames.slice(1)) {
        const descriptor = Object.getOwnPropertyDescriptor(hash, name)!;
        strictEqual(descriptor.value, hashFunction(name));
        strictEqual(descriptor.configurable, true);
        strictEqual(descriptor.enumerable, true);
        strictEqual(descriptor.writable, true);
    }
});
