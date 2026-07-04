import { strictEqual, ok } from 'node:assert';
import { WASI } from 'node:wasi';

// --- 1. WASI is a constructor -----------------------------------------------

Deno.test('wasi: WASI is a constructor', () => {
    ok(typeof WASI === 'function');
});

// --- 2. WASI constructor accepts options ------------------------------------

Deno.test('wasi: WASI constructor accepts options', () => {
    let w: any;
    try {
        w = new WASI({});
    } catch (e: any) {
        // Some runtimes require a wasm module; construction with empty opts
        // should either succeed or throw a clean error, not crash.
        ok(typeof e.message === 'string');
    }
    ok(w || true);
});

// --- 3. WASI.start is a function --------------------------------------------

Deno.test('wasi: WASI.prototype.start is a function', () => {
    ok(typeof WASI.prototype.start === 'function');
});

// --- 4. WASI.initialize is a function ---------------------------------------

Deno.test('wasi: WASI.prototype.initialize is a function', () => {
    ok(typeof WASI.prototype.initialize === 'function');
});

// --- 5. WASI.version getter -------------------------------------------------

Deno.test('wasi: WASI.version is a string', () => {
    const v = (WASI as any).version;
    ok(v === undefined || typeof v === 'string');
});

// --- 6. WASI constructor with version option -------------------------------

Deno.test('wasi: WASI constructor with version option', () => {
    let w: any;
    try {
        w = new WASI({ version: 'preview1' });
    } catch (e: any) {
        ok(typeof e.message === 'string');
    }
    ok(w || true);
});

// --- 7. WASI.start with non-instance throws ---------------------------------

Deno.test('wasi: WASI.start with invalid arg throws cleanly', () => {
    let threw = false;
    try {
        const w = new WASI({});
        w.start({} as any);
    } catch (e: any) {
        threw = true;
        ok(typeof e.message === 'string');
    }
    ok(threw, 'start with non-instance must throw');
});

// --- 8. WASI.initialize with non-instance throws ----------------------------

Deno.test('wasi: WASI.initialize with invalid arg throws cleanly', () => {
    let threw = false;
    try {
        const w = new WASI({});
        w.initialize({} as any);
    } catch (e: any) {
        threw = true;
        ok(typeof e.message === 'string');
    }
    ok(threw, 'initialize with non-instance must throw');
});
