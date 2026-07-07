import { strictEqual, ok, throws } from 'node:assert';

// ============================================================================
// Web API — Location
// ============================================================================

Deno.test('webapi: location exists on globalThis', () => {
    ok(typeof location === 'object');
});

Deno.test('webapi: location is Location instance', () => {
    ok(location instanceof Location);
});

Deno.test('webapi: location exposes about:blank URL shape', () => {
    strictEqual(location.href, 'about:blank');
    strictEqual(location.origin, 'null');
    strictEqual(location.protocol, 'about:');
    strictEqual(location.host, '');
    strictEqual(location.hostname, '');
    strictEqual(location.port, '');
    strictEqual(location.pathname, 'blank');
    strictEqual(location.search, '');
    strictEqual(location.hash, '');
});

Deno.test('webapi: location navigation methods throw', () => {
    throws(() => location.assign('https://example.com'), /Not supported/);
    throws(() => location.replace('https://example.com'), /Not supported/);
    throws(() => location.reload(), /Not supported/);
});

Deno.test('webapi: location setters throw instead of silently mutating', () => {
    throws(() => { location.href = 'https://example.com'; }, /Not supported/);
    throws(() => { location.protocol = 'https:'; }, /Not supported/);
    throws(() => { location.hash = '#x'; }, /Not supported/);
});

Deno.test('webapi: location.ancestorOrigins is DOMStringList', () => {
    ok(location.ancestorOrigins !== undefined);
    strictEqual(location.ancestorOrigins.length, 0);
    strictEqual(location.ancestorOrigins.item(0), null);
});

Deno.test('webapi: location.toString returns href', () => {
    strictEqual(location.toString(), location.href);
});
