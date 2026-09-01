/**
 * The cts POSIX-internal / native-boundary contract.
 *
 * Two path layers share a filename and must not be conflated:
 *   - `cts/src/**` is POSIX-internal: every path is stored, compared and keyed
 *     with `/`. `ModuleInfo.localPath` is posix BY DESIGN (cts/AGENT.md:230,
 *     AGENT.md:402).
 *   - anything handed to USER code must be native (`\` on Windows).
 *
 * These import the cts sources by relative path, which loads the TypeScript from
 * disk rather than the copy baked into `cno.exe` — so they exercise the working
 * tree with no rebuild. That is the only way to verify this layer today.
 *
 * Oracle values were measured on Windows 11 with node v24.18.0 and deno 2.9.3.
 */
import { strictEqual, ok, throws } from 'node:assert';
import { dirname, fileUrlToPath, isAbsolute, isPathWithin, normalizePath, pathRoot, toFileUrl, toHostPath, toHostPaths, hasSchemeId, joinPaths, relativePath } from '../../cts/src/utils/path';

const isWindows = Deno.build.os === 'windows';

Deno.test('host boundary: a drive path is denormalized to native separators', () => {
    const out = toHostPath('D:/tmp/agsep/esm.mjs');
    if (isWindows) {
        // node: import.meta.filename -> D:\tmp\agsep\esm.mjs
        strictEqual(out, 'D:\\tmp\\agsep\\esm.mjs');
    } else {
        strictEqual(out, 'D:/tmp/agsep/esm.mjs');
    }
});

Deno.test('host boundary: scheme-qualified ids cross unchanged', () => {
    // A container id is not a filesystem path; its `/` is part of the id on
    // every platform. `pack:\c.cjs` is not a valid id — this is the inversion
    // that `toWindowsHostPath` used to produce by converting every slash.
    for (const id of ['pack:/c.cjs', 'npm:left-pad', 'node:fs', 'https://x.dev/a.ts']) {
        strictEqual(toHostPath(id), id, `${id} must survive verbatim`);
    }
});

Deno.test('host boundary: a single-letter scheme is a drive, not a scheme', () => {
    // The `*`-vs-`+` quantifier bug: `D:` matched as a URL scheme, so a drive
    // path was mistaken for an already-qualified id and returned early.
    ok(!hasSchemeId('D:/tmp/x.ts'), 'D: is a Windows drive');
    ok(!hasSchemeId('c:/x'), 'c: is a Windows drive');
    ok(hasSchemeId('pack:/x'), 'pack: is a real scheme');
    ok(hasSchemeId('npm:x'), 'npm: is a real scheme');
    ok(hasSchemeId('javascript:alert(1)'), 'scheme detection must not reject long names');
});

Deno.test('host boundary: Windows rooted paths are absolute after slash normalization', () => {
    if (!isWindows) return;

    strictEqual(isAbsolute('\\\\server\\share\\file.ts'), true);
    strictEqual(isAbsolute('\\rooted\\file.ts'), true);
    strictEqual(isAbsolute('C:\\rooted\\file.ts'), true);
    strictEqual(isAbsolute('C:relative\\file.ts'), false);
});

Deno.test('host boundary: toHostPaths maps every entry', () => {
    const out = toHostPaths(['D:/a/b.ts', 'pack:/c.cjs']);
    strictEqual(out.length, 2);
    strictEqual(out[1], 'pack:/c.cjs', 'ids are untouched inside a batch too');
    if (isWindows) strictEqual(out[0], 'D:\\a\\b.ts');
});

Deno.test('host boundary: relative and empty inputs are not corrupted', () => {
    strictEqual(toHostPath(''), '');
    const rel = toHostPath('a/b.ts');
    strictEqual(rel, isWindows ? 'a\\b.ts' : 'a/b.ts');
});

