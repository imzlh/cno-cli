import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { bunSemver, order, satisfies } from '../../cno/src/bun/semver/index.ts';

// Expected results were checked against Bun 1.4.4's Bun.semver.
Deno.test('bun: semver orders versions and prerelease identifiers', () => {
    const cases: [string, string, number][] = [
        ['1.2.3', '1.2.4', -1],
        ['1.2.3-alpha.2', '1.2.3-alpha.11', -1],
        ['1.2.3-01', '1.2.3-1', 0],
        ['1.2.3-1', '1.2.3-alpha', -1],
        ['1.2.3-alpha', '1.2.3', -1],
        ['1.2.3-alpha..2', '1.2.3-alpha..10', -1],
        ['v01.002.003+one', '1.2.3+two', 0],
        ['1.2', '1.2.99', 1],
        ['*', '1.2.3', 1],
    ];
    for (const [left, right, expected] of cases) {
        strictEqual(order(left, right), expected, `${left} vs ${right}`);
        strictEqual(order(right, left), -expected || 0, `${right} vs ${left}`);
    }
    throws(() => order('invalid', '1.0.0'), /Invalid SemVer: invalid\n/);
    throws(() => order(Symbol('version'), '1.0.0'), TypeError);
});

Deno.test('bun: semver exposes native-like method shape and coercion order', () => {
    deepStrictEqual(Reflect.ownKeys(bunSemver), ['satisfies', 'order']);
    for (const [name, fn] of [['satisfies', satisfies], ['order', order]] as const) {
        strictEqual(fn.name, name);
        strictEqual(fn.length, 2);
        strictEqual(Object.hasOwn(fn, 'prototype'), false);
        throws(() => Reflect.construct(fn, ['1.0.0', '2.0.0']), TypeError);
        deepStrictEqual(Object.getOwnPropertyDescriptor(bunSemver, name), {
            value: fn,
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }

    const trace: string[] = [];
    const version = new Proxy({}, {
        get(_target, key) {
            trace.push(`version:get:${String(key)}`);
            if (key === Symbol.toPrimitive) return (hint: string) => {
                trace.push(`version:primitive:${hint}`);
                return 'invalid';
            };
        },
    });
    const sentinel = { sentinel: true };
    const range = new Proxy({}, {
        get(_target, key) {
            trace.push(`range:get:${String(key)}`);
            if (key === Symbol.toPrimitive) return () => { throw sentinel; };
        },
    });
    let caught: unknown;
    try {
        satisfies(version, range);
    } catch (error) {
        caught = error;
    }
    strictEqual(caught, sentinel);
    deepStrictEqual(trace, [
        'version:get:Symbol(Symbol.toPrimitive)',
        'version:primitive:string',
        'range:get:Symbol(Symbol.toPrimitive)',
    ]);
});

Deno.test('bun: semver range alternatives distinguish wildcards from empty branches', () => {
    const cases: [string, string, boolean][] = [
        ['2.0.0', '1.2.3 || *', true],
        ['2.0.0', '* || 1.2.3', true],
        ['2.0.0', '1.2.3 ||', false],
        ['2.0.0', '|| 1.2.3', false],
        ['2.0.0', '', true],
        ['1.2.3-a', '1.2.3 || *', false],
        ['1.2.3-a', '1.2.3-a || *', true],
        ['1.2.3-01', '1.2.3-1', false],
        ['1.2.3-01', '1.2.3-1 || *', true],
        ['1.2.3-01', '>=1.2.3-1', true],
        ['1.2.9', '1.2 - 1.3', true],
        ['1.4.0', '1.2 - 1.3', false],
        ['1.2.3-a', '^1.2.3-a', true],
        ['1.3.0-a', '^1.2.3-a', false],
        ['1.2.3-alpha.1', '>1.2.3-alpha <1.2.3', true],
        ['1.2.4-alpha', '>1.2.3-alpha <2', false],
        ['1.2.3-alpha..2', '>1.2.3-alpha..1 <1.2.3', true],
        ['1.3.0', '>1.2', true],
        ['1.2.9', '>1.2', false],
        ['1.5.0', '>=1,<2', true],
        ['2.0.0', '>=1,<2', false],
        ['invalid', '*', false],
        ['1.2.3', 'not a range', true],
        ['1.2.3-a', 'not a range', false],
        ['1.2.3', null as unknown as string, true],
    ];
    for (const [version, range, expected] of cases) {
        strictEqual(satisfies(version, range), expected, `${version} satisfies ${range}`);
    }
    throws(() => satisfies('1.2.3', Symbol('range')), TypeError);
});
