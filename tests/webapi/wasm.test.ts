import { rejects, strictEqual, ok, throws } from 'node:assert';

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

// Imports env.value(): i32 and exports run(), which calls that import.
const FUNCTION_IMPORT_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
    0x02, 0x0d, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x05, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x01,
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x10, 0x00, 0x0b,
]);

const uleb = (value: number): number[] => {
    const bytes: number[] = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value) byte |= 0x80;
        bytes.push(byte);
    } while (value);
    return bytes;
};
const utf8 = (value: string): number[] => {
    const bytes = [...new TextEncoder().encode(value)];
    return [...uleb(bytes.length), ...bytes];
};
const vector = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const section = (id: number, payload: number[]): number[] => [id, ...uleb(payload.length), ...payload];
const funcType = (params: number[], results: number[]): number[] =>
    [0x60, ...vector(params.map((type) => [type])), ...vector(results.map((type) => [type]))];
const body = (instructions: number[]): number[] => {
    const payload = [0, ...instructions, 0x0b];
    return [...uleb(payload.length), ...payload];
};
const wasmExport = (name: string, kind: number, index: number): number[] =>
    [...utf8(name), kind, ...uleb(index)];

function importedExternProbe(): Uint8Array {
    const I32 = 0x7f;
    const EXTERNREF = 0x6f;
    const types = [
        funcType([I32], [I32]),
        funcType([I32, I32], []),
        funcType([], [I32]),
        funcType([I32], [EXTERNREF]),
        funcType([I32, EXTERNREF], []),
        funcType([I32], []),
        funcType([I32, EXTERNREF], [I32]),
    ];
    const functions = [0, 1, 2, 0, 3, 4, 2, 5, 2, 6];
    const exports = [
        wasmExport('memA', 2, 0), wasmExport('memB', 2, 0),
        wasmExport('tabA', 1, 0), wasmExport('tabB', 1, 0),
        wasmExport('gA', 3, 0), wasmExport('gB', 3, 0),
        wasmExport('read', 0, 0), wasmExport('write', 0, 1),
        wasmExport('pages', 0, 2), wasmExport('growMem', 0, 3),
        wasmExport('getT', 0, 4), wasmExport('setT', 0, 5),
        wasmExport('getG', 0, 6), wasmExport('setG', 0, 7),
        wasmExport('tableSize', 0, 8), wasmExport('growT', 0, 9),
    ];
    const code = [
        body([0x20, 0, 0x28, 2, 0]),
        body([0x20, 0, 0x20, 1, 0x36, 2, 0]),
        body([0x3f, 0]),
        body([0x20, 0, 0x40, 0]),
        body([0x20, 0, 0x25, 0]),
        body([0x20, 0, 0x20, 1, 0x26, 0]),
        body([0x23, 0]),
        body([0x20, 0, 0x24, 0]),
        body([0xfc, 0x10, 0]),
        body([0x20, 1, 0x20, 0, 0xfc, 0x0f, 0]),
    ];
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(1, vector(types)),
        ...section(2, vector([
            [...utf8('env'), ...utf8('mem'), 2, 1, 1, 3],
            [...utf8('env'), ...utf8('tab'), 1, EXTERNREF, 1, 2, 4],
            [...utf8('env'), ...utf8('g'), 3, I32, 1],
        ])),
        ...section(3, vector(functions.map(uleb))),
        ...section(7, vector(exports)),
        ...section(10, vector(code)),
    ]);
}

const IMPORTED_EXTERN_WASM = importedExternProbe();
const LOCAL_FUNCTION_ALIAS_WASM = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 5, 1, 96, 0, 1, 127,
    3, 2, 1, 0,
    7, 9, 2, 1, 97, 0, 0, 1, 98, 0, 0,
    10, 6, 1, 4, 0, 65, 41, 11,
]);
const FUNCTION_REEXPORT_WASM = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 5, 1, 96, 0, 1, 127,
    2, 7, 1, 1, 109, 1, 102, 0, 0,
    7, 9, 2, 1, 97, 0, 0, 1, 98, 0, 0,
]);

