import { strictEqual, ok } from 'node:assert';

// ============================================================================
// URL — WHATWG URL Standard edge cases
// ============================================================================

// --- 1. basic parsing: special scheme (http) -------------------------------

Deno.test('URL: parses http URL completely', () => {
    const u = new URL('http://user:pass@Example.com:8080/a/b/c?x=1&y=2#frag');
    strictEqual(u.protocol, 'http:');
    strictEqual(u.username, 'user');
    strictEqual(u.password, 'pass');
    strictEqual(u.host, 'example.com:8080');
    strictEqual(u.hostname, 'example.com');
    strictEqual(u.port, '8080');
    strictEqual(u.pathname, '/a/b/c');
    strictEqual(u.search, '?x=1&y=2');
    strictEqual(u.hash, '#frag');
    strictEqual(u.origin, 'http://example.com:8080');
});

// --- 2. default ports are omitted from host but origin keeps host name -----

Deno.test('URL: default http port (80) is omitted', () => {
    const u = new URL('http://x.com:80/path');
    strictEqual(u.port, '');
    strictEqual(u.host, 'x.com');
    strictEqual(u.origin, 'http://x.com');
});

// --- 3. non-default port is retained --------------------------------------

Deno.test('URL: non-default port is retained', () => {
    const u = new URL('https://x.com:8443/');
    strictEqual(u.port, '8443');
    strictEqual(u.host, 'x.com:8443');
    strictEqual(u.origin, 'https://x.com:8443');
});

// --- 4. file URL origin is "null" per WHATWG -------------------------------

Deno.test('URL: file URL origin is null', () => {
    const u = new URL('file:///tmp/x.txt');
    strictEqual(u.protocol, 'file:');
    strictEqual(u.pathname, '/tmp/x.txt');
    strictEqual(u.origin, 'null');
});

// --- 5. URLSearchParams: + decodes to space --------------------------------

Deno.test('URL: + in query decodes to space', () => {
    const u = new URL('http://x/?q=a+b');
    strictEqual(u.searchParams.get('q'), 'a b');
});

// --- 6. URLSearchParams: percent-encoding round-trip -----------------------

Deno.test('URL: percent-encoding round-trips reserved chars', () => {
    const u = new URL('http://x/');
    u.searchParams.set('k', 'hello world & friends=you');
    ok(u.search.includes(encodeURIComponent('hello world & friends=you').replace(/%20/g, '+')));
    strictEqual(u.searchParams.get('k'), 'hello world & friends=you');
});

// --- 7. set search resets and rebuilds params ------------------------------

Deno.test('URL: setting search replaces all params', () => {
    const u = new URL('http://x/?a=1&b=2');
    u.search = '?c=3';
    strictEqual(u.searchParams.get('a'), null);
    strictEqual(u.searchParams.get('c'), '3');
});

// --- 8. set pathname -------------------------------------------------------

Deno.test('URL: setting pathname updates pathname', () => {
    const u = new URL('http://x/old/path');
    u.pathname = '/new/path';
    strictEqual(u.pathname, '/new/path');
    strictEqual(u.href, 'http://x/new/path');
});

// --- 9. set hash with/without leading # -----------------------------------

Deno.test('URL: setting hash normalizes leading #', () => {
    const u = new URL('http://x/');
    u.hash = 'frag';
    strictEqual(u.hash, '#frag');
    u.hash = '#other';
    strictEqual(u.hash, '#other');
});

// --- 10. URLSearchParams: duplicate keys via append -----------------------

Deno.test('URL: append creates duplicate keys, getAll returns all', () => {
    const u = new URL('http://x/');
    u.searchParams.append('k', '1');
    u.searchParams.append('k', '2');
    strictEqual(u.searchParams.get('k'), '1');
    deepStrictEqual(u.searchParams.getAll('k'), ['1', '2']);
});

// --- 11. URLSearchParams: sort orders by key -------------------------------

Deno.test('URL: searchParams.sort orders by key', () => {
    const sp = new URLSearchParams('b=2&a=1&c=3');
    sp.sort();
    strictEqual(sp.toString(), 'a=1&b=2&c=3');
});

// --- 12. URLSearchParams: has with value ----------------------------------

Deno.test('URL: searchParams.has with value check', () => {
    const sp = new URLSearchParams('a=1&b=2');
    ok(sp.has('a'));
    ok(sp.has('a', '1'));
    ok(!sp.has('a', '2'));
    ok(!sp.has('z'));
});

// --- 13. URLSearchParams: delete specific value ---------------------------

Deno.test('URL: searchParams.delete removes specific value', () => {
    const sp = new URLSearchParams('a=1&a=2&a=3');
    sp.delete('a', '2');
    deepStrictEqual(sp.getAll('a'), ['1', '3']);
});

// --- 14. URLSearchParams: size reflects count ------------------------------

Deno.test('URL: searchParams.size reflects entry count', () => {
    const sp = new URLSearchParams('a=1&b=2&a=3');
    strictEqual(sp.size, 3);
    sp.delete('a');
    strictEqual(sp.size, 1);
});

