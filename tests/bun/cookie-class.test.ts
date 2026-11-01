import { deepStrictEqual, strictEqual, throws, doesNotThrow } from 'node:assert';
import { Cookie } from '../../cno/src/bun/cookie/cookie.ts';

Deno.test('constructs and serializes attributes in Bun order', () => {
        const cookie = new Cookie('sid', 'a b', { domain: 'example.com', path: '/app', expires: new Date(0), maxAge: 12, secure: true, httpOnly: true, partitioned: true, sameSite: 'strict' });
        strictEqual(cookie.toString(), 'sid=a%20b; Domain=example.com; Path=/app; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=12; Secure; HttpOnly; Partitioned; SameSite=Strict');
        strictEqual(cookie.serialize(), cookie.toString());
        strictEqual(cookie.isExpired(), false);
    });
Deno.test('supports init objects, parsing and from', () => {
        strictEqual(new Cookie({ name: 'a' }).toString(), 'a=; Path=/; SameSite=Lax');
        strictEqual(Cookie.from('a', 'b').toString(), 'a=b; Path=/; SameSite=Lax');
        const parsed = Cookie.parse('a=b%20c; Domain=EXAMPLE.COM; Path=/x; Secure; SameSite=None');
        strictEqual(parsed.toString(), 'a=b%2520c; Domain=example.com; Path=/x; Secure; SameSite=None');
        deepStrictEqual(parsed.toJSON(), Object.assign(Object.create(null), { name: 'a', value: 'b%20c', domain: 'example.com', path: '/x', secure: true, sameSite: 'none', httpOnly: false, partitioned: false }));
    });
Deno.test('matches Bun constructor coercion and option handling', () => {
        strictEqual(new Cookie({ name: undefined } as never).name, 'undefined');
        strictEqual(new Cookie({ name: 'x', value: undefined }).value, 'undefined');
        throws(() => new Cookie({} as never), { name: 'TypeError', message: 'name is required' });
        throws(() => new Cookie(1 as never), { name: 'TypeError', message: 'Not enough arguments', code: 'ERR_MISSING_ARGS' });
        throws(() => new Cookie('x', 'y', 0 as never), { name: 'TypeError', message: 'Options must be an object' });
        throws(() => new Cookie('x', Symbol() as never), { name: 'TypeError', message: 'Cannot convert a Symbol value to a string' });
        strictEqual(new Cookie({ name: 'x', maxAge: '12' as never }).maxAge, undefined);
        strictEqual(new Cookie({ name: 'x', maxAge: Infinity }).maxAge, Infinity);
        strictEqual(new Cookie({ name: 'x', domain: '' }).domain, undefined);
    });
Deno.test('parses attributes and enforces expiration precedence', () => {
        const cookie = Cookie.parse('x=y; Path=relative; Max-Age=12.5; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        strictEqual(cookie.path, '/');
        strictEqual(cookie.maxAge, 12);
        strictEqual(cookie.isExpired(), false);
        strictEqual(Cookie.parse('x=y; Max-Age=0x10').maxAge, 0);
        strictEqual(Cookie.parse('x=y; Path=é').path, '/');
        strictEqual(Cookie.parse('x=y\t; Secure').secure, true);
        throws(() => Cookie.parse('='), { name: 'TypeError', message: 'Invalid cookie string: empty' });
        throws(() => { cookie.expires = NaN; }, RangeError);
        throws(() => { cookie.path = 'é'; }, TypeError);
        cookie.expires = 1e20;
        strictEqual(cookie.expires, undefined);
    });
Deno.test('preserves Bun JSON and prototype descriptor behavior', () => {
        const cookie = new Cookie('a', 'b');
        strictEqual(Object.getPrototypeOf(cookie.toJSON()), null);
        strictEqual(Cookie.length, 2);
        const getter = Object.getOwnPropertyDescriptor(Cookie.prototype, 'name')!.get!;
        strictEqual(getter.name, 'name');
        throws(() => getter.call({}), { name: 'TypeError', message: 'Can only call Cookie.name on instances of Cookie', code: 'ERR_INVALID_THIS' });
        cookie.serialize = () => 'overridden';
        strictEqual(cookie.toString(), 'a=b; Path=/; SameSite=Lax');
    });
Deno.test('validates mutable attributes and converts numeric expiry as seconds', () => {
        const cookie = new Cookie('a', 'b');
        cookie.expires = 42;
        strictEqual(cookie.expires?.getTime(), 42000);
        cookie.maxAge = 0;
        strictEqual(cookie.isExpired(), true);
        throws(() => { cookie.domain = 'EXAMPLE.COM'; }, TypeError);
        throws(() => { cookie.path = '/a;b'; }, TypeError);
        throws(() => { cookie.sameSite = 'invalid' as never; }, TypeError);
        throws(() => { cookie.maxAge = Infinity; }, TypeError);
    });
Deno.test('exposes prototype descriptors and rejects incompatible receivers', () => {
        const descriptor = Object.getOwnPropertyDescriptor(Cookie.prototype, 'name')!;
        strictEqual(descriptor.enumerable, true);
        strictEqual(descriptor.set, undefined);
        throws(() => descriptor.get!.call({}), TypeError);
        strictEqual(Object.prototype.toString.call(new Cookie('a', 'b')), '[object Cookie]');
        doesNotThrow(() => Cookie.from('a' as string, undefined as never));
        throws(() => Cookie.parse('invalid'), TypeError);
    });