function sharedFuncrefTableProbe(): Uint8Array {
    const I32 = 0x7f;
    const FUNCREF = 0x70;
    const types = [funcType([], [I32]), funcType([I32], [I32])];
    const imports = [
        [...utf8('env'), ...utf8('a'), 1, FUNCREF, 1, 2, 4],
        [...utf8('env'), ...utf8('b'), 1, FUNCREF, 1, 2, 4],
    ];
    const exports = [
        wasmExport('a', 1, 0), wasmExport('b', 1, 1),
        wasmExport('sizeA', 0, 0), wasmExport('sizeB', 0, 1),
        wasmExport('growA', 0, 2),
    ];
    const code = [
        body([0xfc, 0x10, 0]),
        body([0xfc, 0x10, 1]),
        body([0xd0, FUNCREF, 0x20, 0, 0xfc, 0x0f, 0]),
    ];
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(1, vector(types)),
        ...section(2, vector(imports)),
        ...section(3, vector([uleb(0), uleb(0), uleb(1)])),
        ...section(7, vector(exports)),
        ...section(10, vector(code)),
    ]);
}

const SHARED_FUNCREF_TABLE_WASM = sharedFuncrefTableProbe();

function providerFuncrefTableProbe(): Uint8Array {
    const I32 = 0x7f;
    const FUNCREF = 0x70;
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(1, vector([funcType([], [I32])])),
        ...section(3, vector([uleb(0)])),
        ...section(4, vector([[FUNCREF, 1, 1, 1]])),
        ...section(7, vector([
            wasmExport('table', 1, 0), wasmExport('value', 0, 0),
        ])),
        ...section(9, vector([[0, 0x41, 0, 0x0b, ...vector([uleb(0)])]])),
        ...section(10, vector([body([0x41, 41])])),
    ]);
}

function consumerFuncrefTableProbe(): Uint8Array {
    const I32 = 0x7f;
    const FUNCREF = 0x70;
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(1, vector([funcType([], [I32])])),
        ...section(2, vector([
            [...utf8('env'), ...utf8('table'), 1, FUNCREF, 1, 1, 1],
        ])),
        ...section(3, vector([uleb(0), uleb(0)])),
        ...section(7, vector([
            wasmExport('local', 0, 0), wasmExport('call', 0, 1),
        ])),
        ...section(10, vector([
            body([0x41, 17]),
            body([0x41, 0, 0x11, 0, 0]),
        ])),
    ]);
}

function externrefTableProviderProbe(): Uint8Array {
    const I32 = 0x7f;
    const EXTERNREF = 0x6f;
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(1, vector([funcType([I32], [EXTERNREF])])),
        ...section(3, vector([uleb(0)])),
        ...section(4, vector([[EXTERNREF, 1, 1, 1]])),
        ...section(7, vector([
            wasmExport('table', 1, 0), wasmExport('get', 0, 0),
        ])),
        ...section(10, vector([body([0x20, 0, 0x25, 0])])),
    ]);
}

function externrefTableConsumerProbe(): Uint8Array {
    const I32 = 0x7f;
    const EXTERNREF = 0x6f;
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(1, vector([funcType([I32, EXTERNREF], [])])),
        ...section(2, vector([
            [...utf8('env'), ...utf8('table'), 1, EXTERNREF, 1, 1, 1],
        ])),
        ...section(3, vector([uleb(0)])),
        ...section(7, vector([wasmExport('set', 0, 0)])),
        ...section(10, vector([body([0x20, 0, 0x20, 1, 0x26, 0])])),
    ]);
}

function providerTrampolineProbe(): Uint8Array {
    const I32 = 0x7f;
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(1, vector([funcType([], [I32])])),
        ...section(2, vector([
            [...utf8('env'), ...utf8('hook'), 0, 0],
        ])),
        ...section(3, vector([uleb(0)])),
        ...section(5, vector([[1, 1, 2]])),
        ...section(7, vector([
            wasmExport('run', 0, 1), wasmExport('memory', 2, 0),
        ])),
        ...section(10, vector([
            body([0x41, 1, 0x40, 0, 0x1a, 0x10, 0]),
        ])),
    ]);
}

function consumerFunctionProbe(): Uint8Array {
    const I32 = 0x7f;
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(1, vector([funcType([], [I32])])),
        ...section(2, vector([
            [...utf8('env'), ...utf8('run'), 0, 0],
        ])),
        ...section(3, vector([uleb(0)])),
        ...section(7, vector([wasmExport('call', 0, 1)])),
        ...section(10, vector([body([0x10, 0])])),
    ]);
}

