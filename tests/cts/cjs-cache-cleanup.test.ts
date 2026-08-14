import type { CjsDeps } from '../../cts/src/compile/cjs.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { CjsLoader } from '../../cts/src/compile/cjs.ts';

const unused = (): never => { throw new Error('unexpected dependency call'); };

Deno.test('cts cjs: failed child loads leave neither cache nor module.children entries', () => {
    const root = makePosixTempDir('cjs-failed-child');
    const parentPath = `${root}/parent.cjs`;
    const childPath = `${root}/child.cjs`;
    mkdirSync(root, { recursive: true });
    // Cleanup uses the loader's original parent, even if failing code mutates module.parent.
    writeFileSync(childPath, `module.parent = null; throw new Error('boom');\n`);
    writeFileSync(parentPath, `
        for (let i = 0; i < 2; i++) {
            try { require('./child.cjs'); } catch {}
        }
        module.exports = {
            children: module.children.map(child => child.filename),
            cached: require.cache[require.resolve('./child.cjs')] !== undefined,
        };
    `);

    const deps: CjsDeps = {
        resolveBuiltin: unused,
        loadEsmSync: unused,
        resolveExternal: () => null,
    };
    try {
        const loader = new CjsLoader(deps);
        const result = loader.loadAndGet(parentPath).exports as {
            children: string[];
            cached: boolean;
        };
        deepStrictEqual(result.children, []);
        strictEqual(result.cached, false);
        strictEqual(loader.cache.has(childPath), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
