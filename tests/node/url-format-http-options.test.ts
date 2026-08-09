import { deepStrictEqual, strictEqual } from 'node:assert';
import * as nodeUrl from 'node:url';

// Every expected value below was captured from node v24.18.0 on the same
// machine by running the identical calls under both runtimes and diffing.

Deno.test('url: urlToHttpOptions returns a null-prototype object', () => {
    const options = nodeUrl.urlToHttpOptions(new URL('http://example.com/a'));
    strictEqual(Object.getPrototypeOf(options), null);
    // The point of the null prototype: a missing option must read as
    // undefined, never as an inherited Object.prototype member.
    strictEqual((options as Record<string, unknown>).toString, undefined);
    strictEqual((options as Record<string, unknown>).constructor, undefined);
    strictEqual((options as Record<string, unknown>).hasOwnProperty, undefined);
});

Deno.test('url: urlToHttpOptions strips IPv6 brackets from hostname', () => {
    // hostname feeds net.connect/dns, which reject the bracketed form.
    strictEqual(nodeUrl.urlToHttpOptions(new URL('http://[::1]:8/x')).hostname, '::1');
    strictEqual(
        nodeUrl.urlToHttpOptions(new URL('http://[2001:db8::1]/x')).hostname,
        '2001:db8::1',
    );
    // host/href keep the brackets — only hostname is unwrapped.
    strictEqual(nodeUrl.urlToHttpOptions(new URL('http://[::1]:8/x')).href, 'http://[::1]:8/x');
    // A normal hostname is untouched, and a leading '[' is the only trigger.
    strictEqual(nodeUrl.urlToHttpOptions(new URL('http://example.com/')).hostname, 'example.com');
    strictEqual(nodeUrl.urlToHttpOptions(new URL('http://[::1]:8/x')).port, 8);
});

Deno.test('url: urlToHttpOptions preserves a subclass own property', () => {
    class Tagged extends URL {
        tag = 'kept';
    }
    const options = nodeUrl.urlToHttpOptions(new Tagged('http://example.com/a'));
    strictEqual((options as unknown as { tag?: string }).tag, 'kept');
    strictEqual(options.hostname, 'example.com');
});

Deno.test('url: format omits "//" when a slashed protocol has no authority', () => {
    // The "//" and the implied leading slash are gated on (slashes || host),
    // not on the protocol alone.
    strictEqual(nodeUrl.format({ protocol: 'http:' }), 'http:');
    strictEqual(nodeUrl.format({ protocol: 'http:', slashes: false }), 'http:');
    strictEqual(nodeUrl.format({ protocol: 'http:', pathname: 'b' }), 'http:b');
    strictEqual(nodeUrl.format({ protocol: 'http:', pathname: '/b' }), 'http:/b');
    strictEqual(nodeUrl.format({ protocol: 'ws:', pathname: 'b' }), 'ws:b');
    // An empty host string is not a host.
    strictEqual(nodeUrl.format({ protocol: 'http:', host: '', pathname: 'b' }), 'http:b');
    strictEqual(nodeUrl.format({ protocol: 'http:', hostname: '', pathname: 'b' }), 'http:b');
});

Deno.test('url: format adds "//" and a leading slash when slashes is explicit', () => {
    strictEqual(nodeUrl.format({ protocol: 'http:', pathname: 'b', slashes: true }), 'http:///b');
    strictEqual(nodeUrl.format({ protocol: 'foo:', pathname: 'b', slashes: true }), 'foo:///b');
    strictEqual(nodeUrl.format({ pathname: 'b', slashes: true }), '///b');
    strictEqual(nodeUrl.format({ slashes: true }), '//');
    strictEqual(nodeUrl.format({ slashes: true, host: 'a' }), '//a');
    strictEqual(nodeUrl.format({ protocol: 'http:', host: '', pathname: 'b', slashes: true }), 'http:///b');
});

Deno.test('url: format does not slash-separate a host under a non-slashed protocol', () => {
    // No slashed protocol and no `slashes` flag: the parts are concatenated raw.
    strictEqual(nodeUrl.format({ host: 'a', pathname: 'b' }), 'ab');
    strictEqual(nodeUrl.format({ host: 'a', pathname: 'b', slashes: false }), 'ab');
    strictEqual(nodeUrl.format({ protocol: 'foo:', host: 'a', pathname: 'b' }), 'foo:ab');
    strictEqual(nodeUrl.format({ protocol: 'foo', host: 'a', pathname: 'b', slashes: false }), 'foo:ab');
    strictEqual(nodeUrl.format({ protocol: 'mailto:', host: 'a', pathname: 'b' }), 'mailto:ab');
    // With slashes the same input gains both separators.
    strictEqual(nodeUrl.format({ protocol: 'foo:', host: 'a', pathname: 'b', slashes: true }), 'foo://a/b');
});

Deno.test('url: format drops auth when there is no host to attach it to', () => {
    // Node only ever emits auth as a prefix of a non-empty host.
    strictEqual(nodeUrl.format({ protocol: 'http:', auth: 'u:p', pathname: 'b' }), 'http:b');
    strictEqual(nodeUrl.format({ protocol: 'http:', auth: 'u:p' }), 'http:');
    strictEqual(nodeUrl.format({ protocol: 'foo:', auth: 'u:p', pathname: 'b' }), 'foo:b');
    strictEqual(nodeUrl.format({ auth: 'u:p', pathname: 'b' }), 'b');
    strictEqual(nodeUrl.format({ protocol: 'foo:', auth: 'u:p', pathname: 'b', slashes: true }), 'foo:///b');
    // With a host, auth is kept and precedes it.
    strictEqual(
        nodeUrl.format({ protocol: 'http:', host: 'a', auth: 'u:p', pathname: 'b' }),
        'http://u:p@a/b',
    );
});

Deno.test('url: format keeps the file: authority carve-out', () => {
    // `file:` still gains a bare "//" with no host at all.
    strictEqual(nodeUrl.format({ protocol: 'file' }), 'file://');
    strictEqual(nodeUrl.format({ protocol: 'file:' }), 'file://');
    strictEqual(nodeUrl.format({ protocol: 'file:', pathname: 'b' }), 'file://b');
    strictEqual(nodeUrl.format({ protocol: 'file:', pathname: '/b' }), 'file:///b');
    // A protocol that merely starts with "file" is not slashed, so no "//".
    strictEqual(nodeUrl.format({ protocol: 'filex:' }), 'filex:');
    strictEqual(nodeUrl.format({ protocol: 'fil:' }), 'fil:');
});

Deno.test('url: format still handles ordinary host and hostname inputs', () => {
    // Guard the common paths against an over-broad change to the gating.
    strictEqual(nodeUrl.format({ protocol: 'http:', host: 'a', pathname: '/b' }), 'http://a/b');
    strictEqual(nodeUrl.format({ protocol: 'http:', hostname: 'a', pathname: 'b' }), 'http://a/b');
    strictEqual(nodeUrl.format({ protocol: 'http:', hostname: 'a', port: 81 }), 'http://a:81');
    strictEqual(nodeUrl.format({ protocol: 'http:', hostname: '::1', port: 81 }), 'http://[::1]:81');
    strictEqual(
        nodeUrl.format({ protocol: 'http:', hostname: 'a', pathname: '/b', search: '?c=1', hash: '#d' }),
        'http://a/b?c=1#d',
    );
    deepStrictEqual(nodeUrl.format({ protocol: 'http:', hostname: 'a', query: { c: 1, d: 2 } }), 'http://a?c=1&d=2');
});
