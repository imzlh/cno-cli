import { strictEqual, ok } from 'node:assert';

// ============================================================================
// Web API — Location
// ============================================================================

Deno.test('webapi: location exists on globalThis', () => {
    ok(typeof location === 'object');
});

Deno.test('webapi: location is URL instance', () => {
    ok(location instanceof URL);
});

Deno.test('webapi: location.href is string', () => {
    ok(typeof location.href === 'string');
});

Deno.test('webapi: location.protocol is string', () => {
    ok(typeof location.protocol === 'string');
});

Deno.test('webapi: location.host is string', () => {
    ok(typeof location.host === 'string');
});

Deno.test('webapi: location.hostname is string', () => {
    ok(typeof location.hostname === 'string');
});

Deno.test('webapi: location.port is string', () => {
    ok(typeof location.port === 'string');
});

Deno.test('webapi: location.pathname is string', () => {
    ok(typeof location.pathname === 'string');
});

Deno.test('webapi: location.search is string', () => {
    ok(typeof location.search === 'string');
});

Deno.test('webapi: location.hash is string', () => {
    ok(typeof location.hash === 'string');
});

Deno.test('webapi: location.assign throws', () => {
    ok(() => location.assign('https://example.com')).throws();
});

Deno.test('webapi: location.replace throws', () => {
    ok(() => location.replace('https://example.com')).throws();
});

Deno.test('webapi: location.reload throws', () => {
    ok(() => location.reload()).throws();
});

Deno.test('webapi: location.ancestorOrigins is DOMStringList', () => {
    ok(location.ancestorOrigins !== undefined);
});

Deno.test('webapi: location.toString returns href', () => {
    strictEqual(location.toString(), location.href);
});
