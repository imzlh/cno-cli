import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';
import * as url from 'node:url';
import * as nodeUrl from 'node:url';
import * as path from 'node:path';

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

// pathToFileURL runs the input through path.resolve, so a driveless "/tmp/x"
// gains the cwd's drive on Windows. Real Node: file:///D:/tmp/foo.txt.
Deno.test('url: fileURLToPath and pathToFileURL round-trip', () => {
    const p = path.resolve('/tmp/foo.txt');
    const u = url.pathToFileURL(p);
    ok(u instanceof URL);
    strictEqual(u.protocol, 'file:');
    strictEqual(url.fileURLToPath(u), p);
});

Deno.test('url: pathToFileURL percent-encodes URL syntax characters', () => {
    strictEqual(url.pathToFileURL('/tmp/a#b?c', { windows: false }).href, 'file:///tmp/a%23b%3Fc');
});

Deno.test('url: pathToFileURL resolves driveless and drive-relative Windows paths', () => {
    const drive = path.win32.resolve('/').slice(0, 2);
    strictEqual(url.pathToFileURL('/tmp/x', { windows: true }).href, `file:///${drive}/tmp/x`);
    strictEqual(url.pathToFileURL('C:a', { windows: true }).href, 'file:///C:/a');
    strictEqual(url.pathToFileURL('C:\\a\\..\\b', { windows: true }).href, 'file:///C:/b');
    strictEqual(url.pathToFileURL('C:\\dir\\', { windows: true }).href, 'file:///C:/dir/');
});

Deno.test('url: pathToFileURL encodes the Node file-URL set, including ~', () => {
    strictEqual(url.pathToFileURL('C:\\a b\\c', { windows: true }).href, 'file:///C:/a%20b/c');
    strictEqual(url.pathToFileURL('C:\\a~b', { windows: true }).href, 'file:///C:/a%7Eb');
    strictEqual(url.pathToFileURL('C:\\a%b', { windows: true }).href, 'file:///C:/a%25b');
    strictEqual(url.pathToFileURL('C:\\a[b]|c', { windows: true }).href, 'file:///C:/a%5Bb%5D%7Cc');
    strictEqual(url.pathToFileURL('/a\\b', { windows: false }).href, 'file:///a%5Cb');
});

Deno.test('url: pathToFileURL handles UNC paths and rejects malformed ones', () => {
    strictEqual(url.pathToFileURL('\\\\srv\\share\\f', { windows: true }).href, 'file://srv/share/f');
    strictEqual(url.pathToFileURL('\\\\?\\UNC\\srv\\share\\f', { windows: true }).href, 'file://srv/share/f');
    strictEqual(url.pathToFileURL('\\\\?\\C:\\a', { windows: true }).href, 'file:///C:/a');
    // Node punycodes the UNC servername via domainToASCII.
    strictEqual(url.pathToFileURL('\\\\пример.рф\\s\\f', { windows: true }).href, 'file://xn--e1afmkfd.xn--p1ai/s/f');
    throws(() => url.pathToFileURL('\\\\srv', { windows: true }), { code: 'ERR_INVALID_ARG_VALUE' });
    throws(() => url.pathToFileURL('\\\\\\x', { windows: true }), { code: 'ERR_INVALID_ARG_VALUE' });
});

Deno.test('url: fileURLToPath maps UNC hosts and rejects driveless Windows paths', () => {
    strictEqual(url.fileURLToPath('file://srv/share/f', { windows: true }), '\\\\srv\\share\\f');
    strictEqual(url.fileURLToPath('file://xn--e1afmkfd.xn--p1ai/s/f', { windows: true }), '\\\\пример.рф\\s\\f');
    strictEqual(url.fileURLToPath('file:///C:/a%20b', { windows: true }), 'C:\\a b');
    throws(() => url.fileURLToPath('file:///tmp/foo.txt', { windows: true }), { code: 'ERR_INVALID_FILE_URL_PATH' });
    throws(() => url.fileURLToPath('file:///C:/a%5Cb', { windows: true }), { code: 'ERR_INVALID_FILE_URL_PATH' });
    throws(() => url.fileURLToPath('file://host/x', { windows: false }), { code: 'ERR_INVALID_FILE_URL_HOST' });
});

Deno.test('url: fileURLToPath rejects encoded slash on POSIX paths', () => {
    throws(() => url.fileURLToPath('file:///tmp/a%2Fb'), TypeError);
});

// Regression: subclassing globalThis.URL broke super() on QuickJS ("not a function").
Deno.test('url: fileURLToPath accepts import.meta.url string', () => {
    const p = url.fileURLToPath(import.meta.url);
    ok(typeof p === 'string' && p.length > 0);
    ok(p.includes('url-edge') || p.endsWith('.ts') || p.endsWith('.js'));
});