const PROVIDER_FUNCREF_TABLE_WASM = providerFuncrefTableProbe();
const CONSUMER_FUNCREF_TABLE_WASM = consumerFuncrefTableProbe();
const EXTERNREF_TABLE_PROVIDER_WASM = externrefTableProviderProbe();
const EXTERNREF_TABLE_CONSUMER_WASM = externrefTableConsumerProbe();
const PROVIDER_TRAMPOLINE_WASM = providerTrampolineProbe();
const CONSUMER_FUNCTION_WASM = consumerFunctionProbe();

function duplicateGlobalImportProbe(): Uint8Array {
    const I32 = 0x7f;
    const types = [funcType([], [I32]), funcType([I32], [])];
    const imports = [
        [...utf8('env'), ...utf8('same'), 3, I32, 1],
        [...utf8('env'), ...utf8('same'), 3, I32, 1],
    ];
    const code = [
        body([0x23, 0]),
        body([0x23, 1]),
        body([0x20, 0, 0x24, 0]),
        body([0x20, 0, 0x24, 1]),
    ];
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(1, vector(types)),
        ...section(2, vector(imports)),
        ...section(3, vector([uleb(0), uleb(0), uleb(1), uleb(1)])),
        ...section(7, vector([
            wasmExport('first', 3, 0), wasmExport('second', 3, 1),
            wasmExport('getFirst', 0, 0), wasmExport('getSecond', 0, 1),
            wasmExport('setFirst', 0, 2), wasmExport('setSecond', 0, 3),
        ])),
        ...section(10, vector(code)),
    ]);
}

function duplicateTableImportProbe(): Uint8Array {
    const I32 = 0x7f;
    const EXTERNREF = 0x6f;
    const types = [
        funcType([], [I32]),
        funcType([I32], [EXTERNREF]),
        funcType([I32, EXTERNREF], []),
    ];
    const imports = [
        [...utf8('env'), ...utf8('same'), 1, EXTERNREF, 1, 1, 3],
        [...utf8('env'), ...utf8('same'), 1, EXTERNREF, 1, 1, 3],
    ];
    const code = [
        body([0xfc, 0x10, 0]),
        body([0xfc, 0x10, 1]),
        body([0x20, 0, 0x25, 0]),
        body([0x20, 0, 0x25, 1]),
        body([0x20, 0, 0x20, 1, 0x26, 0]),
        body([0x20, 0, 0x20, 1, 0x26, 1]),
    ];
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(1, vector(types)),
        ...section(2, vector(imports)),
        ...section(3, vector([uleb(0), uleb(0), uleb(1), uleb(1), uleb(2), uleb(2)])),
        ...section(7, vector([
            wasmExport('first', 1, 0), wasmExport('second', 1, 1),
            wasmExport('sizeFirst', 0, 0), wasmExport('sizeSecond', 0, 1),
            wasmExport('getFirst', 0, 2), wasmExport('getSecond', 0, 3),
            wasmExport('setFirst', 0, 4), wasmExport('setSecond', 0, 5),
        ])),
        ...section(10, vector(code)),
    ]);
}

function duplicateMemoryImportProbe(): Uint8Array {
    const I32 = 0x7f;
    const types = [funcType([], [I32]), funcType([I32], [I32])];
    const imports = [
        [...utf8('env'), ...utf8('same'), 2, 1, 1, 3],
        [...utf8('env'), ...utf8('same'), 2, 1, 1, 3],
    ];
    const code = [
        body([0x3f, 0]),
        body([0x3f, 1]),
        body([0x20, 0, 0x40, 0]),
        body([0x20, 0, 0x40, 1]),
    ];
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(1, vector(types)),
        ...section(2, vector(imports)),
        ...section(3, vector([uleb(0), uleb(0), uleb(1), uleb(1)])),
        ...section(7, vector([
            wasmExport('first', 2, 0), wasmExport('second', 2, 1),
            wasmExport('sizeFirst', 0, 0), wasmExport('sizeSecond', 0, 1),
            wasmExport('growFirst', 0, 2), wasmExport('growSecond', 0, 3),
        ])),
        ...section(10, vector(code)),
    ]);
}

