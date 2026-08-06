import { strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

/**
 * `globalThis.console` is NOT `node:console`.
 *
 * The global is a thin facade (cno/src/webapi/console.ts) over the native C
 * console in circu.js/src/console.c, while `node:console` is a TypeScript
 * implementation over util.inspect. They were two different formatters, so
 * formatting work verified green against `node:console` never reached anyone
 * calling plain `console.log` — or the REPL, which prints every evaluation
 * result through this same native path.
 *
 * Three of the divergences below were worse than cosmetic:
 *
 *  - Typed arrays reported byteLength as the element count and then read past
 *    the end, so `new Float64Array([1.5])` printed
 *    `Float64Array(8) [ 1.5, undefined x7 ]` — a length that is wrong and
 *    seven elements that do not exist.
 *  - The `[Object: null prototype]` marker was dropped entirely, making a
 *    prototype-pollution-hardened object indistinguishable from a plain one.
 *  - Every ordinary function rendered as `[class ...]`, because the classifier
 *    keyed off JS_IsConstructor() — true for all non-arrow functions — instead
 *    of node's test on the source text.
 *
 * Every expectation here was measured against real node v24.18.0.
 *
 * These run in a subprocess on purpose: importing `node:console` in-process
 * would exercise the *other*, already-correct implementation and prove nothing.
 */

interface RunResult { code: number; stdout: string; stderr: string }

async function runScript(dir: string, source: string): Promise<RunResult> {
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const file = join(dir, `probe-${Math.random().toString(36).slice(2)}.js`);
    Deno.writeTextFileSync(file, source);
    const output = await new Deno.Command(execPath, {
        args: ['run', file],
        stdout: 'piped',
        stderr: 'piped',
        env: { CTS_SILENT: 'true', NO_COLOR: '1' },
    }).output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout).replace(/\r\n/g, '\n').trimEnd(),
        stderr: decodeUtf8(output.stderr).replace(/\r\n/g, '\n').trimEnd(),
    };
}

/** Renders `expr` through the GLOBAL console and returns the single output line. */
async function renderGlobal(dir: string, expr: string): Promise<string> {
    const res = await runScript(dir, `console.log(${expr});\n`);
    strictEqual(res.code, 0, `probe exited ${res.code}: ${res.stderr}`);
    return res.stdout;
}

Deno.test('global console: typed arrays report the element count, not byteLength', async () => {
    await withTempDir('gconsole-ta', async (dir) => {
        // The element count is byteLength / bytesPerElement. Printing byteLength
        // both overstated the length and fabricated trailing `undefined`s.
        strictEqual(await renderGlobal(dir, 'new Float64Array([1.5])'),
            'Float64Array(1) [ 1.5 ]');
        strictEqual(await renderGlobal(dir, 'new Float64Array([1.5, 2.5])'),
            'Float64Array(2) [ 1.5, 2.5 ]');
        strictEqual(await renderGlobal(dir, 'new Int32Array([7, 8])'),
            'Int32Array(2) [ 7, 8 ]');
        strictEqual(await renderGlobal(dir, 'new Uint16Array([9])'),
            'Uint16Array(1) [ 9 ]');
        strictEqual(await renderGlobal(dir, 'new Float32Array([1, 2, 3])'),
            'Float32Array(3) [ 1, 2, 3 ]');
        strictEqual(await renderGlobal(dir, 'new BigInt64Array([1n])'),
            'BigInt64Array(1) [ 1n ]');

        // 1-byte element types coincided with the old behaviour — they are the
        // negative control for this fix: they must NOT change.
        strictEqual(await renderGlobal(dir, 'new Uint8Array([1, 2, 3])'),
            'Uint8Array(3) [ 1, 2, 3 ]');
        strictEqual(await renderGlobal(dir, 'new Int8Array([-1, -2])'),
            'Int8Array(2) [ -1, -2 ]');

        // A view over part of a buffer must report its own length, not the
        // buffer's.
        strictEqual(await renderGlobal(dir, 'new Float64Array([1, 2, 3, 4]).subarray(1, 3)'),
            'Float64Array(2) [ 2, 3 ]');
        strictEqual(await renderGlobal(dir, 'new Uint8Array(0)'),
            'Uint8Array(0) [  ]');
    });
});

