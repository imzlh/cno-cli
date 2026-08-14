/*
 * WebAssembly JS-API conformance: error classes, funcref tables, grow refusal,
 * customSections, and argument validation.
 *
 * Measured against node v24.18.0. cno embeds WAMR rather than V8, so message
 * text and stack format differ legitimately -- every assertion here is on
 * observable behaviour: the error CLASS, the VALUE, or the shape.
 *
 * What these lock down (all were wrong before):
 *  - A trap threw a plain Error, not WebAssembly.RuntimeError, so
 *    `e instanceof WebAssembly.RuntimeError` was false for every trap. The C
 *    layer tags the class on a `wasmError` property (tjs_throw_wasm_error in
 *    circu.js/src/mod_wasm.c) but wrapWasmError only read `name`/`code`.
 *  - A compile failure likewise surfaced as a plain Error.
 *  - Table.get() on a funcref table returned a raw function INDEX (a number)
 *    instead of a callable, and Table.set() accepted any value: the C layer
 *    coerces with JS_ToUint32, so a plain JS function became NaN -> 0 and
 *    silently aliased the slot to function index 0.
 *  - Memory.grow / Table.grow past the maximum returned -1 instead of throwing
 *    RangeError, so an over-max grow looked like success.
 *  - customSections(m, name) always returned exactly one entry, so a name that
 *    is absent reported length 1 with an empty buffer.
 */
import { strictEqual, ok, throws } from 'node:assert';

/* ---- minimal wasm emitter (no toolchain needed) ---- */
function uleb(n: number): number[] {
    const out: number[] = [];
    let v = n >>> 0;
    do { let b = v & 0x7f; v >>>= 7; if (v !== 0) b |= 0x80; out.push(b); } while (v !== 0);
    return out;
}
function sleb(n: number): number[] {
    const out: number[] = [];
    let v = BigInt(n);
    for (;;) {
        const b = Number(v & 0x7fn);
        v >>= 7n;
        const sign = (b & 0x40) !== 0;
        if ((v === 0n && !sign) || (v === -1n && sign)) { out.push(b); break; }
        out.push(b | 0x80);
    }
    return out;
}
function str(s: string): number[] {
    const b = [...new TextEncoder().encode(s)];
    return [...uleb(b.length), ...b];
}
function vec(items: number[][]): number[] {
    return [...uleb(items.length), ...items.flat()];
}
function section(id: number, payload: number[]): number[] {
    return [id, ...uleb(payload.length), ...payload];
}
function body(locals: number[][], code: number[]): number[] {
    const inner = [...vec(locals), ...code, 0x0b];
    return [...uleb(inner.length), ...inner];
}
const I32 = 0x7f;
const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const ftype = (p: number[], r: number[]): number[] => [0x60, ...vec(p.map(x => [x])), ...vec(r.map(x => [x]))];

/*
 * Module with: memory(1), a funcref table(1,max 2) holding one function,
 * and exports that trap in distinct ways.
 *   five()          -> i32 42                (table slot 0 target)
 *   boom()          -> unreachable
 *   div(a,b)        -> a / b                 (traps on b == 0)
 *   load(a)         -> i32 load at a         (traps out of bounds)
 *   call_slot(i)    -> call_indirect slot i  (traps on null / oob)
 */
function buildTrapModule(): Uint8Array {
    const parts = [
        section(1, vec([
            ftype([], [I32]),            // 0: () -> i32
            ftype([], []),               // 1: () -> ()
            ftype([I32, I32], [I32]),    // 2: (i32,i32) -> i32
            ftype([I32], [I32]),         // 3: (i32) -> i32
        ])),
        section(3, vec([[0], [1], [2], [3], [3]])),        // 5 local funcs
        section(4, vec([[0x70, 0x01, 1, 2]])),             // funcref table, min 1 max 2
        section(5, vec([[0x00, 1]])),                      // memory 1 page
        section(7, vec([
            [...str('five'), 0x00, 0],
            [...str('boom'), 0x00, 1],
            [...str('div'), 0x00, 2],
            [...str('load'), 0x00, 3],
            [...str('call_slot'), 0x00, 4],
            [...str('memory'), 0x02, 0],
            [...str('table'), 0x01, 0],
        ])),
        section(9, vec([[...uleb(0), 0x41, ...sleb(0), 0x0b, ...vec([uleb(0)])]])), // elem: slot0 = func0
        section(10, vec([
            body([], [0x41, ...sleb(42)]),                                   // five
            body([], [0x00]),                                                // boom: unreachable
            body([], [0x20, 0, 0x20, 1, 0x6d]),                              // div: i32.div_s
            body([], [0x20, 0, 0x28, 0x02, 0x00]),                           // load
            body([], [0x20, 0, 0x11, ...uleb(0), ...uleb(0)]),                // call_indirect type0 table0
        ])),
    ];
    return Uint8Array.from([...MAGIC, ...parts.flat()]);
}

