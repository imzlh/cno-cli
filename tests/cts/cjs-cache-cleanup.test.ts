import type { CjsDeps } from '../../cts/src/compile/cjs.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';
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
            cached: require.cache[${JSON.stringify(childPath)}] !== undefined,
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

Deno.test('cts cjs: clearLoadedModules drops cache and cycle bookkeeping', () => {
    const deps: CjsDeps = {
        resolveBuiltin: unused,
        loadEsmSync: unused,
        resolveExternal: () => null,
    };
    const loader = new CjsLoader(deps);
    loader.loadSourceAndGet('module.exports = { payload: "held" };\n', '/virtual/retained.cjs');
    loader.preRegister('/virtual/pending.cjs', '/virtual/retained.cjs');

    // Exercise the private side tables as well as the public require cache. A
    // real builtin load and an in-flight cycle populate the same tables, but
    // inserting sentinels keeps this regression test independent of the host's
    // builtin resolver and filesystem.
    const state = loader as unknown as {
        builtinCache: Map<string, unknown>;
        executing: Set<string>;
        esmImporters: Map<string, string>;
        mainModule: unknown;
    };
    state.builtinCache.set('node:sentinel', {});
    state.executing.add('/virtual/in-flight.cjs');
    state.esmImporters.set('/virtual/in-flight.cjs', '/virtual/retained.cjs');
    state.mainModule = {};

    loader.clearLoadedModules();

    strictEqual(loader.cache.size, 0, 'require cache must release all CJS modules');
    strictEqual(state.builtinCache.size, 0, 'builtin wrappers must be released');
    strictEqual(state.executing.size, 0, 'cycle state must not retain paths');
    strictEqual(state.esmImporters.size, 0, 'importer state must not retain paths');
    strictEqual(state.mainModule, null, 'main module reference must be released');
});

Deno.test('cts cjs: failed inline source cleans the original parent and can retry', () => {
    const deps: CjsDeps = {
        resolveBuiltin: unused,
        loadEsmSync: unused,
        resolveExternal: () => null,
    };
    for (const preRegistered of [false, true]) {
        const loader = new CjsLoader(deps);
        const parentPath = '/virtual/inline-parent.cjs';
        const childPath = '/virtual/inline-child.cjs';
        const parent = loader.loadSourceAndGet('', parentPath);
        if (preRegistered) loader.preRegister(childPath, parentPath);

        throws(() => loader.loadSourceAndGet(
            'module.parent = null; throw new Error("inline failure");',
            childPath,
            preRegistered ? undefined : parentPath,
        ), /inline failure/);
        deepStrictEqual(parent.children, []);
        strictEqual(loader.cache.has(childPath), false);
        strictEqual(loader.isExecuting(childPath), false);

        const child = loader.loadSourceAndGet('module.exports = 42;', childPath, parentPath);
        strictEqual(child.exports, 42);
        strictEqual(child.loaded, true);
        deepStrictEqual(parent.children, [child]);
    }
});