function distinctGlobalImportProbe(): Uint8Array {
    const I32 = 0x7f;
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(2, vector([
            [...utf8('env'), ...utf8('first'), 3, I32, 0],
            [...utf8('env'), ...utf8('second'), 3, I32, 0],
        ])),
        ...section(7, vector([
            wasmExport('first', 3, 0), wasmExport('second', 3, 1),
        ])),
    ]);
}

function distinctTableImportProbe(): Uint8Array {
    const EXTERNREF = 0x6f;
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...section(2, vector([
            [...utf8('env'), ...utf8('first'), 1, EXTERNREF, 1, 1, 2],
            [...utf8('env'), ...utf8('second'), 1, EXTERNREF, 1, 1, 2],
        ])),
        ...section(7, vector([
            wasmExport('first', 1, 0), wasmExport('second', 1, 1),
        ])),
    ]);
}

const DUPLICATE_GLOBAL_IMPORT_WASM = duplicateGlobalImportProbe();
const DUPLICATE_TABLE_IMPORT_WASM = duplicateTableImportProbe();
const DUPLICATE_MEMORY_IMPORT_WASM = duplicateMemoryImportProbe();
const DISTINCT_GLOBAL_IMPORT_WASM = distinctGlobalImportProbe();
const DISTINCT_TABLE_IMPORT_WASM = distinctTableImportProbe();

type ExternProbe = {
    memA: WebAssembly.Memory; memB: WebAssembly.Memory;
    tabA: WebAssembly.Table; tabB: WebAssembly.Table;
    gA: WebAssembly.Global; gB: WebAssembly.Global;
    read(offset: number): number; write(offset: number, value: number): void;
    pages(): number; growMem(delta: number): number;
    getT(index: number): unknown; setT(index: number, value: unknown): void;
    tableSize(): number; growT(delta: number, init: unknown): number;
    getG(): number; setG(value: number): void;
};

function instantiateExternProbe(
    memory: WebAssembly.Memory,
    table: WebAssembly.Table,
    global: WebAssembly.Global,
): ExternProbe {
    return new WebAssembly.Instance(new WebAssembly.Module(IMPORTED_EXTERN_WASM), {
        env: { mem: memory, tab: table, g: global },
    }).exports as unknown as ExternProbe;
}

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

Deno.test('WebAssembly: one Module can instantiate with independent function imports', () => {
    const module = new WebAssembly.Module(FUNCTION_IMPORT_WASM);
    const first = new WebAssembly.Instance(module, { env: { value: () => 11 } });
    const second = new WebAssembly.Instance(module, { env: { value: () => 22 } });
    const firstRun = first.exports.run as () => number;
    const secondRun = second.exports.run as () => number;
    strictEqual(firstRun(), 11);
    strictEqual(secondRun(), 22);
    strictEqual(firstRun(), 11, 'the second instance must not replace the first import binding');
});

Deno.test('WebAssembly: imported externs retain identity and live state across instances', () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
    const table = new WebAssembly.Table({ element: 'externref', initial: 2, maximum: 4 });
    const global = new WebAssembly.Global({ value: 'i32', mutable: true }, 7);
    const originalBuffer = memory.buffer;
    const firstValue = { from: 'host' };
    table.set(0, firstValue);
    new Int32Array(originalBuffer)[0] = 42;

    const first = instantiateExternProbe(memory, table, global);
    const second = instantiateExternProbe(memory, table, global);

    for (const exports of [first, second]) {
        strictEqual(exports.memA, memory);
        strictEqual(exports.memB, memory);
        strictEqual(exports.tabA, table);
        strictEqual(exports.tabB, table);
        strictEqual(exports.gA, global);
        strictEqual(exports.gB, global);
        strictEqual(exports.read(0), 42);
        strictEqual(exports.getT(0), firstValue);
        strictEqual(exports.getG(), 7);
    }
    strictEqual(memory.buffer, originalBuffer);

    first.write(4, 99);
    strictEqual(new Int32Array(memory.buffer)[1], 99);
    strictEqual(second.read(4), 99);
    const secondValue = { from: 'wasm' };
    first.setT(1, secondValue);
    strictEqual(table.get(1), secondValue);
    strictEqual(second.getT(1), secondValue);
    first.setG(11);
    strictEqual(global.value, 11);
    strictEqual(second.getG(), 11);

    global.value = 13;
    table.set(0, secondValue);
    new Int32Array(memory.buffer)[2] = 77;
    strictEqual(first.getG(), 13);
    strictEqual(first.getT(0), secondValue);
    strictEqual(second.read(8), 77);

    strictEqual(first.growMem(1), 1);
    strictEqual(originalBuffer.byteLength, 0);
    strictEqual(memory.buffer.byteLength, 2 * 65536);
    strictEqual(second.pages(), 2);
    const secondBuffer = memory.buffer;
    strictEqual(memory.grow(1), 2);
    strictEqual(secondBuffer.byteLength, 0);
    strictEqual(first.pages(), 3);
    strictEqual(second.pages(), 3);
    strictEqual(first.growT(1, firstValue), 2);
    strictEqual(table.length, 3);
    strictEqual(second.tableSize(), 3);
    strictEqual(table.get(2), firstValue);
    strictEqual(table.grow(1, secondValue), 3);
    strictEqual(first.tableSize(), 4);
    strictEqual(second.getT(3), secondValue);
});

