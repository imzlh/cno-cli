import { deepStrictEqual, strictEqual } from 'node:assert';
import { addPromiseHook, PromiseState } from '../../cno/src/node/_internal/promise-hook.ts';

const engine = import.meta.use('engine');

Deno.test('promise dispatcher: registrations sharing a callback stop independently', () => {
    let calls = 0;
    const callback = (state: PromiseState) => { if (state === PromiseState.CONSTRUCT) calls++; };
    const stopFirst = addPromiseHook(callback);
    const stopSecond = addPromiseHook(callback);
    try {
        Promise.resolve();
        strictEqual(calls, 2);
        stopFirst();
        stopFirst();
        Promise.resolve();
        strictEqual(calls, 3);
        stopSecond();
        Promise.resolve();
        strictEqual(calls, 3);
    } finally {
        stopFirst();
        stopSecond();
    }
});

Deno.test('promise dispatcher: registration changes apply after the current event', () => {
    const calls: string[] = [];
    let stopLater = () => {};
    let stopSecond = () => {};
    const stopFirst = addPromiseHook(state => {
        if (state !== PromiseState.CONSTRUCT) return;
        calls.push('first');
        stopSecond();
        stopLater();
        stopLater = addPromiseHook(next => { if (next === PromiseState.CONSTRUCT) calls.push('later'); });
    });
    stopSecond = addPromiseHook(state => { if (state === PromiseState.CONSTRUCT) calls.push('second'); });
    try {
        Promise.resolve();
        deepStrictEqual(calls, ['first', 'second']);
        calls.length = 0;
        Promise.resolve();
        deepStrictEqual(calls, ['first', 'later']);
    } finally {
        stopFirst();
        stopSecond();
        stopLater();
    }
});

Deno.test('promise dispatcher: one throwing consumer does not suppress another', () => {
    let calls = 0;
    const stopThrowing = addPromiseHook(() => { throw new Error('observer failed'); });
    const stopOther = addPromiseHook(state => { if (state === PromiseState.CONSTRUCT) calls++; });
    try {
        Promise.resolve();
        strictEqual(calls, 1);
    } finally {
        stopThrowing();
        stopOther();
    }
});

Deno.test('promise dispatcher: final removal restores an empty native hook slot', () => {
    const previous = engine.promiseHook();
    try {
        engine.promiseHook(undefined);
        const stop = addPromiseHook(() => {});
        strictEqual(typeof engine.promiseHook(), 'function');
        stop();
        strictEqual(engine.promiseHook(), undefined);
    } finally {
        engine.promiseHook(previous);
    }
});

Deno.test('promise dispatcher: final removal preserves a newer native hook owner', () => {
    const previous = engine.promiseHook();
    const stop = addPromiseHook(() => {});
    const replacement = () => {};
    try {
        engine.promiseHook(replacement);
        stop();
        strictEqual(engine.promiseHook(), replacement);
    } finally {
        stop();
        engine.promiseHook(previous);
    }
});

Deno.test('promise dispatcher: retained hooks preserve foreign chains without observing later registrations', () => {
    const previous = engine.promiseHook();
    const promise = Promise.resolve();
    const parent = Promise.resolve();
    const calls: string[] = [];
    let forwarded: unknown[] = [];
    let stopFirst = () => {};
    let stopCurrent = () => {};
    try {
        engine.promiseHook((state: number, current: Promise<unknown>, ancestor?: Promise<unknown>) => {
            if (state !== PromiseState.CONSTRUCT) return;
            calls.push('foreign');
            forwarded = [state, current, ancestor];
        });
        stopFirst = addPromiseHook(state => {
            if (state === PromiseState.CONSTRUCT) calls.push('first');
        });
        const retained = engine.promiseHook()!;
        const wrapper = (state: number, current: Promise<unknown>, ancestor?: Promise<unknown>) => {
            if (state === PromiseState.CONSTRUCT) calls.push('wrapper');
            retained(state, current, ancestor);
        };
        engine.promiseHook(wrapper);

        Promise.resolve();
        deepStrictEqual(calls, ['wrapper', 'foreign', 'first']);
        stopFirst();
        strictEqual(engine.promiseHook(), wrapper);

        for (let i = 0; i < 2; i++) {
            stopCurrent = addPromiseHook(state => {
                if (state === PromiseState.CONSTRUCT) calls.push('current');
            });
            calls.length = 0;
            Promise.resolve();
            deepStrictEqual(calls, ['wrapper', 'foreign', 'current']);

            calls.length = 0;
            retained(0, promise, parent);
            deepStrictEqual(calls, ['foreign']);
            deepStrictEqual(forwarded, [PromiseState.CONSTRUCT, promise, parent]);

            stopCurrent();
            stopFirst();
            strictEqual(engine.promiseHook(), wrapper);
        }

        calls.length = 0;
        Promise.resolve();
        deepStrictEqual(calls, ['wrapper', 'foreign']);
    } finally {
        stopCurrent();
        stopFirst();
        engine.promiseHook(previous);
    }
});
