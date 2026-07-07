import { match, strictEqual } from 'node:assert';

Deno.test('deno upstream: Error.stack first line reflects current name and message', () => {
    const cases: Array<[unknown, unknown, RegExp]> = [
        ['Foo', 'bar', /^Foo: bar\n/],
        ['', 'bar', /^bar\n/],
        ['Foo', '', /^Foo\n/],
        ['', '', /^\n/],
        [undefined, undefined, /^Error\n/],
        [null, null, /^null: null\n/],
    ];

    for (const [name, message, expected] of cases) {
        const error = new Error();
        error.name = name as string;
        error.message = message as string;
        match(error.stack!, expected);
    }
});

Deno.test('deno upstream: Error.captureStackTrace removes the requested frame', () => {
    function foo() {
        const error = new Error();
        const stack1 = error.stack!;
        Error.captureStackTrace(error, foo);
        const stack2 = error.stack!;
        strictEqual(stack2, stack1.replace(/(?<=^[^\n]*\n)[^\n]*\n/, ''));
    }

    foo();
});
