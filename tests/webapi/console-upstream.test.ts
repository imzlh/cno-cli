// Derived from Deno upstream unit/console_test.ts public Web console cases.
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { decodeUtf8 } from '../_helpers/bytes.ts';

Deno.test('webapi console upstream: console is a namespace object', () => {
    const prototype = Object.getPrototypeOf(console);
    deepStrictEqual(Object.getOwnPropertyNames(prototype), []);
    strictEqual(Object.getPrototypeOf(prototype), Object.prototype);

    for (const name of [
        'assert',
        'clear',
        'count',
        'countReset',
        'debug',
        'dir',
        'dirxml',
        'error',
        'group',
        'groupCollapsed',
        'groupEnd',
        'info',
        'log',
        'table',
        'time',
        'timeEnd',
        'timeLog',
        'timeStamp',
        'trace',
        'warn',
    ]) {
        strictEqual(typeof (console as unknown as Record<string, unknown>)[name], 'function', `console.${name}`);
    }
});

Deno.test('webapi console upstream: assert does not throw and only emits on falsy input', async () => {
    const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            console.assert(true, 'hidden-assert');
            console.assert(false, 'shown-assert');
            console.log('after-assert');
        `],
    }).output();

    strictEqual(output.success, true);
    strictEqual(decodeUtf8(output.stdout), 'after-assert\n');
    const stderr = decodeUtf8(output.stderr);
    ok(stderr.includes('Assertion failed: shown-assert'));
    ok(!stderr.includes('hidden-assert'));
});

Deno.test('webapi console upstream: format preserves direct long strings but abbreviates object fields', () => {
    const veryLongString = 'a'.repeat(10_100);
    strictEqual(console.format(veryLongString), veryLongString);

    const objectOutput = console.format({ veryLongString });
    ok(objectOutput.includes('...'));
    ok(objectOutput.length < veryLongString.length);
});

Deno.test('webapi console upstream: format specifiers handle numeric and symbol inputs', () => {
    strictEqual(console.format('%i', 42.9), '42');
    strictEqual(console.format('%i', -0.5), '0');
    strictEqual(console.format('%f', 5n), '5');
    strictEqual(console.format('%s', Symbol('foo')), 'Symbol(foo)');
    strictEqual(console.format('%s %s', 42, 43), '42 43');
    strictEqual(console.format('%s %s', 42), '42 %s');
});

Deno.test('webapi console upstream: inspect and format tolerate proxied built-ins', () => {
    const values: unknown[] = [
        new Proxy(new Set([1, 2]), {}),
        new Proxy(new Map([[1, 2]]), {}),
        new Proxy(new Uint8Array([1, 2, 3]), {}),
        new Proxy(/hello/g, {}),
        new Proxy(new Date('2024-01-02T03:04:05Z'), {}),
        new Proxy(new Error('proxied'), {}),
    ];

    for (const value of values) {
        strictEqual(typeof Deno.inspect(value, { colors: false }), 'string');
        strictEqual(typeof console.format(value), 'string');
    }
});

Deno.test('webapi console upstream: Deno.inspect includes Error causes once', () => {
    const error = new TypeError('Type incorrect', {
        cause: new SyntaxError('Improper syntax'),
    });
    strictEqual(
        Deno.inspect(error, { colors: false }),
        'TypeError: Type incorrect\nCaused by SyntaxError: Improper syntax',
    );

    const nonErrorCause = new Error('Object cause', { cause: { code: 100500 } });
    strictEqual(
        Deno.inspect(nonErrorCause, { colors: false }),
        'Error: Object cause\nCaused by { code: 100500 }',
    );

    const circular = new Error('Circular cause') as Error & { cause?: unknown };
    circular.cause = circular;
    strictEqual(
        Deno.inspect(circular, { colors: false }),
        'Error: Circular cause\nCaused by [Circular]',
    );
});

Deno.test('webapi console upstream: Deno.inspect forwards supported inspect options', () => {
    const limitedArray = Deno.inspect(['a', 'b', 'c'], { colors: false, iterableLimit: 2 });
    ok(limitedArray.includes('... 1 more'));
    ok(!limitedArray.includes("'c'"));

    const multilineObject = Deno.inspect({ a: 1, b: 2 }, { colors: false, compact: false });
    ok(multilineObject.includes('\n'));
    ok(multilineObject.includes('a: 1'));
    ok(multilineObject.includes('b: 2'));

    const abbreviatedString = Deno.inspect('abcdefghijklmnopqrstuvwxyz', {
        colors: false,
        strAbbreviateSize: 8,
    });
    ok(abbreviatedString.length < Deno.inspect('abcdefghijklmnopqrstuvwxyz', { colors: false }).length);
    ok(abbreviatedString.includes('...'));
});
