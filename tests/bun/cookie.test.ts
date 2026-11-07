import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { CookieMap } from '../../cno/src/bun/cookie/index.ts';

Deno.test('bun: CookieMap parses string, pair-array and record inits', () => {
    const fromString = new CookieMap('a=1; b=two; empty=; =skip; bare');
    strictEqual(fromString.get('a'), '1');
    strictEqual(fromString.get('b'), 'two');
    strictEqual(fromString.get('empty'), '');
    strictEqual(fromString.has('bare'), false);
    strictEqual(fromString.size, 3);

    const fromPairs = new CookieMap([['x', '1'], ['y', '2']]);
    deepStrictEqual([...fromPairs], [['x', '1'], ['y', '2']]);

    const fromRecord = new CookieMap({ k: 'v', n: 3 as unknown as string });
    strictEqual(fromRecord.get('n'), '3');
    deepStrictEqual(fromRecord.toJSON(), { k: 'v', n: '3' });

    strictEqual(new CookieMap().size, 0);
    strictEqual(new CookieMap(undefined).size, 0);
});

Deno.test('bun: CookieMap rejects malformed pair-array init', () => {
    throws(() => new CookieMap([['only']] as unknown as string[][]), TypeError);
    throws(() => new CookieMap(42 as unknown as string), TypeError);
});

Deno.test('bun: CookieMap decodes header values once with tolerant UTF-8', () => {
    const cases = [
        ['a%20b', 'a b'],
        ['%E4%BD%A0%E5%A5%BD', '\u4f60\u597d'],
        ['%F0%9F%98%80', '\ud83d\ude00'],
        ['a+b', 'a+b'],
        ['%2520', '%20'],
        ['%00', '\0'],
        ['%EF%BB%BFabc', '\ufeffabc'],
        ['%', '\ufffd'],
        ['%A', '\ufffdA'],
        ['%G1', '\ufffd'],
        ['%1G', '\ufffd'],
        ['%A%41', '\ufffd41'],
        ['%FF', '\ufffd'],
        ['%E2%82', '\ufffd'],
        ['%E2%82%FF', '\ufffd\ufffd'],
        ['%C0%80', '\ufffd'],
        ['%E0%80%80', '\ufffd'],
        ['%ED%A0%80', '\ufffd'],
        ['%F4%90%80%80', '\ufffd'],
        ['%E1%80%41', '\ufffdA'],
        ['%80%80', '\ufffd\ufffd'],
        ['a%20\u00e9%21', 'a \u00e9!'],
        ['%\u00e9', '\ufffd'],
        ['x\ud800', 'x\ud800'],
        ['x\ud800%20', 'x\ufffd '],
    ];
    for (const [encoded, decoded] of cases) {
        const map = new CookieMap(`q=${encoded}; after=ok`);
        strictEqual(map.get('q'), decoded, encoded);
        strictEqual(map.get('after'), 'ok', encoded);
    }
    strictEqual(new CookieMap('%61=%62').get('%61'), 'b');
    strictEqual(new CookieMap([['q', '%20']]).get('q'), '%20');
    strictEqual(new CookieMap({ q: '%20' }).get('q'), '%20');
    const map = new CookieMap();
    map.set('q', '%20');
    strictEqual(map.get('q'), '%20');
});

Deno.test('bun: CookieMap preserves initial duplicates and reads the first value', () => {
    for (const init of ['a=1; b=2; a=3', [['a', '1'], ['b', '2'], ['a', '3']]]) {
        const map = new CookieMap(init);
        strictEqual(map.size, 3);
        strictEqual(map.get('a'), '1');
        strictEqual(map.has('a'), true);
        deepStrictEqual([...map], [['a', '1'], ['b', '2'], ['a', '3']]);
        deepStrictEqual([...map.keys()], ['a', 'b', 'a']);
        deepStrictEqual([...map.values()], ['1', '2', '3']);
        deepStrictEqual(map.toJSON(), { a: '1', b: '2' });
        deepStrictEqual(map.toSetCookieHeaders(), []);
        const seen: [string, string][] = [];
        map.forEach((value, name, self) => {
            strictEqual(self, map);
            seen.push([name, value]);
        });
        deepStrictEqual(seen, [...map]);
        map.set('a', 'updated');
        strictEqual(map.size, 2);
        strictEqual(map.get('a'), 'updated');
        deepStrictEqual([...map], [['a', 'updated'], ['b', '2']]);
        deepStrictEqual(map.toSetCookieHeaders(), ['a=updated; Path=/; SameSite=Lax']);
    }
    const special = new CookieMap('__proto__=first; __proto__=second; constructor=value');
    deepStrictEqual(special.toJSON(), JSON.parse('{"__proto__":"first","constructor":"value"}'));
});

