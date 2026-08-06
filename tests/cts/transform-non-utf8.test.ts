import { strictEqual, ok } from 'node:assert';
import { Transformer, firstInvalidUtf8 } from '../../cts/src/source/transform.ts';
import { tryLoadOxc } from '../../cts/src/oxc.ts';

// Non-UTF-8 source must FAIL LOUDLY, never fall back to Sucrase.
//
// The native oxc transpiler rejects non-UTF-8 input (std::str::from_utf8 in
// ext-oxc/src/lib.rs), and OxcTranspiler collapses that failure into `null`,
// which is indistinguishable from "oxc declined". Historically the byte path
// then fell through to Sucrase, which silently ERASES `namespace` bodies and
// decorated classes. Net effect: one stray cp1252 byte anywhere in a .ts file
// (including inside a comment) silently deleted every namespace in that file
// and the process exited 0 with wrong output.
//
// Regression guard: the transformer must throw a located TransformError.

const engine = import.meta.use('engine');

function bytes(parts: Array<string | number>): Uint8Array {
    const out: number[] = [];
    for (const p of parts) {
        if (typeof p === 'number') out.push(p);
        else for (const ch of p) out.push(ch.charCodeAt(0));
    }
    return new Uint8Array(out);
}

function newTransformer(): Transformer {
    const t = new Transformer({ sourceMaps: false });
    const oxc = tryLoadOxc();
    if (oxc) t.setOxc(oxc);
    return t;
}

function expectThrows(input: Uint8Array, label: string): Error {
    const t = newTransformer();
    let caught: Error | null = null;
    try {
        t.transformBytes(input, 'bad.ts', 'ts', 'bad.ts');
    } catch (e) {
        caught = e as Error;
    }
    ok(caught, `${label}: non-UTF-8 source must throw, not fall back to Sucrase`);
    return caught as Error;
}

Deno.test('cts: non-UTF-8 byte in a comment throws instead of erasing namespaces', () => {
    // `namespace N { ... }` followed by a lone 0xff inside a comment.
    const src = bytes([
        'namespace N { export const x = 1 }\n// ', 0xff, '\nconsole.log(N.x);\n',
    ]);
    const err = expectThrows(src, '0xff in comment');
    ok(/UTF-8/i.test(err.message), `message must name the cause, got: ${err.message}`);

    const located = err as unknown as { fileName?: string; line?: number; column?: number };
    strictEqual(located.fileName, 'bad.ts');
    // The bad byte is on line 2, not line 1 where the namespace lives.
    strictEqual(located.line, 2);
    ok(typeof located.column === 'number' && located.column >= 0, 'must carry a column');
});

Deno.test('cts: cp1252 byte in a string literal throws (Windows save-as hazard)', () => {
    // 0xe9 is cp1252 'e-acute' — a lone 0xe9 is not valid UTF-8.
    const src = bytes(['const label = "caf', 0xe9, '";\n']);
    const err = expectThrows(src, 'cp1252 0xe9');
    ok(/UTF-8/i.test(err.message), `message must name the cause, got: ${err.message}`);
});

Deno.test('cts: malformed UTF-8 sequences are all rejected', () => {
    // Truncated 3-byte sequence at EOF.
    expectThrows(bytes(['const s = "x";\n', 0xe2, 0x82]), 'truncated');
    // Surrogate half (CESU-8 style) is not valid UTF-8.
    expectThrows(bytes(['const s = "x";\n', 0xed, 0xa0, 0x80]), 'surrogate half');
    // Overlong 2-byte encoding of '/'.
    expectThrows(bytes(['const s = "x";\n', 0xc0, 0xaf]), 'overlong');
    // Bare continuation byte.
    expectThrows(bytes(['const s = "x";\n', 0x80]), 'bare continuation');
});

