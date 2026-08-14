import { strictEqual } from 'node:assert';
import util from 'node:util';

/**
 * ===========================================================================
 * CRITICAL: the C console formatter diverges from node; util.inspect does not.
 *
 * THESE TESTS FAIL TODAY AND WILL KEEP FAILING UNTIL THE C FIX (OR THE
 * DELEGATION FIX) LANDS. They are `ignore: true` for that reason, exactly as the
 * async-hooks and fs-errno suites do for their rebuild-dependent rows. Do NOT
 * "fix" them by asserting cno's current output -- every expectation below is
 * node v24.18.0's behaviour, which is correct by definition. A landed fix flips
 * these green with no edit to the file.
 *
 * THE VECTOR
 * cno has TWO formatters. `node:util`'s inspect/format (TS) is node-correct and
 * is guarded by the unskipped companion tests at the bottom of this file. The
 * separate C formatter in `circu.js/src/console.c` backs `globalThis.console`,
 * and it is the divergent one. Because `globalThis.console` is what essentially
 * all real code calls, the C copy is the one users actually see.
 *
 * These tests reach the C formatter in-process, with no subprocess, via the C
 * module's own string-returning entry points:
 *     const c = import.meta.use('console');  c.inspect(v) / c.format(fmt, v)
 * `c.inspect` routes through format_value -> format_string (the quote/escape
 * loop) and `c.format` through format_args_node -> format_to_{string,number} --
 * the same functions `console.log` uses, so a fix to either is observed here.
 * (Patching `process.stdout.write` does NOT intercept globalThis.console in cno,
 * which is why the byte capture is done this way.)
 *
 * MEASURED, node v24.18.0 vs cno (colours forced OFF, NO_COLOR=1, redirected):
 *   defect  input                     node                        cno
 *   D1      {s:'a\0b'}                { s: 'a\x00b' }             { s: 'a' }   <-- DATA LOSS
 *   D2      {s:'a\x7fb'}              { s: 'a\x7Fb' }             { s: 'a\x7fb' }
 *   D3      {s:'a\bb'}                { s: 'a\bb' }               { s: 'a\x08b' }
 *   D3      {s:'a\fb'}                { s: 'a\fb' }               { s: 'a\x0cb' }
 *   D6      {s:`it's "hi" ${'$'}{x}`} { s: 'it\'s "hi" ${x}' }    { s: `it's "hi" ${x}` }
 *   D10     format('%s',{a:1})        { a: 1 }                    [object Object]
 *   D10     format('%s',[1,2])        [ 1, 2 ]                    1,2
 *   D10     format('%s',nullproto)    [Object: null prototype] {} '' (EMPTY)
 *   D11     format('%d',3.9)          3.9                         3            <-- PRECISION LOSS
 *   D12     format('%i','42px')       42                          NaN
 *   D12     format('%f','3.5abc')     3.5                         NaN
 *   D13     format('%s',10n)          10n                         10
 *   D14     format('%s',-0)           -0                          0
 *   D15     format('%o',[1,2])        [ 1, 2, [length]: 2 ]       [ 1, 2 ]
 *
 * LAYER: baked C. `circu.js/src/console.c` is compiled into cno.exe, so
 * `cno setup` cannot make a fix live -- a full rebuild is required, and
 * REBUILD_EXIT=0 does not prove the new code linked (verify functionally, not by
 * grepping the binary: grep -a on the exe has returned 0 for known-present
 * literals).
 *
 * ROOT CAUSE, per group (line numbers verified against console.c dated 08-06):
 *   D1  console.c:470  `size_t len = strlen(str)` truncates at an embedded NUL;
 *                      JS_ToCString's buffer legitimately contains one.
 *                      Fix: JS_ToCStringLen to get the true length.
 *   D2  console.c:493  `"\\x%02x"` emits lowercase hex; node emits uppercase.
 *   D3  console.c:488-493 no `\b` / `\f` short escapes, so they fall through to
 *                      the generic `\xNN` branch.
 *   D6  console.c:479-482 picks a backtick after checking only for a backtick;
 *                      node also requires the string to contain no `${`.
 *   D10/D13/D14  console.c:268  format_to_string uses JS_ToCString for every
 *                      value. Node's %s is: not-an-object, null, or a user
 *                      toString -> String(v); otherwise inspect(v,{depth:0}).
 *                      BigInt gets an `n` suffix and -0 prints as `-0`.
 *   D11/D12  console.c:278  format_to_number is called with integer=true for
 *                      BOTH %d and %i, so they behave identically. Node: %d is
 *                      Number(v) with no truncation, %i is parseInt(v,10), %f is
 *                      parseFloat(v) -- three behaviours, not one.
 *   D15  %o must be inspect(showHidden:true, depth:4).
 *
 * MITIGATION / PREFERRED FIX
 * A correct formatter already exists in the same process. Delegating the C
 * console to it was verified empirically: replacing the C module's `log` with
 * `(...a) => origLog(util.format(...a))` at runtime made all of D1,D2,D3,D6 and
 * D10-D15 byte-identical to node, 11 of 11 probes. The one-line home for that
 * change is the facade at `cno/src/webapi/console.ts:113-118`, which already
 * resolves `internal[name]` at call time. That is baked too, so it also needs a
 * rebuild -- but it closes all fourteen rows below at once instead of six
 * separate C edits.
 *
 * ACTION: drop `ignore: true` on the tests below once either fix lands.
 * ===========================================================================
 */