Deno.test('bun: CookieMap set merges and delete removes all matching duplicates', () => {
    const source = 'before=x; a=1; between=y; a=2; after=z';
    const updated = new CookieMap(source);
    updated.set('a', 'new');
    strictEqual(updated.size, 4);
    strictEqual(updated.get('a'), 'new');
    deepStrictEqual([...updated].filter(([name]) => name === 'a'), [['a', 'new']]);
    deepStrictEqual([...updated].filter(([name]) => name !== 'a'), [['before', 'x'], ['between', 'y'], ['after', 'z']]);
    const deleted = new CookieMap(source);
    deleted.delete('a');
    strictEqual(deleted.size, 3);
    strictEqual(deleted.get('a'), null);
    strictEqual(deleted.has('a'), false);
    deepStrictEqual([...deleted], [['before', 'x'], ['between', 'y'], ['after', 'z']]);
    deepStrictEqual(deleted.toJSON(), { before: 'x', between: 'y', after: 'z' });
    deepStrictEqual(deleted.toSetCookieHeaders(), ['a=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax']);
    deleted.set('a', 'restored');
    strictEqual(deleted.size, 4);
    strictEqual(deleted.get('a'), 'restored');
    strictEqual([...deleted].filter(([name]) => name === 'a').length, 1);
});

Deno.test('bun: CookieMap empty set removes entries but emits an ordinary changed header', () => {
    const map = new CookieMap('a=1; b=2; a=3');
    map.set('a', '', { path: '/empty', secure: true });
    strictEqual(map.size, 1);
    strictEqual(map.get('a'), null);
    strictEqual(map.has('a'), false);
    deepStrictEqual([...map], [['b', '2']]);
    deepStrictEqual(map.toJSON(), { b: '2' });
    deepStrictEqual(map.toSetCookieHeaders(), ['a=; Path=/empty; Secure; SameSite=Lax']);

    map.set({ name: 'missing', path: '/object', sameSite: 'strict' });
    strictEqual(map.size, 1);
    deepStrictEqual(map.toSetCookieHeaders(), [
        'a=; Path=/empty; Secure; SameSite=Lax',
        'missing=; Path=/object; SameSite=Strict',
    ]);

    map.set({ name: 'undefined', value: undefined as unknown as string });
    map.set({ name: 'null', value: null as unknown as string });
    deepStrictEqual([...map], [['null', 'null'], ['undefined', 'undefined'], ['b', '2']]);
    map.set('a', 'restored');
    map.set('missing', 'restored');
    map.set('a', '');
    deepStrictEqual(map.toSetCookieHeaders(), [
        'undefined=undefined; Path=/; SameSite=Lax',
        'null=null; Path=/; SameSite=Lax',
        'missing=restored; Path=/; SameSite=Lax',
        'a=; Path=/; SameSite=Lax',
    ]);
});

Deno.test('bun: CookieMap emits changed headers in last-touch order', () => {
    const map = new CookieMap('untouched=yes');
    map.set('a', '1');
    map.set('b', '2');
    map.set('a', '3');
    deepStrictEqual(map.toSetCookieHeaders(), [
        'b=2; Path=/; SameSite=Lax',
        'a=3; Path=/; SameSite=Lax',
    ]);
    map.delete('b');
    map.set('a', '4');
    deepStrictEqual(map.toSetCookieHeaders(), [
        'b=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
        'a=4; Path=/; SameSite=Lax',
    ]);
});

Deno.test('bun: CookieMap get/has/set/delete and last-write-wins', () => {
    const map = new CookieMap('a=1');
    strictEqual(map.get('missing'), null);
    map.set('a', 'updated');
    map.set('b', '2');
    strictEqual(map.get('a'), 'updated');
    strictEqual(map.size, 2);
    map.delete('a');
    strictEqual(map.has('a'), false);
    strictEqual(map.get('a'), null);
    map.set({ name: 'c', value: '3', path: '/x' });
    strictEqual(map.get('c'), '3');
});

Deno.test('bun: CookieMap iteration follows insertion order and supports forEach', () => {
    const map = new CookieMap([['first', '1'], ['second', '2']]);
    map.set('third', '3');
    deepStrictEqual([...map.keys()], ['third', 'first', 'second']);
    deepStrictEqual([...map.values()], ['3', '1', '2']);
    deepStrictEqual([...map.entries()], [['third', '3'], ['first', '1'], ['second', '2']]);
    deepStrictEqual([...map], [['third', '3'], ['first', '1'], ['second', '2']]);
    const seen: unknown[] = [];
    map.forEach((value, key, self) => seen.push([key, value, self === map]));
    deepStrictEqual(seen, [['third', '3', true], ['first', '1', true], ['second', '2', true]]);
    strictEqual(Object.prototype.toString.call(map), '[object CookieMap]');
});

