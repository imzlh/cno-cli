import { ok, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { tryLoadOxc, oxcExtPath, isOxcModule } from '../../cts/src/oxc.ts';

Deno.test('tryLoadOxc: reuses bootstrap-registered oxc (no re-register fail)', () => {
    // cno main always registerExtensions() before CLI code. tryLoadOxc used to
    // call import.meta.register again, catch "already registered", return null,
    // and fall back to Sucrase scan (~seconds per TS file). Native scan is ms.
    const ext = oxcExtPath();
    ok(ext, 'oxc.so must be discoverable (CTS_EXT_PATH or <exe>/ext)');

    const oxc = tryLoadOxc();
    ok(oxc, 'tryLoadOxc must succeed when oxc is already registered or loadable');

    // Prefer a real mid-size TS file if present; else a synthetic type-heavy source.
    let source: string;
    let filename: string;
    try {
        filename = '/home/iz/frpc/src/types.ts';
        source = new TextDecoder().decode(readFileSync(filename));
    } catch {
        filename = 'synthetic-types.ts';
        source = [
            'import type { Socket } from "node:net";',
            'import { Buffer } from "node:buffer";',
            'export type A = string | number | boolean | null | undefined;',
            'export interface B { a: A; b: Socket; c: Buffer; }',
            'export type Nested = { [k: string]: B | Nested };',
            'export const x: Nested = {};',
        ].join('\n');
    }

    const t0 = Date.now();
    const deps = oxc.scanImports(source, filename);
    const ms = Date.now() - t0;
    ok(deps !== null, 'scanImports must not fall through to null');
    ok(ms < 500, `oxc scan should be sub-second on this host, got ${ms}ms`);
    // Second load must hit module cache, not re-register.
    strictEqual(tryLoadOxc(), oxc);
});

Deno.test('oxc as ext: bootstrap dyn_registry + use() shape', () => {
    // Extension model: name is registered once (bootstrap), use() loads the .so.
    // import.meta.use returns null for unknown names (does not throw).
    const mod = import.meta.use('oxc');
    ok(mod !== null && mod !== undefined, 'bootstrap must register oxc when oxc.so is present');
    ok(isOxcModule(mod), 'registered oxc must expose transpile/scanImports/version');
    const ver = Reflect.get(mod, 'version');
    ok(typeof ver === 'string' && ver.includes('oxc'), `unexpected version: ${String(ver)}`);
});

Deno.test('oxc as ext: re-register is harmless for tryLoadOxc', () => {
    // The old bug: register → throw already registered → return null → Sucrase.
    const path = oxcExtPath();
    ok(path);
    let threw = false;
    try {
        import.meta.register('oxc', path!);
    } catch {
        threw = true;
    }
    // Either first register in process or already registered — both ok.
    const oxc = tryLoadOxc();
    ok(oxc, `tryLoadOxc must work after re-register attempt (threw=${threw})`);
});
