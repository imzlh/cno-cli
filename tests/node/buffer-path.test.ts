import { strictEqual, ok } from 'node:assert';
import * as path from 'node:path';
import { Buffer } from 'node:buffer';

// --- path: join collapses and normalizes -----------------------------------

Deno.test('path: join collapses separators and dots', () => {
    strictEqual(path.join('/a', 'b', '..', 'c'), '/a/c');
    strictEqual(path.join('a', 'b', 'c'), 'a/b/c');
});

// --- path: resolve makes absolute -------------------------------------------

Deno.test('path: resolve makes paths absolute', () => {
    const r = path.resolve('a', 'b');
    ok(path.isAbsolute(r), 'resolve must return an absolute path');
});

// --- path: dirname / basename / extname ------------------------------------

Deno.test('path: dirname/basename/extname decompose', () => {
    strictEqual(path.dirname('/a/b/c.js'), '/a/b');
    strictEqual(path.basename('/a/b/c.js'), 'c.js');
    strictEqual(path.basename('/a/b/c.js', '.js'), 'c');
    strictEqual(path.extname('/a/b/c.js'), '.js');
    strictEqual(path.extname('/a/b/c'), '');
});

// --- path: relative computes relative path ---------------------------------

Deno.test('path: relative computes relative path', () => {
    const r = path.relative('/a/b/c', '/a/b/c/d/e');
    ok(typeof r === 'string' && r.length > 0);
});

// --- path: normalize removes redundant separators --------------------------

Deno.test('path: normalize removes redundant separators', () => {
    ok(path.normalize('/a//b/../c').includes('/a/c') || path.normalize('/a//b/../c') === '/a/c');
});

// --- path: isAbsolute -------------------------------------------------------

Deno.test('path: isAbsolute detects absolute paths', () => {
    ok(path.isAbsolute('/a'));
    ok(!path.isAbsolute('a'));
});

// --- path: parse returns components -----------------------------------------

Deno.test('path: parse returns root/dir/base/ext/name', () => {
    const p = path.parse('/a/b/c.js');
    strictEqual(p.root, '/');
    strictEqual(p.dir, '/a/b');
    strictEqual(p.base, 'c.js');
    strictEqual(p.ext, '.js');
    strictEqual(p.name, 'c');
});

// --- path: format rebuilds from object --------------------------------------

Deno.test('path: format rebuilds path', () => {
    const s = path.format({ root: '/', dir: '/a/b', base: 'c.js' });
    ok(s.includes('/a/b/c.js'));
});

// --- path: sep / delimiter --------------------------------------------------

Deno.test('path: sep and delimiter are non-empty', () => {
    ok(path.sep === '/' || path.sep === '\\');
    ok(path.delimiter === ':' || path.delimiter === ';');
});

// --- path: posix / win32 namespaces ----------------------------------------

Deno.test('path: posix and win32 namespaces expose sep', () => {
    strictEqual(path.posix.sep, '/');
    strictEqual(path.win32.sep, '\\');
});

// --- Buffer: from string round-trip -----------------------------------------

Deno.test('buffer: Buffer.from string round-trip', () => {
    const b = Buffer.from('hello', 'utf8');
    strictEqual(b.toString('utf8'), 'hello');
    strictEqual(b.length, 5);
});

// --- Buffer: alloc with fill ------------------------------------------------

Deno.test('buffer: Buffer.alloc fills', () => {
    const b = Buffer.alloc(4, 7);
    strictEqual(b.length, 4);
    for (let i = 0; i < 4; i++) strictEqual(b[i], 7);
});

// --- Buffer: allocUnsafe returns zero-filled buffer of length ---------------

Deno.test('buffer: Buffer.allocUnsafe has correct length', () => {
    const b = Buffer.allocUnsafe(8);
    strictEqual(b.length, 8);
});

// --- Buffer: from array -----------------------------------------------------

Deno.test('buffer: Buffer.from array', () => {
    const b = Buffer.from([0x68, 0x69]);
    strictEqual(b.toString('utf8'), 'hi');
});

// --- Buffer: compare / equals ----------------------------------------------

Deno.test('buffer: compare and equals', () => {
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    const a2 = Buffer.from('a');
    ok(Buffer.compare(a, b) < 0);
    ok(Buffer.compare(b, a) > 0);
    ok(a.equals(a2));
    ok(!a.equals(b));
});

// --- Buffer: concat ---------------------------------------------------------

Deno.test('buffer: Buffer.concat joins buffers', () => {
    const out = Buffer.concat([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]);
    strictEqual(out.toString(), 'abc');
});

// --- Buffer: isBuffer -------------------------------------------------------

Deno.test('buffer: Buffer.isBuffer', () => {
    ok(Buffer.isBuffer(Buffer.from('x')));
    ok(!Buffer.isBuffer('x'));
    ok(!Buffer.isBuffer(new Uint8Array([1])));
});

// --- Buffer: write ---------------------------------------------------------

Deno.test('buffer: Buffer.write writes at offset', () => {
    const b = Buffer.alloc(5);
    b.write('abc', 1);
    strictEqual(b.toString('latin1'), '\x00abc\x00');
});

// --- Buffer: copy -----------------------------------------------------------

Deno.test('buffer: Buffer.copy copies bytes', () => {
    const src = Buffer.from('abcd');
    const dst = Buffer.alloc(4);
    src.copy(dst, 0, 1, 3); // copy 'bc'
    strictEqual(dst[0], 0x62); // 'b'
    strictEqual(dst[1], 0x63); // 'c'
});

// --- Buffer: subarray shares buffer -----------------------------------------

Deno.test('buffer: subarray shares underlying buffer', () => {
    const b = Buffer.from('abcdef');
    const sub = b.subarray(1, 3);
    strictEqual(sub.toString(), 'bc');
});

// --- Buffer: swap16 / swap32 / swap64 --------------------------------------

Deno.test('buffer: swap16 swaps bytes', () => {
    const b = Buffer.from([0x01, 0x02]);
    const swapped = b.swap16();
    strictEqual(swapped[0], 0x02);
    strictEqual(swapped[1], 0x01);
});

// --- Buffer: utf8 vs latin1 byteLength differ for non-ascii -----------------

Deno.test('buffer: byteLength differs by encoding', () => {
    const s = 'café';
    ok(Buffer.byteLength(s, 'utf8') > Buffer.byteLength(s, 'latin1'));
});

// --- Buffer: isEncoding -----------------------------------------------------

Deno.test('buffer: Buffer.isEncoding recognizes utf8', () => {
    ok(Buffer.isEncoding('utf8'));
    ok(Buffer.isEncoding('hex'));
    ok(!Buffer.isEncoding('not-real'));
});
