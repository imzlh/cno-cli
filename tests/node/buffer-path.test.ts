import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';
import * as path from 'node:path';
import posixPath from 'node:path/posix';
import win32Path from 'node:path/win32';
import * as buffer from 'node:buffer';
import { Buffer } from 'node:buffer';

// --- path: join collapses and normalizes -----------------------------------

Deno.test('path: join collapses separators and dots', () => {
    strictEqual(path.join('/a', 'b', '..', 'c'), '/a/c');
    strictEqual(path.join('a', 'b', 'c'), 'a/b/c');
});

Deno.test('path: join with no non-empty segments returns dot', () => {
    strictEqual(path.join('', ''), '.');
    strictEqual(path.posix.join(), '.');
    strictEqual(path.win32.join('', ''), '.');
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

// --- path: edge-case basename/extname/format behavior -----------------------

Deno.test('path: extname handles dotfiles and trailing dots like Node', () => {
    strictEqual(path.extname('.bashrc'), '');
    strictEqual(path.extname('index.'), '.');
    strictEqual(path.extname('archive.tar.gz'), '.gz');
});

Deno.test('path: basename only strips an exact suffix match', () => {
    strictEqual(path.basename('/tmp/file.html', '.txt'), 'file.html');
    strictEqual(path.basename('/tmp/file.html', '.html'), 'file');
});

Deno.test('path: format uses name/ext when base is absent', () => {
    strictEqual(path.format({ dir: '/a/b', name: 'c', ext: '.js' }), '/a/b/c.js');
});

Deno.test('path: format base takes precedence over name and ext', () => {
    strictEqual(path.posix.format({ dir: '/a/b', base: 'file.txt', name: 'ignored', ext: '.js' }), '/a/b/file.txt');
    strictEqual(path.win32.format({ dir: 'C:\\a', base: 'file.txt', name: 'ignored', ext: '.js' }), 'C:\\a\\file.txt');
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

Deno.test('path upstream: posix and win32 namespace identities are stable', () => {
    strictEqual(path.posix, posixPath);
    strictEqual(path.win32, win32Path);
    strictEqual(path.posix, path.posix.posix);
    strictEqual(path.win32, path.posix.win32);
    strictEqual(path.posix, path.win32.posix);
    strictEqual(path.win32, path.win32.win32);
});

Deno.test('path: posix and win32 normalize their own separators', () => {
    strictEqual(path.posix.normalize('/foo//bar/../baz/'), '/foo/baz/');
    strictEqual(path.win32.normalize('C:\\temp\\\\foo\\..\\bar'), 'C:\\temp\\bar');
});

Deno.test('path: relative returns empty string for same resolved path', () => {
    strictEqual(path.posix.relative('/a/b', '/a/b'), '');
    strictEqual(path.win32.relative('C:\\a\\b', 'C:\\a\\b'), '');
});

// --- Buffer: from string round-trip -----------------------------------------

Deno.test('buffer: Buffer.from string round-trip', () => {
    const b = Buffer.from('hello', 'utf8');
    strictEqual(b.toString('utf8'), 'hello');
    strictEqual(b.length, 5);
});

Deno.test('buffer: Buffer.from base64 uses Node-compatible loose decoding', () => {
    strictEqual(Buffer.from('SGVsbG8=', 'base64').toString(), 'Hello');
    strictEqual(Buffer.from('SGV sbG8!!!!', 'base64').toString(), 'Hello');
    strictEqual(Buffer.from('-_8=', 'base64').toString('hex'), 'fbff');
    strictEqual(Buffer.from('䄫䄫䄫䄫', 'base64').toString('hex'), 'fbefbe');
    strictEqual(Buffer.from('A===', 'base64').length, 0);
});

// --- Buffer: alloc with fill ------------------------------------------------

Deno.test('buffer: Buffer.alloc fills', () => {
    const b = Buffer.alloc(4, 7);
    strictEqual(b.length, 4);
    for (let i = 0; i < 4; i++) strictEqual(b[i], 7);
});

Deno.test('buffer upstream: Buffer.alloc rejects non-number sizes', () => {
    for (const size of [{}, '1', 'foo', []]) {
        throws(() => Buffer.alloc(size as unknown as number), TypeError);
    }
});

Deno.test('buffer: Buffer.alloc repeats string fills', () => {
    strictEqual(Buffer.alloc(5, 'ab').toString(), 'ababa');
});

Deno.test('buffer upstream: Buffer.alloc repeats decoded string and byte fills', () => {
    deepStrictEqual([...Buffer.alloc(11, 'aGVsbG8gd29ybGQ=', 'base64')], [
        104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100,
    ]);
    deepStrictEqual([...Buffer.alloc(4, '64656e6f', 'hex')], [100, 101, 110, 111]);
    strictEqual(Buffer.alloc(13, '64656e6f', 'hex').toString(), 'denodenodenod');
    deepStrictEqual([...Buffer.alloc(7, new Uint8Array([100, 101]))], [100, 101, 100, 101, 100, 101, 100]);
    deepStrictEqual([...Buffer.alloc(1, new Uint8Array([100, 101]))], [100]);
    deepStrictEqual([...Buffer.alloc(7, Buffer.from([100, 101]))], [100, 101, 100, 101, 100, 101, 100]);
});

Deno.test('buffer: ascii and latin1 encode code units like Node', () => {
    strictEqual(Buffer.from('AéĀ', 'ascii').toString('hex'), '416900');
    strictEqual(Buffer.from('AéĀ', 'latin1').toString('hex'), '41e900');
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

Deno.test('buffer: Buffer.from ArrayBuffer view shares memory', () => {
    const ab = new ArrayBuffer(4);
    const bytes = new Uint8Array(ab);
    bytes.set([1, 2, 3, 4]);
    const b = Buffer.from(ab, 1, 2);
    strictEqual(b.length, 2);
    strictEqual(b[0], 2);
    b[0] = 9;
    strictEqual(bytes[1], 9);
});

Deno.test('buffer: Buffer.from Uint8Array copies bytes', () => {
    const source = new Uint8Array([1, 2, 3]);
    const b = Buffer.from(source);
    source[0] = 9;
    strictEqual(b[0], 1);
});

Deno.test('buffer upstream: Buffer.from Buffer creates an independent copy', () => {
    const source = Buffer.from('test');
    const copy = Buffer.from(source);
    source[0] = 0x72;
    strictEqual(source.toString(), 'rest');
    strictEqual(copy.toString(), 'test');
});

Deno.test('buffer upstream: Buffer.from invalid encoding throws but empty-ish encodings default', () => {
    for (const encoding of [null, 5, {}, true, false, '']) {
        strictEqual(Buffer.from('yes', encoding as BufferEncoding).toString(), 'yes');
    }
    throws(() => Buffer.from('yes', 'deno' as BufferEncoding), TypeError);
    throws(() => Buffer.from('yes', 'base645' as BufferEncoding), TypeError);
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

Deno.test('buffer: Buffer.concat honors explicit totalLength', () => {
    strictEqual(Buffer.concat([Buffer.from('abc'), Buffer.from('def')], 4).toString(), 'abcd');
    strictEqual(Buffer.concat([Buffer.from('ab')], 4).toString('latin1'), 'ab\x00\x00');
});

Deno.test('buffer upstream: Buffer.concat validates explicit totalLength type and range', () => {
    throws(() => Buffer.concat([Buffer.from('abc')], '2' as unknown as number), TypeError);
    throws(() => Buffer.concat([Buffer.from('abc')], NaN), RangeError);
    throws(() => Buffer.concat([Buffer.from('abc')], -1), RangeError);
});

// --- Buffer: isBuffer -------------------------------------------------------

Deno.test('buffer: Buffer.isBuffer', () => {
    ok(Buffer.isBuffer(Buffer.from('x')));
    ok(!Buffer.isBuffer('x'));
    ok(!Buffer.isBuffer(new Uint8Array([1])));
});

Deno.test('buffer upstream: static methods are enumerable for safer-buffer compatibility', () => {
    const keys = Object.keys(Buffer);
    for (const key of ['from', 'alloc', 'isBuffer', 'concat', 'byteLength']) {
        ok(keys.includes(key), `Buffer.${key} must be enumerable`);
    }
});

Deno.test('buffer upstream: Buffer.copyBytesFrom copies typed array backing bytes', () => {
    const view = new Uint16Array([0x1234, 0x5678, 0x9abc]);
    strictEqual(Buffer.copyBytesFrom(view).toString('hex'), '34127856bc9a');
    strictEqual(Buffer.copyBytesFrom(view, 1, 1).toString('hex'), '7856');
    strictEqual(Buffer.copyBytesFrom(new Uint8Array([1, 2]), 3).length, 0);
    throws(() => Buffer.copyBytesFrom(new DataView(new ArrayBuffer(4)) as any), TypeError);
    throws(() => Buffer.copyBytesFrom(view, '1' as unknown as number), TypeError);
    throws(() => Buffer.copyBytesFrom(view, 0, '1' as unknown as number), TypeError);
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

Deno.test('buffer upstream: Buffer.copy respects target offsets and truncates safely', () => {
    const source = Buffer.from([1, 2, 3]);
    const target = Buffer.alloc(8);
    source.copy(target, 5);
    deepStrictEqual([...target], [0, 0, 0, 0, 0, 1, 2, 3]);

    const shortTarget = Buffer.alloc(8);
    strictEqual(source.copy(shortTarget, 6), 2);
    deepStrictEqual([...shortTarget], [0, 0, 0, 0, 0, 0, 1, 2]);

    const endTarget = Buffer.alloc(8);
    strictEqual(source.copy(endTarget, 8), 0);
    deepStrictEqual([...endTarget], [0, 0, 0, 0, 0, 0, 0, 0]);
});

// --- Buffer: subarray shares buffer -----------------------------------------

Deno.test('buffer: subarray shares underlying buffer', () => {
    const b = Buffer.from('abcdef');
    const sub = b.subarray(1, 3);
    strictEqual(sub.toString(), 'bc');
});

Deno.test('buffer: reverse mutates in place', () => {
    const b = Buffer.from([1, 2, 3, 4, 5]);
    strictEqual(b.reverse(), b);
    strictEqual(b.toString('hex'), '0504030201');
});

Deno.test('buffer: slice supports negative indexes and shares memory', () => {
    const b = Buffer.from('abcd');
    const sub = b.slice(-3, -1);
    strictEqual(sub.toString(), 'bc');
    sub[0] = 0x5a;
    strictEqual(b.toString(), 'aZcd');
});

Deno.test('buffer upstream: Buffer.toJSON exposes type and byte data', () => {
    strictEqual(JSON.stringify(Buffer.from('deno')), '{"type":"Buffer","data":[100,101,110,111]}');
});

// --- Buffer: swap16 / swap32 / swap64 --------------------------------------

Deno.test('buffer: swap16 swaps bytes', () => {
    const b = Buffer.from([0x01, 0x02]);
    const swapped = b.swap16();
    strictEqual(swapped[0], 0x02);
    strictEqual(swapped[1], 0x01);
});

Deno.test('buffer: swap methods reject incompatible lengths', () => {
    for (const [method, bytes] of [
        ['swap16', [1]],
        ['swap32', [1, 2]],
        ['swap64', [1, 2, 3, 4]],
    ] as const) {
        let threw = false;
        try {
            (Buffer.from(bytes) as any)[method]();
        } catch (error) {
            threw = true;
            ok(error instanceof RangeError);
        }
        ok(threw, `${method} must reject incompatible buffer length`);
    }
});

// --- Buffer: utf8 vs latin1 byteLength differ for non-ascii -----------------

Deno.test('buffer: byteLength differs by encoding', () => {
    const s = 'café';
    ok(Buffer.byteLength(s, 'utf8') > Buffer.byteLength(s, 'latin1'));
});

Deno.test('buffer upstream: byteLength handles common encodings and fallbacks', () => {
    strictEqual(Buffer.byteLength('', 'ascii'), 0);
    strictEqual(Buffer.byteLength('', 'HeX' as BufferEncoding), 0);
    strictEqual(Buffer.byteLength('∑éllö wørl∂!', 'utf-8'), 19);
    strictEqual(Buffer.byteLength('κλμνξο', 'utf8'), 12);
    strictEqual(Buffer.byteLength('𠝹𠱓𠱸', 'UTF8' as BufferEncoding), 12);
    strictEqual(Buffer.byteLength('hello world', '' as BufferEncoding), 11);
    strictEqual(Buffer.byteLength('hello world', 'abc' as BufferEncoding), 11);
    strictEqual(Buffer.byteLength('ßœ∑≈', 'unkn0wn enc0ding' as BufferEncoding), 10);
    strictEqual(Buffer.byteLength('aGVsbG8gd29ybGQ=', 'base64'), 11);
    strictEqual(Buffer.byteLength('aaa=', 'base64'), 2);
    strictEqual(Buffer.byteLength('aaaa==', 'base64'), 3);
    strictEqual(Buffer.byteLength('Il était tué', 'latin1'), 12);
    strictEqual(Buffer.byteLength('Il était tué', 'utf16le'), 24);
});

Deno.test('buffer: byteLength for base64 follows Node estimated length', () => {
    strictEqual(Buffer.byteLength('SGVsbG8=', 'base64'), 5);
    strictEqual(Buffer.byteLength('SGVsbG8!!!!', 'base64'), 8);
    strictEqual(Buffer.byteLength('SGV sbG8=', 'base64'), 6);
    strictEqual(Buffer.byteLength('A===', 'base64'), 1);
    strictEqual(Buffer.byteLength('＋＋＋＋', 'base64'), 3);
});

// --- Buffer: isEncoding -----------------------------------------------------

Deno.test('buffer: Buffer.isEncoding recognizes utf8', () => {
    ok(Buffer.isEncoding('utf8'));
    ok(Buffer.isEncoding('hex'));
    ok(!Buffer.isEncoding('not-real'));
});

Deno.test('buffer upstream: Buffer.isEncoding accepts case variants and rejects non-strings', () => {
    for (const encoding of [
        'hex',
        'HEX',
        'HeX',
        'utf8',
        'utf-8',
        'ascii',
        'latin1',
        'binary',
        'base64',
        'BASE64',
        'BASe64',
        'ucs2',
        'ucs-2',
        'utf16le',
        'utf-16le',
    ]) {
        ok(Buffer.isEncoding(encoding), `${encoding} must be recognized`);
    }

    for (const encoding of ['utf9', 'utf-7', false, NaN, {}, Infinity, [], 1, 0, -1]) {
        ok(!Buffer.isEncoding(encoding as unknown as string), `${String(encoding)} must be rejected`);
    }
});

Deno.test('buffer: byteLength accepts DataView and typed array views', () => {
    const ab = new ArrayBuffer(8);
    strictEqual(Buffer.byteLength(new DataView(ab, 2, 4)), 4);
    strictEqual(Buffer.byteLength(new Uint16Array(ab, 0, 2)), 4);
});

Deno.test('buffer: indexOf and includes handle strings buffers and empty needles', () => {
    const b = Buffer.from('abcabc');
    strictEqual(b.indexOf('bc'), 1);
    strictEqual(b.indexOf(Buffer.from('ca')), 2);
    strictEqual(b.indexOf('', 99), b.length);
    strictEqual(b.lastIndexOf('', -99), 0);
    ok(b.includes(Buffer.from('abc'), 1));
    ok(!b.includes('ac'));
});

Deno.test('buffer: hex decoding stops at the first invalid pair', () => {
    strictEqual(Buffer.from('1ag123', 'hex').toString('hex'), '1a');
});

Deno.test('buffer: hex decoding truncates odd length and rejects non-ascii digits', () => {
    strictEqual(Buffer.from('1a7', 'hex').toString('hex'), '1a');
    strictEqual(Buffer.from('zz', 'hex').length, 0);
    strictEqual(Buffer.from('１a', 'hex').length, 0);
});

Deno.test('buffer: writeBigUInt64BE and readBigUInt64BE round-trip', () => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(0x0102030405060708n);
    strictEqual(b.toString('hex'), '0102030405060708');
    strictEqual(b.readBigUInt64BE(), 0x0102030405060708n);
});

Deno.test('buffer: writeBigInt64LE and readBigInt64LE round-trip negatives', () => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(-2n);
    strictEqual(b.toString('hex'), 'feffffffffffffff');
    strictEqual(b.readBigInt64LE(), -2n);
});

Deno.test('buffer upstream: variable-width unsigned reads honor endianness', () => {
    const buffer = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    strictEqual(buffer.readUIntBE(0, 1), 0x01);
    strictEqual(buffer.readUIntBE(0, 2), 0x0102);
    strictEqual(buffer.readUIntBE(0, 4), 0x01020304);
    strictEqual(buffer.readUIntLE(0, 1), 0x01);
    strictEqual(buffer.readUIntLE(0, 2), 0x0201);
    strictEqual(buffer.readUIntLE(0, 4), 0x04030201);
});

Deno.test('buffer upstream: slice infinity and utf8Write edge behavior', () => {
    strictEqual(Buffer.from([1, 2, 3, 4, 5]).slice(Infinity).length, 0);

    const buf = Buffer.alloc(8);
    strictEqual((buf as Buffer & { utf8Write(value: string, offset?: number, length?: number): number }).utf8Write('abc', 0), 3);
    deepStrictEqual([...buf], [0x61, 0x62, 0x63, 0, 0, 0, 0, 0]);
});

Deno.test('buffer upstream: utf8 toString keeps BOM bytes', () => {
    strictEqual(Buffer.from([239, 187, 191, 97, 98]).toString('utf8'), '\uFEFFab');
});

Deno.test('buffer upstream: module constants and web re-exports match public node:buffer surface', () => {
    strictEqual(buffer.constants.MAX_LENGTH, buffer.kMaxLength);
    strictEqual(buffer.constants.MAX_STRING_LENGTH, buffer.kStringMaxLength);
    ok(buffer.constants.MAX_LENGTH > 0);
    ok(buffer.constants.MAX_STRING_LENGTH > 0);

    strictEqual(buffer.Blob, globalThis.Blob);
    strictEqual(buffer.File, globalThis.File);

    const slow = buffer.SlowBuffer(4);
    strictEqual(Buffer.isBuffer(slow), true);
    strictEqual(slow.length, 4);
});

Deno.test('buffer upstream: transcode converts between UTF-8 single-byte and UTF-16 encodings', () => {
    strictEqual(buffer.transcode(Buffer.from('tést', 'utf8'), 'utf8', 'latin1').toString('hex'), '74e97374');
    strictEqual(buffer.transcode(Buffer.from([0x74, 0xe9, 0x73, 0x74]), 'latin1', 'utf8').toString(), 'tést');

    const utf16 = buffer.transcode(Buffer.from('deno', 'utf8'), 'utf8', 'utf16le');
    strictEqual(utf16.toString('hex'), '640065006e006f00');
    strictEqual(buffer.transcode(utf16, 'utf16le', 'utf8').toString(), 'deno');

    strictEqual(buffer.transcode(Buffer.from('é', 'utf8'), 'utf8', 'ascii').toString('hex'), '3f');
    throws(() => buffer.transcode(Buffer.from('x'), 'not-real' as buffer.TranscodeEncoding, 'utf8'), TypeError);
});

Deno.test('buffer upstream: isUtf8 isAscii atob and btoa follow Node helper semantics', () => {
    strictEqual(buffer.isUtf8(Buffer.from('hello')), true);
    strictEqual(buffer.isUtf8(Buffer.from([0xff])), false);
    strictEqual(buffer.isUtf8(new Uint8Array([0xe2, 0x82, 0xac])), true);
    strictEqual(buffer.isUtf8(new DataView(new Uint8Array([0xc3, 0x28]).buffer)), false);

    strictEqual(buffer.isAscii(Buffer.from('plain-ascii')), true);
    strictEqual(buffer.isAscii(Buffer.from([0x7f])), true);
    strictEqual(buffer.isAscii(Buffer.from([0x80])), false);
    strictEqual(buffer.isAscii(new Uint16Array([0x80])), false);

    strictEqual(buffer.atob('Y25vLWNsaQ=='), 'cno-cli');
    strictEqual(buffer.btoa('cno-cli'), 'Y25vLWNsaQ==');
    throws(() => buffer.btoa('\u0100'), DOMException);
});
