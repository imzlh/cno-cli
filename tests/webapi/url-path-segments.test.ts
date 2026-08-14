import { strictEqual } from 'node:assert';

// URL path-segment handling, verified differentially against real Node v24.18.
//
// The defect these cover: #parsePath treated the EMPTY segment as a dot segment
// and dropped it, so `https://x/prefix//key.txt` collapsed to `/prefix/key.txt`.
// Per WHATWG only `.` and `..` (and their percent-encoded spellings) are dot
// segments; an empty segment is ordinary data and must survive. On the wire that
// is a different resource — for an S3-style key `//` names a different object,
// and a loopback server confirmed cno sent `/a/b` where Node sent `/a//b`.
//
// Several tests here are ANTI-REGRESSION guards rather than new behaviour: the
// `pack:/…` cases pin that `..` still shortens for non-special schemes (a
// `pack:` id that keeps `..` verbatim matches no manifest entry), and the
// `file:` cases pin the spec's drive-letter carve-out that stops `..` escaping
// `C:`. Those passed before the fix and must keep passing.

// --- 1. the core fix: empty segments are data, not dot segments -------------

Deno.test('URL: empty path segments are preserved', () => {
    strictEqual(new URL('https://x/prefix//key.txt').pathname, '/prefix//key.txt');
    strictEqual(new URL('https://x/prefix//key.txt').href, 'https://x/prefix//key.txt');
    strictEqual(new URL('https://x/a///b').pathname, '/a///b');
    strictEqual(new URL('https://x//x').pathname, '//x');
    strictEqual(new URL('https://x//a//b//').pathname, '//a//b//');
    strictEqual(new URL('file:///a//b').pathname, '/a//b');
    // An empty segment must also survive when a query follows it.
    strictEqual(new URL('https://x//?q').pathname, '//');
});

// --- 2. a path of nothing but slashes --------------------------------------

Deno.test('URL: a path of only slashes keeps every segment', () => {
    strictEqual(new URL('https://x/').pathname, '/');
    strictEqual(new URL('https://x//').pathname, '//');
    strictEqual(new URL('https://x///').pathname, '///');
    strictEqual(new URL('https://x////').pathname, '////');
    strictEqual(new URL('https://x////').href, 'https://x////');
});

// --- 3. `.` and `..` must STILL collapse ------------------------------------

Deno.test('URL: dot segments still collapse', () => {
    strictEqual(new URL('https://x/a/./b').pathname, '/a/b');
    strictEqual(new URL('https://x/a/../b').pathname, '/b');
    strictEqual(new URL('https://x/../../a').pathname, '/a');
    // `..` pops exactly one segment, and an empty segment is a segment: the
    // '..' here consumes the empty one, not 'a'.
    strictEqual(new URL('https://x/a//../b').pathname, '/a/b');
    strictEqual(new URL('https://x/a//b/../c').pathname, '/a//c');
    strictEqual(new URL('https://x/..//a').pathname, '//a');
});

// --- 4. percent-encoded dot segments ---------------------------------------

Deno.test('URL: percent-encoded dot segments are recognised', () => {
    // All four double-dot spellings, ASCII case-insensitive.
    strictEqual(new URL('https://x/a/%2e%2e/b').pathname, '/b');
    strictEqual(new URL('https://x/a/%2E%2E/b').pathname, '/b');
    strictEqual(new URL('https://x/a/.%2e/b').pathname, '/b');
    strictEqual(new URL('https://x/a/%2e./b').pathname, '/b');
    // And both single-dot spellings.
    strictEqual(new URL('https://x/a/%2e/b').pathname, '/a/b');
    strictEqual(new URL('https://x/a/%2E/b').pathname, '/a/b');
});

// --- 5. lookalikes that are NOT dot segments -------------------------------

Deno.test('URL: dot-segment lookalikes stay verbatim', () => {
    strictEqual(new URL('https://x/a/.../b').pathname, '/a/.../b');
    strictEqual(new URL('https://x/a/%2ee/b').pathname, '/a/%2ee/b');
    strictEqual(new URL('https://x/a/e%2e/b').pathname, '/a/e%2e/b');
    // Detection matches the spec's enumerated literal forms; it must NOT
    // percent-decode first. `%252e%252e` decodes to the TEXT '%2e%2e', so a
    // decode-then-compare implementation would wrongly shorten the path here.
    strictEqual(new URL('https://x/a/%252e%252e/b').pathname, '/a/%252e%252e/b');
    strictEqual(new URL('https://x/a/%2e%2e%2e/b').pathname, '/a/%2e%2e%2e/b');
    // %2f is an encoded slash, not a separator, so this is one segment.
    strictEqual(new URL('https://x/a/%2e%2f%2e/b').pathname, '/a/%2e%2f%2e/b');
});

// --- 6. trailing slashes are neither dropped nor doubled -------------------