Deno.test('global console: function kinds match node', async () => {
    await withTempDir('gconsole-fn', async (dir) => {
        strictEqual(await renderGlobal(dir, 'function named(){}'), '[Function: named]');
        strictEqual(await renderGlobal(dir, 'async function af(){}'), '[AsyncFunction: af]');
        strictEqual(await renderGlobal(dir, 'function* gf(){}'), '[GeneratorFunction: gf]');
        strictEqual(await renderGlobal(dir, 'async function* agf(){}'),
            '[AsyncGeneratorFunction: agf]');
        strictEqual(await renderGlobal(dir, '({m(){}}).m'), '[Function: m]');
        strictEqual(await renderGlobal(dir, '(function nn(){}).bind(null)'),
            '[Function: bound nn]');

        // Real classes stay `[class ...]` — the negative control proving the fix
        // did not simply relabel everything as a function.
        strictEqual(await renderGlobal(dir, 'class Klass{}'), '[class Klass]');
        strictEqual(await renderGlobal(dir, 'class Sub extends Array{}'),
            '[class Sub extends Array]');

        // Native constructors are `[Function: X]` in node, because their source
        // reads `function X() { [native code] }` — a [[Construct]] slot alone
        // does not make something a class.
        strictEqual(await renderGlobal(dir, 'Array'), '[Function: Array]');
        strictEqual(await renderGlobal(dir, 'Math.max'), '[Function: max]');

        // Anonymous forms use node's parenthesised spelling.
        strictEqual(await renderGlobal(dir, '() => {}'), '[Function (anonymous)]');
        strictEqual(await renderGlobal(dir, 'function(){}'), '[Function (anonymous)]');
        strictEqual(await renderGlobal(dir, 'class{}'), '[class (anonymous)]');

        // The classifier must consult Function.prototype.toString, not a
        // user-supplied toString, or any object could disguise itself.
        strictEqual(
            await renderGlobal(dir,
                `Object.defineProperty(function ev(){}, 'toString', {value: () => 'class Fake{}'})`),
            '[Function: ev]');
    });
});

Deno.test('global console: null-prototype marker is preserved', async () => {
    await withTempDir('gconsole-np', async (dir) => {
        // Losing this marker hid exactly the shape that prototype-pollution
        // hardening produces.
        strictEqual(await renderGlobal(dir, 'Object.create(null)'),
            '[Object: null prototype] {}');
        strictEqual(await renderGlobal(dir, 'Object.assign(Object.create(null), {a: 1})'),
            '[Object: null prototype] { a: 1 }');
        strictEqual(await renderGlobal(dir, '({a: Object.create(null)})'),
            '{ a: [Object: null prototype] {} }');

        // A normal object must not gain the marker.
        strictEqual(await renderGlobal(dir, '({a: 1})'), '{ a: 1 }');
    });
});

Deno.test('global console: a bare object does not leak __proto__', async () => {
    await withTempDir('gconsole-proto', async (dir) => {
        // The accessor fallback walked Object.prototype and invoked its
        // `__proto__` getter, rendering `{}` as a two-line `{ __proto__: {} }`.
        strictEqual(await renderGlobal(dir, '({})'), '{}');
        strictEqual(await renderGlobal(dir, '({a: {}})'), '{ a: {} }');
    });
});

Deno.test('global console: depth cutoff matches node console.log', async () => {
    await withTempDir('gconsole-depth', async (dir) => {
        // node's console.log inspects at util.inspect's default depth of 2.
        strictEqual(await renderGlobal(dir, '({a: {b: {c: {d: 1}}}})'),
            '{ a: { b: { c: [Object] } } }');
        strictEqual(await renderGlobal(dir, '({a: {b: {c: {d: {e: 1}}}}})'),
            '{ a: { b: { c: [Object] } } }');
        // Within the limit nothing is collapsed.
        strictEqual(await renderGlobal(dir, '({a: {b: {c: 1}}})'), '{ a: { b: { c: 1 } } }');
        // Functions and Dates are never collapsed by depth in node.
        strictEqual(await renderGlobal(dir, '({a: {b: {c: function foo(){}}}})'),
            '{ a: { b: { c: [Function: foo] } } }');
    });
});

Deno.test('global console: Date renders as ISO, independent of host timezone', async () => {
    await withTempDir('gconsole-date', async (dir) => {
        // The old local-timezone form also made output unassertable, since it
        // varied with the host's zone.
        strictEqual(await renderGlobal(dir, 'new Date(0)'), '1970-01-01T00:00:00.000Z');
        strictEqual(await renderGlobal(dir, 'new Date(NaN)'), 'Invalid Date');
        strictEqual(await renderGlobal(dir, '({a: {b: {c: new Date(0)}}})'),
            '{ a: { b: { c: 1970-01-01T00:00:00.000Z } } }');
    });
});