/* Module with two custom sections named "meta" and one named "other". */
function buildCustomSectionModule(): Uint8Array {
    const parts = [
        section(1, vec([ftype([], [])])),
        section(3, vec([[0]])),
        section(7, vec([[...str('nop'), 0x00, 0]])),
        section(10, vec([body([], [])])),
        section(0, [...str('meta'), 1, 2, 3, 4]),
        section(0, [...str('meta'), 5, 6]),
        section(0, [...str('other'), 0xff]),
    ];
    return Uint8Array.from([...MAGIC, ...parts.flat()]);
}

const trapModule = buildTrapModule();
type TrapExports = {
    five: () => number;
    boom: () => void;
    div: (a: number, b: number) => number;
    load: (a: number) => number;
    call_slot: (i: number) => number;
    memory: WebAssembly.Memory;
    table: WebAssembly.Table;
};
function trapInstance(): TrapExports {
    return new WebAssembly.Instance(new WebAssembly.Module(trapModule))
        .exports as unknown as TrapExports;
}

/* Assert `fn` throws, and hand the thrown value back for classification. */
function caught(fn: () => unknown): unknown {
    try { fn(); } catch (e) { return e; }
    throw new Error('expected a throw, but the call returned normally');
}

// ============================================================================
// Traps must be WebAssembly.RuntimeError
// ============================================================================

Deno.test('wasm: unreachable throws WebAssembly.RuntimeError', () => {
    const e = caught(() => trapInstance().boom());
    ok(e instanceof WebAssembly.RuntimeError, `expected RuntimeError, got ${(e as Error)?.constructor?.name}`);
    ok(e instanceof Error, 'RuntimeError must also be an Error');
    ok(typeof (e as Error).message === 'string' && (e as Error).message.length > 0, 'must carry a message');
});

Deno.test('wasm: integer divide by zero throws RuntimeError', () => {
    const e = caught(() => trapInstance().div(1, 0));
    ok(e instanceof WebAssembly.RuntimeError, `expected RuntimeError, got ${(e as Error)?.constructor?.name}`);
});

Deno.test('wasm: out-of-bounds memory access throws RuntimeError', () => {
    const x = trapInstance();
    strictEqual(x.load(0), 0, 'an in-bounds load must succeed first (negative control)');
    const e = caught(() => x.load(65536));
    ok(e instanceof WebAssembly.RuntimeError, `expected RuntimeError, got ${(e as Error)?.constructor?.name}`);
});

Deno.test('wasm: indirect call to a null table slot throws RuntimeError', () => {
    const x = trapInstance();
    strictEqual(x.call_slot(0), 42, 'slot 0 holds a real function (negative control)');
    /* The table's declared minimum is 1, so slot 1 is beyond cur_size. */
    const e = caught(() => x.call_slot(1));
    ok(e instanceof WebAssembly.RuntimeError, `expected RuntimeError, got ${(e as Error)?.constructor?.name}`);
});

Deno.test('wasm: a trap leaves the instance usable', () => {
    const x = trapInstance();
    caught(() => x.boom());
    strictEqual(x.five(), 42, 'exports must still work after a trap');
});

Deno.test('wasm: a trap carries a stack that names the calling JS frame', () => {
    const e = caught(() => trapInstance().boom()) as Error;
    ok(typeof e.stack === 'string' && e.stack.length > 0, 'a trap must have a stack');
    ok(
        e.stack.includes('wasm-error-classes-and-funcref'),
        'the JS frame that called into wasm must survive in the stack',
    );
});

// ============================================================================
// Compile failures must be WebAssembly.CompileError
// ============================================================================

Deno.test('wasm: a bad magic word throws WebAssembly.CompileError', () => {
    const e = caught(() => new WebAssembly.Module(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])));
    ok(e instanceof WebAssembly.CompileError, `expected CompileError, got ${(e as Error)?.constructor?.name}`);
});

Deno.test('wasm: a truncated module throws CompileError', () => {
    const truncated = trapModule.slice(0, trapModule.length - 5);
    const e = caught(() => new WebAssembly.Module(truncated));
    ok(e instanceof WebAssembly.CompileError, `expected CompileError, got ${(e as Error)?.constructor?.name}`);
});