Deno.test('URL: trailing slash is preserved exactly once', () => {
    strictEqual(new URL('https://x/a/b/').pathname, '/a/b/');
    strictEqual(new URL('https://x/a/').pathname, '/a/');
    strictEqual(new URL('https://x/a//').pathname, '/a//');
    strictEqual(new URL('https://x/a/b/').href, 'https://x/a/b/');
});

// --- 7. a FINAL dot segment still leaves the separator behind -------------

Deno.test('URL: a final dot segment leaves a trailing slash', () => {
    // The path state appends the empty string after a final dot segment, so the
    // separator the dot sat behind remains. Dropping it resolved every such
    // reference one segment short.
    strictEqual(new URL('https://x/a/b/..').pathname, '/a/');
    strictEqual(new URL('https://x/a/b/.').pathname, '/a/b/');
    strictEqual(new URL('https://x/a/b//..').pathname, '/a/b/');
    strictEqual(new URL('https://x/a/b/%2e%2e').pathname, '/a/');
    strictEqual(new URL('https://x/a/b/%2e').pathname, '/a/b/');
});

// --- 8. relative resolution -----------------------------------------------

Deno.test('URL: relative resolution preserves empty segments', () => {
    strictEqual(new URL('a//b', 'https://x/').href, 'https://x/a//b');
    strictEqual(new URL('/a//b', 'https://x/y/z').href, 'https://x/a//b');
    // The base's own empty segment must survive being partly overwritten.
    strictEqual(new URL('x', 'https://x/a//b').href, 'https://x/a//x');
    strictEqual(new URL('', 'https://x/a//b').href, 'https://x/a//b');
    strictEqual(new URL('..//x', 'https://h/a/b/c').href, 'https://h/a//x');
    strictEqual(new URL('a/%2e%2e', 'https://h/a/b').href, 'https://h/a/');
    strictEqual(new URL('a/..', 'https://h/a/b').href, 'https://h/a/');
});

// --- 9. ANTI-REGRESSION: non-special schemes still shorten on `..` --------

Deno.test('URL: pack: ids still shorten on dot segments', () => {
    // "Shorten a URL's path" applies to EVERY scheme with a list path, not just
    // special ones. A `pack:` id that kept '..' verbatim matched no manifest
    // entry, so these must not regress.
    strictEqual(new URL('pack:/a/../b').pathname, '/b');
    strictEqual(new URL('pack:/a/b/..').pathname, '/a/');
    strictEqual(new URL('../x', 'pack:/a/b').href, 'pack:/x');
    strictEqual(new URL('pack:/a/%2e%2e/b').pathname, '/b');
    // ...while still preserving empty segments.
    strictEqual(new URL('pack:/a//b').pathname, '/a//b');
    strictEqual(new URL('foo:/a//b').pathname, '/a//b');
});

// --- 10. ANTI-REGRESSION: `..` cannot escape a file: drive letter ---------

Deno.test('URL: file drive letter survives dot segments and empty segments', () => {
    strictEqual(new URL('file:///C:/..').pathname, '/C:/');
    strictEqual(new URL('file:///C:/../..').pathname, '/C:/');
    strictEqual(new URL('file:///C:/a/../b').pathname, '/C:/b');
    strictEqual(new URL('../../x', 'file:///C:/a/b').href, 'file:///C:/x');
    // The path-start state preserves the base's drive for an absolute reference.
    strictEqual(new URL('/x', 'file:///C:/dir/f.txt').href, 'file:///C:/x');
    // ...and empty segments survive alongside the drive.
    strictEqual(new URL('file:///C:/a//b').pathname, '/C:/a//b');
    strictEqual(new URL('file:///C:/a//').pathname, '/C:/a//');
    strictEqual(new URL('file://///a').pathname, '///a');
});

// --- 11. the pathname setter routes through the same path parser ----------

Deno.test('URL: pathname setter preserves empty segments and resolves dots', () => {
    const set = (base: string, value: string) => {
        const u = new URL(base);
        u.pathname = value;
        return u.pathname;
    };
    strictEqual(set('https://x/', '/a//b'), '/a//b');
    strictEqual(set('https://x/', '//'), '//');
    strictEqual(set('https://x/', 'a//b'), '/a//b');
    strictEqual(set('https://x/', '/c//d/'), '/c//d/');
    // Dot resolution goes through the same parser, so it applies here too.
    strictEqual(set('https://x/', '/b/../c'), '/c');
    strictEqual(set('https://x/', '/a/./b'), '/a/b');
    strictEqual(set('https://x/', '/a/%2e%2e/b'), '/b');
    strictEqual(set('pack:/a/b', '/c//d'), '/c//d');
});

Deno.test('URL: file pathname setter normalizes Windows separators', () => {
    const u = new URL('file:///');
    u.pathname = 'D:' + '\\' + 'docs' + '\\' + 'project' + '\\' + 'main.ts';
    strictEqual(u.href, 'file:///D:/docs/project/main.ts');
    strictEqual(u.pathname, '/D:/docs/project/main.ts');
});