Deno.test('WebAssembly: one standalone funcref Table shares backing across import slots', () => {
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 2, maximum: 4 });
    const exports = new WebAssembly.Instance(
        new WebAssembly.Module(SHARED_FUNCREF_TABLE_WASM),
        { env: { a: table, b: table } },
    ).exports as unknown as {
        a: WebAssembly.Table;
        b: WebAssembly.Table;
        sizeA(): number;
        sizeB(): number;
        growA(delta: number): number;
    };

    strictEqual(exports.a, table);
    strictEqual(exports.b, table);
    strictEqual(exports.sizeA(), 2);
    strictEqual(exports.sizeB(), 2);
    strictEqual(exports.growA(1), 2);
    strictEqual(exports.sizeA(), 3);
    strictEqual(exports.sizeB(), 3);
    strictEqual(table.length, 3);
});

Deno.test('WebAssembly: provider-backed funcref Table calls the provider function', () => {
    const provider = new WebAssembly.Instance(
        new WebAssembly.Module(PROVIDER_FUNCREF_TABLE_WASM),
    ).exports as unknown as { table: WebAssembly.Table; value(): number };
    const consumer = new WebAssembly.Instance(
        new WebAssembly.Module(CONSUMER_FUNCREF_TABLE_WASM),
        { env: { table: provider.table } },
    ).exports as unknown as { local(): number; call(): number };

    strictEqual(provider.value(), 41);
    strictEqual(provider.table.get(0), provider.value);
    strictEqual(consumer.local(), 17);
    strictEqual(consumer.call(), 41);
});

Deno.test('WebAssembly: provider-backed externref Table retains consumer values', () => {
    const engine = import.meta.use('engine');
    const provider = new WebAssembly.Instance(
        new WebAssembly.Module(EXTERNREF_TABLE_PROVIDER_WASM),
    ).exports as unknown as { table: WebAssembly.Table; get(index: number): unknown };
    const value = { retained: true };

    const consumerRef = (() => {
        const consumer = new WebAssembly.Instance(
            new WebAssembly.Module(EXTERNREF_TABLE_CONSUMER_WASM),
            { env: { table: provider.table } },
        );
        (consumer.exports.set as (index: number, value: unknown) => void)(0, value);
        return new WeakRef(consumer);
    })();

    engine.gc.run();
    engine.gc.run();
    strictEqual(consumerRef.deref(), undefined);
    strictEqual(provider.get(0), value);
    strictEqual(provider.table.get(0), value);
});

Deno.test('WebAssembly: provider trampoline uses provider memory and caller exception state', () => {
    let stale: ArrayBuffer;
    const marker = new Error('provider hook marker');
    let shouldThrow = false;
    const provider = new WebAssembly.Instance(
        new WebAssembly.Module(PROVIDER_TRAMPOLINE_WASM),
        { env: { hook: () => {
            if (shouldThrow) throw marker;
            return stale.byteLength;
        } } },
    ).exports as unknown as { run(): number; memory: WebAssembly.Memory };
    const consumer = new WebAssembly.Instance(
        new WebAssembly.Module(CONSUMER_FUNCTION_WASM),
        { env: { run: provider.run } },
    ).exports as unknown as { call(): number };

    stale = provider.memory.buffer;
    strictEqual(consumer.call(), 0);
    strictEqual(stale.byteLength, 0);

    shouldThrow = true;
    let caught: unknown;
    try { consumer.call(); } catch (error) { caught = error; }
    strictEqual(caught, marker);
    shouldThrow = false;
    strictEqual(consumer.call(), 0);
});

