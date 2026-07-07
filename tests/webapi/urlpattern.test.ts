import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';

// Derived from Deno upstream unit/urlpattern_test.ts public API cases.

Deno.test('URLPattern upstream: constructs from absolute string', () => {
    const pattern = new URLPattern('https://deno.land/foo/:bar');
    strictEqual(pattern.protocol, 'https');
    strictEqual(pattern.hostname, 'deno.land');
    strictEqual(pattern.pathname, '/foo/:bar');

    strictEqual(pattern.test('https://deno.land/foo/x'), true);
    strictEqual(pattern.test('https://deno.com/foo/x'), false);

    const match = pattern.exec('https://deno.land/foo/x');
    ok(match);
    strictEqual(match.pathname.input, '/foo/x');
    deepStrictEqual(match.pathname.groups, { bar: 'x' });
});

Deno.test('URLPattern upstream: constructs from relative string with base', () => {
    const pattern = new URLPattern('/foo/:bar', 'https://deno.land');
    strictEqual(pattern.protocol, 'https');
    strictEqual(pattern.hostname, 'deno.land');
    strictEqual(pattern.pathname, '/foo/:bar');
    strictEqual(pattern.test('https://deno.land/foo/x'), true);
    strictEqual(pattern.test('https://deno.com/foo/x'), false);
    deepStrictEqual(pattern.exec('https://deno.land/foo/x')!.pathname.groups, { bar: 'x' });
});

Deno.test('URLPattern upstream: constructs from init and supports ignoreCase', () => {
    const pattern = new URLPattern({ pathname: '/foo/:bar' });
    strictEqual(pattern.protocol, '*');
    strictEqual(pattern.hostname, '*');
    strictEqual(pattern.pathname, '/foo/:bar');
    strictEqual(pattern.test('https://deno.land/foo/x'), true);
    strictEqual(pattern.test('https://deno.com/foo/x'), true);
    strictEqual(pattern.test('https://deno.com/bar/x'), false);
    strictEqual(pattern.test({ pathname: '/foo/x' }), true);

    const insensitive = new URLPattern({ pathname: '/test' }, { ignoreCase: true });
    strictEqual(insensitive.test('/test', 'http://localhost'), true);
    strictEqual(insensitive.test('/TeSt', 'http://localhost'), true);
});

Deno.test('URLPattern upstream: matches all URL components and exposes result shape', () => {
    const pattern = new URLPattern({
        protocol: 'https',
        username: 'user',
        password: 'pass',
        hostname: '*.example.com',
        port: '8080',
        pathname: '/books/:id',
        search: 'q=:query',
        hash: 'top',
    });
    const input = 'https://user:pass@docs.example.com:8080/books/123?q=deno#top';

    strictEqual(pattern.test(input), true);
    strictEqual(pattern.test('https://user:pass@docs.example.com:8080/books/123?q=deno#other'), false);
    strictEqual(pattern.test('https://user:pass@docs.example.com:9090/books/123?q=deno#top'), false);

    const match = pattern.exec(input);
    ok(match);
    deepStrictEqual(match!.inputs, [input]);
    strictEqual(match!.protocol.input, 'https');
    strictEqual(match!.username.input, 'user');
    strictEqual(match!.password.input, 'pass');
    strictEqual(match!.hostname.input, 'docs.example.com');
    deepStrictEqual(match!.hostname.groups, { 0: 'docs' });
    strictEqual(match!.port.input, '8080');
    strictEqual(match!.pathname.input, '/books/123');
    deepStrictEqual(match!.pathname.groups, { id: '123' });
    strictEqual(match!.search.input, 'q=deno');
    deepStrictEqual(match!.search.groups, { query: 'deno' });
    strictEqual(match!.hash.input, 'top');
});

Deno.test('URLPattern upstream: object input uses baseURL and returns original inputs', () => {
    const pattern = new URLPattern('/foo/:id', 'https://example.com/base');
    const input = { pathname: '/foo/42', baseURL: 'https://example.com/base' };
    const match = pattern.exec(input);

    strictEqual(pattern.test(input), true);
    ok(match);
    deepStrictEqual(match!.inputs, [input]);
    deepStrictEqual(match!.pathname.groups, { id: '42' });
    strictEqual(pattern.test({ pathname: '/foo/42', baseURL: 'https://other.example/base' }), false);
});

Deno.test('URLPattern upstream: constructor requires new and validates base URLs', () => {
    throws(() => URLPattern('https://example.com' as unknown as URLPatternInput), TypeError);
    throws(() => new URLPattern('/relative/no/base'), TypeError);
    throws(() => new URLPattern('/relative', 'not a url'), TypeError);
});

Deno.test('URLPattern upstream: RegExp prototype pollution does not break construction', () => {
    const originalExec = RegExp.prototype.exec;
    try {
        RegExp.prototype.exec = () => {
            throw new Error('polluted');
        };
        const pattern = new URLPattern({ pathname: '/foo/:bar' });
        strictEqual(pattern.test('https://deno.land/foo/x'), true);
        deepStrictEqual(pattern.exec('https://deno.land/foo/x')!.pathname.groups, { bar: 'x' });
    } finally {
        RegExp.prototype.exec = originalExec;
    }
});

Deno.test('URLPattern upstream: flags pattern regression', () => {
    new URLPattern({ pathname: '/install(\\.sh|\\.ps1)' });
});
