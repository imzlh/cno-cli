// The load-bearing property of node:assert: an assertion given a failing input
// MUST throw. An assertion that returns silently converts a red test to green
// across the whole suite, so this file pins the must-fail behaviour of every
// assertion function, plus the deepStrictEqual discrimination cases that decide
// whether two look-alike values are told apart.
//
// Every expectation below was measured against real Node v24.18.0.
import assert from 'node:assert';
import { strictEqual } from 'node:assert';

/** Asserts that `fn` throws an AssertionError. */
function mustFail(label: string, fn: () => unknown): void {
    let threw = false;
    try {
        fn();
    } catch (error) {
        threw = true;
        if (!(error instanceof assert.AssertionError)) {
            throw new Error(`${label}: expected AssertionError, got ${(error as Error)?.name}`);
        }
    }
    if (!threw) throw new Error(`FAILS-TO-FAIL: ${label} returned silently on a failing input`);
}

/** Asserts that `fn` returns without throwing. */
function mustPass(label: string, fn: () => unknown): void {
    try {
        fn();
    } catch (error) {
        throw new Error(`OVER-STRICT: ${label} threw on a passing input: ${(error as Error)?.message}`);
    }
}

async function mustFailAsync(label: string, fn: () => Promise<unknown>): Promise<void> {
    let threw = false;
    try {
        await fn();
    } catch (error) {
        threw = true;
        if (!(error instanceof assert.AssertionError)) {
            throw new Error(`${label}: expected AssertionError, got ${(error as Error)?.name}`);
        }
    }
    if (!threw) throw new Error(`FAILS-TO-FAIL: ${label} resolved on a failing input`);
}

Deno.test({ name: 'assert: truthiness and equality assertions fail when they must', timeout: 10000 }, () => {
    mustFail('ok(false)', () => assert.ok(false));
    mustFail('ok(0)', () => assert.ok(0));
    mustFail('ok(NaN)', () => assert.ok(NaN));
    mustFail('ok() with no argument', () => (assert.ok as () => void)());
    mustFail('assert(false)', () => assert(false));

    mustFail('equal(1,2)', () => assert.equal(1, 2));
    mustFail('equal({},{})', () => assert.equal({}, {}));
    mustFail('notEqual(1,1)', () => assert.notEqual(1, 1));
    mustFail("notEqual(1,'1')", () => assert.notEqual(1, '1'));

    mustFail("strictEqual(1,'1')", () => assert.strictEqual(1, '1' as unknown as number));
    mustFail('strictEqual({},{})', () => assert.strictEqual({}, {}));
    mustFail('notStrictEqual(1,1)', () => assert.notStrictEqual(1, 1));
    mustFail('notStrictEqual(NaN,NaN)', () => assert.notStrictEqual(NaN, NaN));

    // Node's loose equal deliberately treats NaN as equal to itself, even though
    // NaN != NaN, so this one must NOT fail.
    mustPass('equal(NaN,NaN)', () => assert.equal(NaN, NaN));
    mustPass('strictEqual(NaN,NaN)', () => assert.strictEqual(NaN, NaN));
});

Deno.test({ name: 'assert: 0 and -0 are never conflated', timeout: 10000 }, () => {
    mustFail('strictEqual(0,-0)', () => assert.strictEqual(0, -0));
    mustFail('strictEqual(-0,0)', () => assert.strictEqual(-0, 0));
    mustFail('deepStrictEqual(0,-0)', () => assert.deepStrictEqual(0, -0));
    mustFail('deepStrictEqual({a:0},{a:-0})', () => assert.deepStrictEqual({ a: 0 }, { a: -0 }));
    mustFail('deepStrictEqual([0],[-0])', () => assert.deepStrictEqual([0], [-0]));
    mustFail('notStrictEqual(-0,-0)', () => assert.notStrictEqual(-0, -0));
    mustFail('Float64Array -0 vs 0', () =>
        assert.deepStrictEqual(new Float64Array([-0]), new Float64Array([0])));

    // A -0/0 mismatch must not render as two identical-looking values: the
    // message is the only thing the developer has to go on.
    try {
        assert.strictEqual(0, -0);
        throw new Error('unreachable');
    } catch (error) {
        const message = (error as Error).message;
        if (!message.includes('-0')) {
            throw new Error(`-0 must be visible in the message, got: ${JSON.stringify(message)}`);
        }
    }

    // Set membership uses SameValueZero, so Node reports these as equal.
    mustPass('Set([0]) vs Set([-0])', () => assert.deepStrictEqual(new Set([0]), new Set([-0])));
});

