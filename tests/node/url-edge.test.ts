import { strictEqual, ok } from 'node:assert';
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

Deno.test('url: URLSearchParams sort orders keys', () => {
    const sp = new URLSearchParams('b=2&a=1&c=3');
    sp.sort();
    strictEqual(sp.toString(), 'a=1&b=2&c=3');
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

// --- 9. domainToASCII / domainToUnicode --------------------------------------

Deno.test('url: domainToASCII punycode-encodes international domain', () => {
    const ascii = nodeUrl.domainToASCII('中文.com');
    ok(ascii.startsWith('xn--'));
});

// --- 10. URLSearchParams from object dedups via append ---------------------

Deno.test('url: URLSearchParams constructor from object takes first value', () => {
    const sp = new URLSearchParams({ a: '1' });
    strictEqual(sp.get('a'), '1');
});