Deno.test('wasm: compile() rejects with CompileError', async () => {
    let err: unknown;
    try { await WebAssembly.compile(Uint8Array.from([1, 2, 3, 4])); }
    catch (e) { err = e; }
    ok(err instanceof WebAssembly.CompileError, `expected CompileError, got ${(err as Error)?.constructor?.name}`);
});

Deno.test('wasm: a valid module still compiles (negative control)', () => {
    ok(new WebAssembly.Module(trapModule) instanceof WebAssembly.Module);
    strictEqual(WebAssembly.validate(trapModule), true);
});

// ============================================================================
// funcref tables: get() yields a callable, set() rejects non-funcrefs
// ============================================================================

Deno.test('wasm: Table.get on a funcref slot returns a callable, not an index', () => {
    const x = trapInstance();
    const t = x.table;
    const f = t.get(0);
    strictEqual(typeof f, 'function', 'a funcref slot must read back as a function');
    strictEqual((f as () => number)(), 42, 'and calling it must reach the wasm function');
    strictEqual(t.get(0), f, 'repeated reads of the same funcref preserve identity');
    strictEqual(f, x.five, 'an exported function and the same table element share identity');
});

Deno.test('wasm: a wasm export can be stored into a funcref table and called', () => {
    const x = trapInstance();
    x.table.grow(1);                 // slot 1 now exists
    x.table.set(1, x.five as unknown as WebAssembly.ExportValue);
    const back = x.table.get(1);
    strictEqual(typeof back, 'function');
    strictEqual((back as () => number)(), 42);
    strictEqual(x.call_slot(1), 42, 'wasm must see the same function through call_indirect');
});

Deno.test('wasm: Table.set rejects a plain JS function', () => {
    const t = trapInstance().table;
    throws(() => t.set(0, (() => 7) as unknown as WebAssembly.ExportValue), TypeError);
    /* The slot must be untouched by the refusal. */
    strictEqual((t.get(0) as () => number)(), 42);
});

Deno.test('wasm: Table.set rejects a number', () => {
    const t = trapInstance().table;
    throws(() => t.set(0, 5 as unknown as WebAssembly.ExportValue), TypeError);
    strictEqual((t.get(0) as () => number)(), 42, 'slot 0 must not have been aliased');
});

Deno.test('wasm: Table.set accepts null and reads back null', () => {
    const t = trapInstance().table;
    t.set(0, null);
    strictEqual(t.get(0), null);
});

Deno.test('wasm: Table.set rejects a funcref from another instance', () => {
    const target = trapInstance();
    const foreign = trapInstance();
    throws(
        () => target.table.set(0, foreign.five as unknown as WebAssembly.ExportValue),
        TypeError,
    );
    strictEqual((target.table.get(0) as () => number)(), 42, 'a refused cross-instance index must not corrupt the slot');
});

// ============================================================================
// grow past the maximum must throw RangeError, not return -1
// ============================================================================

Deno.test('wasm: Memory.grow past the maximum throws RangeError', () => {
    const m = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    strictEqual(m.grow(1), 1, 'a grow within the maximum returns the previous size (negative control)');
    throws(() => m.grow(5), RangeError);
});

Deno.test('wasm: Table.grow past the maximum throws RangeError', () => {
    const t = trapInstance().table;   // min 1, max 2
    strictEqual(t.grow(1), 1, 'a grow within the maximum returns the previous length (negative control)');
    throws(() => t.grow(50), RangeError);
});

// ============================================================================
// Memory.grow detaches the old buffer (spec requirement)
// ============================================================================

Deno.test('wasm: Memory.grow detaches the previously exposed buffer', () => {
    const m = new WebAssembly.Memory({ initial: 1, maximum: 4 });
    const before = m.buffer;
    strictEqual(before.byteLength, 65536);
    new Uint8Array(before)[7] = 0x5a;
    m.grow(1);
    const after = m.buffer;
    ok(before !== after, 'grow must expose a new ArrayBuffer');
    strictEqual(after.byteLength, 131072);
    strictEqual(before.byteLength, 0, 'the old buffer must be DETACHED (byteLength 0)');
    strictEqual(new Uint8Array(after)[7], 0x5a, 'contents must survive the grow');
});

