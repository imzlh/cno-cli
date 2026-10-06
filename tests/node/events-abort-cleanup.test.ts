import { strictEqual } from 'node:assert';
import { getEventListeners } from 'node:events';

for (const completion of ['remove', 'once', 'abort'] as const) {
    Deno.test(`events: ${completion} releases signal-controlled listener tracking`, () => {
        const controller = new AbortController();
        const target = new EventTarget();
        let calls = 0;
        const listener = () => { calls++; };
        target.addEventListener('ready', listener, {
            signal: controller.signal,
            once: completion === 'once',
        });
        strictEqual(getEventListeners(target, 'ready').length, 1);
        if (completion === 'remove') target.removeEventListener('ready', listener);
        else if (completion === 'once') target.dispatchEvent(new Event('ready'));
        else controller.abort();
        strictEqual(getEventListeners(target, 'ready').length, 0);
        strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
        target.dispatchEvent(new Event('ready'));
        strictEqual(calls, completion === 'once' ? 1 : 0);
    });
}

Deno.test('events: already aborted signals never retain listeners', () => {
    const controller = new AbortController();
    controller.abort();
    const target = new EventTarget();
    target.addEventListener('ready', () => {}, { signal: controller.signal });
    strictEqual(getEventListeners(target, 'ready').length, 0);
    strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
});

Deno.test('events: tracking survives loading another module copy', async () => {
    const controller = new AbortController();
    const target = new EventTarget();
    const removed = () => {};
    const once = () => {};
    target.addEventListener('removed', removed, { signal: controller.signal });
    target.addEventListener('once', once, { signal: controller.signal, once: true });
    const other = await import('../../cno/src/node/events/mod.ts');
    strictEqual(other.getEventListeners(target, 'once').length, 1);
    target.removeEventListener('removed', removed);
    target.dispatchEvent(new Event('once'));
    strictEqual(getEventListeners(target, 'removed').length, 0);
    strictEqual(getEventListeners(target, 'once').length, 0);
    strictEqual(other.getEventListeners(controller.signal, 'abort').length, 0);
});

Deno.test('events: removed signal-controlled targets and captures are collectible', async () => {
    const controller = new AbortController();
    const refs: WeakRef<object>[] = [];
    function registerAndRemove(): void {
        const target = new EventTarget();
        const payload = new Uint8Array(64 * 1024);
        const listener = () => payload.byteLength;
        refs.push(new WeakRef(target), new WeakRef(payload));
        target.addEventListener('ready', listener, { signal: controller.signal, capture: true });
        target.addEventListener('ready', listener, { signal: controller.signal, capture: false });
        target.removeEventListener('ready', listener, true);
        strictEqual(getEventListeners(target, 'ready').length, 1);
        target.removeEventListener('ready', listener, false);
    }
    for (let i = 0; i < 32; i++) registerAndRemove();
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    import.meta.use('engine').gc.run();
    strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
    strictEqual(refs.filter(ref => ref.deref() !== undefined).length, 0);
});
