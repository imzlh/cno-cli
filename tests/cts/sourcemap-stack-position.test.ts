import { ok, strictEqual } from 'node:assert';

// These tests pin down source-map fidelity for stack traces coming out of
// oxc-transpiled .ts files. Two defects are covered:
//
//  1. sourcemap.c js_get_source_mapping() converts the LINE between QJS's
//     1-based and the source map's 0-based convention in both directions, but
//     never converts the COLUMN. Result: every column in a mapped .ts frame is
//     reported exactly 1 too small. Byte-identical code run as .js (no map, so
//     the passthrough branch is taken) reports the correct 1-based column.
//
//  2. build_backtrace() in quickjs.c only invokes rt->backtrace_hook (the
//     source-map hook) on the string-building branch. The CallSite branch
//     (js_new_callsite_data) stores find_line_num() output verbatim, so
//     Error.prepareStackTrace receives raw POST-TRANSFORM positions while
//     error.stack shows mapped ORIGINAL ones.

interface Erased1 { a: number }
type ErasedAlias1 = Erased1[];
interface Erased2 { b: string }
type ErasedAlias2 = Readonly<Erased2>;
declare const ERASED_DECL: number;
interface Erased3 { c: boolean }
type ErasedAlias3 = Partial<Erased3>;
interface Erased4 { d: number }
type ErasedAlias4 = Erased4 | Erased1;
interface Erased5 { e: number }

// The line/column of the `thrower` call below is asserted literally, so keep
// THROW_LINE / CALL_LINE in sync if this file is edited above this point.
function thrower(): never {
    throw new Error('smap-probe');
}

const CALL_LINE = 36;
function caller(): void { thrower(); }
//                        ^ col 27 (1-based) -- the `thrower` identifier
const CALLER_CALL_COL = 27;

function frameOf(stack: string, fn: string): { line: number; col: number } | null {
    for (const raw of stack.split('\n')) {
        if (!raw.includes(fn)) continue;
        const m = raw.match(/sourcemap-stack-position\.test\.ts:(\d+):(\d+)/);
        if (m) return { line: Number(m[1]), col: Number(m[2]) };
    }
    return null;
}

Deno.test('sourcemap: .ts stack frames report the ORIGINAL line', () => {
    let stack = '';
    try {
        caller();
    } catch (e) {
        stack = (e as Error).stack ?? '';
    }
    ok(stack, 'error must carry a stack');

    const top = frameOf(stack, 'at thrower');
    ok(top, `no thrower frame in:\n${stack}`);
    // Line mapping is correct: the ~27 erased type-only lines above do not shift
    // the reported line. This is the part that works.
    strictEqual(top!.line, 32, 'thrower frame must map to the original throw line');

    const mid = frameOf(stack, 'at caller');
    ok(mid, `no caller frame in:\n${stack}`);
    strictEqual(mid!.line, CALL_LINE, 'caller frame must map to the original call line');
});

Deno.test('sourcemap: mapped .ts columns are 1-based (regression: off-by-one)', () => {
    let stack = '';
    try {
        caller();
    } catch (e) {
        stack = (e as Error).stack ?? '';
    }
    const mid = frameOf(stack, 'at caller');
    ok(mid, `no caller frame in:\n${stack}`);

    // `function caller(): void { thrower(); }` -- `thrower` starts at 1-based
    // column 26. js_get_source_mapping() returns the source map's 0-based
    // original_column without the +1 that it correctly applies to the line, so
    // this currently reports 25.
    strictEqual(
        mid!.col,
        CALLER_CALL_COL,
        'mapped column must be 1-based; a value one less means the +1 in ' +
        'js_get_source_mapping() (circu.js/src/sourcemap.c) is missing for columns',
    );
});