Deno.test({ name: 'assert: deepStrictEqual discriminates look-alike values', timeout: 10000 }, () => {
    // Boxed primitives are never equal to bare ones.
    mustFail('new Number(1) vs 1', () => assert.deepStrictEqual(new Number(1), 1));
    mustFail("new String('a') vs 'a'", () => assert.deepStrictEqual(new String('a'), 'a'));
    mustFail('new Number(1) vs new Number(2)', () =>
        assert.deepStrictEqual(new Number(1), new Number(2)));

    // Same content, different prototype.
    mustFail('{} vs null-prototype', () => assert.deepStrictEqual({}, Object.create(null)));
    mustFail('class instance vs plain object', () => {
        class A { x = 1; }
        assert.deepStrictEqual(new A(), { x: 1 });
    });
    mustFail('Array subclass vs Array', () => {
        class MyArr extends Array {}
        const m = new MyArr();
        m.push(1);
        assert.deepStrictEqual(m, [1]);
    });

    // Typed arrays of different types with identical bytes.
    mustFail('Uint8Array vs Int8Array', () =>
        assert.deepStrictEqual(new Uint8Array([1, 2]), new Int8Array([1, 2])));
    mustFail('Uint8Array vs Uint16Array', () =>
        assert.deepStrictEqual(new Uint8Array([1, 0]), new Uint16Array([1])));
    mustFail('Uint8Array vs DataView', () =>
        assert.deepStrictEqual(new Uint8Array([1]), new DataView(new Uint8Array([1]).buffer)));
    mustFail('ArrayBuffer vs DataView', () => {
        const buf = new Uint8Array([1]).buffer;
        assert.deepStrictEqual(buf, new DataView(buf));
    });
    // Bytes matching is necessary but not sufficient — extra own props count.
    mustFail('typed array with an extra own property', () => {
        const a = new Uint8Array([1]);
        const b = new Uint8Array([1]) as Uint8Array & { tag?: number };
        b.tag = 1;
        assert.deepStrictEqual(a, b);
    });

    // Date vs number, and differing dates.
    mustFail('Date(0) vs 0', () => assert.deepStrictEqual(new Date(0), 0));
    mustFail('Date(0) vs Date(1)', () => assert.deepStrictEqual(new Date(0), new Date(1)));
    mustFail('Date(0) vs Invalid Date', () => assert.deepStrictEqual(new Date(0), new Date(NaN)));

    // RegExp flags, source and lastIndex.
    mustFail('/a/g vs /a/i', () => assert.deepStrictEqual(/a/g, /a/i));
    mustFail('/a/ vs /b/', () => assert.deepStrictEqual(/a/, /b/));
    mustFail('lastIndex differs', () => {
        const r1 = /a/g;
        const r2 = /a/g;
        r2.lastIndex = 3;
        assert.deepStrictEqual(r1, r2);
    });

    // Own symbol keys.
    mustFail('own symbol values differ', () => {
        const s = Symbol('s');
        assert.deepStrictEqual({ [s]: 1 }, { [s]: 2 });
    });
    mustFail('own symbol present vs absent', () => {
        const s = Symbol('s');
        assert.deepStrictEqual({ [s]: 1 }, {});
    });

    // Errors.
    mustFail('Error messages differ', () => assert.deepStrictEqual(new Error('a'), new Error('b')));
    mustFail('TypeError vs RangeError', () =>
        assert.deepStrictEqual(new TypeError('a'), new RangeError('a')));
    mustFail('Error cause differs', () =>
        assert.deepStrictEqual(new Error('x', { cause: 1 }), new Error('x', { cause: 2 })));

    // Types Node can only compare by reference.
    mustFail('two distinct WeakMaps', () => assert.deepStrictEqual(new WeakMap(), new WeakMap()));
    mustFail('two distinct Promises', () =>
        assert.deepStrictEqual(new Promise(() => {}), new Promise(() => {})));
});