Deno.test('wasm: memory.grow from inside wasm detaches the JS-visible buffer', () => {
    /* Module that grows its own memory by one page. */
    const parts = [
        section(1, vec([ftype([], [I32])])),
        section(3, vec([[0]])),
        section(5, vec([[0x01, 1, 4]])),
        section(7, vec([[...str('grow'), 0x00, 0], [...str('memory'), 0x02, 0]])),
        section(10, vec([body([], [0x41, ...sleb(1), 0x40, 0x00])])),
    ];
    const mod = Uint8Array.from([...MAGIC, ...parts.flat()]);
    const x = new WebAssembly.Instance(new WebAssembly.Module(mod)).exports as unknown as
        { grow: () => number; memory: WebAssembly.Memory };
    const before = x.memory.buffer;
    strictEqual(before.byteLength, 65536);
    strictEqual(x.grow(), 1, 'memory.grow returns the previous page count');
    ok(x.memory.buffer !== before, 'the JS-visible buffer must be replaced');
    strictEqual(before.byteLength, 0, 'the stale buffer must be detached, not left pointing at moved memory');
});

// ============================================================================
// customSections
// ============================================================================

Deno.test('wasm: customSections returns an EMPTY array for an absent name', () => {
    const m = new WebAssembly.Module(buildCustomSectionModule());
    strictEqual(WebAssembly.Module.customSections(m, 'nope').length, 0);
    strictEqual(WebAssembly.Module.customSections(m, '').length, 0);
    /* Section names are case-sensitive. */
    strictEqual(WebAssembly.Module.customSections(m, 'META').length, 0);
});

Deno.test('wasm: customSections returns the bytes of a present section', () => {
    const m = new WebAssembly.Module(buildCustomSectionModule());
    const other = WebAssembly.Module.customSections(m, 'other');
    strictEqual(other.length, 1);
    strictEqual([...new Uint8Array(other[0])].join(','), '255');
});

Deno.test('wasm: customSections returns duplicate sections in module order', () => {
    const m = new WebAssembly.Module(buildCustomSectionModule());
    const sections = WebAssembly.Module.customSections(m, 'meta');
    strictEqual(sections.length, 2);
    strictEqual([...new Uint8Array(sections[0])].join(','), '1,2,3,4');
    strictEqual([...new Uint8Array(sections[1])].join(','), '5,6');
});

// ============================================================================
// argument validation
// ============================================================================

Deno.test('wasm: validate rejects a non-BufferSource with TypeError', () => {
    throws(() => WebAssembly.validate('not a buffer' as unknown as BufferSource), TypeError);
    /* A real buffer that merely fails validation returns false, not a throw. */
    strictEqual(WebAssembly.validate(Uint8Array.from([1, 2, 3, 4])), false);
});

Deno.test('wasm: Memory requires an initial size', () => {
    throws(() => new WebAssembly.Memory({} as WebAssembly.MemoryDescriptor), TypeError);
    ok(new WebAssembly.Memory({ initial: 1 }) instanceof WebAssembly.Memory);
});

Deno.test('wasm: Memory sizes use WebAssembly numeric conversion', () => {
    strictEqual(new WebAssembly.Memory({ initial: 1.9 }).buffer.byteLength, 65536);
    strictEqual(new WebAssembly.Memory({ initial: '2.9' as unknown as number }).buffer.byteLength, 131072);
    const m = new WebAssembly.Memory({ initial: 1, maximum: 3 });
    strictEqual(m.grow(1.9), 1);
    throws(() => m.grow(-0.5), TypeError);
    throws(() => new WebAssembly.Memory({ initial: 3, maximum: 2 }), RangeError);
});

Deno.test('wasm: a Global of type f32 rounds its value to f32 precision', () => {
    const g = new WebAssembly.Global({ value: 'f32', mutable: true }, 0.1);
    strictEqual(g.value, 0.10000000149011612, 'an f32 global cannot hold the f64 0.1');
    g.value = 1.1;
    strictEqual(g.value, 1.100000023841858);
    g.value = '3.7' as unknown as number;
    strictEqual(g.value, 3.700000047683716);
});

Deno.test('wasm: an i32 Global applies ToInt32 conversion', () => {
    const g = new WebAssembly.Global({ value: 'i32', mutable: true }, 3.9);
    strictEqual(g.value, 3);
    g.value = '4294967297' as unknown as number;
    strictEqual(g.value, 1);
    g.value = Number.NaN;
    strictEqual(g.value, 0);
    g.value = Number.POSITIVE_INFINITY;
    strictEqual(g.value, 0);
});

Deno.test('wasm: an immutable Global refuses assignment', () => {
    const g = new WebAssembly.Global({ value: 'i32', mutable: false }, 7);
    throws(() => { (g as WebAssembly.Global).value = 9; }, TypeError);
    strictEqual(g.value, 7);
});
