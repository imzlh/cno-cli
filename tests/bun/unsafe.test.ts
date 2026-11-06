import { ok, strictEqual } from 'node:assert';
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
