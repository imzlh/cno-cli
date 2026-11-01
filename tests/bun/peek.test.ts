import { deepStrictEqual, strictEqual } from 'node:assert';
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
    const reason = new Error('boom');
    const promise = Promise.reject(reason);
    promise.catch(() => {});
    strictEqual(peek(promise), reason);
    strictEqual(peek.status(promise), 'rejected');
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
});