Deno.test('host boundary: upward searches stop at UNC and extended roots', () => {
    if (!isWindows) return;

    strictEqual(pathRoot('//server/share/project'), '//server/share');
    strictEqual(dirname('//server/share'), '//server/share');
    strictEqual(dirname('//server/share/project'), '//server/share');

    strictEqual(pathRoot('//?/UNC/server/share/project'), '//?/UNC/server/share');
    strictEqual(dirname('//?/UNC/server/share'), '//?/UNC/server/share');
    strictEqual(pathRoot('//?/C:/project'), '//?/C:');
    strictEqual(dirname('//?/C:/project'), '//?/C:');

    strictEqual(pathRoot('//./pipe/cno'), '//./pipe');
    strictEqual(normalizePath('//./pipe/cno/../..'), '//./pipe');
    strictEqual(pathRoot('//./'), '//./');
    strictEqual(dirname('//./'), '//./');
    strictEqual(pathRoot('//?/GLOBALROOT/a/../..'), '//?/GLOBALROOT');
    strictEqual(normalizePath('//?/GLOBALROOT/a/../..'), '//?/GLOBALROOT');
    strictEqual(pathRoot('//?/'), '//?/');
    strictEqual(dirname('//?/'), '//?/');
});

Deno.test('host boundary: file URL conversion preserves URL path semantics', () => {
    strictEqual(fileUrlToPath('file:///tmp/a%20b'), '/tmp/a b');
    strictEqual(fileUrlToPath('FILE:///tmp/a%20b'), '/tmp/a b');
    strictEqual(toFileUrl(isWindows ? 'C:/a b/#q?%.ts' : '/tmp/a b/#q?%.ts'),
        isWindows ? 'file:///C:/a%20b/%23q%3F%25.ts' : 'file:///tmp/a%20b/%23q%3F%25.ts');
    strictEqual(toFileUrl(isWindows ? 'C:/percent%20name.ts' : '/tmp/percent%20name.ts'),
        isWindows ? 'file:///C:/percent%2520name.ts' : 'file:///tmp/percent%2520name.ts');
    if (isWindows) {
        strictEqual(fileUrlToPath('file://localhost/C:/x'), 'C:/x');
        strictEqual(fileUrlToPath('file://server/share/x'), '//server/share/x');
        strictEqual(toFileUrl('\\\\server\\share\\a b.ts'), 'file://server/share/a%20b.ts');
        strictEqual(toFileUrl('//?/C:/a b.ts'), 'file:///C:/a%20b.ts');
        strictEqual(toFileUrl('//?/UNC/server/share/a b.ts'), 'file://server/share/a%20b.ts');
        strictEqual(toFileUrl('//./pipe/cno'), 'file://./pipe/cno');
        strictEqual(fileUrlToPath('file://./pipe/cno'), '//./pipe/cno');
        throws(() => fileUrlToPath('file:///C:/a%2Fb'), /Invalid file URL path/);
    } else {
        strictEqual(fileUrlToPath('file:///tmp/a%5Cb'), '/tmp/a\\b');
    }
    throws(() => fileUrlToPath('file:///tmp/%zz'), URIError);
});

Deno.test('host boundary: drive path joining and relative containment follow the host', () => {
    strictEqual(joinPaths('/base', 'C:/x'), isWindows ? 'C:/x' : '/base/C:/x');
    if (isWindows) {
        strictEqual(relativePath('C:/Work', 'c:/work/File.ts'), 'File.ts');
        strictEqual(joinPaths('/base', '//server/share/x'), '//server/share/x');
    }
});

Deno.test('host boundary: containment respects roots, case, and component boundaries', () => {
    if (!isWindows) {
        strictEqual(isPathWithin('/work', '/work/file.ts'), true);
        strictEqual(isPathWithin('/work', '/workspace/file.ts'), false);
        return;
    }

    strictEqual(isPathWithin('C:/Work', 'c:/work/File.ts'), true);
    strictEqual(isPathWithin('C:/work', 'C:/workspace/File.ts'), false);
    strictEqual(isPathWithin('//server/share', '//SERVER/SHARE/project/file.ts'), true);
    strictEqual(isPathWithin('//server/share', '//server/share-archive/file.ts'), false);
    strictEqual(isPathWithin('//?/UNC/server/share', '//?/unc/SERVER/SHARE/project/file.ts'), true);
    strictEqual(isPathWithin('//?/UNC/server/share', '//?/UNC/server/share-archive/file.ts'), false);
    strictEqual(isPathWithin('//?/C:/work', '//?/c:/WORK/project/file.ts'), true);
    strictEqual(isPathWithin('//?/C:/work', '//?/C:/workspace/file.ts'), false);
});
