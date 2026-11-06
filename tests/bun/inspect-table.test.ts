import { strictEqual, throws } from 'node:assert';
import { runInNewContext } from 'node:vm';
import { inspectTable } from '../../cno/src/bun/inspect.ts';

Deno.test('bun: inspect.table formats mixed rows and selected columns', () => {
    const rows = [{ a: 1, b: 'x' }, { b: 2, c: null }, 5];
    strictEqual(inspectTable(rows),
        '┌───┬───┬───┬──────┬────────┐\n' +
        '│   │ a │ b │ c    │ Values │\n' +
        '├───┼───┼───┼──────┼────────┤\n' +
        '│ 0 │ 1 │ x │      │        │\n' +
        '│ 1 │   │ 2 │ null │        │\n' +
        '│ 2 │   │   │      │ 5      │\n' +
        '└───┴───┴───┴──────┴────────┘\n');
    strictEqual(inspectTable(rows, ['b', 'a', 'b']),
        '┌───┬───┬───┬───┐\n│   │ b │ a │ b │\n├───┼───┼───┼───┤\n' +
        '│ 0 │ x │ 1 │ x │\n│ 1 │ 2 │   │ 2 │\n│ 2 │   │   │   │\n└───┴───┴───┴───┘\n');
});

Deno.test('bun: inspect.table handles maps, sets, sparse arrays and empty inputs', () => {
    strictEqual(inspectTable(new Map([['a', 1], ['b', 2]]), []),
        '┌───┬─────┬────────┐\n│   │ Key │ Values │\n├───┼─────┼────────┤\n' +
        '│ 0 │ a   │ 1      │\n│ 1 │ b   │ 2      │\n└───┴─────┴────────┘\n');
    strictEqual(inspectTable(new Set([{ a: 1 }, 2])),
        '┌───┬───┬────────┐\n│   │ a │ Values │\n├───┼───┼────────┤\n' +
        '│ 0 │ 1 │        │\n│ 1 │   │ 2      │\n└───┴───┴────────┘\n');
    strictEqual(inspectTable(new Array(1)),
        '┌───┬───────────┐\n│   │ Values    │\n├───┼───────────┤\n│ 0 │ undefined │\n└───┴───────────┘\n');
    strictEqual(inspectTable(new Map()), '┌───┬─────┐\n│   │ Key │\n├───┼─────┤\n└───┴─────┘\n');
    strictEqual(inspectTable([]), '┌───┐\n│   │\n├───┤\n└───┘\n');
    strictEqual(inspectTable(null), '');
    strictEqual(inspectTable('abc'), '');
});

Deno.test('bun: inspect.table reads own descriptors and propagates getters', () => {
    let calls = 0;
    const row = Object.create({ inherited: 3 });
    Object.defineProperties(row, {
        a: { enumerable: true, get() { calls++; return 9; } },
        hidden: { value: 4 },
        setter: { enumerable: true, set(_v: unknown) {} },
    });
    strictEqual(inspectTable([row], ['a', 'hidden', 'inherited', 'setter']),
        '┌───┬───┬────────┬───────────┬───────────┐\n' +
        '│   │ a │ hidden │ inherited │ setter    │\n' +
        '├───┼───┼────────┼───────────┼───────────┤\n' +
        '│ 0 │ 9 │ 4      │           │ undefined │\n' +
        '└───┴───┴────────┴───────────┴───────────┘\n');
    strictEqual(calls, 1);
    throws(() => inspectTable([{ get a() { throw new Error('oops'); } }]), /oops/);
});

Deno.test('bun: inspect.table handles function values, options and sparse columns', () => {
    const f = function named() {};
    strictEqual(inspectTable([{ f }], null, { colors: true }),
        '┌───┬───────────────────┐\n│   │ f                 │\n├───┼───────────────────┤\n' +
        '│ 0 │ [Function: named] │\n└───┴───────────────────┘\n');
    strictEqual(inspectTable([{ undefined: 3 }], new Array(1)),
        '┌───┬───────────┐\n│   │ undefined │\n├───┼───────────┤\n│ 0 │ 3         │\n└───┴───────────┘\n');
    throws(() => inspectTable([], [Symbol('x')]), TypeError);
});

Deno.test('bun: inspect.table aligns Unicode display widths', () => {
    strictEqual(inspectTable([{ 'é': '中', emoji: '👩‍💻', comb: 'é' }]),
        '┌───┬────┬───────┬──────┐\n│   │ é  │ emoji │ comb │\n├───┼────┼───────┼──────┤\n' +
        '│ 0 │ 中 │ 👩‍💻  │ é    │\n└───┴────┴───────┴──────┘\n');
});

Deno.test('bun: inspect.table formats common builtins in cells', () => {
    strictEqual(inspectTable([{
        date: new Date('2020-01-02T03:04:05.000Z'),
        regexp: /x/g,
        map: new Map([['x', 1]]),
        bytes: new Uint8Array([1, 2]),
    }]),
    '┌───┬──────────────────────────┬────────┬───────────────────┬────────────────────────┐\n' +
    '│   │ date                     │ regexp │ map               │ bytes                  │\n' +
    '├───┼──────────────────────────┼────────┼───────────────────┼────────────────────────┤\n' +
    '│ 0 │ 2020-01-02T03:04:05.000Z │ /x/g   │ Map(1) { "x": 1 } │ Uint8Array(2) [ 1, 2 ] │\n' +
    '└───┴──────────────────────────┴────────┴───────────────────┴────────────────────────┘\n');
});

Deno.test('bun: inspect.table discovers proxy columns once', () => {
    const events: string[] = [];
    const row = new Proxy({ a: 1 }, {
        ownKeys(target) {
            events.push('ownKeys');
            return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
            events.push(`descriptor:${String(key)}`);
            return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key, receiver) {
            events.push(`get:${String(key)}`);
            return Reflect.get(target, key, receiver);
        },
    });
    strictEqual(inspectTable([row]),
        '┌───┬───┐\n│   │ a │\n├───┼───┤\n│ 0 │ 1 │\n└───┴───┘\n');
    strictEqual(events.join(','), 'ownKeys,descriptor:a,get:a');
});

Deno.test('bun: inspect.table formats cross-realm builtins and excludes inherited selected columns', () => {
    const row = runInNewContext(`({
        date: new Date('2020-01-02T03:04:05.000Z'),
        map: new Map([['x', 1]]),
        set: new Set([1]),
        bytes: new Uint8Array([1, 2]),
    })`) as object;
    strictEqual(inspectTable([row]),
        '┌───┬──────────────────────────┬───────────────────┬──────────────┬────────────────────────┐\n' +
        '│   │ date                     │ map               │ set          │ bytes                  │\n' +
        '├───┼──────────────────────────┼───────────────────┼──────────────┼────────────────────────┤\n' +
        '│ 0 │ 2020-01-02T03:04:05.000Z │ Map(1) { "x": 1 } │ Set(1) { 1 } │ Uint8Array(2) [ 1, 2 ] │\n' +
        '└───┴──────────────────────────┴───────────────────┴──────────────┴────────────────────────┘\n');

    const inherited = Object.create({ inherited: 1 });
    Object.defineProperty(inherited, 'hidden', { value: 2 });
    inherited.own = 3;
    strictEqual(inspectTable([inherited], ['inherited', 'hidden', 'own']),
        '┌───┬───────────┬────────┬─────┐\n' +
        '│   │ inherited │ hidden │ own │\n' +
        '├───┼───────────┼────────┼─────┤\n' +
        '│ 0 │           │ 2      │ 3   │\n' +
        '└───┴───────────┴────────┴─────┘\n');
});
