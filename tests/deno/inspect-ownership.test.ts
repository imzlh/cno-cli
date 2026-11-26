import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';

const nativeConsole = import.meta.use('console');
const engine = import.meta.use('engine');
const customInspect = Symbol.for('Deno.customInspect');

type InspectOptions = Deno.InspectOptions & { customInspect?: boolean };
type Inspector = (value: unknown, options?: InspectOptions) => string;

const inspectors: { name: string; inspect: Inspector }[] = [
    {
        name: 'native console.inspect',
        inspect(value, options = {}) {
            const nativeOptions = {
                colors: false,
                depth: options.depth,
                compact: options.compact,
                maxArrayLength: options.iterableLimit,
            };
            return nativeConsole.inspect(value, nativeOptions);
        },
    },
    {
        name: 'Deno.inspect',
        inspect: (value, options) => Deno.inspect(value, { ...options, colors: false }),
    },
];

// A native Sandbox returns actual foreign objects without copying host intrinsics.
const sandbox = new engine.Sandbox();
sandbox.initGlobal();
const realms = [
    { name: 'same realm', create: (source: string): unknown => (0, eval)(source) },
    { name: 'cross realm', create: (source: string): unknown => sandbox.call(source) },
];

Deno.test('inspect fixtures use different realm intrinsics', () => {
    strictEqual(sandbox.call('new Date(0)') instanceof Date, false);
    strictEqual(sandbox.call('new Error("foreign")') instanceof Error, false);
    strictEqual(sandbox.call('new Map()') instanceof Map, false);
    strictEqual(sandbox.call('new Set()') instanceof Set, false);
});