Deno.test({ name: 'assert: deepStrictEqual compares array length, not just indices', timeout: 10000 }, () => {
    // `length` is not an enumerable own key, so a walk over Object.keys alone
    // cannot see any of these differences.
    mustFail('new Array(3) vs new Array(4)', () =>
        assert.deepStrictEqual(new Array(3), new Array(4)));
    mustFail('[] vs new Array(1)', () => assert.deepStrictEqual([], new Array(1)));
    mustFail('same items, longer length', () => {
        const b = [1, 2, 3];
        b.length = 5;
        assert.deepStrictEqual([1, 2, 3], b);
    });
    // Sparse vs dense: a hole is not an undefined element.
    mustFail('sparse vs dense', () => {
        const sparse = [1];
        sparse[2] = 3;
        assert.deepStrictEqual(sparse, [1, undefined, 3]);
    });
    mustFail('[1,2] vs [1,2,undefined]', () => assert.deepStrictEqual([1, 2], [1, 2, undefined]));

    mustPass('two identically sparse arrays', () => {
        const a = [1];
        a[2] = 3;
        const b = [1];
        b[2] = 3;
        assert.deepStrictEqual(a, b);
    });
});

Deno.test({ name: 'assert: Map and Set entries are matched as multisets', timeout: 10000 }, () => {
    // The hazard: every left element finds *some* structurally equal right
    // element, but one right element is reused to satisfy two left elements.
    // Node reports these unequal.
    mustFail('Set{ {x:1}, {x:1} } vs Set{ {x:1}, {x:2} }', () =>
        assert.deepStrictEqual(new Set([{ x: 1 }, { x: 1 }]), new Set([{ x: 1 }, { x: 2 }])));
    mustFail('Set 3-element multiset', () =>
        assert.deepStrictEqual(
            new Set([{ x: 1 }, { x: 1 }, { x: 2 }]),
            new Set([{ x: 1 }, { x: 2 }, { x: 2 }]),
        ));
    mustFail('Set of nested arrays', () =>
        assert.deepStrictEqual(new Set([[1], [1]]), new Set([[1], [2]])));
    mustFail('Map duplicate structural keys', () =>
        assert.deepStrictEqual(
            new Map([[{ x: 1 }, 'v'], [{ x: 1 }, 'v']]),
            new Map([[{ x: 1 }, 'v'], [{ x: 2 }, 'v']]),
        ));

    mustFail('Map values differ', () =>
        assert.deepStrictEqual(new Map([['k', 1]]), new Map([['k', 2]])));
    mustFail('Set primitives differ', () =>
        assert.deepStrictEqual(new Set([1, 2]), new Set([1, 3])));

    // Equal-but-not-identical object keys still match.
    mustPass('Map equal-not-identical keys', () =>
        assert.deepStrictEqual(new Map([[{ a: 1 }, 'v']]), new Map([[{ a: 1 }, 'v']])));
    mustPass('Set equal-not-identical members', () =>
        assert.deepStrictEqual(new Set([{ a: 1 }]), new Set([{ a: 1 }])));
    mustPass('Set NaN', () => assert.deepStrictEqual(new Set([NaN]), new Set([NaN])));
});

