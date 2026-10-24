/*
 * Shape of child stdio 'data' chunks.
 *
 * A chunk read from a child's pipe is a Uint8Array from the native layer. Node
 * hands 'data' listeners a Buffer, so code like `chunk.toString('utf8')`, `+=`
 * on a `let out = ''`, or `Buffer.isBuffer(chunk)` guards works under Node but
 * produced "[115,101,114,...]" or false here: deliverPipeChunk() writes chunks
 * into the readable buffer without going through push(), which is the only
 * place that normalised chunks.
 *
 * The inner script is run with `-e` and always prints one JSON line — including
 * when the child fails to start — so a regression reads as a wrong result
 * rather than a bare timeout.
 */
import { strictEqual, ok } from 'node:assert';

const SOURCE = 'process.stdout.write("hello\\n"); process.stderr.write("oops\\n");';

function inner(lines: string[]): string {
    return [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(SOURCE)}]);`,
        'child.on("error", (err) => { process.stdout.write(JSON.stringify({ error: err.message })); });',
        ...lines,
    ].join('\n');
}

async function runInner(lines: string[]): Promise<Record<string, unknown>> {
    const proc = new Deno.Command(process.execPath, {
        args: ['-e', inner(lines)],
        stdout: 'piped',
        stderr: 'piped',
    });
    const { stdout, stderr } = await proc.output();
    const text = new TextDecoder().decode(stdout).trim();
    ok(text.length > 0, `inner script printed nothing; stderr: ${new TextDecoder().decode(stderr)}`);
    return JSON.parse(text) as Record<string, unknown>;
}

Deno.test({ name: 'child_process: stdout data chunks are Buffers', timeout: 20000 }, async () => {
    const result = await runInner([
        'const seen = [];',
        'child.stdout.on("data", (chunk) => seen.push(Buffer.isBuffer(chunk)));',
        'child.on("close", (code) => process.stdout.write(JSON.stringify({ code, seen })));',
    ]) as { code: number; seen: boolean[] };
    strictEqual(result.code, 0);
    ok(result.seen.length > 0, 'expected at least one stdout chunk');
    strictEqual(result.seen.every(Boolean), true, 'every stdout chunk should be a Buffer');
});

Deno.test({ name: 'child_process: setEncoding decodes stderr, not byte lists', timeout: 20000 }, async () => {
    const result = await runInner([
        'let err = "";',
        'child.stderr.setEncoding("utf8");',
        'child.stderr.on("data", (chunk) => { err += chunk; });',
        'child.on("close", (code) => process.stdout.write(JSON.stringify({ code, err })));',
    ]) as { code: number; err: string };
    strictEqual(result.code, 0);
    strictEqual(result.err, 'oops\n');
});

Deno.test({ name: 'child_process: setEncoding gives stdout strings', timeout: 20000 }, async () => {
    const result = await runInner([
        'let out = "";',
        'const kinds = [];',
        'child.stdout.setEncoding("utf8");',
        'child.stdout.on("data", (chunk) => { kinds.push(typeof chunk); out += chunk; });',
        'child.on("close", (code) => process.stdout.write(JSON.stringify({ code, out, kinds })));',
    ]) as { code: number; out: string; kinds: string[] };
    strictEqual(result.code, 0);
    strictEqual(result.out, 'hello\n');
    ok(result.kinds.length > 0 && result.kinds.every((kind) => kind === 'string'), 'setEncoding should emit strings');
});
