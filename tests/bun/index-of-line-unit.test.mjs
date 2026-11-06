import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { indexOfLine } from '../../cno/src/bun/utils/index-of-line.ts';

const encode = (text) => new TextEncoder().encode(text);

test('indexOfLine finds the first LF byte in an ArrayBuffer', () => {
    const buffer = encode('ab\ncd\n').buffer;
    assert.equal(indexOfLine(buffer), 2);
});

test('indexOfLine honors the start offset', () => {
    const bytes = encode('ab\ncd\n');
    assert.equal(indexOfLine(bytes, 3), 5);
    assert.equal(indexOfLine(bytes, 2), 2);
});

test('indexOfLine accepts bigint offsets, including out-of-range values', () => {
    const bytes = encode('ab\ncd\n');
    assert.equal(indexOfLine(bytes, 0n), 2);
    assert.equal(indexOfLine(bytes, 3n), 5);
    assert.equal(indexOfLine(bytes, -1n), 2);
    assert.equal(indexOfLine(bytes, 6n), -1);
    assert.equal(indexOfLine(bytes, 2n ** 100n), -1);
    assert.equal(indexOfLine(bytes.subarray(3), 1n), 2);
});

test('indexOfLine returns -1 when no LF exists after offset', () => {
    assert.equal(indexOfLine(encode('no newline')), -1);
    assert.equal(indexOfLine(encode('a\nb'), 2), -1);
    assert.equal(indexOfLine(new ArrayBuffer(0)), -1);
});

test('indexOfLine ignores CR and only matches LF', () => {
    assert.equal(indexOfLine(encode('a\rb\r\nc')), 4);
});

test('indexOfLine respects the view window of typed arrays', () => {
    const backing = encode('xx\nyy\nzz');
    const view = backing.subarray(3, 6);
    assert.equal(indexOfLine(view), 2);
    assert.equal(indexOfLine(new DataView(backing.buffer, 0, 2)), -1);
});

test('indexOfLine accepts shared buffers', () => {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const buffer = new SharedArrayBuffer(4);
    new Uint8Array(buffer).set([97, 10, 98, 10]);
    assert.equal(indexOfLine(buffer), 1);
});

test('indexOfLine accepts cross-realm buffers and preserves view windows', () => {
    const foreign = runInNewContext(`(() => {
        const buffer = new ArrayBuffer(8);
        new Uint8Array(buffer).set([120, 120, 10, 97, 98, 10, 121, 121]);
        return {
            buffer,
            typed: new Uint16Array(buffer, 2, 2),
            data: new DataView(buffer, 3, 3),
        };
    })()`);
    assert.equal(foreign.buffer instanceof ArrayBuffer, false);
    assert.equal(indexOfLine(foreign.buffer), 2);
    assert.equal(indexOfLine(foreign.typed), 0);
    assert.equal(indexOfLine(foreign.data), 2);

    if (typeof SharedArrayBuffer === 'function') {
        const shared = runInNewContext(`(() => {
            const buffer = new SharedArrayBuffer(4);
            new Uint8Array(buffer).set([97, 10, 98, 10]);
            return { buffer, view: new Uint8Array(buffer, 1, 2) };
        })()`);
        assert.equal(shared.buffer instanceof SharedArrayBuffer, false);
        assert.equal(indexOfLine(shared.buffer), 1);
        assert.equal(indexOfLine(shared.view), 0);
    }
});

test('indexOfLine ignores shadowed ArrayBufferView metadata', () => {
    const view = new Uint8Array([97, 98, 10, 99]);
    for (const key of ['buffer', 'byteOffset', 'byteLength']) {
        Object.defineProperty(view, key, {
            configurable: true,
            get() { throw new Error(`shadowed ${key} getter ran`); },
        });
    }
    assert.equal(indexOfLine(view), 2);
});

test('indexOfLine treats detached buffers and views as empty', () => {
    const raw = new ArrayBuffer(4);
    const typed = new Uint8Array(raw);
    const dataBuffer = new ArrayBuffer(4);
    const data = new DataView(dataBuffer);
    structuredClone(raw, { transfer: [raw] });
    structuredClone(dataBuffer, { transfer: [dataBuffer] });

    let coercions = 0;
    const offset = { [Symbol.toPrimitive](hint) { coercions++; assert.equal(hint, 'number'); return 0; } };
    assert.equal(indexOfLine(raw, offset), -1);
    assert.equal(indexOfLine(typed, offset), -1);
    assert.equal(indexOfLine(data, offset), -1);
    assert.equal(coercions, 3);
});

test('indexOfLine validates its arguments', () => {
    assert.throws(() => indexOfLine('text'), {
        name: 'TypeError',
        message: 'buffer must be an ArrayBuffer or ArrayBufferView',
        code: 'ERR_INVALID_ARG_TYPE',
    });
    assert.equal(indexOfLine(encode('a\nb\n'), -1), 1);
    assert.equal(indexOfLine(encode('a\nb\n'), 1.5), 1);
    assert.equal(indexOfLine(encode('a\nb\n'), Infinity), -1);
    assert.equal(indexOfLine(encode('a\nb\n'), NaN), 1);
    assert.throws(() => indexOfLine(encode('a\nb\n'), Object(Symbol('offset'))), {
        name: 'TypeError',
        message: 'Cannot convert a symbol to a number',
    });

    let coerced = false;
    assert.throws(() => indexOfLine({}, { valueOf() { coerced = true; return 0; } }), {
        code: 'ERR_INVALID_ARG_TYPE',
    });
    assert.equal(coerced, false);
});

test('indexOfLine exposes Bun function metadata', () => {
    assert.equal(indexOfLine.name, 'indexOfLine');
    assert.equal(indexOfLine.length, 1);
    assert.equal(Object.hasOwn(indexOfLine, 'prototype'), false);
    assert.throws(() => Reflect.construct(indexOfLine, [encode('\n')]), TypeError);
});
