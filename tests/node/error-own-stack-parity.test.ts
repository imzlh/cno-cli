/**
 * Error `stack` shape and content parity.
 *
 * Every expectation here was measured against real Node v24.18.0. Two engine
 * defects motivated the file:
 *
 *  1. QuickJS exposes `stack` only as a CGETSET accessor on `Error.prototype`
 *     (quickjs.c `js_error_proto_funcs`), storing the frames in the instance's
 *     internal `[[ErrorData]]` slot. V8 gives every error an *own* `stack`, so
 *     own-property walks, `util.inspect(showHidden)` and anything enumerating
 *     error properties diverged.
 *  2. `cno/src/webapi/basic.ts` wrapped only the `Error` global, so every other
 *     native error class kept the engine's headerless frames. `new TypeError('m')`
 *     had a `.stack` starting `    at …` with no `TypeError: m` line, and
 *     `util.inspect` rendered `[    at <anonymous> (…)]` instead of `TypeError: m`.
 *     That was the largest single inspect-parity gap (76 of 105 fuzz failures).
 *
 * The header must be synthesised lazily. Real Node does not re-header a stack the
 * user assigned, nor one an `Error.prepareStackTrace` hook returned; an eager
 * implementation was tried and had to be reverted. Both directions are pinned
 * below so the next attempt cannot regress one to fix the other.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import util from 'node:util';

/** Every native error class that must behave identically. */
const ERROR_CLASSES: Array<[string, new (m?: string) => Error]> = [
    ['Error', Error],
    ['TypeError', TypeError],
    ['RangeError', RangeError],
    ['SyntaxError', SyntaxError],
    ['ReferenceError', ReferenceError],
    ['EvalError', EvalError],
    ['URIError', URIError],
];

function ownStackDescriptor(e: object): PropertyDescriptor | undefined {
    return Object.getOwnPropertyDescriptor(e, 'stack');
}

function firstLine(s: unknown): string {
    return String(s).split('\n')[0];
}

test('error stack: every native class instance has an own accessor `stack`', () => {
    for (const [name, Ctor] of ERROR_CLASSES) {
        const e = new Ctor('m');
        assert.ok(
            Object.prototype.hasOwnProperty.call(e, 'stack'),
            `${name}: stack must be an OWN property, not inherited from the prototype`,
        );
        assert.ok(
            Object.getOwnPropertyNames(e).includes('stack'),
            `${name}: getOwnPropertyNames must include 'stack'`,
        );
        const d = ownStackDescriptor(e)!;
        assert.strictEqual(typeof d.get, 'function', `${name}: stack must be an accessor`);
        assert.strictEqual(typeof d.set, 'function', `${name}: stack needs a setter to latch assignments`);
        assert.strictEqual(d.enumerable, false, `${name}: stack must be non-enumerable`);
        assert.strictEqual(d.configurable, true, `${name}: stack must be configurable`);
        assert.strictEqual(typeof e.stack, 'string', `${name}: stack must read as a string`);
    }
});

test('error stack: subclass instances have an own `stack` too', () => {
    for (const [name, Ctor] of ERROR_CLASSES) {
        class Sub extends Ctor { }
        const e = new Sub('m');
        assert.ok(
            Object.prototype.hasOwnProperty.call(e, 'stack'),
            `class extends ${name}: subclass instance must have an own stack`,
        );
        const d = ownStackDescriptor(e)!;
        assert.strictEqual(typeof d.get, 'function', `class extends ${name}: own stack must be an accessor`);
    }
});

test('error stack: AggregateError and its subclass have an own `stack`', () => {
    const a = new AggregateError([new Error('inner')], 'agg');
    assert.ok(Object.prototype.hasOwnProperty.call(a, 'stack'), 'AggregateError needs an own stack');
    assert.ok(Object.getOwnPropertyNames(a).includes('errors'), 'AggregateError keeps its errors property');
    class SubAgg extends AggregateError { }
    const s = new SubAgg([], 'agg');
    assert.ok(Object.prototype.hasOwnProperty.call(s, 'stack'), 'AggregateError subclass needs an own stack');
});

test('error stack: `stack` carries a `Name: message` header for every class', () => {
    for (const [name, Ctor] of ERROR_CLASSES) {
        const e = new Ctor('boom');
        assert.strictEqual(
            firstLine(e.stack),
            `${name}: boom`,
            `${name}: stack must start with the header, not a bare frame — QuickJS frames are headerless`,
        );
    }
});

