/**
 * Regression: a value that throws during reflection must degrade to a placeholder
 * for THAT value only. It used to escape formatRaw's preamble and replace the
 * ENCLOSING object's entire render with "[inspect threw: ...]", silently losing
 * every sibling key — and, worst of all, the whole assert.deepStrictEqual diff.
 *
 * Every expectation below was measured against real Node v24.18.0.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import util from 'node:util';
import console from 'node:console';
import { Writable } from 'node:stream';

/** A real Writable, so these expectations can also be checked against real node. */
function collectingStream(sink: string[]): NodeJS.WritableStream {
    return new Writable({
        write(chunk: unknown, _enc: unknown, cb: (e?: Error | null) => void) {
            sink.push(String(chunk));
            cb();
            return true;
        },
    }) as unknown as NodeJS.WritableStream;
}

/** A Proxy whose named trap always throws. */
function hostile(trap: string): object {
    return new Proxy({ a: 1 }, { [trap]() { throw new Error('T_' + trap); } });
}

// getPrototypeOf reaches inspect via getConstructorName and `value instanceof Error`;
// `has` via `Symbol.iterator in value`; `get` via Symbol.toStringTag and
// [util.inspect.custom]; ownKeys/getOwnPropertyDescriptor via key enumeration.
const FATAL_TRAPS = ['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'];

test('inspect: a throwing proxy trap never collapses the enclosing object', () => {
    for (const trap of FATAL_TRAPS) {
        const out = util.inspect({ keep: 'YES', p: hostile(trap) });
        assert.ok(
            !out.includes('inspect threw'),
            `${trap}: expected no "inspect threw", got ${out}`,
        );
        assert.ok(out.includes("keep: 'YES'"), `${trap}: sibling key lost, got ${out}`);
    }
});

test('inspect: a throwing proxy trap at the top level still renders an object', () => {
    for (const trap of FATAL_TRAPS) {
        const out = util.inspect(hostile(trap));
        assert.ok(
            !out.includes('inspect threw'),
            `${trap}: expected no "inspect threw", got ${out}`,
        );
    }
});

test('inspect: every sibling key survives one hostile value', () => {
    const big: Record<string, unknown> = {};
    for (let i = 1; i <= 7; i++) big['k' + i] = 'v' + i;
    big.hostile = hostile('ownKeys');
    const out = util.inspect(big);
    for (let i = 1; i <= 7; i++) {
        assert.ok(out.includes(`k${i}: 'v${i}'`), `k${i} lost from ${out}`);
    }
    // The unreadable value renders as SOME object. Node prints the proxy target's
    // real contents (`{ a: 1 }`) because it reads the target via getProxyDetails;
    // cno has no such engine binding and prints `{}`. Either is acceptable here —
    // what this test pins is that the throw stays local to this one key.
    assert.ok(/hostile: \{( a: 1 )?\}/.test(out), out);
});

test('inspect: a hostile value inside an array or Map keeps the other entries', () => {
    const arr = util.inspect([1, 2, hostile('ownKeys'), 4, 5]);
    assert.ok(!arr.includes('inspect threw'), arr);
    assert.ok(/^\[ 1, 2, \{( a: 1 )?\}, 4, 5 \]$/.test(arr), arr);

    const map = util.inspect(new Map<string, unknown>([
        ['safe', 1],
        ['bad', hostile('ownKeys')],
    ]));
    assert.ok(!map.includes('inspect threw'), map);
    assert.ok(/^Map\(2\) \{ 'safe' => 1, 'bad' => \{( a: 1 )?\} \}$/.test(map), map);
});

test('inspect: a plain throwing Symbol.toStringTag getter does not break its parent', () => {
    // Not proxy-specific: Object.prototype.toString reads this getter, and that read
    // used to escape formatRaw entirely.
    const inner: Record<PropertyKey, unknown> = { keep: 1 };
    Object.defineProperty(inner, Symbol.toStringTag, {
        get() { throw new Error('tag'); },
    });
    const out = util.inspect({ keep: 'YES', inner });
    assert.ok(!out.includes('inspect threw'), out);
    assert.strictEqual(out, "{ keep: 'YES', inner: { keep: 1 } }");
});

test('inspect: a throwing constructor getter is already contained', () => {
    const inner = {};
    Object.defineProperty(inner, 'constructor', { get() { throw new Error('ctor'); } });
    assert.strictEqual(util.inspect({ keep: 'YES', inner }), "{ keep: 'YES', inner: {} }");
});

test('assert.deepStrictEqual: a hostile value does not erase the diff', () => {
    // This is the practical damage: the whole message became "[inspect threw: X]",
    // hiding the actual difference the assertion was reporting.
    let message = '';
    try {
        assert.deepStrictEqual({ x: 1, p: hostile('ownKeys') }, { x: 2 });
    } catch (err) {
        message = (err as Error).message;
    }
    assert.ok(message !== '', 'deepStrictEqual unexpectedly passed');
    assert.ok(!message.includes('inspect threw'), message);
    // The real difference must still be visible on both sides.
    assert.ok(message.includes('x: 1'), message);
    assert.ok(message.includes('x: 2'), message);
});

