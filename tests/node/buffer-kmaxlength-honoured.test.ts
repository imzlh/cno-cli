/**
 * `buffer.kMaxLength` must be honourable, not merely advertised.
 *
 * The guard every size-validating library writes is
 *
 *     if (size <= buffer.kMaxLength) Buffer.alloc(size);
 *
 * so the constant is only useful if a size that passes it actually allocates.
 * cno previously advertised 0xFFFFFFFF (4294967295) while QuickJS refuses any
 * array buffer past INT32_MAX — `JSArrayBuffer.byte_length` is an `int`, and
 * `js_array_buffer_constructor3` rejects `len > INT32_MAX` outright — so the
 * guard passed and the allocation then threw, which is the one outcome the
 * constant exists to prevent.
 *
 * Note this invariant is deliberately NOT node parity: node advertises
 * `Number.MAX_SAFE_INTEGER` and `Buffer.alloc(buffer.kMaxLength)` throws
 * "Array buffer allocation failed" on node v24 too, because node's number is an
 * argument-validation bound rather than an allocability promise. Ours is both,
 * which is the stronger contract and the one that makes the guard work.
 *
 * The ceiling-sized allocation runs in a child process: it commits 2 GiB, and a
 * failure mode worth catching here is a crash rather than a throw, which an
 * in-process assertion would turn into a lost run instead of a measurement.
 */
import { strictEqual, ok, throws } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import * as buffer from 'node:buffer';
import { Buffer } from 'node:buffer';

/** 2 GiB - 1. Structural: QuickJS stores a buffer length in an `int`. */
const INT32_MAX = 2147483647;

