import { ok, strictEqual } from 'node:assert';
import * as vm from 'node:vm';

/**
 * `vm.compileFunction` must report the line a throw is on *within the supplied
 * body*, counting from 1 -- the same line Node reports. Node compiles the body
 * inside a `function (params) { ... }` wrapper too, but V8 subtracts the wrapper
 * offset internally so the body still starts on line 1.
 *
 * QuickJS has no such knob, so `buildFunctionExpression`
 * (cno/src/node/vm/mod.ts) must keep the wrapper header on the *same physical
 * line* as the body. A leading newline there shifts every reported line by +1:
 * measured against node v24.18.0, `throw new Error('x')` reported `2:7` instead
 * of `1:7`, and a 3-line body reported `4:7` instead of `3:7`.
 *
 * Residual, deliberately not asserted: the *column* of a line-1 frame is offset
 * by the wrapper header width, because the header shares line 1. Lines >= 2 have
 * both the correct line and column. Only line numbers are asserted here.
 */

/** Line number of the first stack frame naming `tag`, from a throwing compiled fn. */
const lineOf = (tag: string, body: string, options: Record<string, unknown> = {}): number => {
    try {
        (vm.compileFunction(body, [], { ...options, filename: tag }) as () => void)();
    } catch (error) {
        const match = new RegExp(`${tag.replace(/\./g, '\\.')}:(\\d+):`).exec(String((error as Error).stack));
        if (match) return Number(match[1]);
        throw new Error(`no stack frame naming ${tag} in: ${String((error as Error).stack)}`);
    }
    throw new Error(`expected ${tag} to throw`);
};

Deno.test('vm regression: compileFunction reports a line-1 throw on line 1', () => {
    strictEqual(lineOf('cf-one.js', 'throw new Error("x")'), 1);
});

Deno.test('vm regression: compileFunction reports the real line of a multi-line body', () => {
    const body = 'const a = 1;\nconst b = 2;\nthrow new Error("x");';
    strictEqual(lineOf('cf-multi.js', body), 3);
});

Deno.test('vm regression: compileFunction counts a leading blank line in the body', () => {
    strictEqual(lineOf('cf-lead.js', '\nthrow new Error("x")'), 2);
});

Deno.test('vm regression: compileFunction line is unaffected by the params list', () => {
    // The wrapper header grows with each param. That must not move the body's line.
    const tag = 'cf-params.js';
    try {
        (vm.compileFunction('throw new Error("x")', ['aaaa', 'bbbb', 'cccc'], { filename: tag }) as (
            a?: unknown, b?: unknown, c?: unknown,
        ) => void)();
    } catch (error) {
        const match = new RegExp(`${tag.replace(/\./g, '\\.')}:(\\d+):`).exec(String((error as Error).stack));
        ok(match, 'expected a frame naming the filename');
        strictEqual(Number(match![1]), 1);
        return;
    }
    throw new Error('expected a throw');
});

Deno.test('vm regression: compileFunction lineOffset adds to the reported line', () => {
    strictEqual(lineOf('cf-off10.js', 'throw new Error("x")', { lineOffset: 10 }), 11);
    strictEqual(lineOf('cf-off0.js', 'throw new Error("x")', { lineOffset: 0 }), 1);
    // lineOffset plus a real multi-line body: both contribute.
    strictEqual(lineOf('cf-off-multi.js', 'const a=1;\nthrow new Error("x");', { lineOffset: 5 }), 7);
});

Deno.test('vm regression: compileFunction body still starts on line 1 relative to the wrapper', () => {
    // A body whose *last* line throws: the reported line must equal the body's
    // own line count, proving no constant offset was reintroduced. Each filler
    // line declares a distinct name -- reusing one is a redeclaration SyntaxError,
    // whose own position would be matched instead of the throw's.
    for (const lines of [1, 2, 5, 12]) {
        const filler = Array.from({ length: lines - 1 }, (_, i) => `const v${i} = ${i};`).join('\n');
        const body = `${filler}${lines > 1 ? '\n' : ''}throw new Error("x");`;
        strictEqual(lineOf(`cf-count-${lines}.js`, body), lines, `body of ${lines} lines`);
    }
});