test('inspect: non-fatal traps were and remain contained', () => {
    for (const trap of ['set', 'deleteProperty', 'defineProperty', 'setPrototypeOf',
        'isExtensible', 'preventExtensions']) {
        const out = util.inspect({ keep: 'YES', p: hostile(trap) });
        assert.strictEqual(out, "{ keep: 'YES', p: { a: 1 } }", `${trap}: ${out}`);
    }
});

test('inspect: containment did not weaken normal rendering', () => {
    // Guards against a fix that swallows real information along with the throws.
    assert.strictEqual(util.inspect({ a: 1, b: 'x' }), "{ a: 1, b: 'x' }");
    assert.strictEqual(util.inspect(Object.create(null)), '[Object: null prototype] {}');
    assert.strictEqual(util.inspect([1, 2, 3]), '[ 1, 2, 3 ]');
    assert.strictEqual(util.inspect(new Error('e')).split('\n')[0], 'Error: e');
    assert.strictEqual(util.inspect(function named() {}), '[Function: named]');
    assert.strictEqual(util.inspect(class K {}), '[class K]');
    assert.strictEqual(util.inspect(new Map([['k', 'v']])), "Map(1) { 'k' => 'v' }");
    assert.strictEqual(util.inspect({ a: { b: { c: { d: 1 } } } }), '{ a: { b: { c: [Object] } } }');
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    assert.strictEqual(util.inspect(circular), '<ref *1> { a: 1, self: [Circular *1] }');
    // Symbol keys still enumerate.
    const sym = Symbol('s');
    assert.strictEqual(util.inspect({ [sym]: 1 }), '{ Symbol(s): 1 }');
    // showHidden still reaches non-enumerable own properties and prototype props.
    const hidden = {};
    Object.defineProperty(hidden, 'h', { value: 1, enumerable: false });
    assert.strictEqual(util.inspect(hidden, { showHidden: true }), '{ [h]: 1 }');
});

test('inspect: a nested [util.inspect.custom] throw propagates, like a top-level one', () => {
    // cno used to disagree with itself: a TOP-LEVEL throwing hook propagated (node's
    // behaviour) but a NESTED one was stringified to "[inspect threw: ...]" by
    // formatRaw's inner catch, which ran before the marker reached inspectImpl.
    const hostileHook = { [util.inspect.custom]() { throw new Error('CUSTOM-NESTED'); } };

    assert.throws(() => util.inspect(hostileHook), /CUSTOM-NESTED/);
    assert.throws(() => util.inspect({ wrapped: hostileHook }), /CUSTOM-NESTED/);
    assert.throws(() => util.inspect([hostileHook]), /CUSTOM-NESTED/);
    assert.throws(() => util.inspect(new Map([['k', hostileHook]])), /CUSTOM-NESTED/);

    // customInspect:false must not consult the hook at all.
    const out = util.inspect({ a: 1, ...hostileHook }, { customInspect: false });
    assert.ok(!out.includes('inspect threw'), out);
});

test('inspect: a throwing Error .stack / .message / .name getter degrades like node', () => {
    // Measured on node v24.18.0.
    const badStack = new Error('outer');
    Object.defineProperty(badStack, 'stack', { get() { throw new Error('STACK-BOOM'); } });
    assert.strictEqual(util.inspect(badStack), '[Error: outer]');
    // And the throw stays local to that value.
    assert.strictEqual(util.inspect({ keep: 1, e: badStack }), '{ keep: 1, e: [Error: outer] }');

    const badMessage = new Error('m');
    Object.defineProperty(badMessage, 'message', { get() { throw new Error('MSG-BOOM'); } });
    assert.strictEqual(util.inspect(badMessage), '[object Error]');

    const badName = new Error('n');
    Object.defineProperty(badName, 'name', { get() { throw new Error('NAME-BOOM'); } });
    assert.strictEqual(util.inspect(badName), '[object Error]');

    // A normal error is unaffected.
    assert.strictEqual(util.inspect(new Error('fine')).split('\n')[0], 'Error: fine');
    const frameless = new Error('x');
    frameless.stack = 'Error: x';
    assert.strictEqual(util.inspect(frameless), '[Error: x]');
});

test('util.deprecate: wrapping a constructor keeps its prototype', () => {
    // The wrapper used to get a fresh prototype, so instances lost every method
    // and were not instanceof the original.
    function Original(this: { x: number }, v: number) { this.x = v; }
    Original.prototype.method = function method(this: { x: number }) { return 'M' + this.x; };

    const Wrapped = util.deprecate(Original as never, 'ctor is deprecated') as never as
        new (v: number) => { x: number; method(): string };
    const instance = new Wrapped(5);

    assert.strictEqual(instance.x, 5);
    assert.strictEqual(instance instanceof (Original as never as new () => object), true);
    assert.strictEqual(
        (Wrapped as unknown as { prototype: unknown }).prototype,
        Original.prototype,
    );
    assert.strictEqual(typeof instance.method, 'function');
    assert.strictEqual(instance.method(), 'M5');
});

