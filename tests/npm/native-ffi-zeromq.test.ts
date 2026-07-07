import { ok, strictEqual } from 'node:assert';

Deno.test({ name: 'zeromq: native addon loads and exposes runtime capabilities', timeout: 30000 }, async () => {
    const zmq = await import('npm:zeromq');
    strictEqual(typeof zmq.version, 'string');
    ok(zmq.version.length > 0, 'zeromq should expose a version string');

    const keys = zmq.curveKeyPair();
    strictEqual(typeof keys.publicKey, 'string');
    strictEqual(typeof keys.secretKey, 'string');
    strictEqual(keys.publicKey.length, 40);
    strictEqual(keys.secretKey.length, 40);
});

Deno.test({ name: 'ffi-napi and ref-napi: call libc and dereference native memory', timeout: 30000 }, async () => {
    const ffiMod = await import('npm:ffi-napi');
    const refMod = await import('npm:ref-napi');
    const ffi = ffiMod.default ?? ffiMod;
    const ref = refMod.default ?? refMod;

    const buf = ref.alloc(ref.types.int, 42);
    strictEqual(ref.deref(buf), 42);

    const libc = ffi.Library('libc.so.6', {
        strlen: ['size_t', ['string']],
    });
    strictEqual(Number(libc.strlen('compat')), 6);
});