Deno.test('url: node:url URL constructs like globalThis.URL', () => {
    const u = new nodeUrl.URL('file:///tmp/x');
    strictEqual(u.href, 'file:///tmp/x');
    strictEqual(nodeUrl.URL, globalThis.URL);
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

Deno.test('url: URL setters remain writable after node:url patching', () => {
    const u = new URL('https://example.com/a b?x=1');
    const params = u.searchParams;

    u.pathname = '/next path';
    strictEqual(u.pathname, '/next%20path');

    u.search = '';
    strictEqual(u.search, '');
    strictEqual(u.searchParams, params);
    strictEqual(params.size, 0);

    params.append('after', 'clear');
    strictEqual(u.search, '?after=clear');

    u.href = 'https://example.com/final path?z=9';
    strictEqual(u.pathname, '/final%20path');
    strictEqual(u.search, '?z=9');
    strictEqual(u.searchParams, params);
    strictEqual(params.get('z'), '9');
});

// --- 9. domainToASCII / domainToUnicode --------------------------------------

// Legacy url.parse has a "simple path" fast path: with no protocol, no `#` and
// no `@`, `//foo/bar` is a PATH, not a host. It also only defaults pathname to
// "/" for slashed protocols, and only emits "//" when slashes is set.
Deno.test('url upstream: parse treats protocol-relative input as a simple path', () => {
    const u = url.parse('//foo/bar');
    strictEqual(u.protocol, null);
    strictEqual(u.slashes, null);
    strictEqual(u.host, null);
    strictEqual(u.pathname, '//foo/bar');
    strictEqual(u.href, '//foo/bar');
    // slashesDenoteHost flips it to a host, but pathname stays null.
    const h = url.parse('//foo', false, true);
    strictEqual(h.host, 'foo');
    strictEqual(h.pathname, null);
    strictEqual(h.href, '//foo');
});

Deno.test('url upstream: parse gives a non-slashed protocol a host but no default pathname', () => {
    const u = url.parse('mailto:me@example.com');
    strictEqual(u.protocol, 'mailto:');
    strictEqual(u.slashes, null);
    strictEqual(u.auth, 'me');
    strictEqual(u.host, 'example.com');
    strictEqual(u.pathname, null);
    strictEqual(u.href, 'mailto:me@example.com');
});

Deno.test('url upstream: parse keeps an empty host for a slashed protocol', () => {
    const u = url.parse('file:///c:/x');
    strictEqual(u.host, '');
    strictEqual(u.hostname, '');
    strictEqual(u.pathname, '/c:/x');
});

Deno.test('url upstream: parse ends the host at non-host characters', () => {
    // ":st" is not a port, so it moves into the path.
    strictEqual(url.parse('http://ho:st/p').hostname, 'ho');
    strictEqual(url.parse('http://ho:st/p').pathname, '/:st/p');
    // Only the trailing all-digit group is a port.
    strictEqual(url.parse('http://a:1:2/p').host, 'a:2');
    strictEqual(url.parse('http://a:1:2/p').pathname, '/:1/p');
    strictEqual(url.parse('http://a;b/p').hostname, 'a');
    strictEqual(url.parse('http://a|b/p').pathname, '%7Cb/p');
    strictEqual(url.parse('http://a b/p').pathname, '%20b/p');
    // A hostname over 255 chars is dropped entirely.
    strictEqual(url.parse(`http://${'h'.repeat(300)}/p`).host, '');
});

Deno.test('url upstream: parse punycodes a non-ASCII hostname', () => {
    strictEqual(url.parse('http://中文.com/p').hostname, 'xn--fiq228c.com');
    strictEqual(url.parse('http://中文.com/p').href, 'http://xn--fiq228c.com/p');
});

Deno.test('url upstream: format only adds // for slashes or a slashed protocol', () => {
    strictEqual(nodeUrl.format({ host: 'h', pathname: '/p' }), 'h/p');
    strictEqual(nodeUrl.format({ protocol: 'foo:', host: 'h' }), 'foo:h');
    strictEqual(nodeUrl.format({ protocol: 'http:', host: 'h' }), 'http://h');
    strictEqual(nodeUrl.format({ protocol: 'foo:', host: 'h', slashes: true }), 'foo://h');
});

Deno.test('url upstream: resolve falls back to the legacy resolver for a bare path base', () => {
    strictEqual(url.resolve('/a/b/c', 'd'), '/a/b/d');
});

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

// UTS-46 runs with VerifyDnsLength=false and UseSTD3ASCIIRules=false, so a long
// ASCII label and `!$&'()*+,;=~` are all legal, while `xn--`/`xn--a` are not
// valid A-labels (they decode to nothing / to a C1 control).
Deno.test('url upstream: domainToASCII follows the UTS-46 ASCII rules', () => {
    strictEqual(nodeUrl.domainToASCII('xn--'), '');
    strictEqual(nodeUrl.domainToASCII('xn--a'), '');
    strictEqual(nodeUrl.domainToASCII('xn--aa'), '');
    strictEqual(nodeUrl.domainToASCII('a!b'), 'a!b');
    strictEqual(nodeUrl.domainToASCII('a~b'), 'a~b');
    strictEqual(nodeUrl.domainToASCII("a'b"), "a'b");
    strictEqual(nodeUrl.domainToASCII('a;b'), 'a;b');
    strictEqual(nodeUrl.domainToASCII('a{b}'), 'a{b}');
    // A 70-char ASCII label is accepted (no DNS length check).
    strictEqual(nodeUrl.domainToASCII(`${'x'.repeat(70)}.com`), `${'x'.repeat(70)}.com`);
    // Tab/LF/CR are stripped; `#/?\` truncate the domain rather than failing.
    strictEqual(nodeUrl.domainToASCII('a/b'), 'a');
    strictEqual(nodeUrl.domainToASCII('a?b'), 'a');
    strictEqual(nodeUrl.domainToASCII('a\tb'), 'ab');
    // Other disallowed ASCII still fails.
    strictEqual(nodeUrl.domainToASCII('a:b'), '');
    strictEqual(nodeUrl.domainToASCII('a b'), '');
    strictEqual(nodeUrl.domainToASCII('a|b'), '');
});

Deno.test('url upstream: domainToUnicode lowercases and rejects invalid A-labels', () => {
    strictEqual(nodeUrl.domainToUnicode('EXAMPLE.COM'), 'example.com');
    strictEqual(nodeUrl.domainToUnicode('XN--FIQ228C.COM'), '中文.com');
    strictEqual(nodeUrl.domainToUnicode('xn--a'), '');
    strictEqual(nodeUrl.domainToUnicode('xn--a.com'), '');
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
