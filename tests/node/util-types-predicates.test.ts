/**
 * Regression tests for util.types predicates that were missing or that threw.
 * Expectations captured from real `node` v24.
 */
import { strictEqual, deepStrictEqual } from 'node:assert';
import { types } from 'node:util';

Deno.test('util.types: isBigIntObject exists and distinguishes boxed BigInt', () => {
    strictEqual(typeof types.isBigIntObject, 'function', 'isBigIntObject must exist');
    strictEqual(types.isBigIntObject(Object(1n)), true);
    strictEqual(types.isBigIntObject(1n), false, 'a primitive BigInt is not a BigInt object');
    strictEqual(types.isBigIntObject(new Number(1)), false);
    strictEqual(types.isBigIntObject(new String('a')), false);
    strictEqual(types.isBigIntObject({}), false);
    strictEqual(types.isBigIntObject(null), false);
    // It must agree with isBoxedPrimitive on a boxed BigInt.
    strictEqual(types.isBoxedPrimitive(Object(1n)), true);
});

Deno.test('util.types: isExternal exists and is false for JS-reachable values', () => {
    strictEqual(typeof types.isExternal, 'function', 'isExternal must exist');
    for (const v of [{}, [], 1, 'a', null, undefined, new ArrayBuffer(1), () => {}]) {
        strictEqual(types.isExternal(v), false);
    }
});

Deno.test('util.types: isFloat16Array exists', () => {
    strictEqual(typeof types.isFloat16Array, 'function', 'isFloat16Array must exist');
    strictEqual(types.isFloat16Array(new Float32Array(1)), false);
    strictEqual(types.isFloat16Array(new Float64Array(1)), false);
    strictEqual(types.isFloat16Array({}), false);
    // Only assert the positive case where the engine actually has Float16Array.
    const F16 = (globalThis as Record<string, unknown>).Float16Array as
        (new (n: number) => object) | undefined;
    if (typeof F16 === 'function') strictEqual(types.isFloat16Array(new F16(1)), true);
});

Deno.test('util.types: no predicate throws on a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const threw: string[] = [];
    let sawTrue = 0;
    for (const [name, fn] of Object.entries(types)) {
        if (typeof fn !== 'function') continue;
        try {
            if ((fn as (v: unknown) => unknown)(proxy) === true) sawTrue++;
        } catch (err) {
            threw.push(`${name}: ${(err as Error).name}`);
        }
    }
    deepStrictEqual(threw, [], 'a type predicate must answer, not throw');
    // Sanity: the value really is a revoked proxy, so isProxy still reports it.
    strictEqual(types.isProxy(proxy), true);
    strictEqual(sawTrue >= 1, true);
});

Deno.test('util.types: predicates answer for a live proxy without unwrapping', () => {
    // Node's predicates read internal slots, so a proxy is not its target.
    strictEqual(types.isDate(new Proxy(new Date(0), {})), false);
    strictEqual(types.isMap(new Proxy(new Map(), {})), false);
    strictEqual(types.isRegExp(new Proxy(/a/, {})), false);
    strictEqual(types.isProxy(new Proxy({}, {})), true);
});