for (const { name, inspect } of inspectors) {
    for (const realm of realms) {
        Deno.test(`${name}: ${realm.name} brands and Error cause`, () => {
            strictEqual(inspect(realm.create('new Date("2020-01-02T03:04:05.000Z")')),
                '2020-01-02T03:04:05.000Z');
            strictEqual(inspect(realm.create('new Date(NaN)')), 'Invalid Date');
            strictEqual(inspect(realm.create('new Map([["key", 7]])')), "Map(1) { 'key' => 7 }");
            strictEqual(inspect(realm.create('new Set([1, 2])')), 'Set(2) { 1, 2 }');
            const error = realm.create('new TypeError("outer", { cause: new Error("inner") })');
            const output = inspect(error);
            ok(output.includes('TypeError: outer'), output);
            ok(output.includes('[cause]: Error: inner'), output);
        });

        Deno.test(`${name}: ${realm.name} ignores built-in instance overrides`, () => {
            const fixture = realm.create(`(() => {
                const reads = [];
                const trap = key => ({ configurable: true, get() {
                    reads.push(String(key));
                    throw new Error('instance property accessed');
                } });
                const date = new Date('2020-01-02T03:04:05.000Z');
                const map = new Map([['key', 7]]);
                const set = new Set([1, 2]);
                for (const key of ['getTime', 'toISOString', 'toString', Symbol.toPrimitive, Symbol.toStringTag]) {
                    Object.defineProperty(date, key, trap(key));
                }
                for (const value of [map, set]) {
                    for (const key of ['size', 'entries', 'values', 'next', Symbol.iterator, Symbol.toStringTag]) {
                        Object.defineProperty(value, key, trap(key));
                    }
                    Object.setPrototypeOf(value, null);
                }
                Object.setPrototypeOf(date, null);
                return { date, map, set, reads };
            })()`) as { date: unknown; map: unknown; set: unknown; reads: string[] };

            strictEqual(inspect(fixture.date), '2020-01-02T03:04:05.000Z');
            strictEqual(inspect(fixture.map), "Map(1) { 'key' => 7 }");
            strictEqual(inspect(fixture.set), 'Set(2) { 1, 2 }');
            ok(inspect({ value: fixture.map }, { depth: 0 }).includes('[Map(1)]'));
            ok(inspect({ value: fixture.set }, { depth: 0 }).includes('[Set(2)]'));
            strictEqual(fixture.reads.length, 0);
        });

        Deno.test(`${name}: ${realm.name} shares cycle ownership across Error Map Set`, () => {
            const fixture = realm.create(`(() => {
                const error = new Error('cycle');
                error.stack = '';
                const map = new Map();
                const set = new Set();
                Object.defineProperty(error, 'cause', { value: map });
                map.set('set', set);
                set.add(error);
                const selfMap = new Map();
                selfMap.set(selfMap, selfMap);
                const selfSet = new Set();
                selfSet.add(selfSet);
                return { error, selfMap, selfSet };
            })()`) as { error: unknown; selfMap: unknown; selfSet: unknown };
            for (const value of [fixture.error, fixture.selfMap, fixture.selfSet]) {
                const output = inspect(value, { depth: Infinity });
                ok(output.includes('[Circular]'), output);
                ok(output.length < 1000, output);
                strictEqual(inspect(value, { depth: Infinity }), output);
            }
            const shared = realm.create('new Set([1])');
            const siblings = inspect(new Map([['a', shared], ['b', shared]]));
            strictEqual(siblings.includes('[Circular]'), false, siblings);
            strictEqual(siblings.split('Set(1)').length - 1, 2, siblings);
        });

        Deno.test(`${name}: ${realm.name} bounds collection traversal and depth`, () => {
            const fixture = realm.create(`(() => {
                let visits = 0;
                const poison = { get unvisited() { visits++; throw new Error('over limit'); } };
                const map = new Map([['first', 1], ['second', 2], ['third', poison]]);
                const set = new Set([1, 2, poison]);
                return { map, set, visits: () => visits };
            })()`) as { map: unknown; set: unknown; visits: () => number };
            for (const value of [fixture.map, fixture.set]) {
                const output = inspect(value, { iterableLimit: 2 });
                ok(output.includes('... 1 more items'), output);
                const empty = inspect(value, { iterableLimit: 0 });
                ok(empty.includes('{ ... 3 more items }'), empty);
                strictEqual(empty.includes('{ ,'), false, empty);
                strictEqual(inspect(value, { iterableLimit: -1 }), empty);
            }
            strictEqual(fixture.visits(), 0);
            const nested = realm.create('new Map([["nested", new Set([7])]])');
            ok(inspect(nested, { depth: 0 }).includes('[Set(1)]'));
            ok(inspect(nested, { depth: 1 }).includes('Set(1) { 7 }'));
            const four = realm.create('new Set([1, 2, 3, 4])');
            strictEqual(inspect(four, { iterableLimit: Infinity }), 'Set(4) { 1, 2, 3, 4 }');
            strictEqual(inspect(four, { iterableLimit: 2 }).includes('3,'), false);
        });
    }

    Deno.test(`${name}: captured intrinsics survive prototype replacements in either realm`, () => {
        type Fixture = {
            values: unknown[];
            poison(): void;
            restore(): void;
            calls(): number;
        };
        const source = `(() => {
            let calls = 0;
            const trap = () => { calls++; throw new Error('prototype accessed'); };
            const values = [
                new Date('2020-01-02T03:04:05.000Z'), new Date(NaN),
                new Map([['key', 7]]), new Set([1, 2]),
            ];
            const targets = [
                [Map.prototype, 'size'], [Map.prototype, 'entries'],
                [Set.prototype, 'size'], [Set.prototype, 'values'],
                [Object.getPrototypeOf(values[2].entries()), 'next'],
                [Object.getPrototypeOf(values[3].values()), 'next'],
                [Date.prototype, 'toISOString'],
            ];
            const saved = targets.map(([proto, key]) => Object.getOwnPropertyDescriptor(proto, key));
            const detached = [new Date('2020-01-02T03:04:05.000Z'),
                new Date(NaN), new Map([['key', 7]]), new Set([1, 2])];
            for (const value of detached) Object.setPrototypeOf(value, null);
            return {
                values: [...values, ...detached],
                poison() {
                    for (let i = 0; i < targets.length; i++) {
                        const [proto, key] = targets[i];
                        Object.defineProperty(proto, key, {
                            configurable: true,
                            ...('get' in saved[i] ? { get: trap } : { value: trap, writable: true }),
                        });
                    }
                },
                restore() {
                    for (let i = 0; i < targets.length; i++) {
                        Object.defineProperty(targets[i][0], targets[i][1], saved[i]);
                    }
                },
                calls: () => calls,
            };
        })()`;
        const fixtures = realms.map(realm => realm.create(source) as Fixture);
        const invokeInSandbox = sandbox.call<(inspect: Inspector, value: unknown, options?: InspectOptions) => string>(
            '(inspect, value, options) => inspect(value, options)');
        const callers: Inspector[] = [inspect, (value, options) => invokeInSandbox(inspect, value, options)];
        const expected = ['2020-01-02T03:04:05.000Z', 'Invalid Date', "Map(1) { 'key' => 7 }", 'Set(2) { 1, 2 }'];

        for (const changed of [[fixtures[0]], [fixtures[1]], fixtures]) {
            const full: string[][] = [];
            const collapsed: string[] = [];
            try {
                for (const fixture of changed) fixture.poison();
                for (const call of callers) {
                    for (const fixture of fixtures) {
                        full.push(fixture.values.map(value => call(value)));
                        collapsed.push(call({ map: fixture.values[2], set: fixture.values[3] }, { depth: 0 }));
                    }
                }
            } finally {
                for (let i = changed.length - 1; i >= 0; i--) changed[i].restore();
            }
            for (const output of full) deepStrictEqual([...output], [...expected, ...expected]);
            for (const output of collapsed) {
                ok(output.includes('[Map(1)]'), output);
                ok(output.includes('[Set(2)]'), output);
            }
            for (const fixture of fixtures) strictEqual(fixture.calls(), 0);
        }
    });

    Deno.test(`${name}: forged tags never select collection methods`, () => {
        let calls = 0;
        for (const tag of ['Map', 'Set', 'Date']) {
            const fake = Object.create(null);
            Object.defineProperty(fake, Symbol.toStringTag, { value: tag });
            for (const key of ['size', 'entries', 'values', 'getTime', 'toISOString']) {
                Object.defineProperty(fake, key, { get() { calls++; throw new Error(key); } });
            }
            const output = inspect(fake);
            strictEqual(output.includes(`${tag}(`), false, output);
            strictEqual(output.includes('Invalid Date'), false, output);
            const collapsed = inspect({ fake }, { depth: 0 });
            strictEqual(collapsed.includes(`${tag}(`), false, collapsed);
        }
        strictEqual(calls, 0);
    });

    Deno.test(`${name}: error descriptors do not execute getters or duplicate cause`, () => {
        let reads = 0;
        const error = new Error('hidden');
        for (const key of ['name', 'message', 'stack', 'cause', 'detail']) {
            Object.defineProperty(error, key, {
                configurable: true,
                enumerable: key === 'cause' || key === 'detail',
                get() { reads++; throw new Error('getter invoked'); },
            });
        }
        const output = inspect(error);
        ok(output.includes('[cause]: [Getter]'), output);
        ok(output.includes('detail: [Getter]'), output);
        strictEqual(output.split('[cause]:').length - 1, 1, output);
        strictEqual(reads, 0);

        const self = new Error('self');
        self.stack = '';
        Object.defineProperty(self, 'cause', { enumerable: true, value: self });
        Object.assign(self, { code: 'OWN_CODE', self });
        const selfOutput = inspect(self, { depth: Infinity });
        ok(selfOutput.includes('[cause]: [Circular]'), selfOutput);
        ok(selfOutput.includes('self: [Circular]'), selfOutput);
        ok(selfOutput.includes("code: 'OWN_CODE'"), selfOutput);
        strictEqual(selfOutput.split('[cause]:').length - 1, 1);
    });

    Deno.test(`${name}: unlimited requested depth still has a native safety bound`, () => {
        let value: unknown = new Error('leaf');
        for (let i = 0; i < 100; i++) {
            value = i % 2 ? new Map([['child', value]]) : new Set([value]);
        }
        const output = inspect(value, { depth: Infinity });
        ok(output.includes('[Inspection depth limit]'), output);
        strictEqual(inspect(new Set([1])), 'Set(1) { 1 }');
    });
}

