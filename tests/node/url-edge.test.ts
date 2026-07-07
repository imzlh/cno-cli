import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';
import * as url from 'node:url';
import * as nodeUrl from 'node:url';

// --- 1. url.parse splits components ------------------------------------------

Deno.test('url: parse splits host, path, query, hash', () => {
    const u = url.parse('https://user:pass@host.com:8080/p?a=1#frag', false);
    strictEqual(u.protocol, 'https:');
    strictEqual(u.host, 'host.com:8080');
    strictEqual(u.hostname, 'host.com');
    strictEqual(u.port, '8080');
    strictEqual(u.pathname, '/p');
    strictEqual(u.hash, '#frag');
    strictEqual(u.auth, 'user:pass');
});

Deno.test('url: parse with parseQueryString returns parsed query', () => {
    const u = url.parse('http://x/?a=1&b=2', true);
    ok(u.query && typeof u.query === 'object');
    const q = u.query as Record<string, unknown>;
    strictEqual(q.a, '1');
    strictEqual(q.b, '2');
});

// --- 2. url.resolve resolves relative paths ----------------------------------

Deno.test('url: resolve resolves relative paths', () => {
    strictEqual(url.resolve('http://a/b/c/d', '../g'), 'http://a/b/g');
    strictEqual(url.resolve('http://a/b/c/d', '/g'), 'http://a/g');
    strictEqual(url.resolve('http://a/b/c/d', 'g'), 'http://a/b/c/g');
});

// --- 3. url.format rebuilds a URL string -------------------------------------

Deno.test('url: format rebuilds URL from object', () => {
    const s = url.format({ protocol: 'https:', host: 'example.com', pathname: '/p', search: '?q=1' });
    ok(s.startsWith('https://example.com/p?q=1'));
});

// --- 4. fileURLToPath / pathToFileURL round-trip -----------------------------

Deno.test('url: fileURLToPath and pathToFileURL round-trip', () => {
    const p = '/tmp/foo.txt';
    const u = url.pathToFileURL(p);
    ok(u instanceof URL);
    strictEqual(u.protocol, 'file:');
    strictEqual(url.fileURLToPath(u), p);
});

Deno.test('url: pathToFileURL percent-encodes URL syntax characters', () => {
    strictEqual(url.pathToFileURL('/tmp/a#b?c').href, 'file:///tmp/a%23b%3Fc');
});

Deno.test('url: fileURLToPath rejects encoded slash on POSIX paths', () => {
    throws(() => url.fileURLToPath('file:///tmp/a%2Fb'), TypeError);
});

// --- 5. URL class parses and normalizes --------------------------------------

Deno.test('url: URL normalizes origin and pathname', () => {
    const u = new URL('HTTP://Example.com:80/a/../b?x=1#f');
    strictEqual(u.origin, 'http://example.com');
    strictEqual(u.pathname, '/b');
    strictEqual(u.searchParams.get('x'), '1');
});

// --- 6. URLSearchParams: append/get/delete/has/sort -------------------------

Deno.test('url: URLSearchParams append/get/delete/has', () => {
    const sp = new URLSearchParams();
    sp.append('a', '1');
    sp.append('a', '2');
    strictEqual(sp.get('a'), '1');
    strictEqual(sp.getAll('a').join(','), '1,2');
    ok(sp.has('a'));
    sp.delete('a');
    ok(!sp.has('a'));
});

Deno.test('url: URLSearchParams sequence constructor preserves duplicate keys', () => {
    const sp = new URLSearchParams([['a', '1'], ['a', '2'], ['b', '3']]);
    strictEqual(sp.get('a'), '1');
    strictEqual(sp.getAll('a').join(','), '1,2');
    strictEqual(sp.toString(), 'a=1&a=2&b=3');
});

Deno.test('url: URLSearchParams set replaces all existing values', () => {
    const sp = new URLSearchParams('a=1&a=2&b=3');
    sp.set('a', '4');
    strictEqual(sp.getAll('a').join(','), '4');
    strictEqual(sp.toString(), 'a=4&b=3');
});

Deno.test('url: URLSearchParams sort orders keys', () => {
    const sp = new URLSearchParams('b=2&a=1&c=3');
    sp.sort();
    strictEqual(sp.toString(), 'a=1&b=2&c=3');
});

Deno.test('url: URLSearchParams sort is stable for duplicate keys', () => {
    const sp = new URLSearchParams('b=2&a=1&a=0');
    sp.sort();
    strictEqual(sp.toString(), 'a=1&a=0&b=2');
});

Deno.test('url: URLSearchParams toString encodes special chars', () => {
    const sp = new URLSearchParams({ q: 'hello world', k: 'a&b' });
    const s = sp.toString();
    ok(s.includes('q=hello+world') || s.includes('q=hello%20world'));
    ok(s.includes('k=a%26b'));
});