test('util.deprecate: warns through process.emitWarning', async () => {
    // A bare console.warn meant process.on('warning') never fired and
    // process.noDeprecation could not silence anything. Assert via the event rather
    // than the call signature: node passes (msg, type, code, ctor) positionally while
    // cno's process.emitWarning takes an options object — the event is what users see.
    const seen: Array<{ name: string; message: string; code?: string }> = [];
    const listener = (w: Error & { code?: string }) => {
        seen.push({ name: w.name, message: w.message, code: w.code });
    };
    process.on('warning', listener);
    try {
        util.deprecate(() => 1, 'DEP MESSAGE', 'DEP9999')();
        // process.emitWarning defers the event by a tick in both runtimes.
        await new Promise<void>(resolve => setTimeout(resolve, 20));
    } finally {
        process.removeListener('warning', listener);
    }
    const found = seen.filter(w => w.message === 'DEP MESSAGE');
    assert.strictEqual(found.length, 1, `got ${JSON.stringify(seen)}`);
    assert.strictEqual(found[0].name, 'DeprecationWarning');
    assert.strictEqual(found[0].code, 'DEP9999');
});

test('util.deprecate: noDeprecation suppresses synchronously without spending the once-flag', () => {
    // Measured on Node v24.18.0: the suppressed call does not consume `warned`,
    // so a later call with the flag cleared still warns exactly once.
    const calls: unknown[][] = [];
    const originalEmit = process.emitWarning;
    const savedFlag = (process as { noDeprecation?: unknown }).noDeprecation;
    try {
        (process as { emitWarning: unknown }).emitWarning = (...args: unknown[]) => {
            calls.push(args);
        };
        const fn = util.deprecate(() => 1, 'LATER');

        (process as { noDeprecation?: unknown }).noDeprecation = true;
        fn();
        assert.strictEqual(calls.length, 0, 'noDeprecation did not suppress');

        (process as { noDeprecation?: unknown }).noDeprecation = false;
        fn();
        assert.strictEqual(calls.length, 1, 'once-flag was spent by the suppressed call');
        fn();
        assert.strictEqual(calls.length, 1, 'warned more than once');
    } finally {
        (process as { emitWarning: unknown }).emitWarning = originalEmit;
        (process as { noDeprecation?: unknown }).noDeprecation = savedFlag;
    }
});

test('util.deprecate: wrapper identity matches Node', () => {
    const wrapped = util.deprecate(function original(_a: number, _b: number) { return 1; }, 'M');
    assert.strictEqual(wrapped.name, 'deprecated');
    assert.strictEqual(wrapped.length, 2);
});

test('console.table renders a Map and a Set by iteration', () => {
    // Both own no enumerable properties, so the generic path produced an EMPTY table.
    const lines: string[] = [];
    const fake = collectingStream(lines);
    const con = new console.Console(fake, fake);

    con.table(new Map([['k1', 'v1'], ['k2', 'v2']]));
    const mapOut = lines.join('');
    assert.ok(mapOut.includes('(iteration index)'), mapOut);
    assert.ok(mapOut.includes('Key'), mapOut);
    assert.ok(mapOut.includes('Values'), mapOut);
    assert.ok(mapOut.includes("'k1'") && mapOut.includes("'v1'"), mapOut);
    assert.ok(mapOut.includes("'k2'") && mapOut.includes("'v2'"), mapOut);

    lines.length = 0;
    con.table(new Set([1, 2]));
    const setOut = lines.join('');
    assert.ok(setOut.includes('(iteration index)'), setOut);
    assert.ok(setOut.includes('Values'), setOut);
    assert.ok(!setOut.includes('Key'), setOut);
    assert.ok(setOut.includes('1') && setOut.includes('2'), setOut);

    // The ordinary array-of-objects table must still use the (index) header.
    lines.length = 0;
    con.table([{ a: 1, b: 2 }]);
    const objOut = lines.join('');
    assert.ok(objOut.includes('(index)'), objOut);
    assert.ok(!objOut.includes('(iteration index)'), objOut);
    assert.ok(objOut.includes('│ a │'), objOut);
});

test('console.table rejects a non-array properties argument like Node', () => {
    const fake = collectingStream([]);
    const con = new console.Console(fake, fake);
    try {
        (con.table as (d: unknown, c: unknown) => void)([{ a: 1 }], 'a');
        assert.fail('expected a throw');
    } catch (err) {
        const e = err as Error & { code?: string };
        assert.strictEqual(e.code, 'ERR_INVALID_ARG_TYPE');
        assert.strictEqual(
            e.message,
            'The "properties" argument must be an instance of Array. Received type string (\'a\')',
        );
    }
    // A real array is still accepted.
    (con.table as (d: unknown, c: unknown) => void)([{ a: 1 }], ['a']);
});