Deno.test('Deno inspect delegates ordinary values and formatting options to native', () => {
    const value = new Map<string, unknown>([['date', new Date(0)], ['set', new Set([1, 2, 3])]]);
    const options = { colors: false, depth: 1, compact: false, iterableLimit: 1 };
    const nativeOptions = { colors: false, depth: 1, compact: false, maxArrayLength: 1 };
    strictEqual(Deno.inspect(value, options), nativeConsole.inspect(value, nativeOptions));
});

Deno.test('Deno custom inspect retains its receiver callback options and error boundary', () => {
    const options = { colors: false, depth: 0, iterableLimit: 1 };
    const custom = {
        [customInspect](this: unknown, inspect: Inspector, received: InspectOptions) {
            strictEqual(this, custom);
            strictEqual(received, options);
            return inspect(new Set([1, 2, 3]), { iterableLimit: 2 });
        },
    };
    strictEqual(Deno.inspect(custom, options), 'Set(3) { 1, 2, ... 1 more items }');

    let reads = 0;
    const disabled = Object.defineProperty({}, customInspect, {
        get() { reads++; throw new Error('disabled hook read'); },
    });
    const disabledOptions: InspectOptions = { colors: false, customInspect: false };
    strictEqual(Deno.inspect(disabled, disabledOptions), '{}');
    strictEqual(reads, 0);

    const failure = new Error('custom inspect failure');
    throws(() => Deno.inspect({ [customInspect]() { throw failure; } }), error => error === failure);
    deepStrictEqual(Object.keys(options), ['colors', 'depth', 'iterableLimit']);
});
