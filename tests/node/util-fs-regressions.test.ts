import { deepStrictEqual, strictEqual } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect, isDeepStrictEqual, parseEnv, types } from 'node:util';

Deno.test('util: inspect, types and comparison exports work together', () => {
    strictEqual(inspect({ value: 1 }), '{ value: 1 }');
    strictEqual(types.isUint8Array(new Uint8Array(1)), true);
    strictEqual(isDeepStrictEqual({ value: [1] }, { value: [1] }), true);
    deepStrictEqual(parseEnv('CNO_REVIEW_VALUE=ok'), { CNO_REVIEW_VALUE: 'ok' });
});

Deno.test('fs: recursive readdir preserves nested paths on the current platform', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cno-readdir-separator-'));
    try {
        mkdirSync(join(root, 'nested'));
        writeFileSync(join(root, 'nested', 'child'), 'contents');
        const expected = ['nested', join('nested', 'child')].sort();
        deepStrictEqual(readdirSync(root, { recursive: true }).sort(), expected);
        deepStrictEqual((await readdir(root, { recursive: true })).sort(), expected);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({
    name: 'fs: recursive readdir preserves POSIX directory names ending in a backslash',
    ignore: process.platform === 'win32',
}, async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cno-readdir-backslash-'));
    const root = join(temp, 'root\\');
    try {
        mkdirSync(join(root, 'nested\\'), { recursive: true });
        writeFileSync(join(root, 'nested\\', 'child'), 'contents');
        const expected = ['nested\\', join('nested\\', 'child')].sort();
        deepStrictEqual(readdirSync(root, { recursive: true }).sort(), expected);
        deepStrictEqual((await readdir(root, { recursive: true })).sort(), expected);
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
});
