import assert, { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import test, { describe, it, mock, suite } from 'node:test';

Deno.test('node:test upstream: top-level helpers share the same callable test function', () => {
    strictEqual(test.test, test);
    strictEqual(test.mock, mock);
    strictEqual(describe, test);
    strictEqual(it, test);
    strictEqual(suite, test);
});

test('node:test upstream: context exposes assert namespace and nested tests', async (t) => {
    strictEqual(t.assert.strictEqual, assert.strictEqual);
    let nested = false;
    await t.test('nested step', () => {
        nested = true;
    });
    strictEqual(nested, true);
});

test('node:test upstream: done callback pass support', (_t, done) => {
    queueMicrotask(done);
});

Deno.test('node:test upstream: mock.fn tracks calls, results, errors and this', () => {
    const fn = mock.fn(function (this: { tag: string }, a: number, b: number) {
        return `${this.tag}:${a + b}`;
    });
    const receiver = { tag: 'sum', fn };

    strictEqual(receiver.fn(1, 2), 'sum:3');
    strictEqual(fn.mock.callCount(), 1);
    deepStrictEqual(fn.mock.calls[0].arguments, [1, 2]);
    strictEqual(fn.mock.calls[0].result, 'sum:3');
    strictEqual(fn.mock.calls[0].this, receiver);
    ok(fn.mock.calls[0].stack instanceof Error);

    const throwing = mock.fn(() => {
        throw new Error('test error');
    });
    throws(() => throwing(), { message: 'test error' });
    strictEqual(throwing.mock.calls[0].result, undefined);
    strictEqual((throwing.mock.calls[0].error as Error).message, 'test error');

    mock.restoreAll();
});

Deno.test('node:test upstream: mock.fn implementation override honors times option', () => {
    const fn = mock.fn(() => 'original', () => 'mocked', { times: 2 });
    strictEqual(fn(), 'mocked');
    strictEqual(fn(), 'mocked');
    strictEqual(fn(), 'original');
    strictEqual(fn.mock.callCount(), 3);
    mock.restoreAll();
});

Deno.test('node:test upstream: mock.method spies, restores and rejects non-functions', () => {
    const obj = {
        add(a: number, b: number) {
            return a + b;
        },
        value: 42,
    };

    const mocked = mock.method(obj, 'add', () => 42);
    strictEqual(obj.add(1, 2), 42);
    strictEqual(mocked.mock.callCount(), 1);
    deepStrictEqual(mocked.mock.calls[0].arguments, [1, 2]);

    mocked.mock.restore();
    strictEqual(obj.add(1, 2), 3);
    throws(() => mock.method(obj, 'value'), {
        message: "Cannot mock property 'value' because it is not a function",
    });
    mock.restoreAll();
});

Deno.test('node:test upstream: mock reset clears calls and restoreAll restores methods', () => {
    const fn1 = mock.fn();
    const fn2 = mock.fn();
    fn1();
    fn1();
    fn2();
    strictEqual(fn1.mock.callCount(), 2);
    strictEqual(fn2.mock.callCount(), 1);
    mock.reset();
    strictEqual(fn1.mock.callCount(), 0);
    strictEqual(fn2.mock.callCount(), 0);

    const obj = {
        greet() {
            return 'hello';
        },
    };
    mock.method(obj, 'greet', () => 'mocked hello');
    strictEqual(obj.greet(), 'mocked hello');
    mock.restoreAll();
    strictEqual(obj.greet(), 'hello');
});