Deno.test({ name: 'assert: cyclic structures compare by cycle shape, without overflowing', timeout: 10000 }, () => {
    // Back-edges must land at the same depth on both sides. Getting this wrong
    // either reports differently-shaped cycles as equal or recurses until the
    // stack overflows — a RangeError in place of the AssertionError.
    mustFail('a.self=a vs b.self={self:b}', () => {
        const a: Record<string, unknown> = {};
        a.self = a;
        const b: Record<string, unknown> = {};
        b.self = { self: b };
        assert.deepStrictEqual(a, b);
    });
    mustFail('2-cycle vs 4-cycle', () => {
        const a1: Record<string, unknown> = {};
        const a2: Record<string, unknown> = {};
        a1.n = a2;
        a2.n = a1;
        const b1: Record<string, unknown> = {};
        const b2: Record<string, unknown> = {};
        const b3: Record<string, unknown> = {};
        const b4: Record<string, unknown> = {};
        b1.n = b2; b2.n = b3; b3.n = b4; b4.n = b1;
        assert.deepStrictEqual(a1, b1);
    });
    mustFail('cyclic array vs nested array', () => {
        const a: unknown[] = [1];
        a.push(a);
        const b: unknown[] = [1];
        b.push([1, b]);
        assert.deepStrictEqual(a, b);
    });
    mustFail('mutually recursive, differing leaf', () => {
        const a1: Record<string, unknown> = { v: 1 };
        const a2: Record<string, unknown> = { v: 1 };
        a1.p = a2; a2.p = a1;
        const b1: Record<string, unknown> = { v: 1 };
        const b2: Record<string, unknown> = { v: 2 };
        b1.p = b2; b2.p = b1;
        assert.deepStrictEqual(a1, b1);
    });

    mustPass('identical self-cycles', () => {
        const a: Record<string, unknown> = {};
        a.self = a;
        const b: Record<string, unknown> = {};
        b.self = b;
        assert.deepStrictEqual(a, b);
    });
    mustPass('two 2-cycles', () => {
        const a1: Record<string, unknown> = {};
        const a2: Record<string, unknown> = {};
        a1.n = a2; a2.n = a1;
        const b1: Record<string, unknown> = {};
        const b2: Record<string, unknown> = {};
        b1.n = b2; b2.n = b1;
        assert.deepStrictEqual(a1, b1);
    });
    // Node is not reference-topology sensitive for acyclic values: a shared
    // reference on one side is still equal to two distinct equal objects.
    mustPass('shared reference vs distinct equals', () => {
        const shared = { x: 1 };
        assert.deepStrictEqual([shared, shared], [{ x: 1 }, { x: 1 }]);
    });
});

Deno.test({ name: 'assert: deepStrictEqual ignores what Node ignores', timeout: 10000 }, () => {
    // Non-enumerable properties never make two objects unequal.
    mustPass('non-enumerable present vs absent', () => {
        const a = {};
        Object.defineProperty(a, 'hidden', { value: 1, enumerable: false });
        assert.deepStrictEqual(a, {});
    });
    mustPass('non-enumerable values differ', () => {
        const a = {};
        Object.defineProperty(a, 'h', { value: 1, enumerable: false });
        const b = {};
        Object.defineProperty(b, 'h', { value: 2, enumerable: false });
        assert.deepStrictEqual(a, b);
    });
    // Property order is not significant.
    mustPass('property order differs', () => assert.deepStrictEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
    mustFail('notDeepStrictEqual on order-only difference', () =>
        assert.notDeepStrictEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));

    // NaN is equal to itself under deepStrictEqual.
    mustPass('NaN vs NaN', () => assert.deepStrictEqual(NaN, NaN));
    mustPass('{a:NaN} vs {a:NaN}', () => assert.deepStrictEqual({ a: NaN }, { a: NaN }));
    mustFail('notDeepStrictEqual(NaN,NaN)', () => assert.notDeepStrictEqual(NaN, NaN));
    mustPass('Float64Array NaN', () =>
        assert.deepStrictEqual(new Float64Array([NaN]), new Float64Array([NaN])));

    // Two Invalid Dates are equal (getTime() is NaN on both).
    mustPass('two Invalid Dates', () => assert.deepStrictEqual(new Date(NaN), new Date(NaN)));
});