Deno.test('bun: CookieMap toSetCookieHeaders emits only changed cookies with Bun defaults', () => {
    const map = new CookieMap('untouched=yes');
    deepStrictEqual(map.toSetCookieHeaders(), []);

    map.set('session', 'abc');
    const [header] = map.toSetCookieHeaders();
    strictEqual(header, 'session=abc; Path=/; SameSite=Lax');

    map.set('token', 'xyz', {
        domain: 'example.com',
        path: '/app',
        maxAge: 60,
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        partitioned: true,
    });
    deepStrictEqual(map.toSetCookieHeaders(), [
        'session=abc; Path=/; SameSite=Lax',
        'token=xyz; Domain=example.com; Path=/app; Max-Age=60; Secure; HttpOnly; Partitioned; SameSite=Strict',
    ]);
});

Deno.test('bun: CookieMap serializes expires as an HTTP date and empty path omits Path', () => {
    const map = new CookieMap();
    map.set('e', 'v', { expires: new Date(Date.UTC(2030, 0, 2, 3, 4, 5)), path: '', sameSite: 'none', secure: true });
    map.set('n', 'v', { expires: 0 });
    deepStrictEqual(map.toSetCookieHeaders(), [
        'e=v; Expires=Wed, 02 Jan 2030 03:04:05 GMT; Secure; SameSite=None',
        'n=v; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
    ]);
    throws(() => map.set('bad', 'v', { expires: 'not a date' }), RangeError);
});

Deno.test('bun: CookieMap numeric expires uses Unix seconds', () => {
    const cases = [
        [1, 'Thu, 01 Jan 1970 00:00:01 GMT'],
        [1000, 'Thu, 01 Jan 1970 00:16:40 GMT'],
        [-1, 'Wed, 31 Dec 1969 23:59:59 GMT'],
        [1.5, 'Thu, 01 Jan 1970 00:00:01 GMT'],
        [-1.5, 'Wed, 31 Dec 1969 23:59:58 GMT'],
        [1893553445, 'Wed, 02 Jan 2030 03:04:05 GMT'],
        [new Date(1000), 'Thu, 01 Jan 1970 00:00:01 GMT'],
        ['2030-01-02T03:04:05Z', 'Wed, 02 Jan 2030 03:04:05 GMT'],
    ] as const;
    for (const [expires, expected] of cases) {
        const map = new CookieMap();
        map.set('q', 'v', { expires });
        deepStrictEqual(map.toSetCookieHeaders(), [`q=v; Path=/; Expires=${expected}; SameSite=Lax`]);
    }
    for (const expires of [NaN, Infinity, -Infinity]) {
        const map = new CookieMap();
        throws(() => map.set('q', 'v', { expires }), RangeError);
        strictEqual(map.size, 0);
    }
});

Deno.test('bun: CookieMap delete emits an expiring Set-Cookie header', () => {
    const map = new CookieMap('gone=1');
    map.delete('gone');
    map.delete({ name: 'other', path: '/p', domain: 'example.com' });
    deepStrictEqual(map.toSetCookieHeaders(), [
        'gone=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
        'other=; Domain=example.com; Path=/p; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
    ]);
});

Deno.test('bun: CookieMap validates names and values', () => {
    const map = new CookieMap();
    throws(() => map.set('', 'v'), TypeError);
    throws(() => map.set('bad name', 'v'), TypeError);
    throws(() => map.set('a=b', 'v'), TypeError);
    map.set('n', 'x; line\nbreak');
    strictEqual(map.toSetCookieHeaders()[0], 'n=x%3B%20line%0Abreak; Path=/; SameSite=Lax');
    map.set('age', 'v', { maxAge: 1.5 });
    strictEqual(map.toSetCookieHeaders()[1], 'age=v; Path=/; Max-Age=1.5; SameSite=Lax');
    throws(() => map.set('bad-domain', 'v', { domain: 'x;y' }), TypeError);
    throws(() => map.set('bad-path', 'v', { path: 'x;y' }), TypeError);
    throws(() => map.set('bad-site', 'v', { sameSite: 'invalid' as never }), TypeError);
    strictEqual(map.size, 2);
});