/** Run `body` in a child cno so a 2 GiB commit cannot take the suite with it. */
function runChild(name: string, body: string): { status: number | null; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cno-kmaxlen-'));
    const file = join(dir, `${name}.mjs`);
    try {
        writeFileSync(file, body, 'utf8');
        const r = spawnSync(process.execPath, ['run', file], {
            encoding: 'utf8',
            timeout: 120_000,
        });
        return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

Deno.test('buffer: kMaxLength is the real ceiling, not an aspiration', () => {
    strictEqual(buffer.kMaxLength, INT32_MAX);
    strictEqual(buffer.constants.MAX_LENGTH, buffer.kMaxLength);
    // The old value is the specific lie this test exists to prevent regressing to.
    ok(buffer.kMaxLength !== 0xFFFFFFFF, 'kMaxLength must not claim 4 GiB - 1; QuickJS caps at INT32_MAX');
});

Deno.test('buffer: Buffer.alloc(kMaxLength) must not throw', () => {
    // The whole point of the constant. Child process: commits 2 GiB.
    const r = runChild('at-ceiling', [
        "import { Buffer, kMaxLength } from 'node:buffer';",
        'try {',
        '    const b = Buffer.alloc(kMaxLength);',
        "    console.log(b.length === kMaxLength ? 'ALLOCATED' : 'WRONG_LENGTH:' + b.length);",
        '} catch (e) {',
        "    console.log('THREW:' + e.name + ':' + e.code + ':' + e.message);",
        '}',
    ].join('\n'));
    strictEqual(r.status, 0, `child must exit cleanly, got ${r.status}; stderr=${r.stderr.slice(0, 300)}`);
    ok(
        r.stdout.includes('ALLOCATED'),
        `Buffer.alloc(kMaxLength) must succeed, so the standard guard is sound. stdout=${r.stdout.trim()}`,
    );
});

Deno.test('buffer: allocUnsafe and ArrayBuffer share the same honoured ceiling', () => {
    const r = runChild('ceiling-all', [
        "import { Buffer, kMaxLength } from 'node:buffer';",
        'const out = [];',
        'for (const [name, fn] of [',
        "    ['allocUnsafe', () => Buffer.allocUnsafe(kMaxLength)],",
        "    ['arraybuffer', () => new ArrayBuffer(kMaxLength)],",
        ']) {',
        "    try { const v = fn(); out.push(name + ':' + (v.byteLength ?? v.length)); }",
        "    catch (e) { out.push(name + ':THREW:' + e.message); }",
        '}',
        "console.log(out.join(' '));",
    ].join('\n'));
    strictEqual(r.status, 0, `child must exit cleanly, got ${r.status}; stderr=${r.stderr.slice(0, 300)}`);
    ok(r.stdout.includes(`allocUnsafe:${INT32_MAX}`), `allocUnsafe(kMaxLength) must succeed: ${r.stdout.trim()}`);
    ok(r.stdout.includes(`arraybuffer:${INT32_MAX}`), `new ArrayBuffer(kMaxLength) must succeed: ${r.stdout.trim()}`);
});

Deno.test('buffer: one byte past kMaxLength throws a node-shaped RangeError', () => {
    // Cheap: rejected by validation before any allocation is attempted, so this
    // one needs no child process. Node's shape for an over-bound size is a
    // RangeError carrying ERR_OUT_OF_RANGE — not QuickJS's uncoded
    // "invalid array buffer length", which is what leaked before the fix.
    for (const [label, fn] of [
        ['alloc', () => Buffer.alloc(INT32_MAX + 1)],
        ['allocUnsafe', () => Buffer.allocUnsafe(INT32_MAX + 1)],
        ['allocUnsafeSlow', () => Buffer.allocUnsafeSlow(INT32_MAX + 1)],
    ] as const) {
        throws(fn, (err: unknown) => {
            const e = err as { name?: string; code?: string; message?: string };
            strictEqual(e.name, 'RangeError', `${label}: name`);
            strictEqual(e.code, 'ERR_OUT_OF_RANGE', `${label}: must carry a code a caller can catch`);
            ok(
                e.message?.includes(`>= 0 && <= ${INT32_MAX}`),
                `${label}: message must quote the real bound, got ${e.message}`,
            );
            ok(
                !e.message?.includes('invalid array buffer length'),
                `${label}: the engine's uncoded error must not leak, got ${e.message}`,
            );
            return true;
        }, `${label}(kMaxLength + 1) must throw`);
    }
});

Deno.test('buffer: a size well past the ceiling is also rejected by validation', () => {
    // 3 GiB: under the OLD advertised 0xFFFFFFFF, so the old code passed its own
    // precheck and then died in the allocator.
    throws(() => Buffer.alloc(3221225472), (err: unknown) => {
        const e = err as { code?: string };
        strictEqual(e.code, 'ERR_OUT_OF_RANGE');
        return true;
    });
});

Deno.test('buffer: MAX_STRING_LENGTH is honoured (advertised limit is reachable)', () => {
    // The sibling defect worth ruling out: an advertised string limit that
    // throws below its own value. cno's real ceiling is JS_STRING_LEN_MAX
    // ((1 << 30) - 1 = 1073741823), so the advertised 536870888 — which equals
    // node's — is comfortably reachable and the guard is safe here.
    strictEqual(buffer.constants.MAX_STRING_LENGTH, buffer.kStringMaxLength);
    strictEqual(buffer.kStringMaxLength, 0x1FFFFFE8);
    ok(buffer.kStringMaxLength < 1073741824, 'advertised string limit must sit under JS_STRING_LEN_MAX');

    const r = runChild('string-limit', [
        "import { kStringMaxLength } from 'node:buffer';",
        'try {',
        "    const s = 'a'.repeat(kStringMaxLength);",
        "    console.log(s.length === kStringMaxLength ? 'STRING_OK' : 'WRONG:' + s.length);",
        '} catch (e) {',
        "    console.log('THREW:' + e.message);",
        '}',
    ].join('\n'));
    strictEqual(r.status, 0, `child must exit cleanly, got ${r.status}; stderr=${r.stderr.slice(0, 300)}`);
    ok(r.stdout.includes('STRING_OK'), `a string of kStringMaxLength must be constructible: ${r.stdout.trim()}`);
});