Deno.test('WebAssembly: duplicate-name Global import occurrences bind every slot', () => {
    const global = new WebAssembly.Global({ value: 'i32', mutable: true }, 7);
    const exports = new WebAssembly.Instance(
        new WebAssembly.Module(DUPLICATE_GLOBAL_IMPORT_WASM),
        { env: { same: global } },
    ).exports as unknown as {
        first: WebAssembly.Global;
        second: WebAssembly.Global;
        getFirst(): number;
        getSecond(): number;
        setFirst(value: number): void;
        setSecond(value: number): void;
    };

    strictEqual(exports.first, global);
    strictEqual(exports.second, global);
    strictEqual(exports.getFirst(), 7);
    strictEqual(exports.getSecond(), 7);
    exports.setSecond(19);
    strictEqual(exports.getFirst(), 19);
    strictEqual(global.value, 19);
});

Deno.test('WebAssembly: duplicate-name Table import occurrences bind every slot', () => {
    const table = new WebAssembly.Table({ element: 'externref', initial: 1, maximum: 3 });
    const firstValue = { slot: 'first' };
    table.set(0, firstValue);
    const exports = new WebAssembly.Instance(
        new WebAssembly.Module(DUPLICATE_TABLE_IMPORT_WASM),
        { env: { same: table } },
    ).exports as unknown as {
        first: WebAssembly.Table;
        second: WebAssembly.Table;
        sizeFirst(): number;
        sizeSecond(): number;
        getFirst(index: number): unknown;
        getSecond(index: number): unknown;
        setSecond(index: number, value: unknown): void;
    };

    strictEqual(exports.first, table);
    strictEqual(exports.second, table);
    strictEqual(exports.sizeFirst(), 1);
    strictEqual(exports.sizeSecond(), 1);
    strictEqual(exports.getFirst(0), firstValue);
    strictEqual(exports.getSecond(0), firstValue);
    const secondValue = { slot: 'second' };
    exports.setSecond(0, secondValue);
    strictEqual(exports.getFirst(0), secondValue);
    strictEqual(table.get(0), secondValue);
});

Deno.test({
    name: 'WebAssembly: duplicate-name Memory import occurrences bind every slot',
    // circu.js currently builds WAMR's fast interpreter, which is incompatible
    // with WAMR_BUILD_MULTI_MEMORY. Keep the occurrence regression armed for
    // builds that enable the proposal instead of rejecting the module at load.
    ignore: !WebAssembly.validate(DUPLICATE_MEMORY_IMPORT_WASM),
    fn() {
        const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
        const exports = new WebAssembly.Instance(
            new WebAssembly.Module(DUPLICATE_MEMORY_IMPORT_WASM),
            { env: { same: memory } },
        ).exports as unknown as {
            first: WebAssembly.Memory;
            second: WebAssembly.Memory;
            sizeFirst(): number;
            sizeSecond(): number;
            growSecond(delta: number): number;
        };

        strictEqual(exports.first, memory);
        strictEqual(exports.second, memory);
        strictEqual(exports.sizeFirst(), 1);
        strictEqual(exports.sizeSecond(), 1);
        strictEqual(exports.growSecond(1), 1);
        strictEqual(exports.sizeFirst(), 2);
        strictEqual(memory.buffer.byteLength, 2 * 65536);
    },
});

Deno.test('WebAssembly: failed Global resolution leaves a Module reusable', () => {
    const module = new WebAssembly.Module(DISTINCT_GLOBAL_IMPORT_WASM);
    const first = new WebAssembly.Global({ value: 'i32', mutable: false }, 11);
    throws(() => new WebAssembly.Instance(module, { env: { first, second: 22n } }));

    const instance = new WebAssembly.Instance(module, { env: { first: 31, second: 37 } });
    strictEqual((instance.exports.first as WebAssembly.Global).value, 31);
    strictEqual((instance.exports.second as WebAssembly.Global).value, 37);
});

