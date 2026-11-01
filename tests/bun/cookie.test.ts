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
        'token=xyz; Domain=example.com; Path=/app; Max-Age=60; Secure; HttpOnly; SameSite=Strict; Partitioned',
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
