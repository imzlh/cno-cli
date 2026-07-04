import { strictEqual, ok } from 'node:assert';

// ============================================================================
// repl — Read-Eval-Print Loop
// ============================================================================

Deno.test('repl: start returns REPLServer', () => {
    const repl = require('node:repl');
    const server = repl.start();
    ok(typeof server === 'object');
});

Deno.test('repl: start with prompt option', () => {
    const repl = require('node:repl');
    const server = repl.start({ prompt: '> ' });
    ok(typeof server === 'object');
});

Deno.test('repl: REPLServer.defineCommand is callable', () => {
    const repl = require('node:repl');
    const server = repl.start();
    ok(typeof server.defineCommand === 'function');
    server.defineCommand('test', { help: 'test cmd', action: () => {} });
    ok(true);
});

Deno.test('repl: REPLServer.displayPrompt is callable', () => {
    const repl = require('node:repl');
    const server = repl.start();
    ok(typeof server.displayPrompt === 'function');
    server.displayPrompt();
    ok(true);
});

Deno.test('repl: REPL_MODE_SLOPPY and REPL_MODE_STRICT are symbols', () => {
    const repl = require('node:repl');
    ok(typeof repl.REPL_MODE_SLOPPY === 'symbol');
    ok(typeof repl.REPL_MODE_STRICT === 'symbol');
    ok(repl.REPL_MODE_SLOPPY !== repl.REPL_MODE_STRICT);
});

Deno.test('repl: builtinModules is array', () => {
    const repl = require('node:repl');
    ok(Array.isArray(repl.builtinModules));
});

Deno.test('repl: recoveredFromError is boolean', () => {
    const repl = require('node:repl');
    ok(typeof repl.recoveredFromError === 'boolean');
});