Deno.test('global console: Promise uses node spelling and shows rejection', async () => {
    await withTempDir('gconsole-promise', async (dir) => {
        // `Promise<1>` looked like a TypeScript type and lost the
        // fulfilled/rejected distinction.
        strictEqual(await renderGlobal(dir, 'Promise.resolve(1)'), 'Promise { 1 }');
        strictEqual(await renderGlobal(dir, 'new Promise(() => {})'), 'Promise { <pending> }');
    });
});

Deno.test('global console: Infinity carries no plus sign', async () => {
    await withTempDir('gconsole-inf', async (dir) => {
        strictEqual(await renderGlobal(dir, '[NaN, Infinity, -Infinity]'),
            '[ NaN, Infinity, -Infinity ]');
    });
});

Deno.test('global console: string quoting picks the quote needing fewest escapes', async () => {
    await withTempDir('gconsole-quote', async (dir) => {
        // node switches to double quotes rather than escaping an apostrophe.
        strictEqual(await renderGlobal(dir, `({a: "it's"})`), `{ a: "it's" }`);
        strictEqual(await renderGlobal(dir, `({a: 'plain'})`), `{ a: 'plain' }`);
    });
});

Deno.test('global console: %O and console.dir honour node semantics', async () => {
    await withTempDir('gconsole-dir', async (dir) => {
        // node's %O is inspect(arg) with DEFAULT options, i.e. depth 2.
        const o = await runScript(dir,
            `console.log('%O', {a:{b:{c:{d:1}}}});\n`);
        strictEqual(o.code, 0, o.stderr);
        strictEqual(o.stdout, '{ a: { b: { c: [Object] } } }');

        // console.dir previously discarded a caller-supplied depth outright, so
        // `{depth: 1}` behaved exactly like no options at all. Only `depth` was
        // made conditional; `dir`'s expanded (compact: false) default is
        // retained deliberately, so compare against the multi-line form.
        const d1 = await runScript(dir, `console.dir({a:{b:{c:{d:1}}}}, {depth: 1});\n`);
        strictEqual(d1.code, 0, d1.stderr);
        strictEqual(d1.stdout, '{\n  a: {\n    b: [Object]\n  }\n}');

        // The negative control: without an explicit depth, `dir` still expands
        // deeply, so the assertion above is testing the option and not just the
        // default.
        const d2 = await runScript(dir, `console.dir({a:{b:{c:{d:1}}}});\n`);
        strictEqual(d2.code, 0, d2.stderr);
        strictEqual(d2.stdout, '{\n  a: {\n    b: {\n      c: {\n        d: 1\n      }\n    }\n  }\n}');

        // An explicit `compact` is honoured too.
        const d3 = await runScript(dir,
            `console.dir({a:{b:{c:{d:1}}}}, {depth: 1, compact: true});\n`);
        strictEqual(d3.code, 0, d3.stderr);
        strictEqual(d3.stdout, '{ a: { b: [Object] } }');
    });
});

Deno.test('global console: agrees with node:console on these shapes', async () => {
    await withTempDir('gconsole-parity', async (dir) => {
        // The point of the whole exercise: the two implementations must not
        // disagree, so formatting work verified against one reaches the other.
        const exprs = [
            'new Float64Array([1.5])',
            'new Int32Array([7, 8])',
            'function named(){}',
            'async function af(){}',
            'function* gf(){}',
            'class Klass{}',
            'Object.create(null)',
            'Object.assign(Object.create(null), {a: 1})',
            '({})',
            '({a: {b: {c: {d: 1}}}})',
            'new Date(0)',
            'Promise.resolve(1)',
            '[NaN, Infinity, -Infinity]',
            `({a: "it's"})`,
            'Array',
            '() => {}',
        ];
        const src = `import nodeConsole from 'node:console';\n`
            + exprs.map((e) =>
                `{ const v = (${e}); console.log(v); nodeConsole.log(v); }`).join('\n')
            + '\n';
        const res = await runScript(dir, src);
        strictEqual(res.code, 0, `parity probe exited ${res.code}: ${res.stderr}`);
        const lines = res.stdout.split('\n');
        strictEqual(lines.length, exprs.length * 2,
            `expected ${exprs.length * 2} lines, got ${lines.length}:\n${res.stdout}`);
        for (let i = 0; i < exprs.length; i++) {
            strictEqual(lines[i * 2], lines[i * 2 + 1],
                `global console and node:console disagree on \`${exprs[i]}\``);
        }
    });
});