Deno.test({ name: 'assert: throw-family and remaining assertions fail when they must', timeout: 10000 }, () => {
    mustFail('deepEqual values differ', () => assert.deepEqual({ a: 1 }, { a: 2 }));
    mustFail('deepEqual [] vs {}', () => assert.deepEqual([], {}));
    mustFail('notDeepEqual on equal values', () => assert.notDeepEqual({ a: 1 }, { a: 1 }));

    mustFail('throws() when nothing throws', () => assert.throws(() => {}));
    mustFail('throws() wrong constructor', () =>
        assert.throws(() => { throw new TypeError('x'); }, RangeError));
    mustFail('throws() regex does not match', () =>
        assert.throws(() => { throw new Error('boom'); }, /nope/));
    mustFail('throws() predicate returns false', () =>
        assert.throws(() => { throw new Error('b'); }, () => false));
    // A predicate must return exactly true; undefined is a failure.
    mustFail('throws() predicate returns undefined', () =>
        assert.throws(() => { throw new Error('b'); }, (() => undefined) as unknown as () => boolean));

    mustFail('doesNotThrow() when it throws', () =>
        assert.doesNotThrow(() => { throw new Error('boom'); }));

    mustFail('match() does not match', () => assert.match('abc', /xyz/));
    mustFail('doesNotMatch() matches', () => assert.doesNotMatch('abc', /b/));

    mustFail('ifError(Error)', () => assert.ifError(new Error('x')));
    mustFail('ifError(1)', () => assert.ifError(1));
    mustFail('ifError(false)', () => assert.ifError(false));
    mustFail('ifError(0)', () => assert.ifError(0));
    mustFail('ifError(NaN)', () => assert.ifError(NaN));
    mustPass('ifError(null)', () => assert.ifError(null));
    mustPass('ifError(undefined)', () => assert.ifError(undefined));

    mustFail('fail()', () => assert.fail());
    mustFail("fail('msg')", () => assert.fail('msg'));

    // The strict namespace must use the strict comparisons.
    mustFail("strict.equal(1,'1')", () => assert.strict.equal(1, '1'));
    mustFail("strict.deepEqual({a:1},{a:'1'})", () =>
        assert.strict.deepEqual({ a: 1 }, { a: '1' }));
    mustFail('strict(false)', () => assert.strict(false));
    mustFail('strict.strict.ok(false)', () => assert.strict.strict.ok(false));

    mustFail('partialDeepStrictEqual missing key', () =>
        assert.partialDeepStrictEqual({ a: 1 }, { b: 2 }));
    mustPass('partialDeepStrictEqual subset', () =>
        assert.partialDeepStrictEqual({ a: 1, b: 2 }, { a: 1 }));
});

Deno.test({ name: 'assert: rejects and doesNotReject fail when they must', timeout: 10000 }, async () => {
    await mustFailAsync('rejects() on a resolved promise', () => assert.rejects(Promise.resolve(1)));
    await mustFailAsync('rejects() on a non-throwing async fn', () =>
        assert.rejects(async () => {}, TypeError));
    await mustFailAsync('rejects() wrong constructor', () =>
        assert.rejects(Promise.reject(new TypeError('x')), RangeError));
    await mustFailAsync('rejects() regex does not match', () =>
        assert.rejects(Promise.reject(new Error('boom')), /nope/));
    await mustFailAsync('doesNotReject() on a rejected promise', () =>
        assert.doesNotReject(Promise.reject(new Error('x'))));

    // These must not throw.
    await assert.rejects(Promise.reject(new TypeError('x')), TypeError);
    await assert.doesNotReject(Promise.resolve(1));
});

Deno.test({ name: 'assert: CallTracker requires an exact call count', timeout: 10000 }, () => {
    // Node fails verify() when the wrapper is called *more* often than declared,
    // not only when it is called too few times.
    mustFail('called twice when one call was declared', () => {
        const tracker = new assert.CallTracker();
        const wrapped = tracker.calls(() => {}, 1);
        wrapped();
        wrapped();
        tracker.verify();
    });
    mustFail('called once when two were declared', () => {
        const tracker = new assert.CallTracker();
        const wrapped = tracker.calls(() => {}, 2);
        wrapped();
        tracker.verify();
    });
    mustFail('never called', () => {
        const tracker = new assert.CallTracker();
        tracker.calls(() => {}, 1);
        tracker.verify();
    });
    mustPass('called exactly twice', () => {
        const tracker = new assert.CallTracker();
        const wrapped = tracker.calls(() => {}, 2);
        wrapped();
        wrapped();
        tracker.verify();
    });

    // report() lists the mismatches without throwing.
    const tracker = new assert.CallTracker();
    tracker.calls(function named() {}, 2);
    const report = tracker.report();
    strictEqual(report.length, 1);
    strictEqual(report[0].actual, 0);
    strictEqual(report[0].expected, 2);
    strictEqual(report[0].message,
        'Expected the named function to be executed 2 time(s) but was executed 0 time(s).');
    // An anonymous callback is reported as 'calls', which is Node's fallback.
    const anon = new assert.CallTracker();
    anon.calls(2);
    strictEqual(anon.report()[0].operator, 'calls');
});