interface CConsole {
    inspect(value: unknown, options?: unknown): string;
    format(...args: unknown[]): string;
}

/** The C console module. Undefined would mean the native module vanished. */
function cConsole(): CConsole {
    const mod = (import.meta as unknown as { use(name: string): CConsole }).use('console');
    if (!mod || typeof mod.inspect !== 'function' || typeof mod.format !== 'function') {
        throw new Error('native console module missing inspect/format');
    }
    return mod;
}

Deno.test({
    name: 'C formatter D1: an embedded NUL must not truncate the string (fails until rebuild)',
    ignore: true,
    fn: () => {
        // Node keeps the whole string and escapes the NUL. cno stops at the NUL,
        // silently dropping every later character -- real data loss in a log line.
        strictEqual(cConsole().inspect({ s: 'a\0b' }), "{ s: 'a\\x00b' }");
    },
});

Deno.test({
    name: 'C formatter D2/D3: control chars use node\'s escapes and uppercase hex (fails until rebuild)',
    ignore: true,
    fn: () => {
        const c = cConsole();
        strictEqual(c.inspect({ s: 'a\x7fb' }), "{ s: 'a\\x7Fb' }"); // uppercase hex
        strictEqual(c.inspect({ s: 'a\x1bb' }), "{ s: 'a\\x1Bb' }");
        strictEqual(c.inspect({ s: 'a\vb' }), "{ s: 'a\\x0Bb' }");
        strictEqual(c.inspect({ s: 'a\bb' }), "{ s: 'a\\bb' }");   // short escape
        strictEqual(c.inspect({ s: 'a\fb' }), "{ s: 'a\\fb' }");   // short escape
    },
});

Deno.test({
    name: 'C formatter D6: a backtick is not chosen when the string contains ${ (fails until rebuild)',
    ignore: true,
    fn: () => {
        // All three quote styles are unusable without escaping, so node falls back
        // to single quotes and escapes. Choosing a backtick here turns the value
        // into something that reads as a live template literal.
        strictEqual(cConsole().inspect({ s: "it's \"hi\" ${x}" }), "{ s: 'it\\'s \"hi\" ${x}' }");
    },
});