Deno.test('cts: valid UTF-8 is unaffected — namespace survives and multibyte round-trips', () => {
    const t = newTransformer();

    // A namespace must still compile to a real IIFE, not be erased.
    const nsSrc = 'namespace N { export const x = 1 }\nconsole.log(N.x);\n';
    const nsOut = t.transformBytes(
        new Uint8Array([...nsSrc].map(c => c.charCodeAt(0))), 'ok.ts', 'ts', 'ok.ts',
    );
    const nsText = typeof nsOut === 'string' ? nsOut : engine.decodeString(nsOut);
    ok(nsText.trim().length > 0, 'valid source must emit code');
    ok(nsText.includes('N ||'), `namespace must compile to an IIFE, got: ${nsText}`);

    // Valid multi-byte UTF-8 (2-byte and 4-byte) must not be flagged.
    const uniSrc = 'const s = "café \u{1f600}";\nconsole.log(s.length);\n';
    const uniOut = t.transformBytes(engine.encodeString(uniSrc), 'ok2.ts', 'ts', 'ok2.ts');
    const uniText = typeof uniOut === 'string' ? uniOut : engine.decodeString(uniOut);
    ok(uniText.includes('café'), `2-byte UTF-8 must survive, got: ${uniText}`);
    ok(uniText.includes('\u{1f600}'), `4-byte UTF-8 must survive, got: ${uniText}`);
});

// --- validator unit tests -------------------------------------------------
//
// The tests above drive transformBytes(), which only reaches the validator
// when oxc DECLINES. Since oxc accepts all valid UTF-8, those tests cannot
// observe a false positive in the validator itself — a bug that flagged valid
// multi-byte UTF-8 would turn a working Sucrase fallback into a spurious hard
// error, invisibly. Exercise firstInvalidUtf8 directly to cover that.

Deno.test('cts: firstInvalidUtf8 accepts every valid UTF-8 form', () => {
    const valid: Array<[string, number[]]> = [
        ['empty', []],
        ['ascii', [0x61, 0x62, 0x63]],
        ['NUL and DEL', [0x00, 0x7f]],
        ['2-byte lower bound (U+0080)', [0xc2, 0x80]],
        ['2-byte upper bound (U+07FF)', [0xdf, 0xbf]],
        ['e-acute (U+00E9)', [0xc3, 0xa9]],
        ['3-byte lower bound (U+0800)', [0xe0, 0xa0, 0x80]],
        ['3-byte upper bound (U+FFFF)', [0xef, 0xbf, 0xbf]],
        ['just below surrogates (U+D7FF)', [0xed, 0x9f, 0xbf]],
        ['just above surrogates (U+E000)', [0xee, 0x80, 0x80]],
        ['4-byte lower bound (U+10000)', [0xf0, 0x90, 0x80, 0x80]],
        ['4-byte upper bound (U+10FFFF)', [0xf4, 0x8f, 0xbf, 0xbf]],
        ['emoji (U+1F600)', [0xf0, 0x9f, 0x98, 0x80]],
        ['BOM then ascii', [0xef, 0xbb, 0xbf, 0x61]],
        ['mixed widths', [0x61, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80, 0x62]],
    ];
    for (const [label, bytes] of valid) {
        strictEqual(
            firstInvalidUtf8(new Uint8Array(bytes)),
            -1,
            `${label} is valid UTF-8 and must not be flagged (false positive would `
            + 'turn a working Sucrase fallback into a spurious hard error)',
        );
    }
});

Deno.test('cts: firstInvalidUtf8 reports the offset of the first bad byte', () => {
    const invalid: Array<[string, number[], number]> = [
        ['bare continuation', [0x80], 0],
        ['0xc1 overlong lead', [0xc1, 0x81], 0],
        ['0xf5 out of range lead', [0xf5, 0x80, 0x80, 0x80], 0],
        ['0xff never valid', [0xff], 0],
        ['0xfe never valid', [0xfe], 0],
        ['lone cp1252 e-acute after ascii', [0x61, 0x62, 0xe9, 0x22], 2],
        ['truncated 2-byte at EOF', [0x61, 0xc3], 1],
        ['truncated 3-byte at EOF', [0x61, 0xe2, 0x82], 1],
        ['truncated 4-byte at EOF', [0x61, 0xf0, 0x9f, 0x98], 1],
        ['bad continuation in 3-byte', [0xe2, 0x28, 0xa1], 0],
        ['overlong 2-byte NUL', [0xc0, 0x80], 0],
        ['overlong 3-byte slash', [0xe0, 0x80, 0xaf], 0],
        ['surrogate half U+D800', [0xed, 0xa0, 0x80], 0],
        ['above U+10FFFF', [0xf4, 0x90, 0x80, 0x80], 0],
        ['valid prefix then bad', [0xc3, 0xa9, 0x61, 0x80], 3],
    ];
    for (const [label, bytes, expected] of invalid) {
        strictEqual(
            firstInvalidUtf8(new Uint8Array(bytes)),
            expected,
            `${label}: wrong offset for the first invalid byte`,
        );
    }
});
