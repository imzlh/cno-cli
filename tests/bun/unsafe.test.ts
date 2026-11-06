import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { runInNewContext } from 'node:vm';
import Bun, { unsafe } from 'bun';
import * as bunModule from 'bun';

Deno.test('bun: unsafe.memoryFootprint exposes a best-effort safe byte count', () => {
    strictEqual(Bun.unsafe, unsafe);
    strictEqual(Object.hasOwn(bunModule, 'arrayBufferToString'), false);
    strictEqual(typeof unsafe.memoryFootprint, 'function');
    strictEqual(unsafe.arrayBufferToString(new Uint8Array([65, 66, 67])), 'ABC');
    strictEqual(unsafe.arrayBufferToString(new Uint8Array([65, 255])), 'A\u00ff');
    strictEqual(unsafe.arrayBufferToString(new Uint16Array([0x0041, 0x03a9])), 'A\u03a9');

    const footprint = unsafe.memoryFootprint();
    if (footprint !== undefined) {
        ok(Number.isSafeInteger(footprint));
        ok(footprint >= 0);
    }
});

Deno.test('bun: unsafe.arrayBufferToString exposes Bun coded errors', () => {
    let error: TypeError & { code: string };
    try {
        unsafe.arrayBufferToString(null as never);
        throw new Error('accepted null');
    } catch (caught) {
        error = caught as TypeError & { code: string };
    }

    strictEqual(error instanceof TypeError, true);
    strictEqual(error.name, 'TypeError');
    strictEqual(error.message, 'Expected an ArrayBuffer');
    strictEqual(error.code, 'ERR_INVALID_ARG_TYPE');
    strictEqual(Object.hasOwn(error, 'code'), false);
    strictEqual(String(error), 'TypeError [ERR_INVALID_ARG_TYPE]: Expected an ArrayBuffer');
    const prototype = Object.getPrototypeOf(error);
    strictEqual(Object.getPrototypeOf(prototype), TypeError.prototype);
    deepStrictEqual(Object.getOwnPropertyDescriptor(prototype, 'code'), {
        configurable: true,
        enumerable: true,
        value: 'ERR_INVALID_ARG_TYPE',
        writable: true,
    });
    throws(() => unsafe.arrayBufferToString(new DataView(new ArrayBuffer(1))), {
        name: 'TypeError',
        message: 'Expected an ArrayBuffer',
        code: 'ERR_INVALID_ARG_TYPE',
    });
});

Deno.test('bun: unsafe.arrayBufferToString reads slots across realms and handles detachment', () => {
    const foreign = runInNewContext(`(() => {
        const arrayBuffer = new Uint8Array([65, 66]).buffer;
        const uint8 = new Uint8Array([67, 68]);
        const uint16 = new Uint16Array([0x0041, 0x03a9]);
        for (const value of [arrayBuffer, uint8, uint16]) {
            for (const key of ['buffer', 'byteOffset', 'byteLength', Symbol.toStringTag]) {
                Object.defineProperty(value, key, {
                    configurable: true,
                    get() { throw new Error('shadowed ' + String(key)); },
                });
            }
        }
        return { arrayBuffer, uint8, uint16 };
    })()`);
    strictEqual(unsafe.arrayBufferToString(foreign.arrayBuffer), 'AB');
    strictEqual(unsafe.arrayBufferToString(foreign.uint8), 'CD');
    strictEqual(unsafe.arrayBufferToString(foreign.uint16), 'A\u03a9');

    for (const make of [
        (buffer: ArrayBuffer): ArrayBuffer | ArrayBufferView => buffer,
        (buffer: ArrayBuffer): ArrayBufferView => new Uint8Array(buffer),
        (buffer: ArrayBuffer): ArrayBufferView => new Uint16Array(buffer),
        (buffer: ArrayBuffer): ArrayBufferView => new Int16Array(buffer),
    ]) {
        const buffer = new ArrayBuffer(4);
        const value = make(buffer);
        structuredClone(buffer, { transfer: [buffer] });
        strictEqual(unsafe.arrayBufferToString(value), '');
    }
});