Deno.test({ name: 'assert: CallTracker.getCalls records real receivers and arguments', timeout: 10000 }, () => {
    const tracker = new assert.CallTracker();
    function named(a: unknown, b: unknown) { return a ?? b; }
    const wrapped = tracker.calls(named, 2);

    wrapped(1, 'x');
    wrapped.call({ ctx: 1 }, 2, { deep: true });

    const calls = tracker.getCalls(wrapped);
    strictEqual(calls.length, 2);
    // Placeholder entries would still have the right length, so the arguments
    // themselves are what matters here.
    assert.deepStrictEqual(calls[0].arguments, [1, 'x']);
    strictEqual(calls[0].thisArg, undefined);
    assert.deepStrictEqual(calls[1].arguments, [2, { deep: true }]);
    assert.deepStrictEqual(calls[1].thisArg, { ctx: 1 });

    // Node freezes the array, each entry, and each arguments list.
    strictEqual(Object.isFrozen(calls), true);
    strictEqual(Object.isFrozen(calls[0]), true);
    strictEqual(Object.isFrozen(calls[0].arguments), true);

    // The wrapper keeps the original's name and arity and gains no own props.
    strictEqual(wrapped.name, 'named');
    strictEqual(wrapped.length, 2);
    assert.deepStrictEqual(Object.keys(wrapped), []);

    // An untracked function is a TypeError, not an empty array.
    try {
        tracker.getCalls(() => {});
        throw new Error('expected getCalls to reject an untracked function');
    } catch (error) {
        const e = error as Error & { code?: string };
        strictEqual(e instanceof TypeError, true);
        strictEqual(e.code, 'ERR_INVALID_ARG_VALUE');
    }

    // reset(fn) clears only that function's records.
    tracker.reset(wrapped);
    strictEqual(tracker.getCalls(wrapped).length, 0);
});

Deno.test({ name: 'assert: an Error passed as the message is thrown unchanged', timeout: 10000 }, () => {
    // Node throws the caller's Error instance rather than wrapping it, so
    // `catch (e) { e instanceof MyError }` keeps working.
    class MyError extends Error {}
    const sentinel = new MyError('sentinel');

    for (const [label, fn] of [
        ['ok', () => assert.ok(false, sentinel)],
        ['equal', () => assert.equal(1, 2, sentinel)],
        ['strictEqual', () => assert.strictEqual(1, 2, sentinel)],
        ['deepStrictEqual', () => assert.deepStrictEqual({ a: 1 }, { a: 2 }, sentinel)],
        ['match', () => assert.match('abc', /x/, sentinel)],
        ['fail', () => assert.fail(sentinel)],
    ] as [string, () => unknown][]) {
        try {
            fn();
            throw new Error(`${label}: expected a throw`);
        } catch (error) {
            if (error !== sentinel) {
                throw new Error(`${label}: expected the exact Error instance, got ${(error as Error)?.name}: ${(error as Error)?.message}`);
            }
        }
    }
});

