import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import path from 'node:path';
import posix from 'node:path/posix';
import win32 from 'node:path/win32';

Deno.test('path: posix and win32 submodules are shared namespace singletons', () => {
    strictEqual(path.posix, posix);
    strictEqual(path.win32, win32);
    strictEqual((path.posix as typeof path).posix, path.posix);
    strictEqual((path.posix as typeof path).win32, path.win32);
    strictEqual((path.win32 as typeof path).posix, path.posix);
    strictEqual((path.win32 as typeof path).win32, path.win32);
});

Deno.test('path: posix root and trailing directory parse like Node', () => {
    deepStrictEqual(path.posix.parse('/'), {
        root: '/',
        dir: '/',
        base: '',
        ext: '',
        name: '',
    });
    deepStrictEqual(path.posix.parse('/foo/bar/'), {
        root: '/',
        dir: '/foo',
        base: 'bar',
        ext: '',
        name: 'bar',
    });
});

Deno.test('path: win32 parse preserves drive and UNC roots in dir', () => {
    deepStrictEqual(path.win32.parse('C:\\'), {
        root: 'C:\\',
        dir: 'C:\\',
        base: '',
        ext: '',
        name: '',
    });
    deepStrictEqual(path.win32.parse('\\\\server\\share\\foo.txt'), {
        root: '\\\\server\\share\\',
        dir: '\\\\server\\share\\',
        base: 'foo.txt',
        ext: '.txt',
        name: 'foo',
    });
});

Deno.test('path: win32 toNamespacedPath handles drive and UNC absolute paths', () => {
    strictEqual(path.win32.toNamespacedPath('C:\\foo\\bar'), '\\\\?\\C:\\foo\\bar');
    strictEqual(path.win32._makeLong('C:\\foo\\bar'), '\\\\?\\C:\\foo\\bar');
    strictEqual(path.win32.toNamespacedPath('\\\\server\\share\\foo'), '\\\\?\\UNC\\server\\share\\foo');
    strictEqual(path.win32.toNamespacedPath('\\\\?\\C:\\foo'), '\\\\?\\C:\\foo');
    strictEqual(path.posix.toNamespacedPath('/tmp/file'), '/tmp/file');
});

Deno.test('path: win32 drive-relative and cross-drive relative edges', () => {
    strictEqual(path.win32.isAbsolute('C:'), false);
    strictEqual(path.win32.isAbsolute('C:\\'), true);
    strictEqual(path.win32.normalize('C:foo\\..\\bar'), 'C:bar');
    strictEqual(path.win32.relative('C:\\a\\b', 'D:\\x'), 'D:\\x');
    strictEqual(path.win32.relative('C:\\a\\b', 'C:\\a\\c\\d'), '..\\c\\d');
});

Deno.test('path: namespace objects expose long path helpers', () => {
    strictEqual(typeof path._makeLong, 'function');
    strictEqual(path.posix._makeLong('/a/b'), '/a/b');
    ok(Object.keys(path.posix).includes('posix'));
    ok(Object.keys(path.win32).includes('win32'));
});

Deno.test('path: public methods reject non-string path arguments', () => {
    throws(() => path.posix.join('a', 1 as unknown as string), TypeError);
    throws(() => path.posix.normalize(1 as unknown as string), TypeError);
    throws(() => path.posix.resolve(1 as unknown as string), TypeError);
    throws(() => path.posix.relative('/a', 1 as unknown as string), TypeError);
    throws(() => path.posix.basename(1 as unknown as string), TypeError);
    throws(() => path.posix.dirname(1 as unknown as string), TypeError);
    throws(() => path.posix.extname(1 as unknown as string), TypeError);
    throws(() => path.posix.parse(1 as unknown as string), TypeError);
    throws(() => path.posix.format(null as unknown as path.FormatInputPathObject), TypeError);
});

Deno.test('path: format inserts extension dots and preserves empty base directories', () => {
    strictEqual(path.posix.format({ dir: '/a', name: 'b', ext: 'js' }), '/a/b.js');
    strictEqual(path.win32.format({ dir: 'C:\\a', name: 'b', ext: 'js' }), 'C:\\a\\b.js');
    strictEqual(path.posix.format({ root: '/', name: 'b', ext: 'js' }), '/b.js');
    strictEqual(path.posix.format({ dir: '/a', base: '' }), '/a/');
});
