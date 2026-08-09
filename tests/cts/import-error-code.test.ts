import { ok, strictEqual } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { err, ErrorKind, codeForKind, isResolutionMiss } from '../../cts/src/errors.ts';
import { esmResolveError } from '../../cts/src/runtime/hooks.ts';
import { createRuntime } from '../../cts/src/api/index.ts';

// A failed dynamic import() must carry `code` AND `url`, as node does.
// Measured on node v24.18.0:
//   await import('file:///D:/no/such/module-xyz.mjs')
//     → name=Error code="ERR_MODULE_NOT_FOUND" url="file:///D:/no/such/module-xyz.mjs"
//   cno, before this fix
//     → name=Error code=undefined url=undefined, own props [cause, kind, message]
//
// The cause was cts/src/errors.ts err(): it attached `code` only for
// ErrorKind.ModuleNotFound, and the ESM resolution path raises FileNotFound
// (measured kind=11), so no code was set at all.
//
// This is not cosmetic. Packages branch on `.code` and assume it is a string
// whenever a load fails. `require('sharp')` under cno died with
// "TypeError: cannot read property 'endsWith' of undefined" inside sharp's own
// dist/sharp.cjs:115 — `if (!err.code.endsWith("MODULE_NOT_FOUND"))` — while
// building its diagnostic message, hiding which of ~10 load attempts failed.
//
// NOTE ON LAYER: cts/src is baked into the binary (cjs_blob is a linked symbol,
// no file fallback) and `cno setup` does not refresh it, so these tests import
// the source by relative path. They pin the source-layer contract; end-to-end
// import() behaviour only changes after a rebuild.

Deno.test('cts import(): missing file URL gets ERR_MODULE_NOT_FOUND + url', () => {
    const spec = 'file:///D:/no/such/module-xyz.mjs';
    const inner = err(ErrorKind.FileNotFound, 'File not found: D:/no/such/module-xyz.mjs');
    const e = esmResolveError(spec, 'D:/some/entry.ts', inner, ErrorKind.FileNotFound);

    strictEqual(Reflect.get(e, 'code'), 'ERR_MODULE_NOT_FOUND');
    strictEqual(Reflect.get(e, 'url'), spec);
    // kind must survive — formatError keys off it for the human-facing label.
    strictEqual(e.kind, ErrorKind.FileNotFound);
    ok(Object.prototype.hasOwnProperty.call(e, 'code'), 'code must be an own property');
    ok(Object.prototype.hasOwnProperty.call(e, 'url'), 'url must be an own property');
});

Deno.test('cts import(): relative miss resolves url against the importer', () => {
    const e = esmResolveError('./missing.mjs', 'file:///D:/proj/entry.mjs',
        err(ErrorKind.FileNotFound, 'nope'), ErrorKind.FileNotFound);
    strictEqual(Reflect.get(e, 'code'), 'ERR_MODULE_NOT_FOUND');
    strictEqual(Reflect.get(e, 'url'), 'file:///D:/proj/missing.mjs');
});

Deno.test('cts import(): bare specifier miss has code but NO url', () => {
    // Measured: node's "Cannot find package 'x' imported from ..." carries
    // ERR_MODULE_NOT_FOUND with own props [code, message, stack] — no url.
    const e = esmResolveError('totally-not-a-real-pkg-xyz', 'D:/proj/entry.ts',
        err(ErrorKind.ModuleNotFound, 'npm package not found'), ErrorKind.ModuleNotFound);
    strictEqual(Reflect.get(e, 'code'), 'ERR_MODULE_NOT_FOUND');
    strictEqual(Reflect.get(e, 'url'), undefined);
    ok(!Object.prototype.hasOwnProperty.call(e, 'url'), 'bare specifier must not fabricate a url');
});

Deno.test('cts import(): a specific inner ERR_ code is not overwritten', () => {
    // pkg.ts raises ERR_PACKAGE_PATH_NOT_EXPORTED and protocols/node.ts raises
    // ERR_UNKNOWN_BUILTIN_MODULE; node reports both in preference to a generic
    // not-found, so the ESM wrap must preserve them.
    for (const code of ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_UNKNOWN_BUILTIN_MODULE']) {
        const inner = err(ErrorKind.ModuleNotFound, 'inner', undefined, code);
        const e = esmResolveError('pkg/sub', 'D:/proj/entry.ts', inner, ErrorKind.ModuleNotFound);
        strictEqual(Reflect.get(e, 'code'), code);
    }
});

