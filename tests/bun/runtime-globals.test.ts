import { ok, strictEqual, throws } from 'node:assert';
import Bun, { embeddedFiles, isStandaloneExecutable, shrink } from 'bun';

Deno.test({ name: 'bun: gc and enableANSIColors globals', timeout: 5000 }, () => {
    strictEqual(typeof Bun.gc, 'function');
    strictEqual(Bun.gc, globalThis.Bun.gc);
    Bun.gc();
    Bun.gc(true);
    strictEqual(typeof Bun.shrink, 'function');
    strictEqual(Bun.shrink, shrink);
    strictEqual(globalThis.Bun.shrink, shrink);
    shrink();
    throws(() => Bun.gc('yes' as never), TypeError);
    Bun.gc(false);

    strictEqual(typeof Bun.enableANSIColors, 'boolean');
    // The value is a non-writable snapshot of stdout's terminal status, not a
    // live getter re-reading the fd on every access.
    const descriptor = Object.getOwnPropertyDescriptor(Bun, 'enableANSIColors');
    ok(descriptor && 'value' in descriptor && descriptor.writable === false);
    const shrinkDescriptor = Object.getOwnPropertyDescriptor(Bun, 'shrink');
    ok(shrinkDescriptor && 'value' in shrinkDescriptor && shrinkDescriptor.writable === false);
});

Deno.test('bun: standalone feature detection remains truthful for cno executables', () => {
    strictEqual(isStandaloneExecutable, false);
    strictEqual(Bun.isStandaloneExecutable, isStandaloneExecutable);
    strictEqual(globalThis.Bun.isStandaloneExecutable, isStandaloneExecutable);

    strictEqual(embeddedFiles, Bun.embeddedFiles);
    strictEqual(Bun.embeddedFiles.length, 0);
    ok(Object.isFrozen(Bun.embeddedFiles));
    for (const name of ['isStandaloneExecutable', 'embeddedFiles'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(Bun, name);
        ok(descriptor && 'value' in descriptor && descriptor.writable === false, name);
    }
});
