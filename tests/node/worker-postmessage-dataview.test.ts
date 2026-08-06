/*
 * postMessage(DataView) used to wedge the event loop.
 *
 * A DataView IS an ArrayBufferView, so encodeForPipe's generic
 * `if (isArrayBufferView(value)) return value;` passthrough handed it straight to
 * the native pipe serializer, which rejects it with "unsupported object class".
 * Typed arrays survive that encoder; DataView does not.
 *
 * The failure mode was worse than a throw. When the receiving worker is not ready
 * yet the payload is queued, so the rejection surfaced later out of
 * `_flushOutgoingQueue` — unreachable by any try/catch around postMessage — and the
 * loop never drained. Measured before the fix: cno rc=124 (killed on timeout)
 * against node rc=0.
 *
 * Every case asserts a CONCRETE DELIVERED VALUE rather than merely "did not
 * throw": the pre-fix symptom is a hang, so an absence-of-exception assertion
 * could pass by timing out into the reject guard and be read as a failure for the
 * wrong reason.
 */
import { Worker } from 'node:worker_threads';
import { strictEqual, deepStrictEqual } from 'node:assert';

const WORKER_SRC = `
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
    parentPort.postMessage(JSON.stringify({
        aOffset: m.a.byteOffset, aLen: m.a.byteLength,
        bOffset: m.b.byteOffset, bLen: m.b.byteLength,
        sameBuffer: m.a.buffer === m.b.buffer,
        aBytes: [m.a.getUint8(0), m.a.getUint8(1), m.a.getUint8(2)],
        isDataView: m.a instanceof DataView,
    }));
});
`;

/** Round-trip one payload through a worker; rejects rather than hanging. */
function roundTrip(payload: unknown, ms = 20000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const w = new Worker(WORKER_SRC, { eval: true });
        const timer = setTimeout(() => {
            w.terminate();
            reject(new Error('worker never replied — the queue likely wedged'));
        }, ms);
        w.on('message', (m: string) => {
            clearTimeout(timer);
            w.terminate();
            resolve(m);
        });
        w.on('error', (e: Error) => {
            clearTimeout(timer);
            w.terminate();
            reject(e);
        });
        w.postMessage(payload);
    });
}

Deno.test({
    name: 'worker postMessage: DataView survives the pipe with offset and length',
    timeout: 30000,
}, async () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const got = JSON.parse(await roundTrip({
        a: new DataView(buf, 1, 3),
        b: new DataView(buf, 0, 2),
    }));

    strictEqual(got.isDataView, true, 'must arrive as a real DataView');
    strictEqual(got.aOffset, 1, 'byteOffset must survive');
    strictEqual(got.aLen, 3, 'byteLength must survive');
    strictEqual(got.bOffset, 0);
    strictEqual(got.bLen, 2);
    // The window must point at the right bytes, not merely have the right size.
    deepStrictEqual(got.aBytes, [2, 3, 4], 'the view must address the right bytes');
    // Two views over one buffer must decode to two views over ONE buffer:
    // decodeFromPipe returns ArrayBuffer identity, which preserves the sharing.
    strictEqual(got.sameBuffer, true, 'both views must still share one buffer');
});

Deno.test({
    name: 'worker postMessage: whole-buffer DataView round-trips',
    timeout: 30000,
}, async () => {
    const buf = new Uint8Array([9, 8, 7]).buffer;
    const got = JSON.parse(await roundTrip({
        a: new DataView(buf),
        b: new DataView(buf, 0, 2),
    }));
    strictEqual(got.isDataView, true);
    strictEqual(got.aOffset, 0);
    strictEqual(got.aLen, 3);
    deepStrictEqual(got.aBytes, [9, 8, 7]);
    strictEqual(got.sameBuffer, true);
});
