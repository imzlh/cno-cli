import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { getEventListeners } from 'node:events';
import { deflateSync, gzipSync } from 'node:zlib';

Deno.test('EventTarget: once listeners do not skip adjacent listeners', () => {
    const target = new EventTarget();
    const calls: string[] = [];
    target.addEventListener('ready', () => calls.push('first'), { once: true });
    target.addEventListener('ready', () => calls.push('second'), { once: true });
    target.addEventListener('ready', () => calls.push('normal'));
    target.dispatchEvent(new Event('ready'));
    target.dispatchEvent(new Event('ready'));
    deepStrictEqual(calls, ['first', 'second', 'normal', 'normal']);
});

Deno.test('EventTarget: additions wait and removed entries stay skipped during dispatch', () => {
    const target = new EventTarget();
    const calls: string[] = [];
    const removed = () => calls.push('removed');
    const late = () => calls.push('late');
    target.addEventListener('ready', () => {
        calls.push('first');
        target.removeEventListener('ready', removed);
        target.addEventListener('ready', late);
        target.addEventListener('ready', removed);
    }, { once: true });
    target.addEventListener('ready', removed);
    target.addEventListener('ready', () => calls.push('normal'));
    target.dispatchEvent(new Event('ready'));
    deepStrictEqual(calls, ['first', 'normal']);
    target.dispatchEvent(new Event('ready'));
    deepStrictEqual(calls, ['first', 'normal', 'normal', 'late', 'removed']);
});

Deno.test('EventTarget: once removal precedes reentrant dispatch', () => {
    const target = new EventTarget();
    const calls: string[] = [];
    target.addEventListener('ready', () => {
        calls.push('once');
        target.dispatchEvent(new Event('ready'));
    }, { once: true });
    target.addEventListener('ready', () => calls.push('normal'));
    target.dispatchEvent(new Event('ready'));
    deepStrictEqual(calls, ['once', 'normal', 'normal']);
});

Deno.test('AbortSignal: every once listener receives cancellation', () => {
    const controller = new AbortController();
    const calls: number[] = [];
    controller.signal.addEventListener('abort', () => calls.push(1), { once: true });
    controller.signal.addEventListener('abort', () => calls.push(2), { once: true });
    controller.abort();
    deepStrictEqual(calls, [1, 2]);
});

for (const completion of ['remove', 'once', 'abort'] as const) {
    Deno.test(`EventTarget: getEventListeners tracks ${completion} cleanup`, () => {
        const target = new EventTarget();
        const controller = new AbortController();
        const listener = () => {};
        target.addEventListener('ready', listener, { signal: controller.signal, once: completion === 'once' });
        deepStrictEqual(getEventListeners(target, 'ready'), [listener]);
        if (completion === 'remove') target.removeEventListener('ready', listener);
        else if (completion === 'once') target.dispatchEvent(new Event('ready'));
        else controller.abort();
        deepStrictEqual(getEventListeners(target, 'ready'), []);
        deepStrictEqual(getEventListeners(controller.signal, 'abort'), []);
    });
}

Deno.test('Event: timestamps record creation time and advance', async () => {
    const before = performance.now();
    const first = new Event('first');
    ok(first.timeStamp >= before && first.timeStamp <= performance.now());
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    const second = new Event('second');
    ok(second.timeStamp > first.timeStamp);
    ok(second.timeStamp <= performance.now());
});

async function decompress(format: CompressionFormat, chunks: Uint8Array[]): Promise<string> {
    const stream = new DecompressionStream(format);
    const writer = stream.writable.getWriter();
    const result = new Response(stream.readable).text();
    // Writes and reads both reject on invalid data; observe both paths.
    void result.catch(() => {});
    try {
        for (const chunk of chunks) await writer.write(chunk as Uint8Array<ArrayBuffer>);
        await writer.close();
        return await result;
    } finally {
        writer.releaseLock();
    }
}

for (const format of ['gzip', 'deflate'] as const) {
    Deno.test(`DecompressionStream: ${format} headers survive every initial chunk split`, async () => {
        const text = 'a header may span arbitrary chunks';
        const bytes = format === 'gzip' ? gzipSync(text) : deflateSync(text);
        for (const split of [1, 2, 3]) {
            strictEqual(await decompress(format, [bytes.subarray(0, split), bytes.subarray(split)]), text);
        }
        strictEqual(await decompress(format, [new Uint8Array(), ...Array.from(bytes, byte => Uint8Array.of(byte))]), text);
    });

    Deno.test(`DecompressionStream: ${format} rejects invalid and incomplete headers`, async () => {
        const invalid = format === 'gzip' ? [0x1f, 0x8b, 0] : [0x78, 0];
        await rejects(() => decompress(format, invalid.map(byte => Uint8Array.of(byte))), TypeError);
        await rejects(() => decompress(format, [Uint8Array.of(invalid[0])]), TypeError);
    });
}
