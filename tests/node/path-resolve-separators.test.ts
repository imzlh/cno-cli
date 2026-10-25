import { strictEqual } from 'node:assert';
import { win32 } from 'node:path';

Deno.test('path.win32.resolve normalizes separators without dot segments', () => {
    for (const [input, expected] of [
        ['C:/foo/', 'C:\\foo'],
        ['C:/foo//bar', 'C:\\foo\\bar'],
        ['C:\\foo\\\\bar\\', 'C:\\foo\\bar'],
        ['//server/share/dir/', '\\\\server\\share\\dir'],
        ['C:/', 'C:\\'],
    ]) strictEqual(win32.resolve(input), expected, input);
    strictEqual(win32.resolve('C:/foo/', 'bar/'), 'C:\\foo\\bar');
    strictEqual(win32.relative('C:/foo/', 'C:/foo/bar/'), 'bar');
});