test('error stack: a subclass header uses the inherited name', () => {
    class MyErr extends TypeError { }
    assert.strictEqual(firstLine(new MyErr('boom').stack), 'TypeError: boom');
    class Named extends TypeError {
        constructor(m: string) { super(m); this.name = 'Named'; }
    }
    assert.strictEqual(firstLine(new Named('boom').stack), 'Named: boom');
    // The name-on-the-prototype idiom, common in libraries.
    class ProtoNamed extends RangeError { }
    ProtoNamed.prototype.name = 'ProtoNamed';
    assert.strictEqual(firstLine(new ProtoNamed('boom').stack), 'ProtoNamed: boom');
});

test('error stack: engine-thrown errors carry a header too', () => {
    let te: Error | undefined;
    try { (null as unknown as { x: number }).x; } catch (e) { te = e as Error; }
    assert.ok(te, 'null property access must throw');
    assert.ok(
        firstLine(te!.stack).startsWith('TypeError: '),
        `engine-thrown TypeError must be headered, got ${JSON.stringify(firstLine(te!.stack))}`,
    );
    let re: Error | undefined;
    try { (undefined as unknown as () => void)(); } catch (e) { re = e as Error; }
    assert.ok(firstLine(re!.stack).startsWith('TypeError: '), 'calling a non-function must be headered');
    let se: Error | undefined;
    try { JSON.parse('{'); } catch (e) { se = e as Error; }
    assert.ok(firstLine(se!.stack).startsWith('SyntaxError: '), 'JSON.parse failure must be headered');
});

test('error stack: header renders through util.inspect for every class', () => {
    for (const [name, Ctor] of ERROR_CLASSES) {
        const out = util.inspect(new Ctor('boom'));
        assert.strictEqual(
            firstLine(out),
            `${name}: boom`,
            `${name}: inspect must render the header; a leading "[    at …" means the stack was headerless`,
        );
    }
    // A bracket wrap means inspect found no frames at all after the message.
    const inspected = util.inspect(new TypeError('boom'));
    assert.ok(!inspected.startsWith('['), 'a headered error with frames must not be bracket-wrapped');
});

test('error stack: `.stack` has no trailing newline', () => {
    for (const [name, Ctor] of ERROR_CLASSES) {
        const s = new Ctor('m').stack!;
        assert.ok(!/\n$/.test(s), `${name}: Node's stack never ends in a newline; QuickJS frames do`);
    }
});

test('error stack: an assigned stack is latched verbatim, never re-headered', () => {
    for (const [name, Ctor] of ERROR_CLASSES) {
        const e = new Ctor('m');
        e.stack = 'CUSTOM_VERBATIM';
        assert.strictEqual(e.stack, 'CUSTOM_VERBATIM', `${name}: assignment must win`);
        // Renaming must not resurrect a synthesised header over the assigned value.
        e.name = 'Renamed';
        assert.strictEqual(e.stack, 'CUSTOM_VERBATIM', `${name}: a rename must not re-header an assigned stack`);
    }
});

test('error stack: a subclass assigning this.stack in its constructor wins', () => {
    class A extends Error {
        constructor(m: string) { super(m); this.stack = 'SUB_CUSTOM'; }
    }
    assert.strictEqual(new A('m').stack, 'SUB_CUSTOM');
    class B extends TypeError {
        constructor(m: string) { super(m); this.stack = 'SUB_CUSTOM_2'; }
    }
    assert.strictEqual(new B('m').stack, 'SUB_CUSTOM_2');
});

test('error stack: assigning a non-string is accepted, not rejected', () => {
    // QuickJS's native setter threw "Error.prototype.stack setter expects a
    // string"; V8 latches any value.
    for (const [name, Ctor] of ERROR_CLASSES) {
        const e = new Ctor('m');
        e.stack = 12345 as unknown as string;
        assert.strictEqual(e.stack, 12345 as unknown as string, `${name}: a numeric stack must latch`);
    }
});

test('error stack: assigning a stack does not make it enumerable', () => {
    // The native setter used JS_PROP_C_W_E, which leaked the stack into
    // JSON.stringify(err) and Object.keys(err) for the unwrapped classes.
    for (const [name, Ctor] of ERROR_CLASSES) {
        const e = new Ctor('m');
        e.stack = 'S';
        assert.deepStrictEqual(Object.keys(e), [], `${name}: stack must stay non-enumerable after assignment`);
        assert.strictEqual(JSON.stringify(e), '{}', `${name}: an assigned stack must not serialise`);
    }
    // Same for an engine-thrown error, which has no own accessor to shadow it.
    let te: Error | undefined;
    try { (null as unknown as { x: number }).x; } catch (e) { te = e as Error; }
    te!.stack = 'S';
    assert.deepStrictEqual(Object.keys(te!), [], 'engine-thrown: stack must stay non-enumerable');
    assert.strictEqual(JSON.stringify(te!), '{}', 'engine-thrown: an assigned stack must not serialise');
});

