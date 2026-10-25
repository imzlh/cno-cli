import { deepStrictEqual, strictEqual } from 'node:assert';
import { structuredCloneWithTransfer } from '../../cno/src/node/_internal/structured-clone.ts';

for (const [name, clone] of [
    ['source', structuredCloneWithTransfer],
    ['global', structuredClone],
] as const) {
    Deno.test(`structuredClone ${name}: typed-array subclasses retain their element type`, () => {
        let tagReads = 0;
        class Pixels extends Uint16Array {
            get [Symbol.toStringTag](): string {
                tagReads++;
                return 'Pixels';
            }
        }
        const pixels = new Pixels([258, 772]);
        const result = clone(pixels);
        strictEqual(result.constructor, Uint16Array);
        deepStrictEqual(Array.from(result), [258, 772]);
        strictEqual(result.byteLength, pixels.byteLength);
        strictEqual(tagReads, 0);
    });
}
