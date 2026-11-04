import { strictEqual } from 'node:assert';
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
    if (typeof SharedArrayBuffer !== 'undefined') {
        const shared = new SharedArrayBuffer(bytes.length);
        new Uint8Array(shared).set(bytes);
        strictEqual(indexOfLine(shared), 2);
    }
});