Deno.test('WebAssembly: failed Table resolution leaves a Module reusable', () => {
    const module = new WebAssembly.Module(DISTINCT_TABLE_IMPORT_WASM);
    const first = new WebAssembly.Table({ element: 'externref', initial: 1, maximum: 2 });
    const tooSmall = new WebAssembly.Table({ element: 'externref', initial: 0, maximum: 2 });
    throws(
        () => new WebAssembly.Instance(module, { env: { first, second: tooSmall } }),
        WebAssembly.LinkError,
    );

    const second = new WebAssembly.Table({ element: 'externref', initial: 1, maximum: 2 });
    const instance = new WebAssembly.Instance(module, { env: { first, second } });
    strictEqual(instance.exports.first, first);
    strictEqual(instance.exports.second, second);
});

Deno.test('WebAssembly: non-null standalone funcref imports fail instead of losing values', () => {
    const provider = new WebAssembly.Instance(
        new WebAssembly.Module(LOCAL_FUNCTION_ALIAS_WASM),
    ).exports as unknown as { a(): number };
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 2, maximum: 4 });
    table.set(0, provider.a);

    throws(
        () => new WebAssembly.Instance(
            new WebAssembly.Module(SHARED_FUNCREF_TABLE_WASM),
            { env: { a: table, b: table } },
        ),
        WebAssembly.LinkError,
    );
});

Deno.test('WebAssembly: function aliases and wasm re-exports preserve identity', () => {
    const provider = new WebAssembly.Instance(
        new WebAssembly.Module(LOCAL_FUNCTION_ALIAS_WASM),
    ).exports as unknown as { a(): number; b(): number };
    strictEqual(provider.a, provider.b);

    const module = new WebAssembly.Module(FUNCTION_REEXPORT_WASM);
    const first = new WebAssembly.Instance(module, { m: { f: provider.a } })
        .exports as unknown as { a(): number; b(): number };
    const second = new WebAssembly.Instance(module, { m: { f: provider.a } })
        .exports as unknown as { a(): number; b(): number };
    strictEqual(first.a, provider.a);
    strictEqual(first.b, provider.a);
    strictEqual(second.a, provider.a);
    strictEqual(first.a(), 41);
});

Deno.test('WebAssembly: JS callback re-export identity is per Instance', () => {
    const module = new WebAssembly.Module(FUNCTION_REEXPORT_WASM);
    const callback = () => 31;
    const first = new WebAssembly.Instance(module, { m: { f: callback } })
        .exports as unknown as { a(): number; b(): number };
    const second = new WebAssembly.Instance(module, { m: { f: callback } })
        .exports as unknown as { a(): number; b(): number };
    strictEqual(first.a, first.b);
    ok(first.a !== callback);
    ok(first.a !== second.a);
    strictEqual(first.a(), 31);
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
    const fn = new WebAssembly.Instance(new WebAssembly.Module(ADD_WASM)).exports.add;
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

Deno.test('WebAssembly upstream: instantiateStreaming rejects non-Response byte source', async () => {
    await rejects(
        WebAssembly.instantiateStreaming(ADD_WASM as unknown as Promise<Response>),
        TypeError,
    );
});

Deno.test('WebAssembly upstream: streaming requires application/wasm content type', async () => {
    await rejects(
        WebAssembly.instantiateStreaming(new Response(ADD_WASM)),
        TypeError,
    );
    await rejects(
        WebAssembly.compileStreaming(Promise.resolve(new Response(ADD_WASM))),
        TypeError,
    );
});

Deno.test('WebAssembly upstream: compileStreaming and instantiateStreaming accept wasm responses', async () => {
    const response = () => new Response(ADD_WASM, {
        headers: { 'Content-Type': 'application/wasm; charset=utf-8' },
    });

    const module = await WebAssembly.compileStreaming(Promise.resolve(response()));
    ok(module instanceof WebAssembly.Module);
    const instance = await WebAssembly.instantiate(module);
    strictEqual((instance.exports as { add(a: number, b: number): number }).add(6, 7), 13);

    const streamed = await WebAssembly.instantiateStreaming(response());
    strictEqual((streamed.instance.exports as { add(a: number, b: number): number }).add(8, 9), 17);
    strictEqual(WebAssembly.Module.exports(streamed.module)[0]?.name, 'add');
});

Deno.test('WebAssembly: invalid bytes throw on compile', () => {
    let threw = false;
    try { new WebAssembly.Module(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])); } catch { threw = true; }
    ok(threw, 'invalid wasm must throw');
});
