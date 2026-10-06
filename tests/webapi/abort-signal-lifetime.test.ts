import { strictEqual } from 'node:assert';
import { getEventListeners } from 'node:events';

const engine = import.meta.use('engine');
const timers = import.meta.use('timers');
const tick = () => new Promise<void>(resolve => timers.setTimeout(resolve, 5));

async function collect(): Promise<void> {
    for (let i = 0; i < 3; i++) {
        await tick();
        engine.gc.run();
    }
    await tick();
}

for (const mode of ['any', 'request', 'clone'] as const) {
    Deno.test(`AbortSignal lifetime: a shared source releases discarded ${mode} signals`, async () => {
        const parent = new AbortController();
        const refs: WeakRef<AbortSignal>[] = [];
        function discard(): void {
            const signal = mode === 'any'
                ? AbortSignal.any([parent.signal])
                : mode === 'request'
                    ? new Request('http://localhost/', { signal: parent.signal }).signal
                    : new Request('http://localhost/', { signal: parent.signal }).clone().signal;
            Object.assign(signal, { payload: new Uint8Array(64 * 1024) });
            refs.push(new WeakRef(signal));
        }
        for (let i = 0; i < 64; i++) discard();
        await collect();
        strictEqual(refs.filter(ref => ref.deref() !== undefined).length, 0);
        strictEqual(getEventListeners(parent.signal, 'abort').length, 0);
    });
}

Deno.test('AbortSignal lifetime: duplicate sources detach every subscription after abort', () => {
    const first = new AbortController();
    const second = new AbortController();
    const derived = AbortSignal.any([first.signal, second.signal, first.signal]);
    second.abort('done');
    strictEqual(derived.reason, 'done');
    strictEqual(getEventListeners(first.signal, 'abort').length, 0);
    strictEqual(getEventListeners(second.signal, 'abort').length, 0);
});

Deno.test('AbortSignal lifetime: live Request clones keep following their source after GC', async () => {
    const parent = new AbortController();
    const request = new Request('http://localhost/', { signal: parent.signal });
    const clone = request.clone();
    await collect();
    strictEqual(request.signal.aborted, false);
    strictEqual(clone.signal.aborted, false);
    const reason = new Error('canceled');
    parent.abort(reason);
    strictEqual(request.signal.reason, reason);
    strictEqual(clone.signal.reason, reason);
    strictEqual(getEventListeners(parent.signal, 'abort').length, 0);
});

Deno.test('AbortSignal lifetime: a live dependent keeps its timeout source functional', async () => {
    const derived = AbortSignal.any([AbortSignal.timeout(100)]);
    await collect();
    if (!derived.aborted) await new Promise(resolve => derived.addEventListener('abort', resolve, { once: true }));
    strictEqual(derived.reason.name, 'TimeoutError');
});

for (const mode of ['any', 'request', 'clone'] as const) {
    Deno.test(`AbortSignal lifetime: a shared source preserves an observed ${mode} signal`, async () => {
        const parent = new AbortController();
        const reason = new Error('observed abort');
        let calls = 0;
        function subscribe(): WeakRef<AbortSignal> {
            const signal = mode === 'any'
                ? AbortSignal.any([parent.signal])
                : mode === 'request'
                    ? new Request('http://localhost/', { signal: parent.signal }).signal
                    : new Request('http://localhost/', { signal: parent.signal }).clone().signal;
            signal.addEventListener('abort', event => {
                strictEqual((event.target as AbortSignal).reason, reason);
                calls++;
            });
            return new WeakRef(signal);
        }
        const ref = subscribe();
        await collect();
        strictEqual(ref.deref() !== undefined, true, 'an observed dependent must remain alive');
        parent.abort(reason);
        strictEqual(calls, 1);
        strictEqual(getEventListeners(parent.signal, 'abort').length, 0);
        await collect();
        strictEqual(ref.deref() === undefined, true, 'abort must release the observed dependent');
    });
}

