import { strictEqual, ok } from 'node:assert';

// ============================================================================
// WebAssembly — Module/Instance/Memory/Table
// ============================================================================

// Minimal wasm binary: a module exporting a function `add(i32,i32)->i32`
// that returns a + b.
const ADD_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // magic
    0x01, 0x00, 0x00, 0x00, // version
    // type section
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    // func section
    0x03, 0x02, 0x01, 0x00,
    // export section
    0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
    // code section
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

Deno.test('WebAssembly: Module can be compiled from bytes', () => {
    const m = new WebAssembly.Module(ADD_WASM);
    ok(m instanceof WebAssembly.Module);
});

Deno.test('WebAssembly: Module.exports lists exported functions', () => {
    const m = new WebAssembly.Module(ADD_WASM);
    const exports = WebAssembly.Module.exports(m);
    ok(Array.isArray(exports));
    const add = exports.find((e) => e.name === 'add');
    ok(add, 'add must be exported');
    strictEqual(add!.kind, 'function');
});

Deno.test('WebAssembly: Module.imports lists imports (empty here)', () => {
    const m = new WebAssembly.Module(ADD_WASM);
    const imports = WebAssembly.Module.imports(m);
    ok(Array.isArray(imports));
    strictEqual(imports.length, 0);
});

Deno.test('WebAssembly: instantiate returns callable exports', async () => {
    const m = new WebAssembly.Module(ADD_WASM);
    const inst = await WebAssembly.instantiate(m);
    ok(inst instanceof WebAssembly.Instance);
    const add = (inst.exports as unknown as { add: (a: number, b: number) => number }).add;
    ok(typeof add === 'function');
    strictEqual(add(2, 3), 5);
    strictEqual(add(-1, 1), 0);
});

Deno.test('WebAssembly: compile + instantiate round-trip', async () => {
    const { instance: inst } = await WebAssembly.instantiate(ADD_WASM);
    const add = (inst.exports as { add: (a: number, b: number) => number }).add;
    strictEqual(add(10, 20), 30);
});

Deno.test('WebAssembly: Memory can be created', () => {
    const mem = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    ok(mem instanceof WebAssembly.Memory);
    ok(mem.buffer instanceof ArrayBuffer);
    strictEqual(mem.buffer.byteLength, 65536, '1 page = 64KiB');
});

Deno.test('WebAssembly: Memory.grow increases size', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const before = mem.buffer.byteLength;
    const pages = mem.grow(1);
    ok(pages >= 1, 'grow returns previous page count');
    strictEqual(mem.buffer.byteLength, before + 65536);
});

Deno.test('WebAssembly: Memory.buffer is live after grow', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const buf1 = mem.buffer;
    mem.grow(1);
    const buf2 = mem.buffer;
    ok(buf1 !== buf2, 'buffer reference must update after grow');
});

Deno.test('WebAssembly: Table can be created', () => {
    const tbl = new WebAssembly.Table({ initial: 2, element: 'anyfunc' });
    ok(tbl instanceof WebAssembly.Table);
    strictEqual(tbl.length, 2);
});

Deno.test('WebAssembly: Table.get/set round-trips', () => {
    const tbl = new WebAssembly.Table({ initial: 2, element: 'anyfunc' });
    const fn = () => 42;
    tbl.set(0, fn);
    ok(tbl.get(0) === fn);
});

Deno.test('WebAssembly: Table.grow increases length', () => {
    const tbl = new WebAssembly.Table({ initial: 1, element: 'anyfunc' });
    const prev = tbl.grow(2);
    strictEqual(prev, 1);
    strictEqual(tbl.length, 3);
});

Deno.test('WebAssembly: validate returns boolean', () => {
    ok(WebAssembly.validate(ADD_WASM));
    ok(!WebAssembly.validate(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])));
});

Deno.test('WebAssembly: compileStreaming/instantiateStreaming exist', () => {
    ok(typeof WebAssembly.compileStreaming === 'function');
    ok(typeof WebAssembly.instantiateStreaming === 'function');
});

Deno.test('WebAssembly: invalid bytes throw on compile', () => {
    let threw = false;
    try { new WebAssembly.Module(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])); } catch { threw = true; }
    ok(threw, 'invalid wasm must throw');
});
