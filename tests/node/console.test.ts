import { doesNotThrow, strictEqual, ok, match } from 'node:assert';
import * as console_ from 'node:console';
import { Console } from 'node:console';
import process from 'node:process';
import { Writable } from 'node:stream';
import vm from 'node:vm';

async function captureWarnings(fn: () => void): Promise<string[]> {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.message);
    process.on('warning', onWarning);
    try {
        fn();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return warnings;
    } finally {
        process.off('warning', onWarning);
    }
}

// --- 1. console.log/info/warn/error write to the right stream --------------

Deno.test('console: log/info go to stdout, warn/error go to stderr', async () => {
    let out = '';
    let err = '';
    const stdout = new Writable({
        write(c: Buffer, _e, cb) { out += c.toString(); cb(); },
    });
    const stderr = new Writable({
        write(c: Buffer, _e, cb) { err += c.toString(); cb(); },
    });
    const c = new Console(stdout, stderr);
    c.log('L');
    c.info('I');
    c.warn('W');
    c.error('E');
    await new Promise((r) => setTimeout(r, 10));
    ok(out.includes('L'), 'log must go to stdout');
    ok(out.includes('I'), 'info must go to stdout');
    ok(err.includes('W'), 'warn must go to stderr');
    ok(err.includes('E'), 'error must go to stderr');
});

// --- 2. console.assert only writes on falsy condition ---------------------

Deno.test('console: assert only writes when assertion is false', async () => {
    let err = '';
    const stderr = new Writable({ write(c: Buffer, _e, cb) { err += c.toString(); cb(); } });
    const stdout = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console(stdout, stderr);
    c.assert(true, 'should-not-appear');
    c.assert(false, 'must-appear');
    await new Promise((r) => setTimeout(r, 10));
    ok(!err.includes('should-not-appear'));
    ok(err.includes('must-appear'));
});

// --- 3. console.count / countReset ----------------------------------------

Deno.test('console: count increments and countReset clears', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const stderr = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console(stdout, stderr);
    c.count('a');
    c.count('a');
    c.countReset('a');
    c.count('a');
    await new Promise((r) => setTimeout(r, 10));
    ok(out.includes('a: 1'));
    ok(out.includes('a: 2'));
    // after reset, the next is 1 again
    const idx = out.lastIndexOf('a:');
    ok(out.slice(idx).startsWith('a: 1'), 'after countReset, count restarts at 1');
});

// --- 4. console.time / timeEnd --------------------------------------------

Deno.test('console: time/timeEnd logs elapsed', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const stderr = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console(stdout, stderr);
    c.time('t');
    await new Promise((r) => setTimeout(r, 20));
    c.timeEnd('t');
    await new Promise((r) => setTimeout(r, 10));
    match(out, /t: \d+\.\d+ms/, 'timeEnd must log elapsed ms');
});

// --- 5. console.dir inspects an object ------------------------------------

Deno.test('console: dir inspects object', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const stderr = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console(stdout, stderr);
    c.dir({ a: 1 });
    await new Promise((r) => setTimeout(r, 10));
    ok(out.includes('a: 1') || out.includes("'a'") || out.includes('a:'));
});

// --- 6. console.table renders tabular data --------------------------------

Deno.test('console: table renders rows', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const stderr = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console(stdout, stderr);
    c.table([{ a: 1, b: 2 }]);
    await new Promise((r) => setTimeout(r, 10));
    ok(out.length > 0, 'table must produce output');
    ok(out.includes('1') && out.includes('2'));
});

// --- 7. console.group / groupEnd indent -----------------------------------

Deno.test('console: group/groupEnd indent', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const stderr = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console({ stdout, stderr, ignoreErrors: false, groupIndentation: 2 });
    c.group('G');
    c.log('inside');
    c.groupEnd();
    await new Promise((r) => setTimeout(r, 10));
    ok(out.includes('inside'));
    // indented line should have leading spaces
    ok(out.includes('  inside'), 'group must indent by groupIndentation');
});

Deno.test('console: options object constructor honors nested groupIndentation', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const stderr = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console({ stdout, stderr, groupIndentation: 4, colorMode: false });
    c.group('G');
    c.group('H');
    c.log('x');
    c.groupEnd();
    c.groupEnd();
    await new Promise((r) => setTimeout(r, 10));
    ok(out.includes('        x'), 'nested groups must indent cumulatively');
});

