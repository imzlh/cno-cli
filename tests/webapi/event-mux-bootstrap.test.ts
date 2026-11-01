import { deepStrictEqual, strictEqual } from 'node:assert';
import {
    claimUnloadEvent,
    dispatchLoadEvent,
    dispatchUnloadEvent,
    installLifecycleEventObserver,
    installWebApiEventReceiver,
    PRIORITY_WEBAPI,
    type RuntimeEventBus,
    type RuntimeEventFrame,
} from '../../cno/src/webapi/event-mux-bootstrap.ts';

const lifecycleSlot = Symbol.for('cno.runtime.lifecycle.v1');

function withLifecycleState(
    state: { loadFired: boolean; unloadFired: boolean },
    fn: () => void,
): void {
    const target = globalThis as unknown as Record<symbol, unknown>;
    const previous = target[lifecycleSlot];
    try {
        target[lifecycleSlot] = state;
        fn();
    } finally {
        target[lifecycleSlot] = previous;
    }
}

function fakeBus() {
    const calls: Array<{
        namespace: string;
        event: string;
        listener: (frame: RuntimeEventFrame) => boolean | undefined;
        priority?: number;
    }> = [];
    let unsubscribeCalls = 0;
    const unsubscribe = () => { unsubscribeCalls++; };
    const bus: RuntimeEventBus = {
        RUNTIME_NAMESPACE: 'test.runtime',
        RUNTIME_EVENT: 'event',
        on(namespace, event, listener, priority) {
            calls.push({ namespace, event, listener, priority });
            return unsubscribe;
        },
    };
    return { bus, calls, unsubscribe, unsubscribeCalls: () => unsubscribeCalls };
}

Deno.test('webapi runtime events: subscribes directly at priority 100', () => {
    const fixture = fakeBus();
    const off = installWebApiEventReceiver(() => undefined, fixture.bus);

    strictEqual(fixture.calls.length, 1);
    strictEqual(fixture.calls[0]?.namespace, fixture.bus.RUNTIME_NAMESPACE);
    strictEqual(fixture.calls[0]?.event, fixture.bus.RUNTIME_EVENT);
    strictEqual(fixture.calls[0]?.priority, PRIORITY_WEBAPI);
    strictEqual(off, fixture.unsubscribe);
});

Deno.test('webapi runtime events: forwards the native frame and shared context', () => {
    const fixture = fakeBus();
    const context = { handled: false, dispatched: false, rejectionEmitted: false };
    const seen: unknown[] = [];
    installWebApiEventReceiver((name, data, ctx) => {
        seen.push(name, data, ctx);
        ctx.handled = true;
        return false;
    }, fixture.bus);

    const result = fixture.calls[0]?.listener({ name: 7, data: 'payload', context });
    strictEqual(result, false);
    deepStrictEqual(seen, [7, 'payload', context]);
    strictEqual(context.handled, true);
});

Deno.test('webapi runtime events: returned unsubscribe remains detachable', () => {
    const fixture = fakeBus();
    const off = installWebApiEventReceiver(() => undefined, fixture.bus);
    off();
    strictEqual(fixture.unsubscribeCalls(), 1);
});

Deno.test('webapi lifecycle: shared realm state suppresses duplicate load', () => {
    withLifecycleState({ loadFired: false, unloadFired: false }, () => {
        const listeners = new Map<string, () => void>();
        installLifecycleEventObserver((type, listener) => listeners.set(type, listener));
        listeners.get('load')?.();
        let loads = 0;
        const onLoad = () => { loads++; };
        globalThis.addEventListener('load', onLoad);
        try {
            strictEqual(dispatchLoadEvent(), false);
        } finally {
            globalThis.removeEventListener('load', onLoad);
        }
        strictEqual(loads, 0);
    });
});

Deno.test('webapi lifecycle: explicit and native unload share one claim', () => {
    withLifecycleState({ loadFired: false, unloadFired: false }, () => {
        let unloads = 0;
        const onUnload = () => { unloads++; };
        globalThis.addEventListener('unload', onUnload);
        try {
            strictEqual(dispatchUnloadEvent(), true);
            strictEqual(claimUnloadEvent(), false);
        } finally {
            globalThis.removeEventListener('unload', onUnload);
        }
        strictEqual(unloads, 1);
    });
});
