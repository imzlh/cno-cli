import { strictEqual, ok } from 'node:assert';
import { parseInspectFlags } from '../../src/commands/inspect';

// --- 1. bare `--inspect` defaults ------------------------------------------

Deno.test('inspector: bare --inspect defaults to 127.0.0.1:9229, no break', () => {
    const o = parseInspectFlags({ inspect: true });
    ok(o, 'must parse');
    strictEqual(o!.host, '127.0.0.1');
    strictEqual(o!.port, 9229);
    strictEqual(o!.breakOnStart, false);
    strictEqual(o!.waitForClient, false);
});

// --- 2. `--inspect=port` keeps default host --------------------------------

Deno.test('inspector: --inspect=9333 parses custom port, default host', () => {
    const o = parseInspectFlags({ inspect: '9333' })!;
    strictEqual(o.host, '127.0.0.1');
    strictEqual(o.port, 9333);
});

// --- 3. `--inspect=host:port` splits correctly -----------------------------

Deno.test('inspector: --inspect=0.0.0.0:9444 splits host and port', () => {
    const o = parseInspectFlags({ inspect: '0.0.0.0:9444' })!;
    strictEqual(o.host, '0.0.0.0');
    strictEqual(o.port, 9444);
});

// --- 4. `--inspect-brk` sets breakOnStart (non-repl) ----------------------

Deno.test('inspector: --inspect-brk sets breakOnStart=true outside REPL', () => {
    const o = parseInspectFlags({ 'inspect-brk': true })!;
    strictEqual(o.breakOnStart, true);
    strictEqual(o.waitForClient, false);
    strictEqual(o.port, 9229);
});

// --- 5. `--inspect-brk` in REPL does NOT break on start --------------------
//
// Intentional asymmetry: a REPL should connect and let you type; only
// `--inspect-wait` defers execution. Verify the flag flips breakOnStart off
// when repl=true.

Deno.test('inspector: --inspect-brk in REPL sets breakOnStart=false', () => {
    const o = parseInspectFlags({ 'inspect-brk': true }, true)!;
    strictEqual(o.breakOnStart, false);
    strictEqual(o.waitForClient, true);
});

// --- 6. `--inspect-wait` sets waitForClient -------------------------------

Deno.test('inspector: --inspect-wait sets waitForClient=true', () => {
    const o = parseInspectFlags({ 'inspect-wait': true })!;
    strictEqual(o.waitForClient, true);
    strictEqual(o.breakOnStart, false);
});

// --- 7. no inspect flags -> null -------------------------------------------

Deno.test('inspector: absent flags return null', () => {
    strictEqual(parseInspectFlags({}), null);
    strictEqual(parseInspectFlags({ silent: true }), null);
});

// --- 8. invalid port falls back to 9229 ------------------------------------

Deno.test('inspector: non-numeric port falls back to 9229', () => {
    const o = parseInspectFlags({ inspect: 'abc' })!;
    strictEqual(o.port, 9229);
});

// --- 9. precedence: inspect-brk wins over inspect -------------------------

Deno.test('inspector: inspect-brk takes precedence over inspect', () => {
    const o = parseInspectFlags({ inspect: true, 'inspect-brk': '9333' })!;
    strictEqual(o.breakOnStart, true);
    strictEqual(o.port, 9333);
});

// --- 10. `--inspect=true` (string) treats as bare -------------------------

Deno.test('inspector: --inspect=true string is treated as bare flag', () => {
    const o = parseInspectFlags({ inspect: 'true' })!;
    strictEqual(o.port, 9229);
    strictEqual(o.host, '127.0.0.1');
});

Deno.test('inspector: empty host before colon falls back to 127.0.0.1', () => {
    const o = parseInspectFlags({ inspect: ':9555' })!;
    strictEqual(o.host, '127.0.0.1');
    strictEqual(o.port, 9555);
});

Deno.test('inspector: host is trimmed around host:port syntax', () => {
    const o = parseInspectFlags({ inspect: ' 0.0.0.0 :9444 ' })!;
    strictEqual(o.host, '0.0.0.0');
    strictEqual(o.port, 9444);
});

Deno.test('inspector: port 0 falls back to 9229', () => {
    const o = parseInspectFlags({ inspect: '127.0.0.1:0' })!;
    strictEqual(o.host, '127.0.0.1');
    strictEqual(o.port, 9229);
});

Deno.test('inspector: inspect-wait takes precedence over inspect', () => {
    const o = parseInspectFlags({ inspect: '9333', 'inspect-wait': '9444' })!;
    strictEqual(o.waitForClient, true);
    strictEqual(o.breakOnStart, false);
    strictEqual(o.port, 9444);
});