// NOTE -- this asserts DENO semantics, and Node deliberately differs. Measured
// 2026-08-03 (Node v24.18.0, deno 2.9.3), do not "fix" this back:
//
//   runtime / mode                | CallSite getters | default string stack
//   ------------------------------+------------------+---------------------
//   node, no flag                 | generated        | generated
//   node --enable-source-maps     | GENERATED        | mapped
//   deno 2.9.3 (maps by default)  | MAPPED           | mapped
//
// In Node the mapping lives ONLY in its default prepareStackTrace; installing
// your own hook replaces that formatter, so getters stay generated even with
// the flag, and Node hands libraries module.findSourceMap() to map themselves.
// Deno maps the getters too, and cno follows Deno. The tradeoff, also measured:
// a consumer that maps a second time (findEntry on an already-original
// position) gets garbage -- gen 3:9 => orig 40:11 correctly, but feeding it
// 40:11 yields 50:5. That is inherent to Deno's choice, not to this test.
Deno.test('sourcemap: CallSite positions must be mapped like error.stack', () => {
    const saved = Error.prepareStackTrace;
    let sites: unknown[] | null = null;
    Error.prepareStackTrace = (_err, cs) => {
        sites = cs as unknown[];
        return 'SENTINEL';
    };
    try {
        try { caller(); } catch (e) { void (e as Error).stack; }
    } finally {
        Error.prepareStackTrace = saved;
    }

    ok(sites, 'Error.prepareStackTrace must be invoked for .ts errors');

    type CallSite = {
        getFileName(): string | null;
        getFunctionName(): string | null;
        getLineNumber(): number | null;
        getColumnNumber(): number | null;
    };
    const list = sites as unknown as CallSite[];
    const inFile = list.filter(cs => {
        const f = cs.getFileName();
        return typeof f === 'string' && f.includes('sourcemap-stack-position.test.ts');
    });
    ok(inFile.length >= 2, `expected >=2 in-file CallSites, got ${inFile.length}`);

    // Pin the NAMED frame, not "is 36 present anywhere". An earlier form of this
    // test asserted lines.includes(CALL_LINE), which a pre-patch binary passed
    // by accident as soon as edits above shifted some unrelated generated line
    // onto 36. Identify the frame by function name so line drift cannot satisfy
    // it, and require the two APIs to AGREE, which is what the title claims.
    const csCaller = inFile.find(cs => cs.getFunctionName() === 'caller');
    ok(csCaller, `no 'caller' CallSite among [${inFile.map(c => c.getFunctionName()).join(', ')}]`);
    const csThrower = inFile.find(cs => cs.getFunctionName() === 'thrower');
    ok(csThrower, `no 'thrower' CallSite among [${inFile.map(c => c.getFunctionName()).join(', ')}]`);

    // Independently capture the string branch, which is already mapped.
    let strStack = '';
    try { caller(); } catch (e) { strStack = (e as Error).stack ?? ''; }
    const strCaller = frameOf(strStack, 'at caller');
    ok(strCaller, `no caller frame in string stack:\n${strStack}`);

    const why = ' -- the CallSite branch of build_backtrace() ' +
        '(circu.js/deps/quickjs/quickjs.c) must call rt->backtrace_hook like the ' +
        'string branch does; without it prepareStackTrace sees generated ' +
        'post-transform positions while error.stack sees mapped original ones.';

    strictEqual(csCaller!.getLineNumber(), CALL_LINE,
        `CallSite 'caller' line must be the mapped original ${CALL_LINE}` + why);
    strictEqual(csThrower!.getLineNumber(), 32,
        'CallSite \'thrower\' line must be the mapped original 32' + why);
    strictEqual(csCaller!.getColumnNumber(), CALLER_CALL_COL,
        `CallSite 'caller' column must be the mapped original ${CALLER_CALL_COL}` + why);

    // The invariant proper: one error must not report two different positions.
    strictEqual(
        `${csCaller!.getLineNumber()}:${csCaller!.getColumnNumber()}`,
        `${strCaller!.line}:${strCaller!.col}`,
        'CallSite and error.stack must report the SAME position for the same frame' + why,
    );
});

Deno.test('sourcemap: prepareStackTrace return value must not be rewritten', () => {
    const saved = Error.prepareStackTrace;
    Error.prepareStackTrace = () => 'SENTINEL';
    let stringStack = '';
    try {
        try { caller(); } catch (e) { stringStack = String((e as Error).stack); }
    } finally {
        Error.prepareStackTrace = saved;
    }

    strictEqual(
        stringStack,
        'SENTINEL',
        'error.stack must be exactly what prepareStackTrace returned; a ' +
        'prepended "Name: message" header means installLazyErrorStack() in ' +
        'cno/src/webapi/basic.ts is re-synthesizing the stack over the hook',
    );
});

Deno.test('sourcemap: CallSite array must not contain Error-proxy frames', () => {
    const saved = Error.prepareStackTrace;
    let sites: unknown[] | null = null;
    Error.prepareStackTrace = (_e, cs) => { sites = cs as unknown[]; return ''; };
    try {
        try { caller(); } catch { /* consume */ }
    } finally {
        Error.prepareStackTrace = saved;
    }
    ok(sites, 'hook must run');

    type CallSite = {
        getFileName(): string | null;
        getFunctionName(): string | null;
        getLineNumber(): number | null;
    };
    const list = sites as unknown as CallSite[];
    // The Error global is a Proxy (cno/src/webapi/basic.ts); its construct trap
    // contributes frames named "construct" with no real position.
    const bogus = list.filter(cs =>
        cs.getFunctionName() === 'construct'
        && (cs.getFileName() === null || cs.getFileName() === '<core>'));
    // stripInternalErrorProxyFrames() only cleans the string form. These stay in
    // the CallSite array, so sites[0] -- which every callsite-consuming library
    // reads to find the throw site -- is garbage.
    strictEqual(
        bogus.length,
        0,
        'Error proxy frames must not leak into the CallSite array: ' +
        bogus.map(c => `${c.getFunctionName()}@${c.getFileName()}:${c.getLineNumber()}`).join(', '),
    );
});
