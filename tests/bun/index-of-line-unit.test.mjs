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

test('indexOfLine validates its arguments', () => {
    assert.throws(() => indexOfLine('text'), TypeError);
    assert.throws(() => indexOfLine(encode('a\n'), -1), RangeError);
    assert.throws(() => indexOfLine(encode('a\n'), 1.5), RangeError);
});
