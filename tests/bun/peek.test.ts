import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { peek } from '../../cno/src/bun/utils/peek.ts';

Deno.test('bun: peek returns non-promise values unchanged', () => {
    const object = { a: 1 };
    strictEqual(peek(5), 5);
    strictEqual(peek(object), object);
    strictEqual(peek(null), null);
    strictEqual(peek(undefined), undefined);
    strictEqual(peek.status(object), 'fulfilled');
    strictEqual(peek.status(null), 'fulfilled');
});

Deno.test('bun: peek returns the value of a fulfilled promise', () => {
    strictEqual(peek(Promise.resolve(42)), 42);
    strictEqual(peek.status(Promise.resolve(42)), 'fulfilled');
});

Deno.test('bun: peek returns null for a promise fulfilled with null', () => {
    const promise = Promise.resolve(null);
    strictEqual(peek(promise), null);
    strictEqual(peek.status(promise), 'fulfilled');
});

Deno.test('bun: peek treats a fulfilled string that looks like pending as fulfilled', () => {
    const promise = Promise.resolve('<pending>');
    strictEqual(peek(promise), '<pending>');
    strictEqual(peek.status(promise), 'fulfilled');
});

Deno.test('bun: peek returns the rejection reason without throwing', () => {
    const reasons = [new Error('boom'), undefined, null, -0, NaN, Symbol('reason')];
    for (const reason of reasons) {
        const promise = Promise.reject(reason);
        promise.catch(() => {});
        strictEqual(Object.is(peek(promise), reason), true);
        strictEqual(peek.status(promise), 'rejected');
    }
});

Deno.test('bun: peek returns the same promise while it is pending', () => {
    const promise = new Promise(() => {});
    strictEqual(peek(promise), promise);
    strictEqual(peek.status(promise), 'pending');
});

Deno.test('bun: peek does not treat a foreign thenable as a promise', () => {
    const thenable = { then(resolve: (value: number) => void) { resolve(7); } };
    strictEqual(peek(thenable), thenable);
    strictEqual(peek.status(thenable), 'fulfilled');

    const promiseProxy = new Proxy(Promise.resolve(1), {});
    strictEqual(peek(promiseProxy), promiseProxy);
    strictEqual(peek.status(promiseProxy), 'fulfilled');
});

Deno.test('bun: peek reads Promise subclasses without invoking user properties', () => {
    class HostilePromise<T> extends Promise<T> {
        get then(): Promise<T>['then'] { throw new Error('then getter must not run'); }
        get catch(): Promise<T>['catch'] { throw new Error('catch getter must not run'); }
        get [Symbol.toStringTag](): string { throw new Error('tag getter must not run'); }
    }

    const fulfilled = new HostilePromise<null>((resolve) => resolve(null));
    const pending = new HostilePromise<never>(() => {});
    strictEqual(peek(fulfilled), null);
    strictEqual(peek.status(fulfilled), 'fulfilled');
    strictEqual(peek(pending), pending);
    strictEqual(peek.status(pending), 'pending');
});

Deno.test('bun: peek and peek.status have Bun-compatible descriptors', () => {
    strictEqual(peek.length, 1);
    strictEqual(peek.name, '');
    strictEqual(peek.status.length, 1);
    strictEqual(peek.status.name, '');
    const descriptor = Object.getOwnPropertyDescriptor(peek, 'status');
    deepStrictEqual(
        { writable: descriptor?.writable, enumerable: descriptor?.enumerable, configurable: descriptor?.configurable },
        { writable: false, enumerable: true, configurable: false },
    );
    strictEqual(Object.hasOwn(peek, 'prototype'), false);
    strictEqual(Object.hasOwn(peek.status, 'prototype'), false);
    throws(() => Reflect.construct(peek as never, [Promise.resolve(1)]), TypeError);
    throws(() => Reflect.construct(peek.status as never, [Promise.resolve(1)]), TypeError);
});