// --- 7. URLSearchParams is iterable ------------------------------------------

Deno.test('url: URLSearchParams is iterable', () => {
    const sp = new URLSearchParams('a=1&b=2');
    const keys = [...sp.keys()];
    ok(keys.includes('a') && keys.includes('b'));
    const entries = [...sp.entries()];
    strictEqual(entries.length, 2);
});

// --- 8. URL with credentials -----------------------------------------------

Deno.test('url: URL exposes username/password', () => {
    const u = new URL('http://user:secret@host/');
    strictEqual(u.username, 'user');
    strictEqual(u.password, 'secret');
});

Deno.test('url: URL serializes spaces in path and query', () => {
    const u = new URL('https://example.com/a b?x=a b');
    strictEqual(u.pathname, '/a%20b');
    strictEqual(u.search, '?x=a%20b');
    strictEqual(u.href, 'https://example.com/a%20b?x=a%20b');
});

// --- 9. domainToASCII / domainToUnicode --------------------------------------

Deno.test('url: domainToASCII punycode-encodes international domain', () => {
    strictEqual(nodeUrl.domainToASCII('中文.com'), 'xn--fiq228c.com');
    strictEqual(nodeUrl.domainToASCII('münchen.de'), 'xn--mnchen-3ya.de');
});

Deno.test('url: domainToASCII preserves ASCII labels around the IDN label', () => {
    strictEqual(nodeUrl.domainToASCII('www.中文.com'), 'www.xn--fiq228c.com');
});

Deno.test('url: domainToASCII normalizes unicode dot separators', () => {
    strictEqual(nodeUrl.domainToASCII('中文。com'), 'xn--fiq228c.com');
});

Deno.test('url upstream: domainToASCII preserves IPv6 literals and rejects invalid punycode labels', () => {
    strictEqual(nodeUrl.domainToASCII('example.com'), 'example.com');
    strictEqual(nodeUrl.domainToASCII('[::1]'), '[::1]');
    strictEqual(nodeUrl.domainToASCII('xn--iñvalid.com'), '');
});

Deno.test('url: domainToUnicode decodes punycoded labels', () => {
    strictEqual(nodeUrl.domainToUnicode('xn--fiq228c.com'), '中文.com');
});

Deno.test('url: domainToUnicode leaves non-punycode ASCII labels unchanged', () => {
    strictEqual(nodeUrl.domainToUnicode('example.com'), 'example.com');
});

Deno.test('url: format URL object can drop auth, search, and fragment', () => {
    const u = new URL('https://user:pass@example.com/path?q=1#frag');
    strictEqual(nodeUrl.format(u, { auth: false, search: false, fragment: false }), 'https://example.com/path');
});

Deno.test('url: format object query preserves nullish and non-finite values as empty', () => {
    strictEqual(
        nodeUrl.format({
            protocol: 'https:',
            host: 'example.com',
            pathname: '/search',
            query: { q: 'cno', empty: null, missing: undefined, n: NaN, values: ['a', null, Infinity] },
        }),
        'https://example.com/search?q=cno&empty=&missing=&n=&values=a&values=&values=',
    );
});

Deno.test('url: format object search takes precedence over query object', () => {
    strictEqual(
        nodeUrl.format({ protocol: 'https:', host: 'example.com', pathname: '/search', search: '?q=1', query: { q: 2 } }),
        'https://example.com/search?q=1',
    );
});

Deno.test('url: format object brackets IPv6 hostname', () => {
    strictEqual(
        nodeUrl.format({ protocol: 'http:', hostname: '::1', pathname: 'a' }),
        'http://[::1]/a',
    );
});

Deno.test('url: format object escapes URL delimiters in pathname', () => {
    strictEqual(
        nodeUrl.format({ protocol: 'http:', host: 'example.com', pathname: '/a?b#c' }),
        'http://example.com/a%3Fb%23c',
    );
});

Deno.test('url: urlToHttpOptions exposes request options from URL', () => {
    const u = new URL('https://user:pass@example.com:8080/a b?x=1#frag');
    deepStrictEqual(nodeUrl.urlToHttpOptions(u), {
        protocol: 'https:',
        hostname: 'example.com',
        hash: '#frag',
        search: '?x=1',
        pathname: '/a%20b',
        path: '/a%20b?x=1',
        href: 'https://user:pass@example.com:8080/a%20b?x=1#frag',
        port: 8080,
        auth: 'user:pass',
    });
});

// --- 10. URLSearchParams from object dedups via append ---------------------

Deno.test('url: URLSearchParams constructor from object takes first value', () => {
    const sp = new URLSearchParams({ a: '1' });
    strictEqual(sp.get('a'), '1');
});

Deno.test('url: URLSearchParams object constructor stringifies array values', () => {
    const sp = new URLSearchParams({ a: ['1', '2'] as unknown as string });
    strictEqual(sp.get('a'), '1,2');
});
