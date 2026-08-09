// Parity regressions for Buffer encoding/validation defects found against
// node v24.18.0 on 2026-08-09. Every expectation below is a MEASURED node
// output, not a spec reading; the comment on each block names the divergence it
// pins so a future refactor cannot quietly undo it.
import { strictEqual, throws, deepStrictEqual } from 'node:assert';
import { Buffer, isUtf8 } from 'node:buffer';

// ── DEFECT 1: hex/base64 decode must narrow each UTF-16 code unit to 8 bits ──
// Node masks before decoding, so U+3C3D acts as '=' and U+0644 as 'D'. Verified
// against node over 986470 injected-codepoint cases (direct vs pre-masked decode
// agreed everywhere), so masking is the rule and not an approximation.
// Before the fix cno SKIPPED such characters instead, decoding more (base64) or
// fewer (hex) bytes than node — silently, with no throw on either side.

Deno.test('buffer: base64 decode narrows code units to 8 bits (lone surrogate acts as "=")', () => {
    // 'SGVsbG8=' ("Hello") with a lone high surrogate spliced in. 0xd83d & 0xff
    // is 0x3d, i.e. '=', which terminates the base64 stream in node.
    strictEqual(Buffer.from('SGVs\ud83dbG8=', 'base64').toString('hex'), '48656c');
    // U+3C3D masks to '=' the same way.
    strictEqual(Buffer.from('SGVs㰽bG8=', 'base64').toString('hex'), '48656c');
    // A lone surrogate mid-string truncates rather than being skipped.
    strictEqual(Buffer.from('a\ud83dz', 'base64').toString('hex'), '');
    strictEqual(Buffer.from('YWJj\ud83dZGVm', 'base64').toString('hex'), '616263');
    // base64url takes the identical path.
    strictEqual(Buffer.from('SGVs\ud83dbG8=', 'base64url').toString('hex'), '48656c');
});

Deno.test('buffer: hex decode narrows code units to 8 bits (U+0644 acts as "D")', () => {
    // 0x0644 & 0xff == 0x44 == 'D', a valid hex digit, so node reads "aabDb"
    // as aa,bd and stops on the leftover nibble.
    strictEqual(Buffer.from('aabلb', 'hex').toString('hex'), 'aabd');
    // At the front: "Daabb" -> da,ab then a leftover 'b'.
    strictEqual(Buffer.from('لaabb', 'hex').toString('hex'), 'daab');
    // U+1761 masks to 0x61 == 'a'.
    strictEqual(Buffer.from('ᝡaabb', 'hex').toString('hex'), 'aaab');
});

Deno.test('buffer: ordinary base64/hex leniency is unchanged by the narrowing', () => {
    // Non-alphabet ASCII is SKIPPED, but '=' TERMINATES. These agreed with node
    // on all 7942 in-range cases and must keep doing so.
    strictEqual(Buffer.from('QUJ*D', 'base64').toString('hex'), '414243');
    strictEqual(Buffer.from('Q UJD', 'base64').toString('hex'), '414243');
    strictEqual(Buffer.from('Q\nUJD', 'base64').toString('hex'), '414243');
    strictEqual(Buffer.from('QU=JD', 'base64').toString('hex'), '41');
    strictEqual(Buffer.from('=QQ', 'base64').toString('hex'), '');
    strictEqual(Buffer.from('QUJD=', 'base64').toString('hex'), '414243');
    // hex stops at the first invalid pair.
    strictEqual(Buffer.from('00gg', 'hex').toString('hex'), '00');
    strictEqual(Buffer.from('deadBEEF', 'hex').toString('hex'), 'deadbeef');
    // byteLength deliberately does NOT mask (it is node's upper-bound estimate).
    strictEqual(Buffer.byteLength('QUJD㰽', 'base64'), 3);
});

// ── DEFECT 2: utf16le/ucs2 write must never emit half a code unit ───────────
// The generic write tail was a bare Math.min(), so an odd clamp left a dangling
// low byte in the buffer AND reported it as written. utf8 already had
// utf8PrefixLength for exactly this reason.

Deno.test('buffer: utf16le write rounds down to a whole code unit', () => {
    const b = Buffer.alloc(12, 0x55);
    strictEqual(b.write('ab', 0, 3, 'utf16le'), 2, 'must not report the half unit');
    strictEqual(b.toString('hex'), '610055555555555555555555');

    const c = Buffer.alloc(12, 0x55);
    strictEqual(c.write('abcd', 0, 7, 'utf16le'), 6);
    strictEqual(c.toString('hex'), '610062006300555555555555');

    // ucs2 / utf-16le are the same encoding and must agree.
    const d = Buffer.alloc(8, 0x55);
    strictEqual(d.write('abc', 0, 5, 'ucs2'), 4);
    strictEqual(d.toString('hex'), '6100620055555555');
});

