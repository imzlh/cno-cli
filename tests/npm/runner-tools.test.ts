import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';

function cacheDir(): string | undefined {
    try {
        return Deno.env.get('CTS_CACHE_DIR') || undefined;
    } catch {
        return undefined;
    }
}

async function runCno(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const dir = cacheDir();
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(execPath, {
        args: dir ? [`--cache-dir=${dir}`, ...args] : args,
        cwd,
        stdout: 'piped',
        stderr: 'piped',
        env: dir ? { CTS_CACHE_DIR: dir } : undefined,
    }).output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

Deno.test({ name: 'uvu bin: runs a directory test suite', timeout: 60000 }, async () => {
    await import('npm:uvu');
    const dir = await Deno.makeTempDir({ prefix: 'cno-uvu-' });
    try {
        const testDir = join(dir, 'test');
        await Deno.mkdir(testDir);
        await Deno.writeTextFile(join(testDir, 'basic.mjs'), [
            'import { test } from "uvu";',
            'import * as assert from "uvu/assert";',
            'test("adds", () => assert.is(1 + 1, 2));',
            'test.run();',
        ].join('\n'));

        const result = await runCno(['exec', 'uvu', '--', 'test'], dir);
        strictEqual(result.code, 0, result.stderr);
        ok(result.stdout.includes('Passed:    1'), result.stdout);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test({ name: 'tape bin: runs a CommonJS test file', timeout: 60000 }, async () => {
    await import('npm:tape');
    const dir = await Deno.makeTempDir({ prefix: 'cno-tape-' });
    try {
        await Deno.writeTextFile(join(dir, 'test.cjs'), [
            'const test = require("tape");',
            'test("adds", (t) => { t.equal(1 + 1, 2); t.end(); });',
        ].join('\n'));

        const result = await runCno(['exec', 'tape', '--', 'test.cjs'], dir);
        strictEqual(result.code, 0, result.stderr);
        ok(result.stdout.includes('ok 1 should be strictly equal') || result.stdout.includes('# pass  1'), result.stdout);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test({ name: 'mocha bin: runs a CommonJS test file', timeout: 60000 }, async () => {
    await import('npm:mocha');
    const dir = await Deno.makeTempDir({ prefix: 'cno-mocha-' });
    try {
        await Deno.writeTextFile(join(dir, 'test.cjs'), [
            'const assert = require("node:assert");',
            'describe("adds", function () {',
            '  it("works", function () { assert.equal(1 + 1, 2); });',
            '});',
        ].join('\n'));

        const result = await runCno(['exec', 'mocha', '--', 'test.cjs'], dir);
        strictEqual(result.code, 0, result.stderr);
        ok(result.stdout.includes('1 passing'), result.stdout);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});
