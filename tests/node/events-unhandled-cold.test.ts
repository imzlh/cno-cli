// The first test runs before node:util is required below. Keep this file free
// of static node:assert/node:util imports so it verifies that node:events can
// synchronously acquire the full inspector only on the rare error path.
import { EventEmitter } from 'node:events';

type WrappedError = Error & { code?: string; context?: unknown };

function expectWrapped(context: unknown, message: string): void {
    let thrown: unknown;
    try {
        new EventEmitter().emit('error', context);
    } catch (error) {
        thrown = error;
    }
    if (!(thrown instanceof Error)) throw new Error('Expected EventEmitter.emit() to throw an Error');

    const wrapped = thrown as WrappedError;
    if (wrapped.code !== 'ERR_UNHANDLED_ERROR') {
        throw new Error(`Expected ERR_UNHANDLED_ERROR, got ${String(wrapped.code)}`);
    }
    if (wrapped.context !== context) throw new Error('Wrapped error did not preserve context identity');
    if (wrapped.message !== message) {
        throw new Error(`Expected ${JSON.stringify(message)}, got ${JSON.stringify(wrapped.message)}`);
    }
}

Deno.test('events: cold unhandled errors load the internal inspector on demand', () => {
    expectWrapped({ a: 1 }, 'Unhandled error. ({ a: 1 })');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expectWrapped(circular, 'Unhandled error. (<ref *1> { self: [Circular *1] })');

    const custom = {
        [Symbol.for('nodejs.util.inspect.custom')]() { return 'custom context'; },
    };
    expectWrapped(custom, 'Unhandled error. (custom context)');

    const throwingInspect = {
        [Symbol.for('nodejs.util.inspect.custom')]() { throw new Error('inspect failed'); },
    };
    expectWrapped(throwingInspect, 'Unhandled error. ([object Object])');
});

Deno.test('events: unhandled errors ignore public util.inspect replacement', () => {
    const publicUtil = require('node:util') as { inspect: (value: unknown) => string };
    const original = publicUtil.inspect;
    try {
        publicUtil.inspect = () => 'PUBLIC_PATCH';
        expectWrapped({ a: 1 }, 'Unhandled error. ({ a: 1 })');
    } finally {
        publicUtil.inspect = original;
    }
});
