/**
 * Regression tests for readline chunk-boundary decoding and line-terminator
 * handling. Each case below produced wrong data before the fix:
 *  - a multi-byte UTF-8 character split across chunks decoded to one U+FFFD per
 *    byte (silent corruption) because `stream: true` was only passed to the
 *    Decoder constructor and not to each `decode()` call;
 *  - a leading U+FEFF was swallowed instead of being reported in the first line;
 *  - U+2028 / U+2029 were not treated as line terminators;
 *  - a CRLF pair straddling a chunk boundary emitted a spurious empty line.
 * All expectations were captured from real `node` v24 on the same inputs.
 */
import { deepStrictEqual, strictEqual } from 'node:assert';
import * as readline from 'node:readline';
import { PassThrough } from 'node:stream';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const BOM = String.fromCharCode(0xFEFF);

/** Feed pre-split chunks and collect the emitted lines. */
function linesFrom(chunks: (string | Uint8Array)[], opts: object = {}): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const input = new PassThrough();
        const lines: string[] = [];
        const rl = readline.createInterface({ input, ...opts });
        rl.on('line', (l: string) => lines.push(l));
        rl.on('close', () => resolve(lines));
        rl.on('error', reject);
        queueMicrotask(() => {
            for (const c of chunks) input.write(c as never);
            input.end();
        });
    });
}

/** Split `text` into one single-byte chunk per UTF-8 byte. */
function perByteChunks(text: string): Uint8Array[] {
    return [...Buffer.from(text, 'utf8')].map((b) => Uint8Array.of(b));
}

Deno.test('readline: multi-byte UTF-8 survives byte-at-a-time chunking', async () => {
    for (const text of ['café naïve', 'Zürich', '中文测试', 'русский', 'a\u{1F600}b']) {
        const lines = await linesFrom(perByteChunks(text));
        deepStrictEqual(lines, [text], `corrupted when chunked per byte: ${text}`);
    }
});

Deno.test('readline: multi-byte UTF-8 survives a split at every byte offset', async () => {
    for (const text of ['xéy', 'x中y', 'x\u{1F600}y']) {
        const buf = Buffer.from(text, 'utf8');
        for (let i = 1; i < buf.length; i++) {
            const lines = await linesFrom([buf.subarray(0, i), buf.subarray(i)]);
            deepStrictEqual(lines, [text], `corrupted splitting ${text} at byte ${i}`);
        }
    }
});

Deno.test('readline: multi-byte characters split across chunks keep their line', async () => {
    // The 3 bytes of U+4E2D arrive in 3 separate chunks around a newline.
    const buf = Buffer.from('a中\nb', 'utf8');
    const lines = await linesFrom([buf.subarray(0, 2), buf.subarray(2, 3), buf.subarray(3)]);
    deepStrictEqual(lines, ['a中', 'b']);
});

Deno.test('readline: a leading BOM is reported, not swallowed', async () => {
    deepStrictEqual(await linesFrom([BOM + 'abc\ndef']), [BOM + 'abc', 'def']);
    deepStrictEqual(await linesFrom([BOM + '\nabc']), [BOM, 'abc']);
    deepStrictEqual(await linesFrom([BOM + BOM + 'abc']), [BOM + BOM + 'abc']);
    // Mid-stream BOM is ordinary data too.
    deepStrictEqual(await linesFrom(['abc\n' + BOM + 'def']), ['abc', BOM + 'def']);
});

Deno.test('readline: a BOM split across chunks is not corrupted', async () => {
    const lines = await linesFrom([Uint8Array.of(0xEF), Uint8Array.of(0xBB, 0xBF, 0x61)]);
    deepStrictEqual(lines, [BOM + 'a']);
});

Deno.test('readline: U+2028 and U+2029 terminate lines', async () => {
    deepStrictEqual(await linesFrom(['a' + LS + 'b']), ['a', 'b']);
    deepStrictEqual(await linesFrom(['a' + PS + 'b']), ['a', 'b']);
    deepStrictEqual(await linesFrom(['a' + LS + 'b' + PS + 'c']), ['a', 'b', 'c']);
    // ...including when the separator ends a chunk.
    deepStrictEqual(await linesFrom(['a' + LS, 'b']), ['a', 'b']);
});

Deno.test('readline: U+0085/VT/FF are NOT line terminators', async () => {
    // Node treats only LF, CR, CRLF, U+2028 and U+2029 as terminators.
    // Guards the fix against over-reaching into other Unicode whitespace.
    for (const code of [0x85, 0x0B, 0x0C]) {
        const text = 'a' + String.fromCharCode(code) + 'b';
        deepStrictEqual(await linesFrom([text]), [text], `U+${code.toString(16)} must not split`);
    }
});

Deno.test('readline: a CRLF split across chunks yields no empty line', async () => {
    deepStrictEqual(await linesFrom(['a\r', '\nb'], { crlfDelay: Infinity }), ['a', 'b']);
    deepStrictEqual(await linesFrom(['a\r', '\nb']), ['a', 'b']);
    // A lone CR ending a chunk still terminates its line.
    deepStrictEqual(await linesFrom(['a\r', 'b']), ['a', 'b']);
    // CR at the very end of input terminates and flushes nothing extra.
    deepStrictEqual(await linesFrom(['a\r']), ['a']);
});

Deno.test('readline: in-chunk line terminators still behave', async () => {
    deepStrictEqual(await linesFrom(['a\nb\nc\n']), ['a', 'b', 'c']);
    deepStrictEqual(await linesFrom(['a\nb\nc']), ['a', 'b', 'c']);
    deepStrictEqual(await linesFrom(['a\r\nb\r\nc\r\n']), ['a', 'b', 'c']);
    deepStrictEqual(await linesFrom(['a\rb\rc']), ['a', 'b', 'c']);
    deepStrictEqual(await linesFrom(['\n\n\n']), ['', '', '']);
    deepStrictEqual(await linesFrom(['a\n\nb\n']), ['a', '', 'b']);
    deepStrictEqual(await linesFrom(['']), []);
});

Deno.test('readline: an input stream error is re-emitted on the Interface', async () => {
    const input = new PassThrough();
    const rl = readline.createInterface({ input });
    // Resolve on a timer as well, so a swallowed error fails the assertion
    // instead of hanging the test.
    const seen = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('<no error event>'), 1000);
        rl.on('error', (err: Error) => {
            clearTimeout(timer);
            resolve(err.message);
        });
        queueMicrotask(() => input.destroy(new Error('boom')));
    });
    strictEqual(seen, 'boom', 'input errors must not be swallowed');
});
