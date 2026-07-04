import { strictEqual, ok, match } from 'node:assert';

// ============================================================================
// CJS ↔ ESM interop — require of ESM, import of CJS, createRequire
// ============================================================================

// --- 1. createRequire returns a function -----------------------------------
Deno.test('cjs: createRequire returns a require function', () => {
    const { createRequire } = require('node:module');
    const req = createRequire(require('node:path').join(__dirname, 'file.js'));
    ok(typeof req === 'function');
});

// --- 2. require of this very module resolves ------------------------------
Deno.test('cjs: require resolves a .ts/.js file', () => {
    const { createRequire } = require('node:module');
    const req = createRequire(import.meta.url);
    const assert = req('node:assert');
    ok(typeof assert.strictEqual === 'function');
});