Deno.test('console: groupCollapsed indents like group', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const c = new Console({ stdout, stderr: stdout, groupIndentation: 2, colorMode: false });
    c.groupCollapsed('G');
    c.log('x');
    c.groupEnd();
    await new Promise((r) => setTimeout(r, 10));
    strictEqual(out, 'G\n  x\n');
});

Deno.test('console: timeLog includes label and extra arguments', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const c = new Console(stdout);
    c.time('t');
    c.timeLog('t', 'mid');
    c.timeEnd('t');
    await new Promise((r) => setTimeout(r, 10));
    match(out, /t: \d+\.\d+ms mid/);
    match(out, /t: \d+\.\d+ms/);
});

// --- 8. global console exists ---------------------------------------------

Deno.test('global console exists', () => {
    ok(typeof console !== 'undefined');
    ok(typeof console.log === 'function');
    ok(typeof console.error === 'function');
});

Deno.test('console: namespace Console export matches named import', () => {
    strictEqual(console_.Console, Console);
});

Deno.test('console: single-stream constructor routes error output to the same stream', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const c = new Console(stdout);
    c.error('e');
    await new Promise((r) => setTimeout(r, 10));
    strictEqual(out, 'e\n');
});

Deno.test('console: count without label uses default label', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const c = new Console(stdout);
    c.count();
    c.count();
    await new Promise((r) => setTimeout(r, 10));
    strictEqual(out, 'default: 1\ndefault: 2\n');
});

Deno.test('console: countReset missing label emits process warning', async () => {
    const stdout = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console(stdout);
    const warnings = await captureWarnings(() => c.countReset('missing-count'));
    ok(warnings.some((message) => message.includes("Count for 'missing-count' does not exist")));
});

Deno.test('console: duplicate time and missing time labels emit process warnings', async () => {
    const stdout = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console(stdout);
    const warnings = await captureWarnings(() => {
        c.time('dup-time');
        c.time('dup-time');
        c.timeEnd('dup-time');
        c.timeEnd('dup-time');
        c.timeLog('missing-time-log');
    });

    ok(warnings.some((message) => message.includes("Label 'dup-time' already exists for console.time()")));
    ok(warnings.some((message) => message.includes("No such label 'dup-time' for console.timeEnd()")));
    ok(warnings.some((message) => message.includes("No such label 'missing-time-log' for console.timeLog()")));
});

// --- 9. Console with ignoreErrors does not throw --------------------------

Deno.test('console: ignoreErrors suppresses write errors', async () => {
    const stdout = new Writable({
        write(_c: Buffer, _e, cb) { cb(new Error('write-fail')); },
    });
    const stderr = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console(stdout, stderr, true);
    let threw = false;
    try { c.log('x'); } catch { threw = true; }
    await new Promise((r) => setTimeout(r, 10));
    ok(!threw, 'ignoreErrors must suppress write errors');
});

Deno.test('console: trace includes message and Trace prefix', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const stderr = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console(stdout, stderr);
    c.trace('marker');
    await new Promise((r) => setTimeout(r, 10));
    ok(out.includes('marker'));
    ok(out.includes('Trace'));
});

Deno.test('console: clear writes terminal clear escape sequence', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const stderr = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console(stdout, stderr);
    c.clear();
    await new Promise((r) => setTimeout(r, 10));
    strictEqual(out, '\x1b[2J\x1b[0;0H\n');
});

Deno.test('console upstream: time and count methods tolerate missing labels', () => {
    const stdout = new Writable({ write(_c: Buffer, _e, cb) { cb(); } });
    const c = new Console(stdout);

    doesNotThrow(() => c.time());
    doesNotThrow(() => c.timeLog());
    doesNotThrow(() => c.timeEnd());
    doesNotThrow(() => c.count());
    doesNotThrow(() => c.countReset());
});

Deno.test('console upstream: formats cross-realm built-in objects', async () => {
    let out = '';
    const stdout = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const c = new Console({ stdout, stderr: stdout, colorMode: false });
    const values = vm.runInNewContext(`[
        new Map([["x", 1]]),
        new Set(["a", "b"]),
        new Date("2018-12-10T02:26:59.002Z"),
        new Error("cross realm"),
    ]`) as unknown[];

    for (const value of values) c.log(value);
    await new Promise((resolve) => setTimeout(resolve, 10));

    ok(out.includes('Map(1) {x => 1}'));
    ok(out.includes('Set(2) {a, b}'));
    ok(out.includes('2018-12-10T02:26:59.002Z'));
    ok(out.includes('Error: cross realm'));
});