Deno.test('cts err(): every ErrorKind carries a code except the parse kinds', () => {
    // Node leaves a module parse failure codeless: import() of a file with a
    // syntax error, and of a malformed data: URL, both give code === undefined
    // (measured v24.18.0). Inventing one would send a consumer down the
    // "install the package" path for a source bug.
    const codeless = new Set<ErrorKind>([ErrorKind.SyntaxError, ErrorKind.TransformError]);
    for (const kind of Object.values(ErrorKind)) {
        if (typeof kind !== 'number') continue;
        const e = err(kind, `probe ${kind}`);
        const code = Reflect.get(e, 'code');
        if (codeless.has(kind)) {
            strictEqual(code, undefined, `kind ${kind} must stay codeless like node`);
            continue;
        }
        strictEqual(typeof code, 'string', `kind ${kind} must carry a string code`);
        ok((code as string).length > 0, `kind ${kind} code must be non-empty`);
        // What sharp actually does to the value.
        ok(typeof (code as string).endsWith === 'function');
    }
});

Deno.test('cts err(): resolution-miss codes stay confined to the miss kinds', () => {
    // isResolutionMiss treats MODULE_NOT_FOUND/ENOENT as "keep walking the CJS
    // chain". Handing either to another kind would swallow a real failure as a
    // miss. tests/cts/resolve-miss.test.ts pins the other side of this.
    const missOnly = new Set<ErrorKind>([ErrorKind.ModuleNotFound, ErrorKind.FileNotFound]);
    for (const kind of Object.values(ErrorKind)) {
        if (typeof kind !== 'number' || missOnly.has(kind)) continue;
        const code = codeForKind(kind);
        ok(code !== 'MODULE_NOT_FOUND', `kind ${kind} must not claim MODULE_NOT_FOUND`);
        ok(code !== 'ENOENT', `kind ${kind} must not claim ENOENT`);
        ok(!isResolutionMiss(err(kind, 'probe')), `kind ${kind} must not read as a miss`);
    }
    strictEqual(codeForKind(ErrorKind.ModuleNotFound), 'MODULE_NOT_FOUND');
    strictEqual(codeForKind(ErrorKind.FileNotFound), 'ENOENT');
});

Deno.test('cts require(): missing module keeps MODULE_NOT_FOUND (already correct)', () => {
    // The require side was and stays MODULE_NOT_FOUND — node uses the
    // un-prefixed code there, and npm optional-dependency handling keys off it.
    const e = err(ErrorKind.ModuleNotFound, "Cannot find module 'x' from 'y'");
    strictEqual(Reflect.get(e, 'code'), 'MODULE_NOT_FOUND');
    ok(isResolutionMiss(e));
});

Deno.test('cts addon load failure reports ERR_DLOPEN_FAILED (the sharp case)', () => {
    // Structural: the throw site is inside a private method, so assert the
    // source rather than reaching through the loader. Node sets
    // ERR_DLOPEN_FAILED for a .node that will not load (measured: both
    // process.dlopen and require() of a bad addon).
    const src = readFileSync(join(import.meta.dirname!, '../../cts/src/compile/cjs.ts'), 'utf8');
    const at = src.indexOf('Error loading native addon');
    ok(at >= 0, 'addon-load throw site not found');
    ok(src.slice(at, at + 240).includes('ERR_DLOPEN_FAILED'),
        'addon-load error must carry ERR_DLOPEN_FAILED — sharp reads .code off it');
});

Deno.test('cts hooks.ts routes resolve failures through esmResolveError', () => {
    // Guards against a future edit reverting the hook to a bare err() wrap,
    // which is what produced the codeless import() error in the first place.
    const src = readFileSync(join(import.meta.dirname!, '../../cts/src/runtime/hooks.ts'), 'utf8');
    ok(/throw esmResolveError\(spec, parent, e, kind\)/.test(src),
        'the resolve hook must wrap via esmResolveError');
});

Deno.test('cts import(): real resolver miss composes into a coded error', () => {
    // End-to-end at the source layer: drive the actual resolver to a real miss,
    // then wrap it the way the engine hook does.
    const root = join(tmpdir(), `cts-imperr-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'entry.mjs'), "import './nope-missing.mjs';\n");
    const rt = createRuntime({
        cacheDir: join(root, '.cache'),
        disableLock: true,
        enableCache: false,
        silent: true,
        enableNode: false,
    });
    try {
        const parent = join(root, 'entry.mjs');
        let thrown: unknown;
        try { rt.resolver.resolve('./nope-missing.mjs', parent); }
        catch (e) { thrown = e; }
        ok(thrown instanceof Error, 'resolver must throw for a missing relative import');
        const kind = thrown.kind ?? ErrorKind.ModuleNotFound;
        ok(kind === ErrorKind.FileNotFound || kind === ErrorKind.ModuleNotFound,
            `expected a resolution-miss kind, got ${String(kind)}`);

        const wrapped = esmResolveError('./nope-missing.mjs', parent, thrown, kind);
        strictEqual(Reflect.get(wrapped, 'code'), 'ERR_MODULE_NOT_FOUND');
        const url = Reflect.get(wrapped, 'url');
        strictEqual(typeof url, 'string');
        ok((url as string).startsWith('file://'), `url must be a file URL, got ${String(url)}`);
        ok((url as string).endsWith('/nope-missing.mjs'), `url must name the missing module, got ${String(url)}`);
    } finally {
        rt.cleanup();
        try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});
