import { deepStrictEqual, strictEqual } from 'node:assert';

// Unnamed bytecode module exporting add(i32, i32) -> i32.
const ADD_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

// Module exporting one page of linear memory.
const MEMORY_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    0x05, 0x03, 0x01, 0x00, 0x01,
    0x07, 0x0a, 0x01, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
]);

// One local function exported twice. Both descriptors must expose its same
// kind-relative extern index.
const FUNCTION_ALIAS_WASM = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 5, 1, 96, 0, 1, 127,
    3, 2, 1, 0,
    7, 9, 2, 1, 97, 0, 0, 1, 98, 0, 0,
    10, 6, 1, 4, 0, 65, 41, 11,
]);

// Imports env.value: () -> i32 and re-exports it as get.
const IMPORT_FUNCTION_WASM = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 5, 1, 96, 0, 1, 127,
    2, 13, 1, 3, 101, 110, 118, 5, 118, 97, 108, 117, 101, 0, 0,
    7, 7, 1, 3, 103, 101, 116, 0, 0,
]);

Deno.test('CNO native wasm: Module.info handles an unnamed bytecode module', () => {
    const wasm = import.meta.use('wasm');
    const module = wasm.load(ADD_WASM);

    deepStrictEqual({ ...module.info() }, {
        packageType: 'bytecode',
        packageVersion: 1,
        name: '',
    });

    // Calling info() must not invalidate the otherwise usable module.
    strictEqual(module.instantiate().call('add', 2, 3), 5);
});

Deno.test('CNO native wasm: collecting an Instance detaches retained memory buffers', () => {
    const wasm = import.meta.use('wasm');
    const engine = import.meta.use('engine');
    let instance: CModuleWASM.Instance | null = wasm.load(MEMORY_WASM).instantiate();
    const buffer = instance.memoryBuffer();
    strictEqual(buffer.byteLength, 65536);

    instance = null;
    engine.gc.run();
    engine.gc.run();
    strictEqual(buffer.byteLength, 0);
});

Deno.test('CNO native wasm: descriptors expose stable kind-relative externIndex', () => {
    const wasm = import.meta.use('wasm');
    const module = wasm.load(FUNCTION_ALIAS_WASM);
    const exports = module.exports();
    strictEqual(exports.length, 2);
    strictEqual(exports[0].kind, 'function');
    strictEqual(exports[0].externIndex, exports[1].externIndex);
    strictEqual(exports[0].externIndex, 0);

    const instance = module.instantiate();
    strictEqual(instance.callByIndex(exports[0].externIndex), 41);
});

Deno.test('CNO native wasm: function callbacks are configured per Instance', () => {
    const wasm = import.meta.use('wasm');
    const module = wasm.load(IMPORT_FUNCTION_WASM);
    const first = module.instantiate({
        functions: [{ module: 'env', name: 'value', func: () => 11 }],
    });
    const second = module.instantiate({
        functions: [{ module: 'env', name: 'value', func: () => 29 }],
    });

    strictEqual(first.call('get'), 11);
    strictEqual(second.call('get'), 29);
    strictEqual(first.call('get'), 11);
});