Deno.test('bun: CookieMap brands methods before touching arguments', () => {
    const proto = CookieMap.prototype;
    let coerced = 0;
    const input = { [Symbol.toPrimitive]() { coerced++; return 'a'; } };
    for (const [method, args] of [
        ['get', [input]],
        ['has', [input]],
        ['set', [input, input, input]],
        ['delete', [input, input]],
        ['forEach', [() => {}]],
    ] as const) {
        throws(() => (proto[method] as Function).apply({}, args), {
            name: 'TypeError',
            message: `Can only call CookieMap.${method} on instances of CookieMap`,
            code: 'ERR_INVALID_THIS',
        });
    }
    strictEqual(coerced, 0);

    const map = new CookieMap('a=1');
    const proxy = new Proxy(map, {});
    throws(() => CookieMap.prototype.get.call(proxy, 'a'), {
        name: 'TypeError',
        message: 'Can only call CookieMap.get on instances of CookieMap',
        code: 'ERR_INVALID_THIS',
    });
    throws(() => CookieMap.prototype.entries.call(Object.create(proto)), {
        name: 'TypeError',
        message: 'Can only call CookieMap.entries on instances of CookieMap',
        code: 'ERR_INVALID_THIS',
    });
});

Deno.test('bun: CookieMap exposes Bun prototype and iterator shapes', () => {
    strictEqual(CookieMap.length, 1);
    strictEqual(CookieMap.prototype.set.length, 2);
    strictEqual(CookieMap.prototype.delete.length, 1);
    strictEqual(CookieMap.prototype.forEach.length, 1);
    strictEqual(CookieMap.prototype[Symbol.iterator], CookieMap.prototype.entries);
    for (const method of [
        'get', 'toSetCookieHeaders', 'has', 'set', 'delete',
        'entries', 'keys', 'values', 'forEach', 'toJSON',
    ] as const) {
        strictEqual(Object.getOwnPropertyDescriptor(CookieMap.prototype, method)?.enumerable, true, method);
    }
    const size = Object.getOwnPropertyDescriptor(CookieMap.prototype, 'size')!;
    strictEqual(size.enumerable, true);
    strictEqual(size.configurable, false);

    const iterator = new CookieMap('a=1').entries();
    strictEqual(Object.prototype.toString.call(iterator), '[object CookieMap Iterator]');
    strictEqual(iterator[Symbol.iterator](), iterator);
    strictEqual(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(iterator), 'next')?.enumerable, true);
    throws(() => iterator.next.call(new Proxy(iterator, {})), {
        name: 'TypeError',
        message: 'Cannot call next() on a non-Iterator object',
        code: 'ERR_INVALID_THIS',
    });
});

Deno.test('bun: CookieMap follows constructor and method coercion order', () => {
    const log: string[] = [];
    const value = (label: string, result: string) => ({
        [Symbol.toPrimitive](hint: string) {
            log.push(`${label}:${hint}`);
            return result;
        },
    });
    const map = new CookieMap([[value('name', 'a'), value('value', '1')]] as unknown as string[][]);
    deepStrictEqual([...map], [['a', '1']]);
    deepStrictEqual(log, ['name:string', 'value:string']);

    log.length = 0;
    map.set({
        name: value('set-name', 'b') as unknown as string,
        value: value('set-value', '2') as unknown as string,
        path: value('path', '/p') as unknown as string,
        sameSite: value('sameSite', 'strict') as unknown as 'strict',
    });
    deepStrictEqual(log, ['set-name:string', 'set-value:string', 'path:string', 'sameSite:string']);
    deepStrictEqual(map.toSetCookieHeaders(), ['b=2; Path=/p; SameSite=Strict']);
    throws(() => (map.set as Function)('x'), { name: 'TypeError', message: 'Not enough arguments', code: 'ERR_MISSING_ARGS' });
    throws(() => (map.set as Function)('x', 'y', 1), { name: 'TypeError', message: 'Options must be an object' });
});

Deno.test('bun: CookieMap iterators stay live across front insertions and deletions', () => {
    const map = new CookieMap('a=1; b=2; c=3');
    const iterator = map.entries();
    deepStrictEqual(iterator.next(), { value: ['a', '1'], done: false });
    map.delete('b');
    map.set('d', '4');
    deepStrictEqual([...iterator], [['d', '4'], ['a', '1'], ['c', '3']]);
});

Deno.test('bun: CookieMap live iterators treat empty set as one deletion operation', () => {
    const after = new CookieMap('a=1; b=2; c=3');
    const afterIterator = after.entries();
    deepStrictEqual(afterIterator.next(), { value: ['a', '1'], done: false });
    after.set('c', '');
    deepStrictEqual([...afterIterator], [['a', '1'], ['b', '2']]);

    const duplicates = new CookieMap('x=0; a=1; y=2; a=3; z=4');
    const duplicateIterator = duplicates.entries();
    deepStrictEqual(duplicateIterator.next(), { value: ['x', '0'], done: false });
    deepStrictEqual(duplicateIterator.next(), { value: ['a', '1'], done: false });
    deepStrictEqual(duplicateIterator.next(), { value: ['y', '2'], done: false });
    duplicates.set('a', '');
    deepStrictEqual([...duplicateIterator], [['z', '4']]);
    deepStrictEqual([...duplicates], [['x', '0'], ['y', '2'], ['z', '4']]);
});
