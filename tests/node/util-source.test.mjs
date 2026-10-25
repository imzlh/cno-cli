// Run with: node --test tests/node/util-source.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { transform } from 'esbuild';

test('util source compiles without duplicate imports or exports', async () => {
    const source = await readFile(new URL('../../cno/src/node/util/mod.ts', import.meta.url), 'utf8');
    const result = await transform(source, {
        loader: 'ts',
        format: 'esm',
        sourcefile: 'cno/src/node/util/mod.ts',
    });
    assert.equal(result.warnings.length, 0);
});
