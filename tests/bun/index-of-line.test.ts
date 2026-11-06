import { strictEqual, throws } from 'node:assert';
import { runInNewContext } from 'node:vm';
import { indexOfLine } from 'bun';

Deno.test('bun: indexOfLine supports bigint offsets', () => {
    const bytes = new TextEncoder().encode('ab\ncd\n');
    strictEqual(indexOfLine(bytes, 3n), 5);
    strictEqual(indexOfLine(bytes, -1n), 2);
    strictEqual(indexOfLine(bytes, 2n ** 100n), -1);
    strictEqual(indexOfLine(bytes.subarray(3), 1n), 2);
    strictEqual(indexOfLine(bytes, -1), 2);
    strictEqual(indexOfLine(bytes, 3.9), 5);
    strictEqual(indexOfLine(bytes, Infinity), -1);
    strictEqual(indexOfLine(bytes, NaN), 2);
    strictEqual(indexOfLine(bytes, '3' as unknown as number), 5);
    strictEqual(indexOfLine(bytes, true as unknown as number), 2);
    strictEqual(indexOfLine(bytes, { valueOf: () => 3 } as unknown as number), 5);
    throws(() => indexOfLine(bytes, Symbol('offset') as unknown as number), {
        name: 'TypeError',
        message: 'Cannot convert a symbol to a number',
    });
    throws(() => indexOfLine(undefined as never), {
        name: 'TypeError',
        message: 'buffer must be an ArrayBuffer or ArrayBufferView',
        code: 'ERR_INVALID_ARG_TYPE',
    });
    if (typeof SharedArrayBuffer !== 'undefined') {
        const shared = new SharedArrayBuffer(bytes.length);
        new Uint8Array(shared).set(bytes);
        strictEqual(indexOfLine(shared), 2);
    }
});

Deno.test('bun: indexOfLine uses binary brands and intrinsic view metadata', () => {
    const foreign = runInNewContext(`(() => {
        const buffer = new ArrayBuffer(8);
        new Uint8Array(buffer).set([120, 120, 10, 97, 98, 10, 121, 121]);
        return {
            buffer,
            typed: new Uint16Array(buffer, 2, 2),
            data: new DataView(buffer, 3, 3),
        };
    })()`);
    strictEqual(indexOfLine(foreign.buffer), 2);
    strictEqual(indexOfLine(foreign.typed), 0);
    strictEqual(indexOfLine(foreign.data), 2);

    const view = new Uint8Array([97, 98, 10, 99]);
    for (const key of ['buffer', 'byteOffset', 'byteLength']) {
        Object.defineProperty(view, key, {
            configurable: true,
            get() { throw new Error(`shadowed ${key} getter ran`); },
        });
    }
    strictEqual(indexOfLine(view), 2);

    if (typeof SharedArrayBuffer === 'function') {
        const shared = runInNewContext(`(() => {
            const buffer = new SharedArrayBuffer(4);
            new Uint8Array(buffer).set([97, 10, 98, 10]);
            return { buffer, view: new Uint8Array(buffer, 1, 2) };
        })()`);
        strictEqual(indexOfLine(shared.buffer), 1);
        strictEqual(indexOfLine(shared.view), 0);
    }
});

Deno.test('bun: indexOfLine matches detached, coercion, and function metadata', () => {
    const raw = new ArrayBuffer(4);
    const typed = new Uint8Array(raw);
    const dataBuffer = new ArrayBuffer(4);
    const data = new DataView(dataBuffer);
    structuredClone(raw, { transfer: [raw] });
    structuredClone(dataBuffer, { transfer: [dataBuffer] });

    let coercions = 0;
    const offset = { [Symbol.toPrimitive](hint: string) { coercions++; strictEqual(hint, 'number'); return 0; } };
    strictEqual(indexOfLine(raw, offset as unknown as number), -1);
    strictEqual(indexOfLine(typed, offset as unknown as number), -1);
    strictEqual(indexOfLine(data, offset as unknown as number), -1);
    strictEqual(coercions, 3);

    throws(() => indexOfLine(new Uint8Array([10]), Object(Symbol('offset')) as unknown as number), {
        name: 'TypeError',
        message: 'Cannot convert a symbol to a number',
    });
    let invalidOffsetCoerced = false;
    throws(() => indexOfLine({} as never, {
        valueOf() { invalidOffsetCoerced = true; return 0; },
    } as unknown as number), { code: 'ERR_INVALID_ARG_TYPE' });
    strictEqual(invalidOffsetCoerced, false);

    strictEqual(indexOfLine.name, 'indexOfLine');
    strictEqual(indexOfLine.length, 1);
    throws(() => Reflect.construct(indexOfLine, [new Uint8Array([10])]), TypeError);
});