test('error stack: the header is formatted once, on first read', () => {
    // V8 formats lazily then caches: renaming before the first read changes the
    // header, renaming after it does not.
    const before = new TypeError('m');
    before.name = 'Renamed';
    assert.strictEqual(firstLine(before.stack), 'Renamed: m', 'rename-then-read must use the new name');

    const after = new TypeError('m');
    void after.stack;
    after.name = 'Renamed';
    assert.strictEqual(firstLine(after.stack), 'TypeError: m', 'read-then-rename must keep the formatted header');

    const msg = new TypeError('m');
    void msg.stack;
    msg.message = 'CHANGED';
    assert.strictEqual(firstLine(msg.stack), 'TypeError: m', 'read-then-mutate-message must keep the header');
});

test('error stack: empty name or message degrade like Node', () => {
    assert.strictEqual(firstLine(new TypeError('').stack), 'TypeError', 'empty message drops the colon');
    const noName = new TypeError('m');
    noName.name = '' as string;
    assert.strictEqual(firstLine(noName.stack), 'm', 'empty name leaves just the message');
    const undefName = new TypeError('m');
    (noName as { name?: unknown }).name = undefined;
    undefName.name = undefined as unknown as string;
    assert.strictEqual(firstLine(undefName.stack), 'Error: m', 'an undefined name falls back to Error');
});

test('error stack: stackTraceLimit 0 leaves a bare header', () => {
    const prev = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
        assert.strictEqual(new Error('m').stack, 'Error: m');
        assert.strictEqual(new TypeError('m').stack, 'TypeError: m');
    } finally {
        Error.stackTraceLimit = prev;
    }
});

test('error stack: a frozen error still reports a headered stack', () => {
    const e = Object.freeze(new TypeError('m'));
    assert.strictEqual(firstLine(e.stack), 'TypeError: m', 'freezing must not lose the header');
});

test('error stack: captureStackTrace synthesises a header on a plain object', () => {
    const bare = {};
    Error.captureStackTrace(bare);
    assert.strictEqual(firstLine((bare as { stack?: string }).stack), 'Error', 'a bare target reads as Error');
    assert.ok(
        Object.prototype.hasOwnProperty.call(bare, 'stack'),
        'captureStackTrace must install an own stack',
    );

    const named = { name: 'N', message: 'M' };
    Error.captureStackTrace(named);
    assert.strictEqual(firstLine((named as { stack?: string }).stack), 'N: M', 'name/message drive the header');
    assert.ok(
        String((named as { stack?: string }).stack).includes('\n    at '),
        'captureStackTrace must keep the frames below the header',
    );
});

test('error stack: prepareStackTrace return value is used verbatim', () => {
    // The hook's return value IS the stack. Synthesising a header over it produced
    // 'Error: m\nSENTINEL'. Pinned for every class, since only Error was wrapped
    // before and the bug was invisible on the others.
    const saved = Error.prepareStackTrace;
    Error.prepareStackTrace = () => 'SENTINEL';
    try {
        for (const [name, Ctor] of ERROR_CLASSES) {
            assert.strictEqual(
                new Ctor('m').stack,
                'SENTINEL',
                `${name}: a prepareStackTrace result must not be re-headered`,
            );
        }
    } finally {
        Error.prepareStackTrace = saved;
    }
});

test('error stack: prepareStackTrace may return a non-string', () => {
    const saved = Error.prepareStackTrace;
    const sentinel = { marker: 'not-a-string' };
    Error.prepareStackTrace = () => sentinel as unknown as string;
    try {
        assert.strictEqual(new Error('m').stack as unknown, sentinel, 'Error: object result must pass through');
        assert.strictEqual(new TypeError('m').stack as unknown, sentinel, 'TypeError: object result must pass through');
        Error.prepareStackTrace = (_e, sites) => sites as unknown as string;
        assert.ok(Array.isArray(new TypeError('m').stack as unknown), 'a CallSite array must survive as an array');
    } finally {
        Error.prepareStackTrace = saved;
    }
});

