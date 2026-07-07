import assert, { AssertionError, deepStrictEqual, doesNotReject, doesNotThrow, rejects, strictEqual, throws } from 'node:assert';
import * as assertNS from 'node:assert';

Deno.test('assert: default function behaves like ok for falsy values', () => {
    throws(() => assert(0), AssertionError);
    throws(() => assert(), AssertionError);
});

Deno.test('assert: strict namespace function rejects all falsy values', () => {
    for (const value of [false, 0, '', null, undefined]) {
        throws(() => assert.strict(value), AssertionError);
    }
});

Deno.test('assert: throws RegExp predicate matches primitive thrown values', () => {
    assert.throws(() => {
        throw 'primitive boom';
    }, /primitive/);
});

Deno.test('assert: throws validation function must return true exactly', () => {
    throws(() => {
        assert.throws(() => {
            throw new Error('boom');
        }, () => 'truthy');
    }, AssertionError);
});

Deno.test('assert: throws validates Error object message and name', () => {
    assert.throws(() => {
        throw new Error('boom');
    }, new Error('boom'));

    throws(() => {
        assert.throws(() => {
            throw new Error('boom');
        }, new Error('different'));
    }, AssertionError);
});

Deno.test('assert: throws object matcher requires expected undefined properties to exist', () => {
    const present = Object.assign(new Error('boom'), { code: undefined });
    doesNotThrow(() => {
        assert.throws(() => {
            throw present;
        }, { code: undefined });
    });

    throws(() => {
        assert.throws(() => {
            throw new Error('boom');
        }, { code: undefined });
    }, AssertionError);
});

Deno.test('assert: doesNotThrow rethrows exceptions that do not match predicate', () => {
    const error = new TypeError('boom');
    try {
        doesNotThrow(() => {
            throw error;
        }, RangeError);
    } catch (caught) {
        strictEqual(caught, error);
    }
});

Deno.test('assert: rejects rejects when callback does not return a promise', async () => {
    await rejects(
        () => rejects(() => 1 as unknown as Promise<unknown>),
        TypeError,
    );
});

Deno.test('assert: rejects object matcher requires expected undefined properties to exist', async () => {
    const present = Object.assign(new Error('boom'), { code: undefined });
    await rejects(Promise.reject(present), { code: undefined });

    await rejects(
        () => rejects(Promise.reject(new Error('boom')), { code: undefined }),
        AssertionError,
    );
});

Deno.test('assert upstream: CallTracker is exported on namespace default and strict', () => {
    strictEqual(typeof assertNS.CallTracker, 'function');
    strictEqual(typeof assertNS.default.CallTracker, 'function');
    strictEqual(assertNS.CallTracker, assertNS.default.CallTracker);
    strictEqual(assertNS.strict.CallTracker, assertNS.CallTracker);
});

Deno.test('assert upstream: AssertionError stores explicit metadata', () => {
    const err = new AssertionError({
        message: 'answer',
        actual: '42',
        expected: '42',
        operator: 'notStrictEqual',
    });

    strictEqual(err.name, 'AssertionError');
    strictEqual(err.message, 'answer');
    strictEqual(err.generatedMessage, false);
    strictEqual(err.code, 'ERR_ASSERTION');
    strictEqual(err.actual, '42');
    strictEqual(err.expected, '42');
    strictEqual(err.operator, 'notStrictEqual');
});

Deno.test('assert upstream: AssertionError generates messages and honors stackStartFn', () => {
    const generated = new AssertionError({ actual: 1, expected: 2, operator: 'equal' });
    strictEqual(generated.name, 'AssertionError');
    strictEqual(generated.message, '1 equal 2');
    strictEqual(generated.generatedMessage, true);

    function stackStartFn() {
        const err = new AssertionError({
            actual: 'deno',
            expected: /node/,
            operator: 'match',
            stackStartFn,
        });
        strictEqual(err.message, "'deno' match /node/");
        strictEqual(err.stack?.includes('stackStartFn'), false);
    }
    stackStartFn();
});

Deno.test('assert upstream: strictEqual message matches equivalent AssertionError', () => {
    const { message } = new AssertionError({
        actual: 1,
        expected: 2,
        operator: 'strictEqual',
    });

    throws(() => {
        assert.strictEqual(1, 2);
    }, { message });
});

Deno.test('assert upstream: deepStrictEqual distinguishes -0 and boxed numbers', () => {
    throws(() => assert.deepStrictEqual(0, -0), AssertionError);
    throws(() => assert.deepStrictEqual(new Number(1), new Number(2)), AssertionError);
    doesNotThrow(() => assert.deepStrictEqual(new Number(1), new Number(1)));
});

Deno.test('assert upstream: throws and rejects support message-only overloads', async () => {
    assert.throws(() => {
        throw new Error('test error');
    }, 'custom message');

    assert.throws(() => {
        throw new TypeError('test error');
    }, TypeError, 'custom message');

    doesNotThrow(() => {}, 'custom message');
    doesNotThrow(() => {}, TypeError, 'custom message');

    await rejects(async () => {
        throw new Error('async error');
    }, 'custom message');

    await rejects(async () => {
        throw new TypeError('async error');
    }, TypeError, 'custom message');

    await doesNotReject(async () => {}, 'custom message');
    await doesNotReject(async () => {}, TypeError, 'custom message');
});

Deno.test('assert upstream: strict namespace aliases use strict deep equality', () => {
    strictEqual(assert.strict.deepEqual, assert.strict.deepStrictEqual);
    strictEqual(assert.strict.notDeepEqual, assert.strict.notDeepStrictEqual);
    throws(() => assert.strict.deepEqual({ value: 1 }, { value: '1' }), AssertionError);
    deepStrictEqual({ a: 1 }, { a: 1 });
});