Deno.test('buffer: utf16le write with odd remaining space writes nothing', () => {
    // Reachable with no explicit length: the clamp is the remaining space, which
    // is odd whenever the buffer (or the offset) makes it so.
    const one = Buffer.alloc(1, 0x55);
    strictEqual(one.write('a', 'utf16le'), 0);
    strictEqual(one[0], 0x55, 'buffer must be untouched');

    const b = Buffer.alloc(3, 0x55);
    strictEqual(b.write('ab', 0, 'utf16le'), 2);
    strictEqual(b.toString('hex'), '610055');

    // Odd offset leaves odd space.
    const c = Buffer.alloc(2, 0x55);
    strictEqual(c.write('a', 1, 'utf16le'), 0);
    strictEqual(c.toString('hex'), '5555');
});

Deno.test('buffer: utf8/hex/base64 write clamping is unaffected', () => {
    const b = Buffer.alloc(10, 0x55);
    // utf8 truncates on a character boundary, never mid-sequence.
    strictEqual(b.write('你好', 0, 4, 'utf8'), 3);
    strictEqual(Buffer.alloc(10, 0x55).write('你好', 0, 2, 'utf8'), 0);
    const h = Buffer.alloc(8, 0x55);
    strictEqual(h.write('aabbcc', 0, 2, 'hex'), 2);
});

// ── DEFECT 3: the BigInt writers must reject a non-BigInt ───────────────────
// QuickJS's setBigUint64 coerces, so writeBigUInt64LE('1', 0) silently wrote 8
// bytes and returned 8. Node throws — but only AFTER validating the offset,
// because `'1' > 0n` is a legal comparison that simply returns false.

Deno.test('buffer: writeBigUInt64LE rejects a non-BigInt value', () => {
    for (const method of ['writeBigUInt64LE', 'writeBigUInt64BE',
                          'writeBigInt64LE', 'writeBigInt64BE'] as const) {
        const b = Buffer.alloc(16);
        throws(() => (b[method] as (v: unknown, o: number) => number)('1', 0), {
            name: 'TypeError',
            message: 'Cannot mix BigInt and other types, use explicit conversions',
        }, `${method} must reject a string`);
        throws(() => (b[method] as (v: unknown, o: number) => number)(1, 0), {
            name: 'TypeError',
        }, `${method} must reject a number`);
        // Nothing may have been written.
        strictEqual(b.toString('hex'), '0'.repeat(32), `${method} must not write`);
    }
});

Deno.test('buffer: BigInt writers validate the offset before the value type', () => {
    const b = Buffer.alloc(16);
    // Bad offset wins over the bad value type.
    throws(() => (b.writeBigUInt64LE as (v: unknown, o: unknown) => number)('1', null), {
        code: 'ERR_INVALID_ARG_TYPE',
    });
    // A real BigInt out of range is still a range error.
    throws(() => b.writeBigUInt64LE(18446744073709551616n, 0), { code: 'ERR_OUT_OF_RANGE' });
    // The valid case still works.
    strictEqual(b.writeBigUInt64LE(1n, 0), 8);
    strictEqual(b.readBigUInt64LE(0), 1n);
});

// ── DEFECT 4: argument-validation precedence (3 irregular orders) ───────────
// Node is not uniform here. Each assertion below is a measured cell; an
// "obvious" uniform ordering was wrong on hundreds of cases.

Deno.test('buffer: 8-bit writers report a bad offset type before a bad value range', () => {
    const b = Buffer.alloc(8);
    throws(() => (b.writeUInt8 as (v: number, o: unknown) => number)(256, null),
           { code: 'ERR_INVALID_ARG_TYPE' }, 'writeUInt8: offset type wins');
    throws(() => (b.writeInt8 as (v: number, o: unknown) => number)(255, null),
           { code: 'ERR_INVALID_ARG_TYPE' }, 'writeInt8: offset type wins');
    // ...but the value range still wins when the offset is fine.
    throws(() => b.writeUInt8(256, 0), { code: 'ERR_OUT_OF_RANGE' });
});

Deno.test('buffer: 16/32-bit writers report a bad value range before a bad offset', () => {
    const b = Buffer.alloc(8);
    // The REVERSE of the 8-bit rule. This is the cell an unconditional hoist broke.
    throws(() => (b.writeUInt16LE as (v: number, o: unknown) => number)(65536, null),
           { code: 'ERR_OUT_OF_RANGE' }, 'writeUInt16LE: value range wins');
    throws(() => (b.writeUInt32LE as (v: number, o: unknown) => number)(4294967296, null),
           { code: 'ERR_OUT_OF_RANGE' }, 'writeUInt32LE: value range wins');
    throws(() => (b.writeInt16BE as (v: number, o: unknown) => number)(32768, null),
           { code: 'ERR_OUT_OF_RANGE' }, 'writeInt16BE: value range wins');
});

