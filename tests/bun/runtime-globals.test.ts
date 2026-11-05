import { ok, strictEqual, throws } from 'node:assert';
import Bun from 'bun';

Deno.test({ name: 'bun: gc and enableANSIColors globals', timeout: 5000 }, () => {
    strictEqual(typeof Bun.gc, 'function');
    strictEqual(Bun.gc, globalThis.Bun.gc);
    Bun.gc();
    Bun.gc(true);
    throws(() => Bun.gc('yes' as never), TypeError);
    Bun.gc(false);

    strictEqual(typeof Bun.enableANSIColors, 'boolean');
    // The value is a non-writable snapshot of stdout's terminal status, not a
    // live getter re-reading the fd on every access.
    const descriptor = Object.getOwnPropertyDescriptor(Bun, 'enableANSIColors');
    ok(descriptor && 'value' in descriptor && descriptor.writable === false);
});
