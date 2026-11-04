import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('indexOfLine validates its arguments', () => {
    assert.throws(() => indexOfLine('text'), TypeError);
    assert.equal(indexOfLine(encode('a\nb\n'), -1), 1);
    assert.equal(indexOfLine(encode('a\nb\n'), 1.5), 1);
    assert.equal(indexOfLine(encode('a\nb\n'), Infinity), -1);
    assert.equal(indexOfLine(encode('a\nb\n'), NaN), 1);
});