for (const completion of ['remove', 'once', 'signal', 'onabort'] as const) {
    Deno.test(`AbortSignal lifetime: ${completion} releases the last observer's dependent`, async () => {
        const parent = new AbortController();
        const lifetime = new AbortController();
        let calls = 0;
        const listener = () => { calls++; };
        function subscribe(): WeakRef<AbortSignal> {
            const signal = AbortSignal.any([parent.signal]);
            if (completion === 'onabort') signal.onabort = listener;
            else signal.addEventListener('abort', listener, {
                capture: true,
                once: completion === 'once',
                signal: completion === 'signal' ? lifetime.signal : undefined,
            });
            return new WeakRef(signal);
        }
        const ref = subscribe();
        await collect();
        strictEqual(ref.deref() !== undefined, true);
        function detach(): void {
            const signal = ref.deref()!;
            if (completion === 'remove') signal.removeEventListener('abort', listener, true);
            else if (completion === 'once') signal.dispatchEvent(new Event('abort'));
            else if (completion === 'signal') lifetime.abort();
            else signal.onabort = null;
        }
        detach();
        await collect();
        strictEqual(ref.deref() === undefined, true);
        strictEqual(getEventListeners(parent.signal, 'abort').length, 0);
        parent.abort();
        strictEqual(calls, completion === 'once' ? 1 : 0);
    });
}

Deno.test('AbortSignal lifetime: removing one observer preserves the remaining observer', async () => {
    const parent = new AbortController();
    let calls = 0;
    const first = () => {};
    const second = () => { calls++; };
    function subscribe(): WeakRef<AbortSignal> {
        const signal = AbortSignal.any([parent.signal]);
        signal.addEventListener('abort', first);
        signal.addEventListener('abort', second);
        signal.removeEventListener('abort', first);
        return new WeakRef(signal);
    }
    const ref = subscribe();
    await collect();
    strictEqual(ref.deref() !== undefined, true);
    parent.abort();
    strictEqual(calls, 1);
});

Deno.test('AbortSignal lifetime: an unreachable observed source/dependent cycle is collectible', async () => {
    function subscribe(): WeakRef<AbortSignal>[] {
        const parent = new AbortController();
        const signal = AbortSignal.any([parent.signal]);
        signal.addEventListener('abort', () => {});
        return [new WeakRef(parent.signal), new WeakRef(signal)];
    }
    const refs = subscribe();
    await collect();
    strictEqual(refs.filter(ref => ref.deref() !== undefined).length, 0);
});

for (const nested of [false, true]) {
    Deno.test(`AbortSignal lifetime: an observed ${nested ? 'nested ' : ''}empty any is collectible`, async () => {
        function subscribe(): WeakRef<AbortSignal> {
            const empty = AbortSignal.any([]);
            const signal = nested ? AbortSignal.any([empty]) : empty;
            signal.addEventListener('abort', () => {});
            return new WeakRef(signal);
        }
        const ref = subscribe();
        await collect();
        strictEqual(ref.deref() === undefined, true);
    });
}

for (const observed of [false, true]) {
    Deno.test(`AbortSignal lifetime: flattened clone chains release unused intermediate signals (${observed})`, async () => {
        const parent = new AbortController();
        let calls = 0;
        function cloneChain(): WeakRef<AbortSignal>[] {
            let request = new Request('http://localhost/', { signal: parent.signal });
            const refs = [new WeakRef(request.signal)];
            for (let i = 0; i < 24; i++) {
                request = request.clone();
                refs.push(new WeakRef(request.signal));
            }
            if (observed) request.signal.addEventListener('abort', () => { calls++; });
            return refs;
        }
        const refs = cloneChain();
        await collect();
        strictEqual(refs.slice(0, -1).filter(ref => ref.deref() !== undefined).length, 0);
        strictEqual(refs.at(-1)!.deref() !== undefined, observed);
        strictEqual(getEventListeners(parent.signal, 'abort').length, observed ? 1 : 0);
        parent.abort();
        strictEqual(calls, observed ? 1 : 0);
    });
}