Deno.test('buffer: variable-width reads — undefined offset outranks a bad byteLength', () => {
    const b = Buffer.alloc(8);
    for (const method of ['readUIntLE', 'readUIntBE', 'readIntLE', 'readIntBE'] as const) {
        // undefined offset wins...
        throws(() => (b[method] as (o: unknown, bl: number) => number)(undefined, 0),
               { code: 'ERR_INVALID_ARG_TYPE' }, `${method}: undefined offset wins`);
        // ...but every OTHER bad offset loses to the byteLength check.
        throws(() => (b[method] as (o: unknown, bl: number) => number)(null, 0),
               { code: 'ERR_OUT_OF_RANGE' }, `${method}: null offset loses to byteLength`);
        throws(() => (b[method] as (o: unknown, bl: number) => number)({}, 7),
               { code: 'ERR_OUT_OF_RANGE' }, `${method}: object offset loses to byteLength`);
        // A valid byteLength then validates the offset normally.
        throws(() => (b[method] as (o: unknown, bl: number) => number)(null, 3),
               { code: 'ERR_INVALID_ARG_TYPE' }, `${method}: null offset with valid byteLength`);
    }
});

// ── DEFECT 5: isUtf8/isAscii must tag ERR_INVALID_ARG_TYPE ─────────────────

Deno.test('buffer: isUtf8 rejects a non-buffer with ERR_INVALID_ARG_TYPE', () => {
    throws(() => (isUtf8 as (i: unknown) => boolean)('abc'), {
        name: 'TypeError',
        code: 'ERR_INVALID_ARG_TYPE',
    });
    // The valid paths still work.
    strictEqual(isUtf8(Buffer.from('abc')), true);
    strictEqual(isUtf8(Buffer.from([0xff])), false);
});

// ── Guard rails: things that were already correct and must stay so ──────────

Deno.test('buffer: invalid UTF-8 decodes to node-identical U+FFFD counts', () => {
    // 6674-case sweep was clean; these are the shapes most likely to regress.
    const cases: Array<[number[], number[]]> = [
        [[0xff], [0xfffd]],
        [[0x80, 0x81, 0xbf], [0xfffd, 0xfffd, 0xfffd]],
        [[0xc0, 0x80], [0xfffd, 0xfffd]],
        [[0xe4, 0xbd], [0xfffd]],
        [[0xf0, 0x9f, 0x98], [0xfffd]],
        [[0xed, 0xa0, 0x80], [0xfffd, 0xfffd, 0xfffd]],
        [[0xf4, 0x90, 0x80, 0x80], [0xfffd, 0xfffd, 0xfffd, 0xfffd]],
        [[0x41, 0xe4, 0xbd, 0x42], [0x41, 0xfffd, 0x42]],
    ];
    for (const [bytes, expected] of cases) {
        const s = Buffer.from(bytes).toString('utf8');
        deepStrictEqual(
            Array.from(s, (c) => c.charCodeAt(0)), expected,
            `bytes ${bytes.map((x) => x.toString(16)).join(' ')}`,
        );
    }
});

Deno.test('buffer: lone surrogates in a JS string encode as U+FFFD', () => {
    strictEqual(Buffer.from('\ud83d', 'utf8').toString('hex'), 'efbfbd');
    strictEqual(Buffer.from('a\ud83db', 'utf8').toString('hex'), '61efbfbd62');
    // A valid pair is preserved.
    strictEqual(Buffer.from('\u{1f600}', 'utf8').toString('hex'), 'f09f9880');
});

Deno.test('buffer: slice and subarray alias the same memory', () => {
    const b = Buffer.from([1, 2, 3, 4]);
    const s = b.slice(1, 3);
    s[0] = 0xaa;
    strictEqual(b[1], 0xaa, 'slice must alias, not copy');
    const t = b.subarray(2, 4);
    t[0] = 0xbb;
    strictEqual(b[2], 0xbb, 'subarray must alias, not copy');
    // ...while Buffer.from(buffer) must COPY.
    const src = Buffer.from([1, 2, 3]);
    const copy = Buffer.from(src);
    src[0] = 0xff;
    strictEqual(copy[0], 1, 'Buffer.from(buffer) must copy');
});

Deno.test('buffer: small allocations do not alias each other', () => {
    const bufs: Buffer[] = [];
    for (let i = 0; i < 200; i++) {
        const b = Buffer.allocUnsafe(8);
        b.fill(i & 0xff);
        bufs.push(b);
    }
    for (let i = 0; i < bufs.length; i++) {
        for (let j = 0; j < 8; j++) {
            strictEqual(bufs[i][j], i & 0xff, `buffer ${i} byte ${j} was clobbered`);
        }
    }
    // subarray cannot grow past its own length into neighbouring memory.
    strictEqual(Buffer.allocUnsafe(8).subarray(0, 999).length, 8);
});

Deno.test('buffer: overlapping copy has memmove semantics', () => {
    const a = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    a.copy(a, 2, 0, 6);
    deepStrictEqual(Array.from(a), [0, 1, 0, 1, 2, 3, 4, 5], 'forward overlap');
    const b = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    b.copy(b, 0, 2, 8);
    deepStrictEqual(Array.from(b), [2, 3, 4, 5, 6, 7, 6, 7], 'backward overlap');
});
