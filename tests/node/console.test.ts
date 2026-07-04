import { strictEqual, ok, match } from 'node:assert';
import * as console_ from 'node:console';
import { Console } from 'node:console';
import { Writable } from 'node:stream';

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
    const c = new Console(stdout, stderr, false, 2);
    c.group('G');
    c.log('inside');
    c.groupEnd();
    await new Promise((r) => setTimeout(r, 10));
    ok(out.includes('inside'));
    // indented line should have leading spaces
    ok(out.includes('  inside'), 'group must indent by groupIndentation');
});

// --- 8. global console exists ---------------------------------------------

Deno.test('global console exists', () => {
    ok(typeof console !== 'undefined');
    ok(typeof console.log === 'function');
    ok(typeof console.error === 'function');
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
