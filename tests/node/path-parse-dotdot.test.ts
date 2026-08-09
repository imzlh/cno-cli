import { deepStrictEqual, strictEqual } from 'node:assert';
import path from 'node:path';

// Node's posix.parse disagrees with its own extname for exactly one shape:
// a single-slash-rooted path whose only component is '..'. Every value below
// was captured from node v24.18.0 on the same machine; the ecosystem diffs
// against Node's output, so Node's inconsistency is the contract.

Deno.test('path: posix parse of a root-level ".." reports ext "." like Node', () => {
    deepStrictEqual(path.posix.parse('/..'), {
        root: '/',
        dir: '/',
        base: '..',
        ext: '.',
        name: '.',
    });
    deepStrictEqual(path.posix.parse('/../'), {
        root: '/',
        dir: '/',
        base: '..',
        ext: '.',
        name: '.',
    });
    // Trailing separators are trimmed before the component is examined, so
    // any number of them lands on the same quirk.
    deepStrictEqual(path.posix.parse('/..//'), {
        root: '/',
        dir: '/',
        base: '..',
        ext: '.',
        name: '.',
    });
});

Deno.test('path: the posix ".." quirk does not leak past its exact shape', () => {
    // More than one leading slash makes the backward scan stop at a separator,
    // which is what Node's carve-out actually tests for. Note `///..` keeps
    // dir '//' — captured from Node, not assumed.
    deepStrictEqual(path.posix.parse('//..'), {
        root: '/',
        dir: '/',
        base: '..',
        ext: '',
        name: '..',
    });
    deepStrictEqual(path.posix.parse('//../'), {
        root: '/',
        dir: '/',
        base: '..',
        ext: '',
        name: '..',
    });
    deepStrictEqual(path.posix.parse('///..'), {
        root: '/',
        dir: '//',
        base: '..',
        ext: '',
        name: '..',
    });
    // A '..' that is not the first component is ordinary.
    for (const input of ['/a/..', '/./..', '/../../', '/x/../..']) {
        const parsed = path.posix.parse(input);
        strictEqual(parsed.ext, '', input);
        strictEqual(parsed.name, '..', input);
    }
    // Relative '..' has no root, so it never qualifies.
    for (const input of ['..', '../', 'a/..']) {
        const parsed = path.posix.parse(input);
        strictEqual(parsed.ext, '', input);
        strictEqual(parsed.name, '..', input);
    }
    // A single '.' is not the quirk either.
    deepStrictEqual(path.posix.parse('/.'), {
        root: '/',
        dir: '/',
        base: '.',
        ext: '',
        name: '.',
    });
});

Deno.test('path: win32 parse of a root-level ".." keeps ext empty, unlike posix', () => {
    // Node's win32.parse does NOT carry the quirk — the two must disagree.
    deepStrictEqual(path.win32.parse('/..'), {
        root: '/',
        dir: '/',
        base: '..',
        ext: '',
        name: '..',
    });
    // A backslash root behaves the same; built from a char code so no quoting
    // layer can silently eat the separator and turn this into a '..' test.
    const backslash = String.fromCharCode(92);
    deepStrictEqual(path.win32.parse(`${backslash}..`), {
        root: backslash,
        dir: backslash,
        base: '..',
        ext: '',
        name: '..',
    });
    // On posix a backslash is an ordinary character, so the base is '\..' and
    // the ordinary extname path applies — a different result from both above.
    deepStrictEqual(path.posix.parse(`${backslash}..`), {
        root: '',
        dir: '',
        base: `${backslash}..`,
        ext: '.',
        name: `${backslash}.`,
    });
    strictEqual(path.win32.parse('/..').ext, '');
    strictEqual(path.posix.parse('/..').ext, '.');
});

Deno.test('path: extname stays self-consistent even where parse does not', () => {
    // parse('/..').ext is '.', but extname('/..') is '' in Node. Both.
    for (const p of [path.posix, path.win32]) {
        strictEqual(p.extname('/..'), '');
        strictEqual(p.extname('..'), '');
        strictEqual(p.extname('/.'), '');
    }
    // Dot-runs longer than two do take an extension, in both flavours.
    strictEqual(path.posix.extname('/...'), '.');
    strictEqual(path.win32.extname('/...'), '.');
    deepStrictEqual(path.posix.parse('/...'), {
        root: '/',
        dir: '/',
        base: '...',
        ext: '.',
        name: '..',
    });
});

Deno.test('path: a "/.." base survives a parse/format round trip', () => {
    // format prefers `base`, so the quirky ext/name must not corrupt it.
    strictEqual(path.posix.format(path.posix.parse('/..')), '/..');
    strictEqual(path.win32.format(path.win32.parse('/..')), '/..');
    // Rebuilding from name+ext reproduces Node's own lossy result.
    const { root, name, ext } = path.posix.parse('/..');
    strictEqual(path.posix.format({ root, name, ext }), '/..');
});
