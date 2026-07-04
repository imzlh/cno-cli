import { strictEqual, ok } from 'node:assert';

// ============================================================================
// Web API — Storage (localStorage / sessionStorage)
// ============================================================================

Deno.test('webapi: localStorage exists', () => {
    ok(typeof localStorage === 'object');
    ok(typeof localStorage.getItem === 'function');
    ok(typeof localStorage.setItem === 'function');
    ok(typeof localStorage.removeItem === 'function');
    ok(typeof localStorage.clear === 'function');
});

Deno.test('webapi: localStorage set/get round-trip', () => {
    localStorage.setItem('test-key-1', 'value-1');
    strictEqual(localStorage.getItem('test-key-1'), 'value-1');
    localStorage.removeItem('test-key-1');
});

Deno.test('webapi: localStorage getItem returns null for missing', () => {
    strictEqual(localStorage.getItem('nonexistent-key-xyz'), null);
});

Deno.test('webapi: localStorage removeItem removes', () => {
    localStorage.setItem('test-key-2', 'value-2');
    localStorage.removeItem('test-key-2');
    strictEqual(localStorage.getItem('test-key-2'), null);
});

Deno.test('webapi: localStorage clear removes all', () => {
    localStorage.setItem('test-key-a', 'a');
    localStorage.setItem('test-key-b', 'b');
    localStorage.clear();
    strictEqual(localStorage.getItem('test-key-a'), null);
    strictEqual(localStorage.getItem('test-key-b'), null);
});

Deno.test('webapi: localStorage length property', () => {
    localStorage.clear();
    localStorage.setItem('k1', 'v1');
    localStorage.setItem('k2', 'v2');
    ok(localStorage.length >= 2);
});

Deno.test('webapi: localStorage key() returns key at index', () => {
    localStorage.clear();
    localStorage.setItem('idx-key', 'val');
    const key = localStorage.key(0);
    ok(typeof key === 'string');
});

Deno.test('webapi: sessionStorage exists and works', () => {
    ok(typeof sessionStorage === 'object');
    sessionStorage.setItem('sess-key', 'sess-value');
    strictEqual(sessionStorage.getItem('sess-key'), 'sess-value');
    sessionStorage.removeItem('sess-key');
});

Deno.test('webapi: localStorage and sessionStorage are independent', () => {
    localStorage.setItem('shared-key', 'local-value');
    sessionStorage.setItem('shared-key', 'session-value');
    strictEqual(localStorage.getItem('shared-key'), 'local-value');
    strictEqual(sessionStorage.getItem('shared-key'), 'session-value');
    localStorage.clear();
    sessionStorage.clear();
});