// --- 15. URLSearchParams: forEach + entries + keys + values --------------

Deno.test('URL: searchParams iteration methods', () => {
    const sp = new URLSearchParams('a=1&b=2');
    const entries: string[] = [];
    sp.forEach((v, k) => entries.push(`${k}=${v}`));
    entries.sort();
    deepStrictEqual(entries, ['a=1', 'b=2']);

    const keys = [...sp.keys()].sort();
    const values = [...sp.values()].sort();
    deepStrictEqual(keys, ['a', 'b']);
    deepStrictEqual(values, ['1', '2']);

    const iterEntries = [...sp.entries()].map(([k, v]) => `${k}=${v}`).sort();
    deepStrictEqual(iterEntries, ['a=1', 'b=2']);
});

// --- 16. URLSearchParams: constructor from object -------------------------

Deno.test('URL: URLSearchParams from object', () => {
    const sp = new URLSearchParams({ a: '1', b: '2' });
    strictEqual(sp.get('a'), '1');
    strictEqual(sp.get('b'), '2');
});

// --- 17. URLSearchParams: constructor from another URLSearchParams ---------

Deno.test('URL: URLSearchParams from another instance clones', () => {
    const sp1 = new URLSearchParams('a=1');
    const sp2 = new URLSearchParams(sp1);
    sp2.set('a', '99');
    strictEqual(sp1.get('a'), '1', 'clone must be independent');
    strictEqual(sp2.get('a'), '99');
});

// --- 18. URLSearchParams: empty key/value --------------------------------

Deno.test('URL: URLSearchParams handles empty key and value', () => {
    const sp = new URLSearchParams('=value&=&=novalue');
    strictEqual(sp.get(''), 'value'); // first empty key
    strictEqual(sp.getAll('').length >= 2, true);
});

// --- 19. URL canParse static -----------------------------------------------

Deno.test('URL.canParse validates URL strings', () => {
    ok(URL.canParse('http://x.com/'));
    ok(URL.canParse('https://x.com:443/p?q=1'));
    ok(!URL.canParse('not a url'));
    ok(!URL.canParse('http://[')); // invalid host
});

// --- 20. URL.parse static returns null on invalid -------------------------

Deno.test('URL.parse returns null on invalid, URL on valid', () => {
    ok(URL.parse('http://x.com/') instanceof URL);
    strictEqual(URL.parse('not a url'), null);
});

// --- 21. URL with base: relative resolution -------------------------------

Deno.test('URL: relative URL resolves against base', () => {
    const u = new URL('b/c', 'http://x.com/a/');
    strictEqual(u.href, 'http://x.com/a/b/c');
});

// --- 22. URL normalization: uppercase host lowercased ---------------------

Deno.test('URL: hostname is lowercased', () => {
    const u = new URL('http://EXAMPLE.COM/');
    strictEqual(u.hostname, 'example.com');
    strictEqual(u.host, 'example.com');
});

// --- 23. URL: setting host updates hostname + port -----------------------

Deno.test('URL: setting host updates hostname', () => {
    const u = new URL('http://x.com/');
    u.host = 'y.com:9090';
    strictEqual(u.hostname, 'y.com');
    strictEqual(u.port, '9090');
    strictEqual(u.host, 'y.com:9090');
});

// --- 24. URL: setting hostname alone does not drop port -------------------

Deno.test('URL: setting hostname alone retains port', () => {
    const u = new URL('http://x.com:8080/');
    u.hostname = 'y.com';
    strictEqual(u.hostname, 'y.com');
    strictEqual(u.port, '8080');
});

// --- 25. URL: setting port alone ------------------------------------------

Deno.test('URL: setting port alone', () => {
    const u = new URL('http://x.com/');
    u.port = '9999';
    strictEqual(u.port, '9999');
    strictEqual(u.host, 'x.com:9999');
});

// --- 26. URL: credentials in origin for special schemes -------------------

Deno.test('URL: origin does not include credentials', () => {
    const u = new URL('http://user:pass@x.com/');
    strictEqual(u.origin, 'http://x.com');
    strictEqual(u.username, 'user');
    strictEqual(u.password, 'pass');
});

// --- 27. URL: toJSON returns href ----------------------------------------

Deno.test('URL: toJSON returns href', () => {
    const u = new URL('http://x.com/p?q=1');
    strictEqual(u.toJSON(), u.href);
});

// --- 28. URL: href setter re-parses --------------------------------------

Deno.test('URL: href setter re-parses entire URL', () => {
    const u = new URL('http://x.com/a');
    u.href = 'https://y.com:8443/b?c=3#d';
    strictEqual(u.protocol, 'https:');
    strictEqual(u.host, 'y.com:8443');
    strictEqual(u.pathname, '/b');
    strictEqual(u.search, '?c=3');
    strictEqual(u.hash, '#d');
});

// --- helper ---------------------------------------------------------------

function deepStrictEqual(a: unknown, b: unknown) {
    strictEqual(JSON.stringify(a), JSON.stringify(b));
}
