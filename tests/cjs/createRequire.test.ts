import { strictEqual, ok } from 'node:assert';

// ============================================================================
// CJS ↔ ESM interop — require of ESM, import of CJS, createRequire
// cno runtime does NOT define __dirname in ESM scope — verify that first.
// ============================================================================

Deno.test('cjs: __dirname is undefined in ESM scope', () => {
    // cno runs test files as ESM, so __dirname is not injected.
    // This is a deliberate difference from Node.js — document it.
    ok(typeof __dirname === 'undefined');
});

Deno.test('cjs: createRequire returns a function', () => {
    const { createRequire } = require('node:module');
    ok(typeof createRequire === 'function');
});

Deno.test('cjs: createRequire(import.meta.url) returns working require', () => {
    const { createRequire } = require('node:module');
    const req = createRequire(import.meta.url);
    ok(typeof req === 'function');
    const assert = req('node:assert');
    ok(typeof assert.strictEqual === 'function');
});
