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

    type CallSite = { getFileName(): string | null; getLineNumber(): number | null };
    const list = sites as unknown as CallSite[];
    const inFile = list.filter(cs => {
        const f = cs.getFileName();
        return typeof f === 'string' && f.includes('sourcemap-stack-position.test.ts');
    });
    ok(inFile.length >= 2, `expected >=2 in-file CallSites, got ${inFile.length}`);

    // build_backtrace() skips rt->backtrace_hook on the CallSite branch, so
    // these are generated-file positions. With the erased type-only lines above
    // they come out far too small.
    const lines = inFile.map(cs => cs.getLineNumber());
    ok(
        lines.includes(CALL_LINE),
        `CallSite.getLineNumber() must return mapped ORIGINAL lines. Expected ` +
        `${CALL_LINE} among [${lines.join(', ')}] -- smaller values mean the ` +
        `CallSite branch of build_backtrace() (circu.js/deps/quickjs/quickjs.c) ` +
        `never calls rt->backtrace_hook, unlike the string branch.`,
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
