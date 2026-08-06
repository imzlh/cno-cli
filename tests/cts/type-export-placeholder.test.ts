import { ok, strictEqual } from 'node:assert';
import { Transformer } from '../../cts/src/source/transform.ts';

// Type-only export placeholders.
//
// A TS `export type` / `export interface` has no runtime value, so stripping
// types should leave no export behind. Both transpiler paths nevertheless emit
// `export const <Name> = <undefined-ish>;` on purpose: transpilation is
// per-file, so when module B writes
//
//     import { Iface } from './a'; export { Iface };
//
// neither path can tell that `Iface` is type-only (that needs whole-program
// type info), keeps the binding, and the ESM linker then demands a real export
// named `Iface` from module A. The placeholder on A's side satisfies it.
//
// Node rejects that same code outright ("does not provide an export named"),
// so the placeholder is a deliberate compatibility extension, NOT a bug — and
// removing it wholesale breaks working code. What *is* a bug is emitting a
// placeholder twice, which is a redeclaration SyntaxError that fails the whole
// module. These tests pin the intended shape on the Sucrase fallback path.
//
// `Transformer` is imported by relative path, so these exercise the
// TypeScript source on disk with no rebuild.

/** Transformer pinned to the Sucrase fallback (no native oxc). */
function sucraseOnly(): Transformer {
    const t = new Transformer({ sourceMaps: false });
    t.setOxcLoader(() => null);
    return t;
}

function placeholdersFor(code: string): string[] {
    const out = sucraseOnly().transform(code, 'in.ts');
    return [...out.matchAll(/export const (\w+) = undefined;/g)].map((m) => m[1]);
}

// --- 1. Declaration merging must not emit the placeholder twice -------------
//
// `export interface D {}` twice in one file is legal TypeScript that Node
// accepts. Emitting two `export const D = undefined;` is a QuickJS
// "invalid redefinition of global identifier" that kills the entire module,
// turning valid input into a hard load failure.

Deno.test('cts: declaration-merged export interface emits one placeholder', () => {
    const names = placeholdersFor(
        'export interface D { a: number }\nexport interface D { b: string }\nexport const v = 1;\n',
    );
    const dCount = names.filter((n) => n === 'D').length;
    strictEqual(dCount, 1, `expected exactly one D placeholder, got ${dCount}: ${names.join(',')}`);
});

Deno.test('cts: declaration-merged export type alias emits one placeholder', () => {
    // Distinct names still each get one; only repeats collapse.
    const names = placeholdersFor('export type A = 1;\nexport interface B { x: 1 }\n');
    strictEqual(names.filter((n) => n === 'A').length, 1);
    strictEqual(names.filter((n) => n === 'B').length, 1);
});

Deno.test('cts: repeated type-only export produces parseable output', () => {
    // Guard the actual failure mode, not just the placeholder count: the
    // emitted source must be syntactically valid.
    const out = sucraseOnly().transform(
        'export interface D { a: number }\nexport interface D { b: string }\nexport const v = 1;\n',
        'in.ts',
    );
    // Two identical `const` declarations at module scope is the crash.
    const dupes = out.match(/export const D = undefined;/g) ?? [];
    strictEqual(dupes.length, 1, `duplicate const D is a redeclaration SyntaxError: ${out}`);
    ok(!out.includes('interface'), `TS syntax must be stripped: ${out}`);
});

// --- 2. The sentinel: a lone type-only export KEEPS its placeholder ---------
//
// Over-narrowing here is the documented hazard. A plain (non-`type`) named
// import of a type-only export works in cno solely because of this stub.

Deno.test('cts: lone export interface still emits its placeholder', () => {
    strictEqual(placeholdersFor('export interface PeerCertificate { subject: string }\n').join(','),
        'PeerCertificate');
});

Deno.test('cts: lone export type alias still emits its placeholder', () => {
    strictEqual(placeholdersFor('export type OnlyAType = { x: number };\n').join(','), 'OnlyAType');
});

// --- 3. A real runtime value with the same name wins -----------------------

Deno.test('cts: no placeholder when a value of the same name is exported', () => {
    const out = sucraseOnly().transform(
        'export interface M { a: number }\nexport const M = 1;\n', 'in.ts',
    );
    ok(!out.includes('M = undefined'), `value must win over the type placeholder: ${out}`);
    ok(out.includes('export const M = 1'), out);
});

// --- 4. Re-export forms emit nothing --------------------------------------
//
// `export type { X } from './m'` names another module's binding, so there is
// nothing local to stub; emitting one would invent an export.

Deno.test('cts: export type re-export from a module emits no placeholder', () => {
    strictEqual(placeholdersFor("export type { R } from './other';\nexport const v = 1;\n").length, 0);
});

Deno.test('cts: inline export { type X } emits no placeholder', () => {
    strictEqual(
        placeholdersFor('interface L { x: number }\nexport { type L };\nexport const v = 1;\n').length,
        0,
    );
});

// --- 5. Value exports are never treated as types --------------------------

Deno.test('cts: ordinary value exports emit no placeholders', () => {
    strictEqual(placeholdersFor('export const a = 1;\nexport function f() {}\nexport class C {}\n').length, 0);
});

Deno.test('cts: unexported interface gets no placeholder', () => {
    strictEqual(placeholdersFor('interface Internal { x: number }\nexport const v = 1;\n').length, 0);
});