Deno.test({
    name: 'C formatter D10: spec-s inspects objects instead of String()-ing them (fails until rebuild)',
    ignore: true,
    fn: () => {
        const c = cConsole();
        strictEqual(c.format('%s', { a: 1 }), '{ a: 1 }');
        strictEqual(c.format('%s', [1, 2]), '[ 1, 2 ]');
        strictEqual(c.format('%s', { a: { b: { c: 1 } } }), '{ a: [Object] }'); // depth 0
        strictEqual(c.format('%s', Object.create(null)), '[Object: null prototype] {}');
        // A user-supplied toString must still win -- this arm already passes, and
        // guards against a fix that inspects unconditionally.
        strictEqual(c.format('%s', { toString() { return 'TS'; } }), 'TS');
    },
});

Deno.test({
    name: 'C formatter D11/D12: spec-d, spec-i and spec-f are three behaviours (fails until rebuild)',
    ignore: true,
    fn: () => {
        const c = cConsole();
        strictEqual(c.format('%d', 3.9), '3.9');      // Number(), NOT truncation
        strictEqual(c.format('%i', 3.9), '3');        // parseInt
        strictEqual(c.format('%i', '42px'), '42');    // parseInt takes the prefix
        strictEqual(c.format('%f', '3.5abc'), '3.5'); // parseFloat takes the prefix
        strictEqual(c.format('%d', 'abc'), 'NaN');
    },
});

Deno.test({
    name: 'C formatter D13/D14: BigInt keeps its n suffix and -0 stays signed (fails until rebuild)',
    ignore: true,
    fn: () => {
        const c = cConsole();
        strictEqual(c.format('%s', 10n), '10n');
        strictEqual(c.format('%d', 10n), '10n');
        strictEqual(c.format('%s', -0), '-0');
    },
});

Deno.test({
    name: 'C formatter D15: spec-o applies showHidden (fails until rebuild)',
    ignore: true,
    fn: () => {
        strictEqual(cConsole().format('%o', [1, 2]), '[ 1, 2, [length]: 2 ]');
    },
});

/**
 * ---------------------------------------------------------------------------
 * UNSKIPPED COMPANIONS. These guard the TS formatter that is already correct,
 * so a future "fix" that regresses util.inspect to match the C copy -- or that
 * routes util through the C formatter -- goes red immediately. They are the
 * positive control for the block above: if these ever fail, the harness itself
 * is broken rather than the C layer.
 * ---------------------------------------------------------------------------
 */

Deno.test('util.inspect escaping matches node (guards the correct TS formatter)', () => {
    strictEqual(util.inspect({ s: 'a\0b' }), "{ s: 'a\\x00b' }");
    strictEqual(util.inspect({ s: 'a\x7fb' }), "{ s: 'a\\x7Fb' }");
    strictEqual(util.inspect({ s: 'a\bb' }), "{ s: 'a\\bb' }");
    strictEqual(util.inspect({ s: 'a\fb' }), "{ s: 'a\\fb' }");
    strictEqual(util.inspect({ s: "it's \"hi\" ${x}" }), "{ s: 'it\\'s \"hi\" ${x}' }");
});

Deno.test('util.inspect quote selection matches node (guards the correct TS formatter)', () => {
    strictEqual(util.inspect({ s: 'abc' }), "{ s: 'abc' }");
    strictEqual(util.inspect({ s: "it's" }), '{ s: "it\'s" }');
    strictEqual(util.inspect({ s: 'say "hi"' }), "{ s: 'say \"hi\"' }");
    strictEqual(util.inspect({ s: 'it\'s "hi"' }), '{ s: `it\'s "hi"` }');
});

Deno.test('util.format specifiers match node (guards the correct TS formatter)', () => {
    strictEqual(util.format('%s', { a: 1 }), '{ a: 1 }');
    strictEqual(util.format('%s', [1, 2]), '[ 1, 2 ]');
    strictEqual(util.format('%s', 10n), '10n');
    strictEqual(util.format('%s', -0), '-0');
    strictEqual(util.format('%d', 3.9), '3.9');
    strictEqual(util.format('%i', '42px'), '42');
    strictEqual(util.format('%f', '3.5abc'), '3.5');
    strictEqual(util.format('%o', [1, 2]), '[ 1, 2, [length]: 2 ]');
});