Deno.test({ name: 'assert: failed deepStrictEqual prints a structured diff', timeout: 10000 }, () => {
    // The diff block is what a developer reads to locate the difference, so its
    // shape is worth pinning. Every expected string was measured on Node v24.18.0.
    const messageOf = (fn: () => unknown): string => {
        try {
            fn();
        } catch (error) {
            return (error as Error).message;
        }
        throw new Error('expected the assertion to throw');
    };

    strictEqual(
        messageOf(() => assert.deepStrictEqual({ a: 1, b: 2 }, { a: 1, b: 3 })),
        'Expected values to be strictly deep-equal:\n'
        + '+ actual - expected\n'
        + '\n'
        + '  {\n'
        + '    a: 1,\n'
        + '+   b: 2\n'
        + '-   b: 3\n'
        + '  }\n',
    );

    // A key present on only one side is marked without a paired line.
    strictEqual(
        messageOf(() => assert.deepStrictEqual({ a: 1 }, { a: 1, b: 2 })),
        'Expected values to be strictly deep-equal:\n'
        + '+ actual - expected\n'
        + '\n'
        + '  {\n'
        + '    a: 1,\n'
        + '-   b: 2\n'
        + '  }\n',
    );

    // Nesting is expanded one property per line, so the diff points at the leaf.
    strictEqual(
        messageOf(() => assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7], [1, 2, 3, 9, 5, 6, 7])),
        'Expected values to be strictly deep-equal:\n'
        + '+ actual - expected\n'
        + '\n'
        + '  [\n'
        + '    1,\n'
        + '    2,\n'
        + '    3,\n'
        + '+   4,\n'
        + '-   9,\n'
        + '    5,\n'
        + '    6,\n'
        + '    7\n'
        + '  ]\n',
    );

    // Short primitives use the terse form rather than a diff block.
    strictEqual(
        messageOf(() => assert.deepStrictEqual(1, 2)),
        'Expected values to be strictly deep-equal:\n\n1 !== 2\n',
    );

    // Typed arrays and Maps keep their constructor prefix.
    strictEqual(
        messageOf(() => assert.deepStrictEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))),
        'Expected values to be strictly deep-equal:\n'
        + '+ actual - expected\n'
        + '\n'
        + '  Uint8Array(2) [\n'
        + '    1,\n'
        + '+   2\n'
        + '-   3\n'
        + '  ]\n',
    );

    // strictEqual on two structurally equal objects says so explicitly.
    strictEqual(
        messageOf(() => assert.strictEqual({ a: 1 }, { a: 1 })),
        'Values have same structure but are not reference-equal:\n\n{\n  a: 1\n}\n',
    );

    // notDeepStrictEqual shows the single offending value, not a diff.
    strictEqual(
        messageOf(() => assert.notDeepStrictEqual({ a: 1 }, { a: 1 })),
        'Expected "actual" not to be strictly deep-equal to:\n\n{\n  a: 1\n}\n',
    );
});

Deno.test({ name: 'assert: bad arguments raise TypeErrors, not AssertionErrors', timeout: 10000 }, () => {
    // Measured on Node v24.18.0: a missing operand or a non-function/non-RegExp
    // argument is a TypeError with a code, which callers branch on.
    const expectType = (label: string, code: string, fn: () => unknown): void => {
        try {
            fn();
        } catch (error) {
            const e = error as Error & { code?: string };
            if (!(e instanceof TypeError)) throw new Error(`${label}: expected TypeError, got ${e?.name}`);
            if (e.code !== code) throw new Error(`${label}: expected code ${code}, got ${e.code}`);
            return;
        }
        throw new Error(`${label}: expected a throw`);
    };

    expectType('equal with one argument', 'ERR_MISSING_ARGS',
        () => (assert.equal as (a: unknown) => void)(1));
    expectType('deepStrictEqual with one argument', 'ERR_MISSING_ARGS',
        () => (assert.deepStrictEqual as (a: unknown) => void)(1));
    expectType('match with a non-RegExp', 'ERR_INVALID_ARG_TYPE',
        () => assert.match('abc', 'abc' as unknown as RegExp));
    expectType('doesNotMatch with a non-RegExp', 'ERR_INVALID_ARG_TYPE',
        () => assert.doesNotMatch('abc', 'abc' as unknown as RegExp));
    expectType('throws with a non-function', 'ERR_INVALID_ARG_TYPE',
        () => assert.throws(123 as unknown as () => void));
    expectType('doesNotThrow with a non-function', 'ERR_INVALID_ARG_TYPE',
        () => assert.doesNotThrow(123 as unknown as () => void));

    // A non-string `string` argument to match() stays an AssertionError.
    mustFail('match with a non-string', () => assert.match(123 as unknown as string, /1/));
});
