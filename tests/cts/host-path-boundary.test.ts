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
import { strictEqual, ok } from 'node:assert';
import { toHostPath, toHostPaths, hasSchemeId } from '../../cts/src/utils/path';

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