test('error stack: no Error-proxy frames leak into the CallSite array', () => {
    // The `Error` global is a Proxy; its construct/apply traps add frames named
    // "construct"/"apply". stripInternalErrorProxyFrames only cleans the string
    // form, so these survived as sites[0..1] — exactly where a CallSite-consuming
    // library looks for the throw site. Wrapping all ten classes would otherwise
    // spread a leak that previously only affected `Error`.
    type CallSite = { getFunctionName(): string | null; getFileName(): string | null };
    const saved = Error.prepareStackTrace;
    const seen: Record<string, CallSite[]> = {};
    Error.prepareStackTrace = (_e, sites) => { seen.last = sites as unknown as CallSite[]; return 'X'; };
    try {
        for (const [name, Ctor] of ERROR_CLASSES) {
            void new Ctor('m').stack;
            const sites = seen.last;
            assert.ok(Array.isArray(sites), `${name}: the hook must receive a CallSite array`);
            const bogus = sites.filter((cs) => {
                const fn = cs.getFunctionName();
                const file = cs.getFileName();
                return (fn === 'construct' || fn === 'apply') && (file === null || file === '<core>');
            });
            assert.strictEqual(
                bogus.length,
                0,
                `${name}: Error-proxy frames leaked into the CallSite array: ` +
                bogus.map((c) => `${c.getFunctionName()}@${c.getFileName()}`).join(', '),
            );
        }
        // Error() without `new` goes through the apply trap.
        void (Error('m') as Error).stack;
        const applySites = seen.last;
        assert.strictEqual(
            applySites.filter((cs) => cs.getFunctionName() === 'apply' && cs.getFileName() === null).length,
            0,
            'the apply trap must not leak a frame either',
        );
    } finally {
        Error.prepareStackTrace = saved;
    }
});

test('error stack: prepareStackTrace reports the user function, not a wrapper', () => {
    const saved = Error.prepareStackTrace;
    const hook = () => 'X';
    Error.prepareStackTrace = hook;
    try {
        assert.strictEqual(Error.prepareStackTrace, hook, 'the getter must report the assigned function');
    } finally {
        Error.prepareStackTrace = saved;
    }
    assert.strictEqual(Error.prepareStackTrace, saved, 'restoring must round-trip');
});

test('error stack: native class identity survives the wrapping', () => {
    for (const [name, Ctor] of ERROR_CLASSES) {
        assert.strictEqual((Ctor as { name: string }).name, name, `${name}: .name must be preserved`);
        assert.ok(new Ctor('m') instanceof Ctor, `${name}: instanceof itself`);
        assert.ok(new Ctor('m') instanceof Error, `${name}: instanceof Error`);
        assert.strictEqual(
            Ctor.prototype.constructor as unknown,
            Ctor as unknown,
            `${name}: prototype.constructor must name the global, or err.constructor === ${name} fails`,
        );
        if (name !== 'Error') {
            assert.strictEqual(
                Object.getPrototypeOf(Ctor) as unknown,
                Error as unknown,
                `${name}: must inherit from Error, as it does in Node`,
            );
        }
        class Sub extends Ctor { }
        const s = new Sub('m');
        assert.ok(s instanceof Sub && s instanceof Ctor && s instanceof Error, `${name}: subclass chain intact`);
        assert.strictEqual(Object.getPrototypeOf(s), Sub.prototype, `${name}: subclass prototype preserved`);
    }
    assert.strictEqual(
        Object.prototype.toString.call(new TypeError('m')),
        '[object Error]',
        'the internal class must stay Error',
    );
    assert.strictEqual(new TypeError('m').toString(), 'TypeError: m');
});

test('error stack: captureStackTrace is shared across the class statics', () => {
    assert.strictEqual(
        TypeError.captureStackTrace as unknown,
        Error.captureStackTrace as unknown,
        'TypeError inherits Error.captureStackTrace',
    );
    // Inherited through the prototype chain, so it must be the patched one that
    // installs an own accessor rather than the raw native data property.
    const o = {};
    (TypeError as unknown as { captureStackTrace(t: object): void }).captureStackTrace(o);
    const d = ownStackDescriptor(o);
    assert.ok(d, 'TypeError.captureStackTrace must install a stack');
    assert.strictEqual(typeof d!.get, 'function', 'it must be an accessor, matching Error.captureStackTrace');
});

test('error stack: structuredClone preserves a headered stack', () => {
    for (const [name, Ctor] of ERROR_CLASSES) {
        const clone = structuredClone(new Ctor('m')) as Error;
        assert.strictEqual(typeof clone.stack, 'string', `${name}: a cloned stack must be a string`);
        assert.ok(
            !firstLine(clone.stack).trimStart().startsWith('at '),
            `${name}: a cloned stack must keep its header, not start at a bare frame`,
        );
    }
});

test('error stack: inspect(showHidden) lists stack and message', () => {
    const e = new TypeError('m');
    e.stack = 'TypeError: m\n    at F';
    assert.strictEqual(
        util.inspect(e, { showHidden: true }),
        "TypeError: m\n    at F {\n  [stack]: [Getter/Setter],\n  [message]: 'm'\n}",
    );
});

test('error stack: extra own properties still render after the frames', () => {
    const e = new TypeError('m');
    (e as { code?: string }).code = 'ECODE';
    const out = util.inspect(e);
    assert.ok(firstLine(out) === 'TypeError: m', 'header first');
    assert.ok(out.includes("code: 'ECODE'"), 'extra own properties must still be listed');
});
